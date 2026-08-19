// Anthropic /v1/messages adapter: request parsing + response shaping.
//
// The relay is wire-agnostic and shared; this file is the entire Anthropic
// side of the seam. Key invariants: SSE must carry `event:` names (SDKs
// dispatch on them), tool ids echo back as `toolu_`, and the SDK's raw usage
// shape is converted only at the sink boundary.

import crypto from "node:crypto";
import { flatten as flattenOpenAi, stripBillingHeaders } from "./format.mjs";
import { ACTIVE_STREAMS } from "./stream.mjs";
import * as engine from "./relay.mjs";
import { respondError, respondJson } from "./http-helpers.mjs";
import { log } from "./logger.mjs";
import { feedResults, lookupTurn } from "./tool-relay.mjs";

const freshMsgId = () => "msg_" + crypto.randomBytes(12).toString("hex");

/** SDK usage -> Anthropic usage; the field names share nothing with the OpenAI set. */
export function toAnthropicUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    cache_read_input_tokens: u.cacheReadTokens ?? 0,
    cache_creation_input_tokens: u.cacheWriteTokens ?? 0,
  };
}

/** Wire finish reasons -> Anthropic stop_reason spellings. */
const stopReasonOf = { tool_calls: "tool_use", stop: "end_turn", length: "max_tokens" };

function blockToText(b) {
  if (typeof b === "string") return b;
  if (b?.type === "text") return b.text ?? "";
  // Images mark only their position: the SDK's prompt is plain text, and a
  // dropped block would leave a sentence with no head.
  if (b?.type === "image") return "[image]";
  if (b?.type === "tool_use") return `[calls tool ${b.name}: ${JSON.stringify(b.input ?? {})}]`;
  if (b?.type === "tool_result") {
    const tag = b.is_error ? "[tool result (error)]" : "[tool result]";
    return `${tag} ${flattenOpenAi(b.content)}`;
  }
  return "";
}

/** Anthropic content may be a plain string or a block array. */
export function flatten(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map(blockToText).filter(Boolean).join("\n");
}

function foldHistory(history) {
  if (!history.length) return [];
  const lines = history
    .map((m) => {
      const text = stripBillingHeaders(flatten(m.content));
      return text ? `${m.role === "assistant" ? "Assistant" : "User"}: ${text}` : null;
    })
    .filter(Boolean);
  return ["<conversation-so-far>", ...lines, "</conversation-so-far>", ""];
}

/**
 * Collapse the request into one prompt: the last message is the live
 * question, everything before it sits inside a wrapper tag as history.
 */
export function renderPrompt(body) {
  const sys = body?.system;
  const system = stripBillingHeaders(typeof sys === "string" ? sys : flatten(sys)).trim();
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const parts = [];
  if (system) parts.push(system, "");
  parts.push(...foldHistory(msgs.slice(0, -1)));
  parts.push(stripBillingHeaders(flatten(msgs[msgs.length - 1]?.content)));
  return parts.join("\n");
}

/** Anthropic tools[] -> protocol-neutral `{name, description, parameters}`; the schema field is input_schema. */
export function normalizeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const kept = [];
  for (const raw of tools) {
    // Server-side tools (web_search etc.) carry no input_schema and execute
    // inside Anthropic; they cannot be relayed, so skip them.
    if (!raw?.name || !raw.input_schema) continue;
    kept.push({ name: raw.name, description: raw.description ?? "", parameters: raw.input_schema });
  }
  return kept.length ? kept : null;
}

/**
 * Dig tool results out of this batch: Anthropic nests `tool_result` blocks in
 * user messages (no standalone `role:"tool"`), one level deeper than OpenAI.
 *
 * Returns null when the trailing turn carries no tool results, `{turn,
 * results, orphan: null}` when at least one id matches a live turn, and
 * `{turn: null, results, orphan: [ids]}` when trailing results exist but
 * no id is live. The caller starts a new run for the orphan case: Claude
 * Code compact/follow-up resends finished tool_result blocks, and a 400
 * aborts autocompact.
 */
function messagesAfterLastAssistant(messages) {
  let start = 0;
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      start = i + 1;
      break;
    }
  }
  return (messages ?? []).slice(start);
}

