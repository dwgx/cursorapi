// Message formatting: content flattening, prompt assembly, usage mapping.
// This is the relay's only data transformation — flatten it wrong and the
// model answers wrong.
import assert from "node:assert/strict";
import { flatten, renderPrompt, toOpenAiUsage } from "./src/format.mjs";

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

// ── flatten: content shapes ─────────────────────────────
test("flatten: strings, block arrays, and null pass through", () => {
  assert.equal(flatten("hello"), "hello");
  assert.equal(flatten([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(flatten(null), "");
});

test("flatten: multimodal content marks the image position", () => {
  // The SDK prompt is plain text; marking the spot beats dropping the image
  // block, which would leave the model a headless sentence.
  assert.equal(
    flatten([{ type: "text", text: "look at this" }, { type: "image_url", image_url: {} }]),
    "look at this[image]",
  );
});

// ── renderPrompt: history vs. current instruction ───────
test("renderPrompt: system first, history wrapped, current question last", () => {
  // Unseparated, the model cannot tell history from the live instruction
  // and tends to answer old questions from the history.
  const p = renderPrompt([
    { role: "system", content: "be concise" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "the question now" },
  ]);
  assert.ok(p.startsWith("be concise"), "system goes first");
  assert.ok(p.includes("<conversation-so-far>"), "history needs its wrapper marker");
  assert.ok(p.includes("User: first question"), "history keeps the user turns");
  assert.ok(p.includes("Assistant: first answer"), "history keeps the assistant turns");
  assert.ok(p.trimEnd().endsWith("the question now"), "the current question sits at the very end");
  assert.ok(!p.includes("<conversation-so-far>\nUser: the question now"), "the current question must not count as history");
});

test("renderPrompt: a single message gets no empty history block", () => {
  const single = renderPrompt([{ role: "user", content: "just one line" }]);
  assert.ok(!single.includes("conversation-so-far"), "no wrapper when there is no history");
  assert.equal(single.trim(), "just one line");
});

test("renderPrompt: strips Claude Code's per-request billing header line", () => {
  // `cch=` changes every request; verbatim into the prompt it busts the
  // upstream prompt cache on every turn.
  const p = renderPrompt([
    { role: "system", content: "x-anthropic-billing-header: cc_version=2026-08-13; cch=xyz\nbe concise" },
    { role: "user", content: "hi" },
  ]);
  assert.ok(!p.includes("x-anthropic-billing-header"), "the billing line must not reach the prompt");
  assert.ok(p.includes("be concise"), "the rest of the system text survives");
});

test("renderPrompt: tool results are labeled in history", () => {
  // Unlabeled, the model thinks the user said them.
  const withTool = renderPrompt([
    { role: "user", content: "list the dir" },
    { role: "assistant", content: "" },
    { role: "tool", tool_call_id: "x", content: "a.txt b.txt" },
    { role: "user", content: "how many files" },
  ]);
  assert.ok(withTool.includes("ToolResult: a.txt b.txt"), "tool output must be identified as such");
});

// ── toOpenAiUsage: SDK usage -> OpenAI wire shape ───────
test("toOpenAiUsage: null stays null", () => {
  assert.equal(toOpenAiUsage(null), null);
});

test("toOpenAiUsage: maps fields and computes a missing total", () => {
  const u = toOpenAiUsage({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 7 });
  assert.equal(u.prompt_tokens, 10);
  assert.equal(u.completion_tokens, 3);
  assert.equal(u.total_tokens, 13, "when the SDK gives no total, compute it — never send undefined");
  assert.equal(u.prompt_tokens_details.cached_tokens, 7);
});

test("toOpenAiUsage: cache creation rides along in prompt_tokens_details", () => {
  const u = toOpenAiUsage({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 5 });
  assert.equal(u.prompt_tokens_details.cached_tokens, 7);
  assert.equal(u.prompt_tokens_details.cache_creation_input_tokens, 5, "cache writes must not vanish from the wire");
});

await run();
if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`message formatting: all passed (${passed.length} tests)`);
