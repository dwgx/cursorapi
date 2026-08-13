// Session auth failure recognition and handling. No network, zero cost.
// Guards the trap measured 2026-08-12: the run replies status:"error" with
// "Authentication error..." inside the stream while HTTP and Cursor.me()
// both succeed — so the account stays "available" forever and every request
// fails, with the panel looking perfectly healthy.
import assert from "node:assert/strict";

const { classify, isSessionAuthError, Verdict, reportFailure, Account } = await import(
  "./src/keys.mjs"
);

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

// The exact line captured from production.
const REAL = "run error: Authentication error If you are logged in, try logging out and back in.";

// ── recognition ─────────────────────────────────────────
test("recognition: catches the production in-run auth error", () => {
  assert.equal(isSessionAuthError(REAL), true);
});

test("recognition: case and surrounding text do not affect the match", () => {
  assert.equal(isSessionAuthError("AUTHENTICATION ERROR"), true);
  assert.equal(isSessionAuthError("xxx Authentication Error yyy"), true);
});

test("recognition: does not mis-hit other errors", () => {
  // Match narrowly: over-disabling is invisible (a good account kicked from
  // the pool, showing up only as "why does it keep switching"), while
  // under-disabling is visible (the panel keeps reporting errors). Prefer
  // under.
  for (const s of [
    "run error: rate limit exceeded",
    "model does not support this parameter",
    "turn idle timeout",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isSessionAuthError(s), false, `must not match: ${s}`);
  }
});

// ── classify integration ────────────────────────────────
test("classify: treats the session auth error as disable-and-switch", () => {
  assert.equal(classify(new Error(REAL)), Verdict.DISABLE_AND_RETRY);
});

test("classify: structured 401 keeps the old rules", () => {
  const e = new Error("Invalid User API Key");
  e.name = "AuthenticationError";
  e.status = 401;
  assert.equal(classify(e), Verdict.DISABLE_AND_RETRY);
});

test("classify: ordinary errors still follow their own rules", () => {
  const e = new Error("bad request");
  e.status = 400;
  assert.equal(classify(e), Verdict.RETURN);
  const r = new Error("boom");
  r.status = 503;
  assert.equal(classify(r), Verdict.RETRY_OTHER);
});

function freshAccount() {
  return new Account({ key: "crsr_" + "z".repeat(58), name: "test account" });
}

// ── effect on the account ───────────────────────────────
test("effect: the account really gets disabled (can't be selected)", () => {
  const a = freshAccount();
  assert.equal(a.disabled, false, "precondition: available at first");
  reportFailure(a, new Error(REAL));
  assert.equal(a.disabled, true, "must disable after an auth failure hit");
});

test("effect: probe re-enable can't detect it (autoRecoverable false)", () => {
  // Probing only asks Cursor.me(), and such accounts return 200 from me() —
  // letting the prober re-enable them would ping-pong: disabled -> next
  // probe round re-enables -> next request fails again.
  const a = freshAccount();
  reportFailure(a, new Error(REAL));
  assert.equal(a.autoRecoverable, false, "session auth failure is invisible to probing");
});

test("effect: cooldown retry puts the account back after a while", () => {
  // It must not stay disabled forever either: on 2026-08-12 the upstream
  // failed wholesale for 3h16m and healed; disable-only would mean the
  // service never recovers after the upstream heals — and outages usually
  // happen while nobody watches.
  const a = freshAccount();
  reportFailure(a, new Error(REAL));
  assert.ok(a.cooldownUntil > Date.now(), "must schedule a retry time");
  assert.equal(a.cooledDown, false, "just disabled, not yet at the time");
  assert.equal(a.disabled, true, "cooling accounts don't participate in selection");

  // Wind the clock past the cooldown.
  a.cooldownUntil = Date.now() - 1;
  assert.equal(a.cooledDown, true);
  assert.equal(a.tryRelease(), true, "on expiry it must actually come back");
  assert.equal(a.disabled, false, "must return to the pool on expiry, or recovery never happens");
});

test("effect: the 401 kind doesn't cooldown — probing manages it; the mechanisms don't fight", () => {
  const a = freshAccount();
  const e = new Error("Invalid User API Key");
  e.name = "AuthenticationError";
  e.status = 401;
  reportFailure(a, e);
  assert.equal(a.cooldownUntil, null);
  assert.equal(a.autoRecoverable, true);
});

test("effect: a manual disable is never quietly released by the cooldown", () => {
  const a = freshAccount();
  reportFailure(a, new Error(REAL));
  a.cooldownUntil = Date.now() - 1;
  a.cooldownUntil = null; // manual disable: no scheduled cooldown
  assert.equal(a.tryRelease(), false, "accounts without a scheduled cooldown must not be released");
  assert.equal(a.disabled, true, "manually disabled accounts stay disabled until someone enables them");
});

test("effect: the 401 kind can be probe-re-enabled (rotated key -> back in the pool)", () => {
  const a = freshAccount();
  const e = new Error("Invalid User API Key");
  e.name = "AuthenticationError";
  e.status = 401;
  reportFailure(a, e);
  assert.equal(a.disabled, true);
  assert.equal(a.autoRecoverable, true);
});

// ── view: what the panel reads ──────────────────────────
test("view: the disable reason reads like a human, not a bare Error", () => {
  const a = freshAccount();
  reportFailure(a, new Error(REAL));
  assert.notEqual(a.disabledReason, "Error", "a bare Error says nothing");
  assert.ok(/authentication/i.test(a.disabledReason), `actual: ${a.disabledReason}`);
});

test("view: exposes the state so the panel can render it", () => {
  const a = freshAccount();
  reportFailure(a, new Error(REAL));
  const v = a.view();
  assert.equal(v.disabled, true);
  assert.equal(v.disabledBy, "auto");
  assert.equal(v.autoRecoverable, false);
  assert.ok(v.disabledReason);
});

await run();
if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`session auth failure handling: all passed (${passed.length} tests)`);
