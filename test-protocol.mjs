// The two protocol adapters: tool normalization, usage field names, wire
// format. All the difference between OpenAI and Anthropic lives in this
// layer — a missed fix never errors, it silently emits wrong data.
import assert from "node:assert/strict";
import * as A from "./src/anthropic.mjs";
import { normalizeTools as oaiTools, handleChat } from "./src/openai.mjs";
import { recentLogs } from "./src/logger.mjs";

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

// ── tool normalization ──────────────────────────────────
// The two schema field names differ: OpenAI puts it in function.parameters,
// Anthropic in input_schema. Both must end up protocol-neutral.
const schema = { type: "object", properties: { p: { type: "string" } } };

test("normalizeTools: OpenAI function shape", () => {
  assert.deepEqual(
    oaiTools([{ type: "function", function: { name: "read_file", description: "read", parameters: schema } }]),
    [{ name: "read_file", description: "read", parameters: schema }],
  );
});

test("normalizeTools: Anthropic input_schema shape", () => {
  assert.deepEqual(
    A.normalizeTools([{ name: "read_file", description: "read", input_schema: schema }]),
    [{ name: "read_file", description: "read", parameters: schema }],
  );
});

test("normalizeTools: skips non-function entries on both sides", () => {
  // Codex's type:"custom", Anthropic's native server tools: the SDK's
  // customTools only eat the function shape; a mixed-in stranger would blow
  // up at registration.
  assert.deepEqual(
    oaiTools([
      { type: "function", function: { name: "grep", parameters: schema } },
      { type: "custom", name: "apply_patch" },
      { type: "web_search_20250305", name: "web_search" },
    ]).map((t) => t.name),
    ["grep"],
  );
  // The Anthropic-side equivalent is "no input_schema" — server-side tools
  // Anthropic executes itself and cannot be relayed.
  assert.deepEqual(
    A.normalizeTools([
      { name: "grep", input_schema: schema },
      { type: "web_search_20250305", name: "web_search" },
    ]).map((t) => t.name),
    ["grep"],
  );
});

test("normalizeTools: empty or undefined -> null, not an empty array", () => {
  assert.equal(oaiTools([]), null, "the relay tests truthiness on the result");
  assert.equal(A.normalizeTools(undefined), null);
});

// ── usage field names: two completely different sets ────
const sdkUsage = { inputTokens: 11296, outputTokens: 68, totalTokens: 19785, cacheReadTokens: 8421 };
const au = A.toAnthropicUsage(sdkUsage);

test("usage: Anthropic field names only — no OpenAI names leak through", () => {
  // Regression: a wrong field name never errors; it just leaves the
  // client's stats columns permanently empty. And k2cc bills from the
  // upstream-reported usage, so a wrong name means the ledger is all zeros.
  assert.equal(au.input_tokens, 11296);
  assert.equal(au.output_tokens, 68);
  assert.equal(au.cache_read_input_tokens, 8421);
  assert.equal(au.prompt_tokens, undefined, "don't leak OpenAI field names in here");
});

test("usage: null -> structurally complete zeros, never null", () => {
  // Clients read .output_tokens directly.
  assert.deepEqual(A.toAnthropicUsage(null), { input_tokens: 0, output_tokens: 0 });
});

test("usage: cache_creation_input_tokens comes from the SDK's cacheWriteTokens", () => {
  const u = A.toAnthropicUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
  assert.equal(u.cache_creation_input_tokens, 4);
  assert.equal(u.cache_read_input_tokens, 3);
  // Missing cache write counts as 0, never undefined.
  assert.equal(A.toAnthropicUsage({ inputTokens: 1, outputTokens: 2 }).cache_creation_input_tokens, 0);
});

// ── Anthropic: prompt flattening ────────────────────────
test("renderPrompt: system first, history wrapped, current question last", () => {
  // system is a standalone field (not a message like OpenAI), and history
  // goes inside the wrapper marker, or the model can't tell current
  // instruction from history.
  const prompt = A.renderPrompt({
    system: "you are an assistant",
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: [{ type: "text", text: "second question" }] },
    ],
  });
  assert.match(prompt, /^you are an assistant/);
  assert.match(prompt, /<conversation-so-far>[\s\S]*User: first question[\s\S]*Assistant: first answer[\s\S]*<\/conversation-so-far>/);
  assert.match(prompt, /second question\s*$/, "the last message sits alone at the end");
});

