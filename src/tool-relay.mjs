// Tool relay: client-declared tools become SDK customTools whose callbacks
// run in the host process. Each callback is not executed — it is translated
// into an OpenAI/Anthropic tool_calls reply, the client executes it, and the
// returned result resolves the callback.
//
// Invariants:
// - One turn lives exactly one run; tool round-trips span multiple HTTP
//   requests, so a turn outlives the request that started it.
// - Tool calls are never dropped: batched within BATCH_WINDOW_MS, cached
//   while the sink is closed, replayed when the next request attaches.
// - Every pending call is bounded by config.toolResultTimeoutMs.
// - The sink receives the SDK's raw usage; wire-format conversion is the
//   sink's job (it is the layer that knows the wire format).

import crypto from "node:crypto";
import { config } from "./settings.mjs";
import { describe, log } from "./logger.mjs";

/** toolCallId -> RelayTurn. The client's next request finds its turn through this. */
const byToolCall = new Map();

/**
 * Back-to-back calls within one turn are flushed together so the client can
 * run them in parallel; the window stays small so a single call does not wait.
 */
const BATCH_WINDOW_MS = 80;

/**
 * Tools that spawn another independent conversation are not registered by
 * default: each subagent starts its own billed run, so 5 subagents in one
 * turn is 6 billings. Enabled with CURSOR_ALLOW_SUBAGENTS.
 *
 * Matching is prefix-based; benign names like `taskStatus` are caught too —
 * a known trade-off.
 */
const SUBAGENT_TOOLS =
  /^(task|subagent|best[_-]?of[_-]?n|(spawn|launch|create|run|start|dispatch|delegate)[_-]?(sub)?agent)/i;

const allowSubagents = /^(1|true|yes|on)$/i.test(process.env.CURSOR_ALLOW_SUBAGENTS ?? "");

/** Generate a tool-call id unique within the process. */
function makeCallId(prefix) {
  return prefix + crypto.randomBytes(12).toString("hex");
}

function trackCall(id, turn) {
  byToolCall.set(id, turn);
}

function untrackCall(id) {
  byToolCall.delete(id);
}

/**
 * Normalized tools[] -> SDK customTools. The execution body is
 * "suspend and hand to the client".
 *
 * Input is protocol-neutral `{name, description, parameters}`; the protocol
 * adapters (openai.mjs / anthropic.mjs) convert before calling in.
 */
export function buildCustomTools(tools, turn) {
  const out = {};
  const blocked = [];

  for (const t of tools ?? []) {
    if (!t?.name) continue;
    if (!allowSubagents && SUBAGENT_TOOLS.test(t.name)) {
      blocked.push(t.name);
      continue;
    }
    const schema = normalizeSchema(t.parameters);
    out[t.name] = {
      description: normalizeDescription(t.description, schema),
      inputSchema: schema,
      execute: (args, opts) => turn.delegate(t.name, args, opts),
    };
  }

  if (blocked.length) log.info(`blocked conversation-spawning tools: ${blocked.join(", ")}`);
  return out;
}

/**
 * Make a client-declared schema safe for the SDK to validate against
 * (kiro's four-piece treatment): `required` must be an array of strings,
 * `properties` must be an object, `type` must be a string, and
 * `additionalProperties` must be boolean-or-schema. The `$schema` artifact
 * (a human-tools convention the SDK does not need) is dropped. Applied
 * recursively to property schemas; unknown keys are preserved.
 */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const out = { ...schema };
  delete out.$schema;
  if (typeof out.type !== "string") out.type = "object";
  if (!Array.isArray(out.required)) out.required = [];
  else out.required = out.required.filter((n) => typeof n === "string");
  if (out.properties == null || typeof out.properties !== "object" || Array.isArray(out.properties)) {
    out.properties = {};
  } else {
    for (const [key, sub] of Object.entries(out.properties)) {
      if (sub && typeof sub === "object" && !Array.isArray(sub)) {
        out.properties[key] = normalizeSchema(sub);
      }
    }
  }
  const ap = out.additionalProperties;
  if (ap !== undefined && (ap === null || (typeof ap !== "boolean" && typeof ap !== "object"))) {
    out.additionalProperties = true;
  }
  return out;
}

