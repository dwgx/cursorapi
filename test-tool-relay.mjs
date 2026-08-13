// Tool relay: which tools get registered, which get blocked, which get
// skipped. Guards both ends — a blocked-but-should-pass tool silently costs
// extra money; a passed-but-should-block tool leaves the agent unable to
// work.
import assert from "node:assert/strict";
import { RelayTurn, buildCustomTools, feedResults } from "./src/tool-relay.mjs";

const tests = [];
const passed = [];
const failed = [];
function test(name, fn) {
  tests.push({ name, fn });
}
async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed.push(name);
    } catch (e) {
      failed.push({ name, error: e });
    }
  }
}

// buildCustomTools eats the protocol-neutral shape; converting each protocol
// into that shape is the adapters' job (see test-protocol.mjs). This layer
// must not know that OpenAI calls the schema `parameters` while Anthropic
// calls it `input_schema`.
const tool = (name) => ({ name, description: "", parameters: { type: "object", properties: {} } });
const names = (list) => Object.keys(buildCustomTools(list, new RelayTurn()));

// ── registration and blocking ───────────────────────────
test("registration: every normal tool registers — none may be lost", () => {
  const keep = [
    "read_file", "list_dir", "grep", "codebase_search", "run_terminal_cmd",
    "edit_file", "write", "todo_write", "web_search", "delete_file",
    // Names containing task/agent that do NOT spawn new conversations must
    // not be collateral damage.
    "agentic_search", "list_tasks", "delegate_review",
  ];
  assert.deepEqual(names(keep.map((n) => tool(n))), keep);
});

test("blocking: subagent spawners are rejected", () => {
  // Turns are billed anyway, but 5 subagents in one turn is 6 billings, and
  // the client cannot see where the money went.
  for (const n of ["Task", "task", "subagent", "spawn_agent", "launchAgent",
                   "create_agent", "run_agent", "dispatch_agent",
                   "best_of_n_runner", "best-of-n-runner"]) {
    assert.deepEqual(names([tool(n)]), [], `${n} must be blocked`);
  }
});

test("blocking: spawners are rejected even among normal tools", () => {
  assert.deepEqual(names([tool("read_file"), tool("Task"), tool("grep")]), ["read_file", "grep"]);
});

test("skipping: nameless entries are skipped, never crash", () => {
  assert.deepEqual(names([tool("read_file"), {}, { description: "nameless" }, tool("grep")]),
    ["read_file", "grep"]);
});

// ── tool results: resolving the pending call ────────────
test("results: a pending call resolves with the client's answer", async () => {
  const turn = new RelayTurn();
  const tools = buildCustomTools([tool("read_file")], turn);
  // execute doesn't actually run; it suspends waiting for the client's result.
  const pending = tools.read_file.execute({ path: "/x" });
  assert.equal(turn.waiting, true, "after the call the turn must be waiting");

  const callId = [...turn.pending.keys()][0];
  assert.match(callId, /^call_/, "the default prefix is the OpenAI set");

  assert.equal(feedResults(turn, [{ id: callId, content: "file content" }]), 1);
  assert.equal(await pending, "file content", "the returned result must reach the agent verbatim");
  assert.equal(turn.waiting, false);
});

test("results: a wrong id never resolves the pending call", () => {
  // That would hand A's result to B.
  const turn = new RelayTurn();
  buildCustomTools([tool("read_file")], turn).read_file.execute({ path: "/x" });
  assert.equal(feedResults(turn, [{ id: "call_nonexistent", content: "x" }]), 0);
  assert.equal(turn.waiting, true, "the call stays suspended");
});

test("results: non-string results serialize to JSON", async () => {
  // Never feed [object Object] to the model.
  const turn2 = new RelayTurn();
  const t2 = buildCustomTools([tool("read_file")], turn2);
  const p2 = t2.read_file.execute({});
  const id2 = [...turn2.pending.keys()][0];
  feedResults(turn2, [{ id: id2, content: { a: 1 } }]);
  assert.equal(await p2, '{"a":1}');
});

// ── call-id prefix ──────────────────────────────────────
test("prefix: the call-id prefix is switchable per protocol", () => {
  // Anthropic clients echo tool_use.id back verbatim as
  // tool_result.tool_use_id; `call_`-prefixed ids can be treated as
  // anomalous data.
  const turnA = new RelayTurn();
  turnA.callIdPrefix = "toolu_";
  buildCustomTools([tool("read_file")], turnA).read_file.execute({});
  assert.match([...turnA.pending.keys()][0], /^toolu_/);
});

