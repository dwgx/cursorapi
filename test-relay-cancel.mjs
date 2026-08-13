// Resource release in the relay: the SDK run must be cancelled when the
// turn dies (idle timeout / client abandonment / launch timeout), or the
// account keeps burning quota with nobody consuming. All three paths are
// exercised end-to-end through handle() against an in-memory @cursor/sdk
// (see test-relay-hook.mjs); the assertions are the SDK calls recorded in
// `mock` plus the pool's in-flight counter.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

// The hook must own "@cursor/sdk" before any SDK-dependent module is
// imported — static imports would resolve too early, so everything below
// loads dynamically. registerHooks applies synchronously (no loader-worker
// race like register()), and unlike bare specifiers a resolved file URL can
// carry a query string for the probe below.
const sdkUrl = import.meta.resolve("@cursor/sdk");
const fakeUrl = new URL("./test-relay-hook.mjs", import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(sdkUrl)) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `import { Agent, Cursor } from ${JSON.stringify(fakeUrl)}; export { Agent, Cursor };`,
    };
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// The accounts file must point at a temp dir before the pool is imported.
// One account per test: a turn that leaks on failure must not poison the
// next test's in-flight assertions.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-relay-test-"));
const accountsFile = path.join(dir, "accounts.json");
fs.writeFileSync(accountsFile, JSON.stringify(
  [{ name: "A", key: "crsr_aaa" }, { name: "B", key: "crsr_bbb" },
   { name: "C", key: "crsr_ccc" }, { name: "D", key: "crsr_ddd" }],
), "utf8");

const { config } = await import("./src/settings.mjs");
config.accountsPath = accountsFile;

const pool = await import("./src/keys.mjs");
pool.loadAccounts();

const { mock } = await import("./test-relay-hook.mjs");
const A = await import("./src/anthropic.mjs");

// Keep the suite fast: the short tests use tiny budgets, the abandonment
// window has a 30s floor.
config.turnIdleTimeoutMs = 1000;
config.maxAccountAttempts = 3;

const account = pool.all()[0];
assert.ok(account, "the fake pool must hold the test account");
const accounts = pool.all();
assert.equal(accounts.length, 4, "one account per test");
// Selection round-robins and the catalog fetch also takes a turn, so the
// account a test lands on is looked up by state, not by index.
const held = () => accounts.find((a) => a.inflight === 1) ?? null;

// AnthropicSseWriter needs a writable http response; only status matters
// for the assertions here.
function fakeRes() {
  return {
    status: 0,
    chunks: [],
    setHeader() {},
    writeHead(s) { this.status = s; },
    write(s) { this.chunks.push(s); },
    end(body) { this.ended = true; if (body !== undefined) this.chunks.push(body); },
    get raw() { return this.chunks.join(""); },
  };
}

function resetMock() {
  mock.cancels.length = 0;
  mock.runs.length = 0;
  mock.createDelayMs = 0;
  mock.fireTool = null;
  mock.lastCustomTools = null;
  mock.pendingExec = null;
}

// ── idle timeout cancels the run ───────────────────────
test("idle timeout: the run is cancelled and the account released", async () => {
  resetMock();
  const res = fakeRes();  await A.handleMessages({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }, res);
  const acc = held();
  assert.ok(acc, "the launch must hold exactly one reservation");
  assert.equal(mock.cancels.length, 1, "waitTurn's idle path must cancel the run");
  await sleep(150);
  assert.equal(acc.inflight, 0, "consume's finally must release the reservation");
});

test("idle timeout: the stream is failed, not left hanging", async () => {
  resetMock();
  const res = fakeRes();
  await A.handleMessages({
    model: "claude-opus-5",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  }, res);
  // fail() now sends a proper Anthropic error frame (no text-mixing).
  assert.match(res.raw, /event: error/, "the giving-up must arrive as an error frame");
  assert.match(res.raw, /giving up/, "the error payload must carry the reason");
  assert.equal(res.ended, true, "the response must actually end");
});