/** Descriptions longer than this are bloat, not signal; cut them. */
const MAX_DESCRIPTION_LEN = 10000;

/**
 * Description fallback coverage: non-string or whitespace-only descriptions
 * distill from the schema, and oversized ones are truncated on a character
 * boundary (a cut must never split a surrogate pair).
 */
function normalizeDescription(desc, schema) {
  if (typeof desc !== "string" || !desc.trim()) return describeFromSchema(schema);
  if (desc.length <= MAX_DESCRIPTION_LEN) return desc;
  let end = MAX_DESCRIPTION_LEN;
  const c = desc.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1; // the pair's high half was cut off
  return desc.slice(0, end);
}

/**
 * Description fallback: distill a one-line summary from the schema when the
 * tool declares none. Empty descriptions render as a useless placeholder in
 * Cursor and the model calls the tool measurably less.
 */
function describeFromSchema(params) {
  if (!params || typeof params !== "object") return "call a client-provided tool";
  const req = Array.isArray(params.required) ? params.required : [];
  const props = params.properties && typeof params.properties === "object"
    ? Object.keys(params.properties)
    : [];
  const names = req.length ? req : props.slice(0, 4);
  if (!names.length) return "call a client-provided tool";
  return `call a client-provided tool (params: ${names.join(", ")})`;
}

/**
 * The tool round-trip state of one turn.
 *
 * Lifecycle: from the client's request carrying tools until the agent
 * finishes answering. Any number of tool round-trips can be woven in, each
 * hanging a fresh HTTP request on as its output sink.
 */
export class RelayTurn {
  constructor() {
    this.pending = new Map(); // toolCallId -> {resolve, reject, timer, name}
    this.sink = null;
    this.sinkRelease = null; // resolves the promise returned by attach
    this.pendingText = "";
    this.queued = []; // tool calls awaiting the batch flush
    this.flushTimer = null;
    this.usage = null;
    this.finished = false;
    this.error = null;
    this.lastActivityAt = Date.now();
    /** Account this turn runs on; round-trips must continue with it — switching accounts mid-turn means switching brains. */
    this.account = null;
    /**
     * Prefix for tool-call ids (OpenAI: `call_`, Anthropic: `toolu_`).
     *
     * Not cosmetic: Anthropic clients echo `tool_use.id` back verbatim as
     * `tool_result.tool_use_id`, and some implementations treat a
     * `call_`-prefixed id as anomalous data.
     */
    this.callIdPrefix = "call_";
    /** Calls arriving while the sink is closed wait here for the next attach to replay them. */
    this.parked = [];
  }