test("renderPrompt: system can also be a block array", () => {
  assert.match(A.renderPrompt({ system: [{ type: "text", text: "block form" }], messages: [{ role: "user", content: "x" }] }),
    /^block form/);
});

test("renderPrompt: strips Claude Code's per-request billing header line", () => {
  // `cch=` changes every request; pasted into the prompt it busts the
  // upstream prompt cache on every turn (5-10x cost). Only that line goes —
  // the rest of the system text must survive.
  const prompt = A.renderPrompt({
    system: "x-anthropic-billing-header: cc_version=2026-08-13; cch=abc123\nbe an assistant",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.ok(!prompt.includes("x-anthropic-billing-header"), "the billing line must not reach the prompt");
  assert.ok(prompt.includes("be an assistant"), "the rest of the system text survives");
});

test("renderPrompt: billing header stripped from history folds too", () => {
  const prompt = A.renderPrompt({
    system: "sys",
    messages: [
      { role: "user", content: "x-anthropic-billing-header: cch=old\nfirst question" },
      { role: "user", content: "second question" },
    ],
  });
  assert.ok(!prompt.includes("x-anthropic-billing-header"));
  assert.ok(prompt.includes("first question"));
});

test("flatten: images are marked, never dropped", () => {
  // Dropping leaves the model with a headless sentence.
  assert.match(A.flatten([{ type: "image", source: {} }, { type: "text", text: "what is this" }]), /\[image\][\s\S]*what is this/);
});

test("flatten: tool_use / tool_result stay readable in history", () => {
  // Otherwise multi-round tool conversations lose their context.
  const hist = A.flatten([
    { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "/a" } },
  ]);
  assert.match(hist, /read_file/);
  assert.match(hist, /\/a/);
  assert.match(A.flatten([{ type: "tool_result", tool_use_id: "toolu_1", content: "file content" }]), /file content/);
});

// ── Anthropic: non-streaming response body ──────────────
test("nonStreamBody: message shape and stop_reason mapping", () => {
  const body = A.nonStreamBody({
    id: "msg_x", model: "claude-opus-5", content: "answer",
    toolCalls: [{ id: "toolu_a", name: "read_file", args: '{"path":"/x"}' }],
    finishReason: "tool_calls",
    usage: au,
  });
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.equal(body.stop_reason, "tool_use", "tool_calls must map to Anthropic's tool_use");
  assert.deepEqual(body.content[0], { type: "text", text: "answer" });
  assert.equal(body.content[1].type, "tool_use");
  assert.equal(body.usage.input_tokens, 11296);
});

test("nonStreamBody: string args parse to an object", () => {
  const body = A.nonStreamBody({
    id: "msg_x", model: "x", content: "answer",
    toolCalls: [{ id: "toolu_a", name: "read_file", args: '{"path":"/x"}' }],
    finishReason: "tool_calls",
    usage: au,
  });
  assert.deepEqual(body.content[1].input, { path: "/x" }, "Anthropic's input is an object");
});

test("nonStreamBody: content never empty, plain stop -> end_turn", () => {
  // Many clients assume at least one block.
  assert.equal(A.nonStreamBody({ id: "m", model: "x", content: "", toolCalls: [], finishReason: "stop" })
    .content.length, 1);
  assert.equal(A.nonStreamBody({ id: "m", model: "x", content: "answer", finishReason: "stop" }).stop_reason, "end_turn");
});

// ── Anthropic: SSE event sequence ───────────────────────
// The client is a state machine; a wrong order fails parsing outright. And
// the `event:` line is mandatory — the OpenAI set only has `data:`, and
// copy-pasting that makes the official SDK receive a stream of untyped
// events.
function fakeRes() {
  const chunks = [];
  return {
    chunks,
    writeHead() {},
    write(s) { chunks.push(s); },
    end() { this.ended = true; },
    get raw() { return chunks.join(""); },
    get events() {
      return chunks
        .join("")
        .split("\n\n")
        .filter(Boolean)
        .map((block) => {
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          return { ev, data: data ? JSON.parse(data) : null };
        });
    },
  };
}

test("SSE: exact event sequence, every event with its event: line", () => {
  const res = fakeRes();
  const w = new A.AnthropicSseWriter(res, { id: "msg_1", model: "claude-opus-5" });
  w.text("hel");
  w.text("lo");
  w.toolCall(0, { id: "toolu_1", name: "read_file", args: { path: "/x" } });
  w.finish("tool_calls", sdkUsage);

  const seq = res.events.map((e) => e.ev);
  assert.deepEqual(seq, [
    "message_start",
    "ping",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ], "a wrong event order fails client parsing");
  assert.ok(res.raw.startsWith("event: message_start\ndata: {"), "every event needs its event: line");
});

test("SSE: text and tool payloads carry their content", () => {
  const res = fakeRes();
  const w = new A.AnthropicSseWriter(res, { id: "msg_1", model: "claude-opus-5" });
  w.text("hel");
  w.text("lo");
  w.toolCall(0, { id: "toolu_1", name: "read_file", args: { path: "/x" } });
  w.finish("tool_calls", sdkUsage);

  assert.equal(res.events[0].data.message.role, "assistant");
  assert.equal(res.events[3].data.delta.text, "hel");
  assert.equal(res.events[6].data.content_block.type, "tool_use");
  assert.equal(res.events[6].data.content_block.id, "toolu_1");
  assert.deepEqual(JSON.parse(res.events[7].data.delta.partial_json), { path: "/x" });
});

test("SSE: block indexes ascend — a repeat would stack blocks", () => {
  const res = fakeRes();
  const w = new A.AnthropicSseWriter(res, { id: "msg_1", model: "claude-opus-5" });
  w.text("hel");
  w.text("lo");
  w.toolCall(0, { id: "toolu_1", name: "read_file", args: { path: "/x" } });
  w.finish("tool_calls", sdkUsage);

  assert.equal(res.events[2].data.index, 0);
  assert.equal(res.events[6].data.index, 1);
});

test("SSE: usage is billed in message_delta — inputs too", () => {
  const res = fakeRes();
  const w = new A.AnthropicSseWriter(res, { id: "msg_1", model: "claude-opus-5" });
  w.text("hel");
  w.toolCall(0, { id: "toolu_1", name: "read_file", args: { path: "/x" } });
  w.finish("tool_calls", sdkUsage);

  const last = res.events[res.events.length - 2];
  assert.equal(last.ev, "message_delta");
  assert.equal(last.data.delta.stop_reason, "tool_use");
  assert.equal(last.data.usage.output_tokens, 68, "output tokens must be reported here — k2cc bills on them");
  // message_start fires before any usage exists, so it can only hold a 0
  // placeholder; given only there, a usage-billing downstream sees inputs
  // as zero. Caught in shadow testing on 2026-08-12: that streamed
  // transaction recorded input=0 output=6.
  assert.equal(last.data.usage.input_tokens, 11296, "inputs must be reported at stream end too");
  assert.equal(res.events[0].data.message.usage.input_tokens, 0, "message_start genuinely doesn't know yet; the 0 placeholder is correct");
});

test("SSE: message_delta carries cache_read and cache_creation — nothing dropped", () => {
  const res = fakeRes();
  const w = new A.AnthropicSseWriter(res, { id: "msg_1", model: "claude-opus-5" });
  w.text("hi");
  w.finish("stop", { ...sdkUsage, cacheWriteTokens: 321 });
  const last = res.events[res.events.length - 2];
  assert.equal(last.ev, "message_delta");
  assert.equal(last.data.usage.cache_read_input_tokens, 8421, "cache read must ride the stream delta");
  assert.equal(last.data.usage.cache_creation_input_tokens, 321, "cache creation must ride the stream delta");
});

test("SSE: the connection actually closes", () => {
  const res = fakeRes();
  const w = new A.AnthropicSseWriter(res, { id: "msg_1", model: "claude-opus-5" });
  w.text("hel");
  w.finish("stop", sdkUsage);
  assert.equal(res.ended, true);
});

test("SSE: tool-only stream — no fabricated empty text block", () => {
  const res2 = fakeRes();
  const w2 = new A.AnthropicSseWriter(res2, { id: "m", model: "x" });
  w2.toolCall(0, { id: "toolu_2", name: "grep", args: {} });
  w2.finish("tool_calls", null);
  assert.deepEqual(res2.events.map((e) => e.ev), [
    "message_start", "ping", "content_block_start", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ]);
  assert.equal(res2.events[2].data.content_block.type, "tool_use");
});

test("SSE: plain-text wrap-up", () => {
  const res3 = fakeRes();
  const w3 = new A.AnthropicSseWriter(res3, { id: "m", model: "x" });
  w3.text("done");
  w3.finish("stop", sdkUsage);
  assert.deepEqual(res3.events.map((e) => e.ev), [
    "message_start", "ping", "content_block_start", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ]);
  assert.equal(res3.events[5].data.delta.stop_reason, "end_turn");
});

test("SSE: writes after finish produce nothing (double wrap-up is a protocol error)", () => {
  const res3 = fakeRes();
  const w3 = new A.AnthropicSseWriter(res3, { id: "m", model: "x" });
  w3.text("done");
  w3.finish("stop", sdkUsage);
  const before = res3.chunks.length;
  w3.text("extra");
  w3.finish("stop", null);
  assert.equal(res3.chunks.length, before);
});

// ── Anthropic: non-streaming sink converts usage too ────
test("collect sink: converts usage, keeps content", () => {
  const c = new A.AnthropicCollectSink();
  c.text("answer");
  c.finish("stop", sdkUsage);
  assert.equal(c.usage.input_tokens, 11296);
  assert.equal(c.usage.inputTokens, undefined, "the SDK's raw field names must not leak to the client");
  assert.equal(c.content, "answer");
});

// ── entry guard: orphan tool results must 400, never bill a new run ────
// A tool_result whose id matches no live turn used to be treated as a fresh
// request: new account, new run, second billing for the same turn. It must
// come back as 400 invalid_request_error so the client retries instead.
function fakeHttpRes() {
  return {
    status: 0,
    headers: null,
    body: "",
    writeHead(s, h) { this.status = s; this.headers = h; },
    end(b) { this.body = b; },
  };
}

test("entry: anthropic tool results with no matching turn -> 400 invalid_request_error", async () => {
  const res = fakeHttpRes();
  await A.handleMessages({
    model: "claude-opus-5",
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_deadbeef", content: "x" }] },
    ],
  }, res);
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /no matching pending tool call/);
});