// ── tool-call abandonment (freeloading) ────────────────
test("abandonment: unanswered tool calls cancel the run after the short window", async () => {
  resetMock();
  // The fake run's first stream pull hands one tool call to the turn, as a
  // real SDK would when the model calls a customTool; the client never
  // comes back with a result.
  mock.fireTool = async () => {
    mock.pendingExec = mock.lastCustomTools.read_file.execute({});
    mock.pendingExec.catch(() => {});
  };
  const res = fakeRes();
  await A.handleMessages({
    model: "claude-opus-5",
    stream: true,
    messages: [{ role: "user", content: "read the file" }],
    tools: [{ name: "read_file", description: "read a file", input_schema: { type: "object", properties: {} } }],
  }, res);
  assert.match(res.raw, /tool_use/, "the tool call must reach the client");
  const acc = held();
  assert.ok(acc, "the launch must hold exactly one reservation");
  assert.equal(acc.inflight, 1, "the reservation stays held during the round-trip");

  // Window: min(60s, max(30s, turnIdleTimeoutMs/2)) = 30s with the test
  // budget; allow the 1s poll granularity.
  await sleep(31_500);
  assert.equal(mock.cancels.length, 1, "an abandoned turn must cancel its run");
  assert.equal(acc.inflight, 0, "the cancelled run's consume finally releases the account");
  assert.ok(acc.failures >= 1, "abandonment must be billed as a failure");
  assert.match(acc.lastError?.message ?? "", /abandoned/, "the failure reason must be recorded");
  mock.fireTool = null;
});

// The same abandonment with the configurable window shortened: the env
// override must skip the 30s floor, so the run dies in seconds, not
// minutes.
test("abandonment: a configured short window cancels the run without the 30s floor", async () => {
  try {
    process.env.CURSOR_TOOL_ABANDON_TIMEOUT_MS = "1500";
    resetMock();
    mock.fireTool = async () => {
      mock.pendingExec = mock.lastCustomTools.read_file.execute({});
      mock.pendingExec.catch(() => {});
    };
    const res = fakeRes();
    await A.handleMessages({
      model: "claude-opus-5",
      stream: true,
      messages: [{ role: "user", content: "read the file" }],
      tools: [{ name: "read_file", description: "read a file", input_schema: { type: "object", properties: {} } }],
    }, res);
    assert.match(res.raw, /tool_use/, "the tool call must reach the client");
    const acc = held();
    assert.ok(acc, "the launch must hold exactly one reservation");

    // Window 1.5s + the 1s poll granularity; nowhere near the 30s floor.
    await sleep(3000);
    assert.equal(mock.cancels.length, 1, "a shortened window must cancel the run");
    assert.equal(acc.inflight, 0, "the account must be released");
    assert.ok(acc.failures >= 1, "abandonment must be billed as a failure");
    assert.match(acc.lastError?.message ?? "", /abandoned/, "the failure reason must be recorded");
    mock.fireTool = null;
  } finally {
    delete process.env.CURSOR_TOOL_ABANDON_TIMEOUT_MS;
  }
});

// ── tool-result timeout: all pending rejected, run cancelled ──
test("tool result timeout: all pending rejected while unattached cancels the run", async () => {
  resetMock();
  const before = config.toolResultTimeoutMs;
  config.toolResultTimeoutMs = 1500; // the per-call timer, well under the 30s abandon window
  mock.fireTool = async () => {
    mock.pendingExec = mock.lastCustomTools.read_file.execute({});
    mock.pendingExec.catch(() => {});
  };
  const res = fakeRes();
  await A.handleMessages({
    model: "claude-opus-5",
    stream: true,
    messages: [{ role: "user", content: "read the file" }],
    tools: [{ name: "read_file", description: "read a file", input_schema: { type: "object", properties: {} } }],
  }, res);
  assert.match(res.raw, /tool_use/, "the tool call must reach the client");
  const acc = held();
  assert.ok(acc, "the launch must hold exactly one reservation");
  await sleep(3000);
  assert.equal(mock.cancels.length, 1, "all-pending-rejected must cancel the run");
  assert.equal(acc.inflight, 0, "the account must be released");
  assert.match(acc.lastError?.message ?? "", /timeout/, "the failure reason must be recorded");
  mock.fireTool = null;
  config.toolResultTimeoutMs = before;
});

