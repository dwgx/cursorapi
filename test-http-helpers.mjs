// http-helpers: readBody size cap + total read timeout, ttlCache memoization.
// The read timeout is env-tunable (CURSOR_READ_BODY_TIMEOUT_MS) so the 60s
// production default can be exercised as milliseconds in tests — set before
// the module import, since the deadline is captured at load time.
import assert from "node:assert/strict";

process.env.CURSOR_READ_BODY_TIMEOUT_MS = "150";

const { readBody, ttlCache } = await import("./src/http-helpers.mjs");

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

// A request object that yields chunks like an IncomingMessage and whose
// destroy() unblocks a stalled read — mirroring the real socket teardown.
// stall: hold the read open forever after the first chunk, like a client
// that trickled one byte and went silent.
function makeReq(chunks, { stall = false } = {}) {
  let release;
  let aborted = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    destroyed: false,
    destroy() {
      this.destroyed = true;
      aborted = true;
      release();
    },
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) {
        if (stall) {
          await gate;
          if (aborted) throw new Error("aborted");
        }
        yield Buffer.from(c);
      }
      if (stall) {
        await gate;
        if (aborted) throw new Error("aborted");
      }
    },
  };
}

// ── readBody: timeout ───────────────────────────────────
test("readBody: a stalled body is cut off with 408 and the connection is destroyed", async () => {
  const req = makeReq(['{"key":"x'], { stall: true });
  const t0 = Date.now();
  const err = await readBody(req).then(() => null, (e) => e);
  assert.ok(err, "must reject instead of hanging forever");
  assert.equal(err.httpStatus, 408, "a slow body must be 408, not 400/500");
  assert.equal(err.code, "request_timeout");
  assert.ok(Date.now() - t0 < 5000, "the deadline must actually fire");
  // The kill lands a beat after the rejection so the 408 can flush first.
  for (let i = 0; i < 50 && !req.destroyed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(req.destroyed, true, "the connection must be killed, not left to trickle");
});

test("readBody: normal bodies read through untouched (no false timeout)", async () => {
  const req = makeReq(['{"a":', "1}"]);
  const buf = await readBody(req);
  assert.equal(buf.toString("utf8"), '{"a":1}');
  assert.equal(req.destroyed, false, "a completed read must never be destroyed");
});

test("readBody: the size cap still aborts oversized bodies", async () => {
  const req = makeReq(["x".repeat(1024)]);
  const err = await readBody(req, 10).then(() => null, (e) => e);
  assert.ok(err, "must reject");
  assert.match(err.message, /exceeds/);
  assert.equal(req.destroyed, true);
});

// ── ttlCache: /admin/update/check dedupe ────────────────
test("ttlCache: concurrent calls share one upstream request", async () => {
  let calls = 0;
  const cached = ttlCache(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return "v";
  }, 60_000);
  const rs = await Promise.all([cached(), cached(), cached(), cached(), cached()]);
  assert.deepEqual(rs, ["v", "v", "v", "v", "v"]);
  assert.equal(calls, 1, "5 simultaneous callers -> exactly one upstream hit");
});

test("ttlCache: a fresh hit is served from memory", async () => {
  let calls = 0;
  const cached = ttlCache(async () => ({ n: ++calls }), 60_000);
  const a = await cached();
  const b = await cached();
  assert.deepEqual([a.n, b.n], [1, 1]);
  assert.equal(calls, 1);
});

test("ttlCache: the entry expires after the TTL", async () => {
  let calls = 0;
  const cached = ttlCache(async () => ++calls, 40);
  await cached();
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 80));
  await cached();
  assert.equal(calls, 2, "after the TTL the upstream is hit again");
});

test("ttlCache: failures are never cached", async () => {
  let calls = 0;
  const cached = ttlCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error("upstream down");
    return "ok";
  }, 60_000);
  const err = await cached().then(() => null, (e) => e);
  assert.ok(err, "the first failure must propagate");
  assert.equal(await cached(), "ok", "the next call must retry the upstream");
  assert.equal(calls, 2);
});

await run();
if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`http helpers: all passed (${passed.length} tests)`);