  #touch() {
    this.lastActivityAt = Date.now();
    // Event-driven wake-up for waitTurn: the idle deadline is a function of
    // lastActivityAt, so every touch re-arms it (no 200ms polling).
    if (typeof this.onActivity === "function") this.onActivity();
  }

  /**
   * Hang an HTTP response on as the output sink. The returned promise
   * resolves when that sink closes.
   */
  attach(sink) {
    // A finished turn is dead: nothing will be emitted again. Seal the
    // sink so the caller's response ends promptly, and never replay parked
    // calls into it — stale tool calls in a fresh response would make the
    // client run them for a run that no longer exists. The promise never
    // resolves: there is no more output to wait for.
    if (this.finished) {
      if (sink && !sink.closed) sink.finish("stop", this.usage);
      return new Promise(() => {});
    }
    // A still-open previous sink is replaced: the client disconnecting and
    // resending lands here; without releasing the old promise, the previous
    // request handler would await forever.
    if (this.sinkRelease) {
      const stale = this.sinkRelease;
      this.sinkRelease = null;
      stale();
    }
    this.sink = sink;
    if (this.pendingText) {
      sink.text(this.pendingText);
      this.pendingText = "";
    }
    // Replay calls cached while the sink was closed: the agent can emit
    // several parallel tool_use at once (concurrent subagents). After the
    // first flush closes the sink, later arrivals are cached and replayed
    // when the client's next request (with tool results) attaches — dropping
    // them would look like "connection interrupted".
    if (this.parked.length) {
      const deferred = this.parked;
      this.parked = [];
      log.info(`replaying ${deferred.length} cached tool call(s): ${deferred.map((c) => c.name).join(", ")}`);
      deferred.forEach((c, i) => sink.toolCall(i, c));
      this.#sealSink("tool_calls", this.usage);
    }
    return new Promise((resolve) => {
      this.sinkRelease = resolve;
    });
  }

  /**
   * Close the output sink.
   *
   * The sink receives the SDK's raw usage (`inputTokens` / `outputTokens`);
   * format conversion is the sink's job — it is the layer that knows the
   * wire format. Converting here used to break the Anthropic endpoint:
   * it wants `input_tokens` / `output_tokens`, so one shape was always
   * undefined — and never errored, just blank stat columns.
   */
  #sealSink(reason, usage) {
    const sink = this.sink;
    this.sink = null;
    const done = this.sinkRelease;
    this.sinkRelease = null;
    if (sink && !sink.closed) sink.finish(reason, usage);
    if (done) done();
  }

  #emitText(t) {
    if (!t) return;
    this.#touch();
    if (this.sink) this.sink.text(t);
    else this.pendingText += t;
  }

  /** The customTool callback's landing point: do not execute, hand to the client. */
  delegate(name, args, opts) {
    this.#touch();
    const id = makeCallId(this.callIdPrefix);
    trackCall(id, this);
    this.queued.push({ id, name, args });

    const p = new Promise((resolve, reject) => {
      const timer = this.#armTimer(id, name, reject);
      // The SDK's own call id rides along for diagnostics: it is a separate
      // id space from our wire id, but correlating the two helps trace
      // round-trips against the SDK's tool-execution logs.
      this.pending.set(id, { resolve, reject, timer, name, toolCallId: opts?.toolCallId ?? null });
    });

    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.#flush(), BATCH_WINDOW_MS);
    this.flushTimer.unref?.();
    return p;
  }

  #armTimer(id, name, reject) {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      untrackCall(id);
      reject(new Error(`client did not return a result for ${name} within ${Math.round(config.toolResultTimeoutMs / 1000)}s`));
    }, config.toolResultTimeoutMs);
    timer.unref?.();
    return timer;
  }

  #flush() {
    this.flushTimer = null;
    const batch = this.queued;
    this.queued = [];
    if (!batch.length) return;

    if (!this.sink) {
      // No open HTTP round-trip: do not drop — parallel tool_use can arrive
      // after the sink already closed on the first flush, so the rest are
      // cached until the client's next request attaches. The pending
      // promises carry their own toolResultTimeoutMs timeout.
      this.parked.push(...batch);
      log.warn(`sink closed, caching ${batch.length} tool call(s) for replay: ${batch.map((c) => c.name).join(", ")}`);
      return;
    }

    log.info(`handing to the client: ${batch.map((c) => c.name).join(", ")}`);
    batch.forEach((c, i) => this.sink.toolCall(i, c));
    this.#sealSink("tool_calls", this.usage);
  }

  #failCall(id, err) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    untrackCall(id);
    p.reject(err);
  }

  /** The client sent a result back. An error result resolves as `{content, isError}`. */
  resolveTool(id, content, isError) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.#touch();
    clearTimeout(p.timer);
    this.pending.delete(id);
    untrackCall(id);
    p.isError = Boolean(isError);
    if (isError) {
      // Structured error result: the SDK's result normalizer forwards
      // `isError` to the model, which must know the call failed — fed back
      // as plain text it would keep reasoning on a failure it thinks
      // succeeded.
      p.resolve({ content: [{ type: "text", text: stringifyResult(content) }], isError: true });
    } else {
      p.resolve(stringifyResult(content));
    }
    return true;
  }

  get waiting() {
    return this.pending.size > 0;
  }

  /**
   * Consume the run's event stream. This loop belongs to the turn, not to
   * any HTTP request — during a tool round-trip the current request has long
   * returned while the stream keeps running.
   */
  async consume(run) {
    try {
      for await (const ev of run.stream()) {
        // Any event counts as alive, not just text: thinking, tool calls and
        // usage events all emit; text-only would misjudge a long thinking
        // phase as hung.
        this.#touch();
        if (ev.type === "assistant") {
          for (const b of ev.message.content ?? []) {
            if (b.type === "text") this.#emitText(b.text);
          }
        } else if (ev.type === "usage") {
          this.usage = ev.usage;
        }
      }
      const result = await run.wait();
      if (result.status !== "finished") {
        // Use describe rather than concatenation: `result.error` is measured
        // to be an object, and concatenation turns it into
        // `run error: [object Object]`, erasing the only diagnostic clue.
        this.error = `run ${result.status}${result.error ? ": " + describe(result.error) : ""}`;
        // Keep the raw object too: describe only reaches one level, and this
        // is our only channel for accumulating how Cursor runs fail.
        log.warn("run did not finish normally", { status: result.status, error: result.error });
      } else if (!this.#hasText && result.result) {
        // No text at all in the stream: use the final value as a fallback so
        // the client never gets an empty reply.
        this.#emitText(result.result);
      }
    } catch (e) {
      this.error = `execution failed: ${describe(e)}`;
    } finally {
      this.finished = true;
      for (const id of [...this.pending.keys()]) {
        this.#failCall(id, new Error("run ended"));
      }
      if (this.sink) {
        if (this.error) this.sink.text(`\n\n[cursorapi] ${this.error}\n`);
        this.#sealSink("stop", this.usage);
      }
    }
  }

  get #hasText() {
    return this.pendingText.length > 0 || (this.sink?.parts?.length ?? 0) > 0;
  }
}