// ── launch timeout ─────────────────────────────────────
test("launch timeout: account released, late-arriving run cancelled", async () => {
  resetMock();
  config.turnIdleTimeoutMs = 1000; // launch cap = min(60s, 2x1s) = 2s
  config.maxAccountAttempts = 1;
  mock.createDelayMs = 3000;       // the attempt lands after the cap
  const res = fakeRes();
  await A.handleMessages({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }, res);
  assert.equal(res.status, 502, "an exhausted launch loop must answer 502");
  const acc = accounts.find((a) => /timed out/.test(a.lastError?.message ?? ""));
  assert.ok(acc, "the timed-out account must carry the failure");
  assert.equal(acc.inflight, 0, "the timed-out attempt must release the reservation");
  assert.equal(mock.cancels.length, 0, "nothing to cancel yet: the attempt is still in flight");
  await sleep(1500);
  assert.equal(mock.cancels.length, 1, "a run that lands after the timeout must be cancelled, not orphaned");
  config.maxAccountAttempts = 3;
});


// ── reviewer M1 regression: a turn that FINISHED during the idle wait is
// a success, not an idle failure (tool round-trip where the run completes
// while the sink is closed: consume's finally sets finished=true but never
// resolves the attach promise; the deadline timer must read finished).
test("idle deadline: a finished turn is success, not idle failure", async () => {
  resetMock();
  // Fire one tool call (sink closes for the round-trip); the run then
  // completes ON ITS OWN while the client never re-attaches. consume's
  // finally sets finished=true, but the sink is null so the attach promise
  // never resolves — the deadline timer must read finished and treat the
  // turn as a successful completion: no failure billing, no cancel.
  mock.finishAfterTool = true;
  mock.fireTool = async () => {
    mock.pendingExec = mock.lastCustomTools.read_file.execute({});
    mock.pendingExec.catch(() => {});
  };
  const res = fakeRes();
  await A.handleMessages({
    model: "claude-opus-5",
    stream: true,
    messages: [{ role: "user", content: "read the file" }],
    tools: [{ name: "read_file", description: "read a file", input_schema: { type: "object", properties: {} } }],
  }, res);
  assert.match(res.raw, /tool_use/, "the tool call must reach the client");
  const acc = held();
  assert.ok(acc, "the launch must hold exactly one reservation");
  const failuresBefore = acc.failures; // shared pool: prior tests may have billed this account
  await sleep(1500); // deadline is turnIdleTimeoutMs=1000 + margin
  assert.equal(mock.cancels.length, 0, "a completed turn must not be cancelled as idle");
  const f = accounts.find((a) => a.id === acc.id);
  assert.equal(f.failures, failuresBefore, "a completed turn must not add failure billing");
  mock.fireTool = null;
  mock.finishAfterTool = false;
});

// ── reviewer M2: non-streaming idle timeout must end the response ──────
test("non-streaming idle timeout: the response ends with 504, not hangs", async () => {
  resetMock();
  // No tools, no activity: the run idles out.
  const res = fakeRes();
  await A.handleMessages({
    model: "claude-opus-5",
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  }, res);
  assert.equal(res.status, 504, "the client must get a 504, not a hang");
  if (!/idle/.test(res.raw)) {
    console.log("M2 debug raw:", JSON.stringify(res.raw.slice(0, 300)), "status:", res.status);
  }
  assert.match(res.raw, /idle/, "the body must explain the timeout");
  assert.equal(res.ended, true, "the response must actually end");
});

await run();
if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`relay release: all passed (${passed.length} tests)`);