// ── usage and errors ────────────────────────────────────
test("usage: the sink receives the SDK's raw usage, unconverted", async () => {
  // Format conversion is the sink's job (it knows the wire format). It used
  // to convert to the OpenAI shape in the engine; the Anthropic endpoint
  // exposed the bug: that side wants input_tokens, so one of the two was
  // forever empty — never errored, just blank stat columns.
  const turn3 = new RelayTurn();
  const captured = { usage: undefined };
  const fakeSink = {
    closed: false, parts: [],
    role() {}, text() {}, toolCall() {},
    finish(_reason, usage) { captured.usage = usage; this.closed = true; },
  };
  turn3.attach(fakeSink);
  turn3.usage = { inputTokens: 11296, outputTokens: 68, totalTokens: 19785, cacheReadTokens: 8421 };
  // Run the full wrap-up path (consume's finally closes the sink).
  await turn3.consume({
    async *stream() {},
    async wait() { return { status: "finished", result: "" }; },
  });

  assert.equal(captured.usage.inputTokens, 11296, "the relay must not convert formats here");
  assert.equal(captured.usage.prompt_tokens, undefined, "conversion is the sink's job");
  assert.equal(turn3.usage.inputTokens, 11296, "accounting uses the raw shape too");
});

test("errors: upstream error objects serialize, never [object Object]", async () => {
  // Regression: the SDK's `result.error` is measured to be an object;
  // string concatenation turns it into `run error: [object Object]`. 98
  // consecutive production failures on 2026-08-12, every log line like
  // that — the only diagnostic clue erased.
  const { describe } = await import("./src/logger.mjs");
  assert.equal(describe({ code: "quota_exceeded", detail: "no quota left" }),
    '{"code":"quota_exceeded","detail":"no quota left"}');
  assert.equal(describe(new Error("boom")), "boom");
  assert.equal(describe("already a string"), "already a string");
  assert.equal(describe(null), "null");
  const circular = { a: 1 }; circular.self = circular;
  assert.ok(describe(circular).length > 0, "circular refs must not take the logging down");
});

test("errors: a run failure surfaces the upstream's reason", async () => {
  const turn4 = new RelayTurn();
  await turn4.consume({
    async *stream() {},
    async wait() { return { status: "error", error: { code: "rate_limited", retryAfter: 30 } }; },
  });
  assert.ok(!turn4.error.includes("[object Object]"), `error info was swallowed: ${turn4.error}`);
  assert.match(turn4.error, /rate_limited/, "the upstream's reason must be visible");
});

