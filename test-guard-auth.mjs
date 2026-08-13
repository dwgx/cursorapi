// Auth: header spellings, two identity levels, sessions, and the browser's
// only native path (Basic + cookie). Wrong here means the panel is 401
// forever or a client key administers.
import assert from "node:assert/strict";

const { config } = await import("./src/settings.mjs");
config.clientKeys = ["sk-client-aaa", "sk-client-bbb"];
config.adminKey = "adm-secret";
const { extractKey, isAdmin, isClient } = await import("./src/guard-auth.mjs");
const { createSession, destroySession, cookie, penaltyMs, resetPenalty } = await import("./src/sessions.mjs");

const basic = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

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

// ── key extraction: every accepted spelling ─────────────
test("extractKey: Bearer token, case-insensitive", () => {
  assert.equal(extractKey({ authorization: "Bearer abc" }), "abc");
  assert.equal(extractKey({ authorization: "bearer abc" }), "abc", "case is client habit, not meaning");
});

test("extractKey: x-api-key header", () => {
  assert.equal(extractKey({ "x-api-key": "abc" }), "abc");
});

test("extractKey: missing headers yield an empty key", () => {
  assert.equal(extractKey({}), "");
});

test("extractKey: Basic takes the password segment", () => {
  // Basic is the only thing a browser can do natively. Regression: drop it
  // and the status page is 401 forever in browsers — while curl tests stay
  // green, because curl dutifully sends Bearer.
  assert.equal(extractKey({ authorization: basic("whatever", "abc") }), "abc", "take the password segment");
  assert.equal(extractKey({ authorization: basic("", "abc") }), "abc", "empty username is fine");
});

test("extractKey: a colon inside the password does not truncate it", () => {
  // Random strings can contain colons; cut at the first colon only.
  assert.equal(extractKey({ authorization: basic("u", "a:b:c") }), "a:b:c");
});

// ── identity levels ─────────────────────────────────────
test("isClient: accepts exactly the configured client keys", () => {
  assert.equal(isClient({ authorization: "Bearer sk-client-aaa" }), true);
  assert.equal(isClient({ authorization: "Bearer sk-client-bbb" }), true);
  assert.equal(isClient({ authorization: "Bearer guessed" }), false);
  assert.equal(isClient({}), false);
});

test("isAdmin: accepts the admin key via Bearer and Basic", () => {
  assert.equal(isAdmin({ authorization: "Bearer adm-secret" }), true);
  assert.equal(isAdmin({ authorization: basic("x", "adm-secret") }), true, "the browser path must work");
});

test("isAdmin: a client key must never administer", () => {
  // Clients would see your account count and emails.
  assert.equal(isAdmin({ authorization: "Bearer sk-client-aaa" }), false);
});

// ── session cookie ──────────────────────────────────────
test("cookie: finds the session token and ignores lookalikes", () => {
  assert.equal(cookie({ cookie: "a=1; cursorapi_sess=T0K3N; b=2" }, "cursorapi_sess"), "T0K3N");
  assert.equal(cookie({ cookie: "cursorapi_sess=T0K3N" }, "cursorapi_sess"), "T0K3N");
  assert.equal(cookie({}, "cursorapi_sess"), "", "no cookie header must not throw");
  assert.equal(cookie({ cookie: "cursorapi_sess_other=X" }, "cursorapi_sess"), "", "prefix lookalikes must not match");
});

test("session: tokens are long, URL-safe, and unique", () => {
  const s = createSession();
  assert.match(s.token, /^[\w-]{40,}$/, "tokens must be long and URL-safe");
  assert.notEqual(createSession().token, s.token, "every login mints a fresh token");
});

test("session: a valid token administers, a forged one does not", () => {
  const s = createSession();
  assert.equal(isAdmin({ cookie: "cursorapi_sess=" + s.token }), true);
  assert.equal(isAdmin({ cookie: "cursorapi_sess=forged" }), false);
});

test("session: destroy invalidates immediately", () => {
  const s = createSession();
  destroySession(s.token);
  assert.equal(isAdmin({ cookie: "cursorapi_sess=" + s.token }), false, "invalid right after logout");
});

test("session: a client key cannot buy an admin session", () => {
  assert.equal(isAdmin({ cookie: "cursorapi_sess=sk-client-aaa" }), false);
});

test("penalty: delay, not lockout — few typos free, caps out, one success clears", () => {
  // Lockout would let anyone lock the administrator out of their own panel.
  resetPenalty();
  const first = [1, 2, 3].map(() => penaltyMs());
  assert.deepEqual(first, [0, 0, 0], "a few typos shouldn't be penalized");
  let last = 0;
  for (let i = 0; i < 40; i++) last = penaltyMs();
  assert.ok(last > 0 && last <= 5000, `delay must cap out, actual ${last}ms`);
  resetPenalty();
  assert.equal(penaltyMs(), 0, "one success clears the penalty");
});

// ── degraded mode: no adminKey ──────────────────────────
test("degraded: without an adminKey, client keys administer too", async () => {
  config.adminKey = "";
  const fresh = await import("./src/guard-auth.mjs?v=2");
  assert.equal(fresh.isAdmin({ authorization: "Bearer sk-client-aaa" }), true);
  assert.equal(fresh.isAdmin({ authorization: "Bearer guessed" }), false);
});

await run();
if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`auth: all passed (${passed.length} tests)`);
