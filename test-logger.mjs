// Logging: the stdout view escapes control characters so a message can
// never forge extra log lines, while the ring buffer keeps messages raw
// (JSON.stringify re-escapes them for SSE and the jsonl export).
import assert from "node:assert/strict";
import { log, recentLogs } from "./src/logger.mjs";

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

// ── stdout escaping ────────────────────────────────────
test("stdout: newlines and control characters are escaped on the line", () => {
  const writes = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { writes.push(String(s)); return true; };
  try {
    log.info("line1\nline2\tevil\x1b[31mred");
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(writes.length, 1, "one log call -> exactly one stdout write");
  const line = writes[0];
  assert.ok(!line.includes("\nline2"), "no raw newline may forge a second line");
  assert.ok(line.includes("\\n"), "newline escaped");
  assert.ok(line.includes("\\t"), "tab escaped");
  assert.ok(line.includes("\\x1b"), "ANSI escape escaped");
  assert.ok(!line.includes("\x1b[31m"), "no raw ANSI sequence reaches the terminal");
});

test("stdout: the extra payload is escaped too", () => {
  const writes = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { writes.push(String(s)); return true; };
  try {
    log.warn("boom", "a\nb");
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(writes.length, 1);
  assert.ok(!writes[0].includes("a\nb"), "a raw newline in extra must not reach the line");
  assert.ok(writes[0].includes("a\\nb"), "extra newline escaped");
});

// ── ring buffer (SSE / export surface) ─────────────────
test("ring: multiline messages stay raw for SSE and the jsonl export", () => {
  log.info("multi\nline");
  const last = recentLogs(1)[0];
  assert.ok(last.msg.includes("\n"), "the ring keeps the message raw — SSE/export render it multiline");
  assert.ok(!JSON.stringify(last).includes("\nline"), "JSON.stringify re-escapes: the frame is single-line");
});

await run();

if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`logger: all passed (${passed.length} tests)`);