test("entry: openai tool results with no matching turn -> 400 invalid_request_error", async () => {
  const res = fakeHttpRes();
  await handleChat({
    model: "x",
    messages: [{ role: "tool", tool_call_id: "call_deadbeef", content: "x" }],
  }, res);
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /no matching pending tool call/);
});

test("entry: a fresh request without tool results never trips the orphan guard", async () => {
  // No tool results -> no orphan check -> the request proceeds down the
  // normal path (here the empty test pool answers 502; anything but 400
  // proves the guard did not fire).
  const res = fakeHttpRes();
  await A.handleMessages({
    model: "claude-opus-5",
    messages: [{ role: "user", content: "hi" }],
  }, res);
  assert.notEqual(res.status, 400, "a clean request must not be rejected as an orphan");
  assert.equal(res.status, 502, "empty pool answers 502 before any run");
});

test("entry: thinking param is accepted and declared ignored, never an error", async () => {
  const res = fakeHttpRes();
  await A.handleMessages({
    model: "claude-opus-5",
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: [{ role: "user", content: "hi" }],
  }, res);
  assert.notEqual(res.status, 400, "requesting thinking must not be an error");
  assert.ok(
    recentLogs(50).some((e) => e.level === "info" && /extended thinking/.test(e.msg)),
    "the ignore must be declared in the log, not silent",
  );
});

await run();
if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`protocol adapters: all passed (${passed.length} tests)`);