/**
 * Find the turn a tool-call id belongs to.
 *
 * Each protocol's message shape differs (OpenAI: `role:"tool"` +
 * `tool_call_id`; Anthropic: `tool_result` blocks inside user messages +
 * `tool_use_id`), so "how to dig the id out of messages" stays with the
 * adapters; here it is just id -> turn.
 */
export function lookupTurn(toolCallId) {
  return byToolCall.get(toolCallId) ?? null;
}

/**
 * Hand a batch of `{id, content, isError?}` back. Returns how many were fed.
 *
 * Protocol-neutral too: the adapters extract this array from their own
 * message structures.
 *
 * Dispatch is by id against the global byToolCall map, not against the
 * caller's turn: a request can carry results from several turns at once
 * (two rounds of tool calls in flight, results batched by the client), and
 * feeding them all into the first turn's pending map would silently drop
 * the rest — their promises would hang until the timeout. `turn` is kept
 * for call-site compatibility only. Ids with no matching pending call are
 * logged, never silently discarded.
 */
export function feedResults(turn, results) {
  let fed = 0;
  const missed = [];
  for (const r of results ?? []) {
    if (!r?.id) continue;
    const owner = lookupTurn(r.id);
    if (!owner || !owner.resolveTool(r.id, r.content, r.isError)) missed.push(r.id);
    else fed += 1;
  }
  if (missed.length) {
    log.warn(`no pending tool call for result id(s): ${missed.join(", ")}`);
  }
  return fed;
}

/** String or JSON; never the string "[object Object]". */
function stringifyResult(content) {
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

export function pendingToolCalls() {
  return byToolCall.size;
}