function digToolResults(messages) {
  const results = [];
  let turn = null;
  // Only the trailing user turn after the last assistant reply can resume a
  // live RelayTurn. Historical tool_result blocks in earlier user messages
  // belong to finished turns; treating them as resume 400s the next prompt.
  for (const m of messagesAfterLastAssistant(messages)) {
    if (m?.role !== "user" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block?.type !== "tool_result" || !block.tool_use_id) continue;
      results.push({
        id: block.tool_use_id,
        content: flattenOpenAi(block.content),
        isError: block.is_error === true,
      });
      turn = turn ?? lookupTurn(block.tool_use_id);
    }
  }
  if (!results.length) return null;
  return turn ? { turn, results, orphan: null } : { turn: null, results, orphan: results.map((r) => r.id) };
}

function tryJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/**
 * Streaming sink. Event order is a client state machine, do not shuffle:
 * message_start -> [content_block_start -> delta* -> content_block_stop]*
 * -> message_delta (stop_reason + usage) -> message_stop. Text blocks open on
 * demand so a bare tool call never fabricates an empty one.
 */
export class AnthropicSseWriter {
  constructor(res, { id, model }) {
    this.res = res;
    this.id = id;
    this.model = model;
    this.closed = false;
    this.blockIdx = 0;
    this.textLive = false;
    this.accum = [];
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // Proxies buffer by default; buffered turns streaming into "spinner,
      // then everything at once".
      "X-Accel-Buffering": "no",
    });
    ACTIVE_STREAMS.add(this);
    this.heartbeat = setInterval(() => {
      if (!this.closed && !res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    this.heartbeat.unref?.();
    this.#emit("message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    // Typed ping right after message_start: strict Anthropic clients and
    // proxies rely on it for keep-alive (windsurf messages.js:1102-1105).
    this.#emit("ping", { type: "ping" });
  }

  // The `event:` line is mandatory: SDKs dispatch on the name, and a
  // data-only stream fails parsing outright.
  #emit(name, obj) {
    if (this.closed) return;
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`);
  }

  role() {}

  text(t) {
    if (!t) return;
    this.accum.push(t);
    if (!this.textLive) {
      this.#emit("content_block_start", {
        type: "content_block_start", index: this.blockIdx,
        content_block: { type: "text", text: "" },
      });
      this.textLive = true;
    }
    this.#emit("content_block_delta", {
      type: "content_block_delta", index: this.blockIdx,
      delta: { type: "text_delta", text: t },
    });
  }

  #sealText() {
    if (!this.textLive) return;
    this.#emit("content_block_stop", { type: "content_block_stop", index: this.blockIdx });
    this.textLive = false;
    this.blockIdx += 1;
  }

  toolCall(_i, { id, name, args }) {
    this.#sealText();
    const input = typeof args === "string" ? tryJson(args) : (args ?? {});
    this.#emit("content_block_start", {
      type: "content_block_start", index: this.blockIdx,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    // Sending the JSON whole is a legal subset; clients concatenate slices.
    this.#emit("content_block_delta", {
      type: "content_block_delta", index: this.blockIdx,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    });
    this.#emit("content_block_stop", { type: "content_block_stop", index: this.blockIdx });
    this.blockIdx += 1;
  }

  finish(reason = "stop", usage = null) {
    if (this.closed) return;
    this.#sealText();
    const u = toAnthropicUsage(usage);
    // input_tokens repeats here although message_start carries the field: the
    // start event fires before the SDK reports usage, so it can only hold a 0
    // placeholder — the real value must ride the final delta for usage-billing
    // downstreams. The full conversion rides along too: cache_read and
    // cache_creation are dropped nowhere (k2cc bills on them).
    this.#emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReasonOf[reason] ?? "end_turn", stop_sequence: null },
      usage: u,
    });
    this.#emit("message_stop", { type: "message_stop" });
    this.res.end();
    this.closed = true;
    clearInterval(this.heartbeat);
    ACTIVE_STREAMS.delete(this);
  }

  /**
   * Error mid-stream: close any open block, then `event: error`
   * (Anthropic shape, windsurf messages.js:1434-1450) — never text-mixed,
   * and never followed by message_stop.
   */
  fail(message) {
    if (this.closed) return;
    this.#sealText();
    this.#emit("error", { type: "error", error: { type: "upstream_error", message: String(message) } });
    this.res.end();
    this.closed = true;
    clearInterval(this.heartbeat);
    ACTIVE_STREAMS.delete(this);
  }
}

/** Non-streaming twin of AnthropicSseWriter: collect instead of send. */
export class AnthropicCollectSink {
  constructor() {
    this.accum = [];
    this.toolUses = [];
    this.finishReason = null;
    this.usage = null;
    this.closed = false;
  }

  role() {}
  text(t) { if (t) this.accum.push(t); }
  toolCall(_i, c) { this.toolUses.push(c); }

  finish(reason, usage) {
    this.finishReason = reason;
    this.usage = toAnthropicUsage(usage);
    this.closed = true;
  }

  /** Non-streaming twin: the error rides along as content (no frame concept here). */
  fail(msg) {
    this.text(`\n[cursorapi] ${msg}\n`);
    this.finish("stop");
  }

  get content() { return this.accum.join(""); }
}

function assembleBlocks(content, toolUses) {
  const blocks = [];
  if (content) blocks.push({ type: "text", text: content });
  for (const t of toolUses ?? []) {
    blocks.push({
      type: "tool_use", id: t.id, name: t.name,
      input: typeof t.args === "string" ? tryJson(t.args) : (t.args ?? {}),
    });
  }
  // An empty content array is fatal for some clients; keep at least one block.
  if (!blocks.length) blocks.push({ type: "text", text: "" });
  return blocks;
}

export function nonStreamBody({ id, model, content, toolCalls, finishReason, usage }) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: assembleBlocks(content, toolCalls),
    stop_reason: stopReasonOf[finishReason] ?? "end_turn",
    stop_sequence: null,
    usage: usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}

const adapter = {
  // Clients echo tool_use.id back as tool_result.tool_use_id; `call_`-style
  // ids can look like anomalous data to strict implementations.
  callIdPrefix: "toolu_",

  parse(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (!messages.length) return { error: "messages must not be empty", status: 400 };
    if (!body?.model) return { error: "model must not be empty", status: 400 };

    if (body?.thinking?.type === "enabled") {
      log.info(
        `client requested extended thinking (budget ${body.thinking.budget_tokens ?? "?"} tokens); `
        + "the upstream has no thinking support, silently disabling",
      );
    }

    const resume = digToolResults(messages);
    if (resume && !resume.turn) {
      // Stale tool_result after the last assistant (compaction, follow-up, or
      // an already-finished turn). 400 here aborts Claude Code auto-compact
      // and surfaces as "Prompt is too long · automatic compaction failed".
      // Start a new run with the folded prompt instead of resume.
      log.warn(`stale tool_result id(s) ${resume.orphan.join(", ")}; starting a new run`);
    }

    return {
      stream: body?.stream === true,
      id: freshMsgId(),
      publicModel: body.model,
      prompt: renderPrompt(body),
      tools: normalizeTools(body.tools),
      resume: resume && resume.turn ? { turn: resume.turn, results: resume.results } : null,
    };
  },

  makeSink(res, { stream, id, model }) {
    return stream ? new AnthropicSseWriter(res, { id, model }) : new AnthropicCollectSink();
  },

  feed: feedResults,

  finishNonStream(res, sink, { id, model }) {
    respondJson(res, 200, nonStreamBody({
      id,
      model,
      content: sink.content,
      toolCalls: sink.toolUses.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      finishReason: sink.finishReason ?? "stop",
      usage: sink.usage,
    }));
  },
};

/** Anthropic-style error body; its shape differs from OpenAI's and clients parse this one. */
function errorBody(status, message) {
  return {
    type: "error",
    error: {
      type:
        status === 400 ? "invalid_request_error"
        : status === 401 ? "authentication_error"
        : status === 429 ? "rate_limit_error"
        : status === 503 ? "service_unavailable"
        : "api_error",
      message: `[cursorapi] ${message}`,
    },
  };
}

/** POST /v1/messages */
export function handleMessages(body, res) {
  return engine.handle(adapter, body, res, {
    respondError: (r, status, message) => respondJson(r, status, errorBody(status, message)),
  });
}

export { respondError };