// ── parallel tool calls ─────────────────────────────────
test("parallel: cached while the sink is closed, replayed on attach", async () => {
  // Regression: Cursor's agent emits several parallel tool_use at once
  // (Claude Code's concurrent subagents are three or four at a time). After
  // the first flush closes the sink, later arrivals dropped outright would
  // show the client "connection interrupted". Correct behaviour: cache and
  // replay when the client's next request attaches.
  const turn5 = new RelayTurn();
  const sent5 = [];
  const fakeSink5a = { text() {}, finish() {}, toolCall(i, c) { sent5.push(c); } };
  const fakeSink5b = { text() {}, finish() {}, toolCall(i, c) { sent5.push(c); } };
  turn5.attach(fakeSink5a);
  // First call: sink open -> batched out after 80ms and closed.
  const q1 = turn5.delegate("agent_a", { prompt: "task 1" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sent5.length, 1, "the first call must go out normally");
  assert.equal(sent5[0].name, "agent_a");
  assert.equal(turn5.sink, null, "after the flush the sink closes (waiting for the client to run and return)");
  // Sink closed, the model emits two more parallel calls -> must cache, not
  // reject.
  const q2 = turn5.delegate("agent_b", { prompt: "task 2" });
  const q3 = turn5.delegate("agent_c", { prompt: "task 3" });
  await new Promise((r) => setTimeout(r, 150));
  const settled = await Promise.race([
    Promise.allSettled([q2, q3]).then(() => "settled"),
    new Promise((r) => setTimeout(() => r("timeout"), 300)),
  ]);
  assert.equal(settled, "timeout", "with the sink closed, parallel calls must stay suspended, never reject");
  // The client's next request (returning tool results) attaches -> replay
  // the cache.
  turn5.attach(fakeSink5b);
  await new Promise((r) => setTimeout(r, 30));
  const deferred = sent5.slice(1);
  assert.equal(deferred.length, 2, "attaching must replay the cached parallel calls");
  assert.equal(deferred[0].name, "agent_b");
  assert.equal(deferred[1].name, "agent_c");
  assert.equal(turn5.sink, null, "after the replay the sink closes again, waiting for results");
  assert.ok(q2 instanceof Promise && q3 instanceof Promise, "the replay doesn't change the suspended semantics");
});

// ── description fallback ────────────────────────────────
test("description: empty descriptions distill from the schema", () => {
  const turn6 = new RelayTurn();
  const ct = buildCustomTools([
    { name: "no_desc", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    { name: "with_desc", description: "original description", parameters: { type: "object", properties: {} } },
  ], turn6);
  assert.ok(ct.no_desc.description.length > 5, "empty descriptions need a generated summary");
  assert.match(ct.no_desc.description, /file_path/, "the summary must include required param names");
  assert.equal(ct.with_desc.description, "original description", "a given description stays verbatim");
});

test("description: non-string, blank and oversized descriptions are covered", () => {
  const turn = new RelayTurn();
  const ct = buildCustomTools([
    { name: "num_desc", description: 42, parameters: { type: "object", properties: { a: {} } } },
    { name: "blank_desc", description: "   \n\t ", parameters: { type: "object", properties: { b: {} } } },
    { name: "long_desc", description: "x".repeat(12000), parameters: { type: "object", properties: {} } },
    { name: "emoji_desc", description: "a".repeat(9999) + "\ud83d\ude00tail", parameters: { type: "object", properties: {} } },
  ], turn);
  assert.equal(ct.num_desc.description, "call a client-provided tool (params: a)", "non-string descriptions fall back to the schema summary");
  assert.equal(ct.blank_desc.description, "call a client-provided tool (params: b)", "whitespace-only descriptions fall back too");
  assert.equal(ct.long_desc.description.length, 10000, "oversized descriptions are truncated");
  assert.equal(ct.emoji_desc.description, "a".repeat(9999),
    "the truncation must not split a surrogate pair");
});

// ── schema normalization ────────────────────────────────
test("schema: client schemas are normalized for the SDK", () => {
  const turn = new RelayTurn();
  const ct = buildCustomTools([
    {
      name: "messy",
      parameters: {
        $schema: "http://json-schema.org/draft-07/schema#",
        required: "file_path", // not an array
        properties: null,
        additionalProperties: "no", // string, not bool/schema
      },
    },
    {
      name: "nested",
      parameters: {
        type: "object",
        required: ["top", 42, ""],
        properties: {
          file_path: { type: "string", required: "x", additionalProperties: "no" },
          opts: { type: "object", properties: null },
        },
      },
    },
  ], turn);

  const messy = ct.messy.inputSchema;
  assert.deepEqual(messy.required, [], "non-array required becomes an empty array");
  assert.deepEqual(messy.properties, {}, "null properties become an empty object");
  assert.equal(messy.type, "object", "a missing type defaults to object");
  assert.equal(messy.additionalProperties, true, "a non-bool/object additionalProperties becomes true");
  assert.equal(messy.$schema, undefined, "the $schema artifact is dropped");

  const nested = ct.nested.inputSchema;
  assert.deepEqual(nested.required, ["top", ""], "non-string required entries are filtered");
  assert.deepEqual(nested.properties.file_path.required, [], "property schemas are normalized too");
  assert.equal(nested.properties.file_path.additionalProperties, true);
  assert.deepEqual(nested.properties.opts.properties, {}, "null properties inside a property schema are fixed");
});

// ── isError channel ────────────────────────────────────
test("results: an error result resolves as {content, isError} for the SDK", async () => {
  // The SDK's result normalizer forwards execute()'s {content, isError}
  // shape to the model; fed back as plain text, the model keeps reasoning
  // on a failure it thinks succeeded.
  const turn = new RelayTurn();
  const tools = buildCustomTools([tool("read_file")], turn);
  const pending = tools.read_file.execute({ path: "/x" });
  const callId = [...turn.pending.keys()][0];
  assert.equal(feedResults(turn, [{ id: callId, content: "permission denied", isError: true }]), 1);
  assert.deepEqual(await pending,
    { content: [{ type: "text", text: "permission denied" }], isError: true });
  assert.equal(turn.waiting, false);
});

test("results: an error result with non-string content serializes to JSON", async () => {
  const turn = new RelayTurn();
  const tools = buildCustomTools([tool("edit_file")], turn);
  const pending = tools.edit_file.execute({});
  const callId = [...turn.pending.keys()][0];
  feedResults(turn, [{ id: callId, content: { code: 42 }, isError: true }]);
  assert.deepEqual(await pending,
    { content: [{ type: "text", text: '{"code":42}' }], isError: true });
});

// ── cross-turn mixed batches ────────────────────────────
test("results: a mixed batch dispatches each id to its own turn", async () => {
  // Two turns with tool calls in flight, results for both batched into one
  // follow-up request. The old code fed everything into the first id's turn
  // and silently dropped the second turn's results (its promise hung until
  // the timeout).
  const turnA = new RelayTurn();
  const turnB = new RelayTurn();
  const ta = buildCustomTools([tool("read_file")], turnA);
  const tb = buildCustomTools([tool("grep")], turnB);
  const pa = ta.read_file.execute({});
  const pb = tb.grep.execute({});
  const idA = [...turnA.pending.keys()][0];
  const idB = [...turnB.pending.keys()][0];

  assert.equal(feedResults(turnA, [
    { id: idA, content: "from A" },
    { id: idB, content: "from B" },
  ]), 2);
  assert.equal(await pa, "from A");
  assert.equal(await pb, "from B", "each result must reach its own turn, not the caller's");
  assert.equal(turnA.waiting, false);
  assert.equal(turnB.waiting, false);
});

test("results: an orphan id is reported, never silently dropped", () => {
  const turn = new RelayTurn();
  const tools = buildCustomTools([tool("read_file")], turn);
  const pending = tools.read_file.execute({});
  const callId = [...turn.pending.keys()][0];
  assert.equal(feedResults(turn, [{ id: "call_unknown-orphan", content: "x" }]), 0,
    "an id with no pending call feeds nothing");
  assert.equal(turn.waiting, true, "the real call stays suspended");
  feedResults(turn, [{ id: callId, content: "real" }]);
  return pending.then((v) => assert.equal(v, "real", "the real id still resolves afterwards"));
});

// ── dead turns ─────────────────────────────────────────
test("dead turn: attach after the run finished never replays parked calls", async () => {
  const turn = new RelayTurn();
  const sinkA = { text() {}, finish() {}, toolCall() {} };
  turn.attach(sinkA);
  const qA = turn.delegate("agent_a", {});
  await new Promise((r) => setTimeout(r, 150)); // flushed, sink closed
  const qB = turn.delegate("agent_b", {}); // parked (sink closed)
  // The run ends while calls are parked.
  await turn.consume({
    async *stream() {},
    async wait() { return { status: "finished", result: "" }; },
  });
  assert.equal(turn.finished, true);
  // consume's finally rejects every pending call ("run ended"); swallow the
  // rejections the way the SDK's executor would.
  await Promise.allSettled([qA, qB]);

  let replayed = 0;
  let sealed = false;
  const sinkB = { text() {}, finish() { sealed = true; }, toolCall() { replayed += 1; } };
  const end = turn.attach(sinkB);
  assert.equal(replayed, 0, "a dead turn must not replay stale calls into a fresh response");
  assert.equal(sealed, true, "the dead turn's sink is sealed immediately");
  assert.equal(turn.sink, null);
  const settled = await Promise.race([
    end.then(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), 50)),
  ]);
  assert.equal(settled, "pending", "the attach promise never resolves: no more output will come");
});

// ── SDK call-id diagnostics ─────────────────────────────
test("toolCallId: the SDK's call id is recorded on the pending call", () => {
  const turn = new RelayTurn();
  const tools = buildCustomTools([tool("read_file")], turn);
  tools.read_file.execute({}, { toolCallId: "call_sdk-abc123" });
  const rec = [...turn.pending.values()][0];
  assert.equal(rec.toolCallId, "call_sdk-abc123", "the SDK-side id rides along for diagnostics");
  assert.equal(rec.name, "read_file");
});

await run();
if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`tool relay: all passed (${passed.length} tests)`);
