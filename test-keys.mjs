// Account pool: error classification, selection, hot reload state survival,
// accounting persistence, lifecycle ops. These are the places where "wrong"
// means money lost or accounts lost — all need regression coverage.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// The accounts file must point at a temp dir before pool is imported — it
// reads the disk on import and writes stats into the same directory later.
// Otherwise the test would touch the real accounts file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-test-"));
const accountsFile = path.join(dir, "accounts.json");
const { config } = await import("./src/settings.mjs");
config.accountsPath = accountsFile;

const pool = await import("./src/keys.mjs");
const { Verdict } = pool;

const write = (list) => fs.writeFileSync(accountsFile, JSON.stringify(list), "utf8");

// ── error classification ────────────────────────────────
// Shapes taken from real 2026-08-12 samples, not invented.
const mkErr = (o) => Object.assign(new Error(o.message ?? "x"), o);

test("classify: a dead key (401 auth) disables the account and retries", () => {
  // Otherwise every selection slams the dead account for nothing.
  assert.equal(
    pool.classify(mkErr({ name: "AuthenticationError", status: 401, code: "error", isRetryable: false })),
    Verdict.DISABLE_AND_RETRY,
  );
});

test("classify: 403 is account-level — retry another account", () => {
  // Another account may have the capability.
  assert.equal(
    pool.classify(mkErr({ name: "UnknownAgentError", status: 403, code: "feature_unavailable", isRetryable: false })),
    Verdict.RETRY_OTHER,
  );
});

test("classify: 5xx retries another account", () => {
  assert.equal(pool.classify(mkErr({ name: "X", status: 500, isRetryable: true })), Verdict.RETRY_OTHER);
});

test("classify: rate limit switches accounts", () => {
  assert.equal(pool.classify(mkErr({ name: "X", status: 429, isRetryable: false })), Verdict.RETRY_OTHER);
});

test("classify: 400 returns to the client — switching cannot fix bad params", () => {
  // Hiding them only hides the real cause.
  assert.equal(pool.classify(mkErr({ name: "X", status: 400, isRetryable: false })), Verdict.RETURN);
});

test("classify: trusts the SDK's own retry verdict", () => {
  // Don't invent a criterion.
  assert.equal(pool.classify(mkErr({ name: "X", isRetryable: true })), Verdict.RETRY_OTHER);
});

test("classify: timeouts retry another account, never RETURN", () => {
  // Link-level timeouts are transient; the account is fine, the path was not.
  assert.equal(pool.classify(mkErr({ name: "AbortError", code: "ABORT_ERR" })), Verdict.RETRY_OTHER);
  assert.equal(pool.classify(mkErr({ name: "Error", code: "ETIMEDOUT" })), Verdict.RETRY_OTHER);
  assert.equal(pool.classify(mkErr({ name: "Timeout", code: "ETIMEDOUT" })), Verdict.RETRY_OTHER);
  assert.equal(pool.classifyError(mkErr({ name: "AbortError" })).verdict, Verdict.RETRY_OTHER);
  assert.equal(pool.classifyError(mkErr({ name: "AbortError" })).retryAfterSecs, null, "timeouts carry no RA");
});

// ── loading and selection ───────────────────────────────
test("load: config-disabled accounts don't count as available", () => {
  write([
    { name: "A", key: "crsr_aaa", priority: 0 },
    { name: "B", key: "crsr_bbb", priority: 0 },
    { name: "C", key: "crsr_ccc", priority: 9 },
    { name: "D", key: "crsr_ddd", priority: 0, disabled: true },
  ]);
  pool.loadAccounts();
  assert.equal(pool.all().length, 4);
  assert.equal(pool.availableCount(), 3);
});

test("select: on a tie, lower priority wins and everyone gets picked", () => {
  // Same sort key -> round-robin, so the same account is not picked forever.
  const picked = new Set();
  for (let i = 0; i < 2; i++) picked.add(pool.select().name);
  assert.deepEqual([...picked].sort(), ["A", "B"]);
});

test("select: lower inflight wins even at higher priority", () => {
  // With A and B both busy, idle C (priority 9) wins — piling onto busy
  // accounts instead of letting the spare work is worse.
  assert.equal(pool.select().name, "C");
});

test("select: once C is busy it yields back to the A/B tier", () => {
  assert.notEqual(pool.select().name, "C", "priority tiebreak applies when inflight ties");
});

test("select: tried accounts are excluded from failover", () => {
  // Switching must never land on an account already tried this turn.
  const first = pool.select([]);
  const second = pool.select([first.id]);
  assert.notEqual(first.id, second.id);
  const third = pool.select([first.id, second.id]);
  assert.notEqual(third.id, first.id);
  assert.notEqual(third.id, second.id);
});

test("select: all excluded -> null", () => {
  assert.equal(pool.select(pool.all().filter((a) => !a.disabled).map((a) => a.id)), null);
});

// ── dead key -> auto-disable ────────────────────────────
test("failure: a 401 auto-disables the account", () => {
  const a = pool.all().find((x) => x.name === "A");
  const verdict = pool.reportFailure(a, mkErr({ name: "AuthenticationError", status: 401 }));
  assert.equal(verdict, Verdict.DISABLE_AND_RETRY);
  assert.equal(a.disabled, true, "a 401 must take the account out");
  assert.equal(pool.availableCount(), 2);
});

// ── accounting ──────────────────────────────────────────
test("accounting: runs and token counters accumulate", () => {
  const b = pool.all().find((x) => x.name === "B");
  pool.reportSuccess(b, { inputTokens: 100, outputTokens: 20 });
  pool.reportSuccess(b, { inputTokens: 50, outputTokens: 5 });
  assert.equal(b.runs, 2);
  assert.equal(b.inputTokens, 150);
  assert.equal(b.outputTokens, 25);
});

// ── hot reload ──────────────────────────────────────────
test("reload: runtime state survives — auto-disable and counters", () => {
  // Regression: if loadAccounts rebuilt Account objects every time, ① the
  // auto-disable would be cleared -> a dead account gets put back and
  // slammed once per selection, ② counts would zero out -> the usage record
  // (the gateway's only ledger) goes false.
  pool.flush(); // persist first, simulating real running
  write([
    { name: "A renamed", key: "crsr_aaa", priority: 3 }, // same key, new name and priority
    { name: "B", key: "crsr_bbb", priority: 0 },
    { name: "E", key: "crsr_eee", priority: 0 },    // freshly added
  ]);
  const r = pool.loadAccounts();
  assert.equal(r.added, 1, "only E should be new");
  assert.equal(r.removed, 2, "C and D are gone from the file");

  const a2 = pool.all().find((x) => x.key === "crsr_aaa");
  assert.equal(a2.disabled, true, "auto-disable state must survive the hot reload");

  const b2 = pool.all().find((x) => x.key === "crsr_bbb");
  assert.equal(b2.runs, 2, "counts must survive the hot reload");
  assert.equal(b2.inputTokens, 150);
});

test("reload: config-owned fields update (name, priority)", () => {
  const a2 = pool.all().find((x) => x.key === "crsr_aaa");
  assert.equal(a2.name, "A renamed");
  assert.equal(a2.priority, 3);
});

// ── manual enable ───────────────────────────────────────
test("enable: manual enable rescues an auto-disabled account and clears failures", () => {
  const a2 = pool.all().find((x) => x.key === "crsr_aaa");
  assert.equal(pool.setDisabled(a2.id, false), true);
  assert.equal(a2.disabled, false);
  assert.equal(a2.failures, 0, "or the next failure re-disables");
});

test("enable: manual enable also clears the half-open gate", () => {
  const a2 = pool.all().find((x) => x.key === "crsr_aaa");
  a2.halfOpen = true;
  a2.halfOpenAttempts = 3;
  pool.setDisabled(a2.id, true);
  pool.setDisabled(a2.id, false);
  assert.equal(a2.halfOpen, false, "a deliberate enable is a full re-admission");
  assert.equal(a2.halfOpenAttempts, 0);
});

// ── status view ─────────────────────────────────────────
test("view: never leaks the raw key", () => {
  const a2 = pool.all().find((x) => x.key === "crsr_aaa");
  const view = a2.view();
  assert.ok(!JSON.stringify(view).includes("crsr_aaa"), "status page data must never contain the raw key");
  assert.match(view.maskedKey, /…/);
});

// ── adding accounts from the page ───────────────────────
// Swap the SDK's `Cursor.me` for a stub: keys.mjs reads this property **at
// call time**, so replacing the method on the same object intercepts it —
// no injection hook in product code needed. Bonus: this whole section is
// offline; a test that depends on the internet goes red at random times.
const { Cursor } = await import("@cursor/sdk");
const realMe = Cursor.me;
let meImpl = async () => ({ userEmail: "who@example.com", apiKeyName: "KeyName", createdAt: "2026-01-01" });
Cursor.me = (...args) => meImpl(...args);

const readFile = () => JSON.parse(fs.readFileSync(accountsFile, "utf8"));
// Looking at `httpStatus`, not `status`: SDK errors carry `status` too (the
// Cursor upstream's code); conflating the two lets an upstream 401
// masquerade as the gateway's own auth failure.
const failsWith = async (status, fn) => {
  const e = await fn().then(() => null, (x) => x);
  assert.ok(e, "should have failed but succeeded");
  assert.equal(e.httpStatus, status, `expected ${status}, got ${e.httpStatus}: ${e.message}`);
  assert.equal(e.status, undefined, "stop setting `status` — that name belongs to upstream status codes");
  return e;
};

test("add: keys that fail validation never get persisted", async () => {
  write([{ name: "only one", key: "crsr_only", priority: 0 }]);
  pool.loadAccounts();
  // Persisted, a dead key would lie in the file, be re-loaded on every
  // restart, and only get auto-disabled after hitting a 401 on some **real
  // client request** — making the client do your testing.
  await failsWith(400, () => pool.addAccount({ key: "" }));
  await failsWith(400, () => pool.addAccount({ key: "sk-not-a-cursor-key" }));
  assert.equal(readFile().length, 1, "two failures must leave the file untouched");
  assert.equal(pool.all().length, 1);
});

test("add: an upstream auth failure maps to 400, not 401", async () => {
  meImpl = async () => { throw Object.assign(new Error("Invalid User API Key"), { name: "AuthenticationError", status: 401 }); };
  await failsWith(400, () => pool.addAccount({ key: "crsr_deadkey" }));
  assert.equal(readFile().length, 1, "a dead key must leave the file untouched");
});

test("add: a valid key lands in memory and on disk immediately", async () => {
  meImpl = async () => ({ userEmail: "new@example.com", apiKeyName: "NewKey", createdAt: "2026-02-02" });
  const added = await pool.addAccount({ key: "crsr_new1" });
  assert.equal(added.email, "new@example.com");
  assert.equal(pool.all().length, 2, "added must be in the pool immediately, no manual reload");
  assert.equal(readFile().length, 2, "and persisted, so it survives restart");
  assert.equal(pool.get(added.id).identity.userEmail, "new@example.com", "identity fills in immediately, no waiting for the next probe round");
});

test("add: a missing name falls back to the key name, never a blank row", () => {
  assert.equal(readFile()[1].name, "NewKey");
});

test("add: priority 0 is not written into the user's file as a default", () => {
  assert.ok(!("priority" in readFile()[1]));
});

test("add: the accounts file keeps 0600 permissions", () => {
  // Regression: writeFileSync creates new files per umask (usually 644);
  // the rename then replaces the original 600 — and any user on the host
  // can read the whole pool, while the add itself succeeds so functionality
  // looks fine. Leaked on launch day, 2026-08-12.
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(accountsFile).mode & 0o777, 0o600);
  }
});

test("add: duplicates are rejected with 409", async () => {
  // They'd append the same key twice in the file while memory dedupes by id
  // — invisible until you open the file one day.
  await failsWith(409, () => pool.addAccount({ key: "crsr_new1" }));
  assert.equal(readFile().length, 2);
});

test("add: keys present on disk but not yet reloaded are duplicates too", async () => {
  write([...readFile(), { name: "hand-added", key: "crsr_byhand" }]);
  await failsWith(409, () => pool.addAccount({ key: "crsr_byhand" }));
});

test("add: the {accounts:[...]} wrapper shape is preserved", async () => {
  // Restructuring the user's file because the page added one account is
  // presumptuous.
  fs.writeFileSync(accountsFile, JSON.stringify({ note: "my accounts", accounts: [{ name: "X", key: "crsr_x" }] }), "utf8");
  pool.loadAccounts();
  await pool.addAccount({ key: "crsr_new2", name: "two", priority: 7 });
  const wrapped = readFile();
  assert.ok(Array.isArray(wrapped.accounts), "the wrapper shape must be preserved");
  assert.equal(wrapped.note, "my accounts", "other keys in the file must survive");
  assert.equal(wrapped.accounts.length, 2);
  assert.equal(wrapped.accounts[1].priority, 7, "a given priority must be written");
});

// ── rename / change priority ────────────────────────────
test("update: name and priority apply to memory and disk", () => {
  const x = pool.all().find((a) => a.name === "X");
  pool.updateAccount(x.id, { name: "X updated", priority: 5 });
  assert.equal(pool.get(x.id).name, "X updated", "memory must update immediately");
  assert.equal(pool.get(x.id).priority, 5);
  assert.equal(readFile().accounts[0].name, "X updated", "the file must update too, or a restart reverts it");
  assert.equal(readFile().accounts[0].priority, 5);
});

test("update: priority 0 removes the field but keeps the name", () => {
  // Don't stuff defaults into the user's file.
  const x = pool.all().find((a) => a.name === "X updated");
  pool.updateAccount(x.id, { priority: 0 });
  assert.ok(!("priority" in readFile().accounts[0]));
  assert.equal(pool.get(x.id).name, "X updated", "changing priority must not clobber the name");
});

test("update: unknown id -> 404, bad priority -> 400", async () => {
  await failsWith(404, async () => pool.updateAccount("ffffffffffff", { name: "none" }));
  const x = pool.all().find((a) => a.name === "X updated");
  await failsWith(400, async () => pool.updateAccount(x.id, { priority: "not a number" }));
});

// ── remove ──────────────────────────────────────────────
test("remove: gone from memory and disk, file shape preserved", () => {
  const n2 = pool.all().find((a) => a.name === "two");
  pool.reportSuccess(n2, { inputTokens: 10, outputTokens: 2 });
  const before = pool.all().length;
  pool.removeAccount(n2.id);
  assert.equal(pool.all().length, before - 1, "gone from memory");
  assert.equal(readFile().accounts.length, 1, "gone from the file");
  assert.ok(!JSON.stringify(readFile()).includes("crsr_new2"), "the key must be fully gone from the file");
  assert.ok(Array.isArray(readFile().accounts), "removal must not change the file's shape");
});

test("remove: unknown id -> 404", async () => {
  await failsWith(404, async () => pool.removeAccount("ffffffffffff"));
});

// ── bulk import ─────────────────────────────────────────
test("batch: good keys added, bad ones skipped — each failure with a reason", async () => {
  // A whole-batch rollback would sink a column pasted from a spreadsheet
  // (expired keys are the norm there) and leave you picking out the bad
  // ones yourself.
  meImpl = async (o) => {
    if (String(o.apiKey).includes("bad")) {
      throw Object.assign(new Error("Invalid User API Key"), { name: "AuthenticationError", status: 401 });
    }
    return { userEmail: o.apiKey.slice(-4) + "@example.com", apiKeyName: "batch" };
  };
  const batch = await pool.addAccounts([
    { key: "crsr_ok1" },
    { key: "sk-wrong-format" },
    { key: "crsr_bad1" },
    { key: "crsr_ok2", name: "named", priority: 2 },
    { key: "crsr_ok1" }, // same key pasted twice in one batch
  ]);
  assert.equal(batch.added.length, 2, "the two good ones must be added");
  assert.equal(batch.failed.length, 3, "wrong format, dead key, in-batch duplicate: one each");
  assert.ok(batch.failed.every((f) => f.reason), "every failure needs its reason, or nothing can be debugged");
  assert.ok(!JSON.stringify(batch.failed).includes("crsr_bad1"), "keys in the failure receipts must be masked");
  assert.equal(pool.all().length, 3);
  assert.equal(readFile().accounts.length, 3, "one write; both good ones present");
  assert.equal(pool.all().find((a) => a.name === "named").priority, 2);
});

test("batch: empty or oversized lists -> 400", async () => {
  await failsWith(400, () => pool.addAccounts([]));
  await failsWith(400, () => pool.addAccounts(new Array(201).fill({ key: "crsr_x" })));
});

// ── manual probe ────────────────────────────────────────
test("probe: returns fresh identity for the UI", async () => {
  const ok1 = pool.all().find((a) => a.key === "crsr_ok1");
  meImpl = async () => ({ userEmail: "probed@example.com", apiKeyName: "k" });
  const pr = await pool.probeOne(ok1.id);
  assert.equal(pr.ok, true);
  assert.equal(pr.account.email, "probed@example.com");
});

test("probe: unknown id -> 404", async () => {
  await failsWith(404, () => pool.probeOne("ffffffffffff"));
});

test("probe: a 401 auto-disables the account", async () => {
  // The only auto-disable case probing can cause.
  const ok1 = pool.all().find((a) => a.key === "crsr_ok1");
  meImpl = async () => { throw Object.assign(new Error("x"), { name: "AuthenticationError", status: 401 }); };
  const pr2 = await pool.probeOne(ok1.id);
  assert.equal(pr2.ok, false);
  assert.equal(pool.get(ok1.id).disabled, true, "a dead key must disable the account");
  Cursor.me = realMe;
});

// ── request-level accounting (the /admin/stats source) ──
test("stats: totals, per-model aggregation, and hourly buckets", () => {
  // Reset the aggregation first so it doesn't mix with the earlier cases.
  pool.resetAggForTest();
  const ok1 = pool.all().find((a) => a.key === "crsr_ok1");
  pool.recordRequest("claude-opus-5", true, 1200, ok1.id, { input: 100, output: 50 });
  pool.recordRequest("claude-opus-5", false, 300, ok1.id, { input: 10 });
  const ok2 = pool.all().find((a) => a.key === "crsr_ok2") ?? pool.all()[0];
  const ok2id = ok2.id;
  pool.recordRequest("gpt-5.6", true, 800, ok2id, { input: 200, output: 100, cacheRead: 30 });
  const st = pool.getStats();
  assert.equal(st.totals.requests, 3);
  assert.equal(st.totals.success, 2);
  assert.equal(st.totals.errors, 1);
  assert.deepEqual(st.totals.tokens, { input: 310, output: 150, cacheRead: 30, cacheWrite: 0 });
  assert.equal(st.models.length, 2, "aggregated by model");
  const opus = st.models.find((m) => m.id === "claude-opus-5");
  assert.equal(opus.requests, 2);
  assert.equal(opus.avgMs, 750, "avg latency = (1200+300)/2");
  assert.ok(Array.isArray(st.hourlyBuckets) && st.hourlyBuckets.length >= 1, "hourly buckets exist");
  assert.ok(
    st.hourlyBuckets.every((b) => typeof b.ts === "string" && b.requests >= 0),
    "hourly bucket shape: ts + counts",
  );
  const hourTotal = st.hourlyBuckets.reduce((s, b) => s + b.requests, 0);
  assert.ok(hourTotal >= 3, "sum of hourly bucket counts >= recorded requests");
});

test("stats: aggregation persists atomically to disk", () => {
  // Within the debounce window the file may not exist yet; call the
  // internal flush directly and read back.
  pool.flushAggNow();
  assert.ok(fs.existsSync(path.join(dir, "cursorapi-agg-stats.json")), "aggregation persisted");
  const aggOnDisk = JSON.parse(fs.readFileSync(path.join(dir, "cursorapi-agg-stats.json"), "utf8"));
  assert.equal(aggOnDisk.totals.requests, 3, "on-disk aggregation matches memory");
  assert.ok(aggOnDisk.buckets && Object.keys(aggOnDisk.buckets).length >= 1, "hourly buckets persisted too");
});

// ── batch ops (batchOps) ────────────────────────────────
test("batchOps: disable and enable all ids", async () => {
  const ok1 = pool.all().find((a) => a.key === "crsr_ok1");
  const ok2 = pool.all().find((a) => a.key === "crsr_ok2") ?? pool.all()[0];
  const { batchOps } = pool;
  const dis = await batchOps([ok1.id, ok2.id], "disable");
  assert.equal(dis.ok.length, 2, "both must disable");
  assert.equal(pool.get(ok1.id).disabled, true);
  assert.equal(pool.get(ok2.id).disabled, true);
  const en = await batchOps([ok1.id, ok2.id], "enable");
  assert.equal(en.ok.length, 2);
  assert.equal(pool.get(ok1.id).disabled, false);
});

test("batchOps: a nonexistent id mixed in only reports a failure, no clobbering", async () => {
  const ok1 = pool.all().find((a) => a.key === "crsr_ok1");
  const { batchOps } = pool;
  const mixed = await batchOps([ok1.id, "ffffffffffff"], "probe");
  assert.equal(mixed.ok.length, 1);
  assert.equal(mixed.failed.length, 1);
  assert.ok(mixed.failed[0].reason, "failures need a reason");
});

test("batchOps: unknown op -> 400", async () => {
  const ok1 = pool.all().find((a) => a.key === "crsr_ok1");
  const { batchOps } = pool;
  await failsWith(400, () => batchOps([ok1.id], "nonsense"));
});

// ── export (never plaintext keys) ───────────────────────
test("export: counts accounts, never carries plaintext keys", () => {
  const { exportAccounts } = pool;
  const ex = exportAccounts();
  assert.equal(ex.count, pool.all().length);
  const raw = JSON.stringify(ex);
  assert.ok(!raw.includes("crsr_ok1") && !raw.includes("crsr_ok2"), "export must not carry plaintext keys");
  assert.ok(raw.includes("maskedKey"), "export carries masked keys");
  assert.ok(ex.accounts.every((a) => !String(a.maskedKey ?? "").includes(a.key ?? "§")), "masks never leak the original");
});

// ── P0: 5-dimensional selection key ─────────────────────
// A standalone pool. O1/O2 masquerade as old accounts (fresh ones, in the
// pool < 5 min, sort last — bypass that to test other dimensions), N1 is
// fresh and stays inside the ramp-up window.
let realMe2 = null;

test("selection: accounts inside the ramp-up window are never picked", async () => {
  realMe2 = Cursor.me;
  Cursor.me = async () => ({ userEmail: "p0@example.com", apiKeyName: "P0", createdAt: "2026-01-01" });
  write([
    { name: "O1", key: "crsr_o1", priority: 0 },
    { name: "O2", key: "crsr_o2", priority: 0 },
  ]);
  pool.loadAccounts();
  for (const a of pool.all()) a.addedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await pool.addAccount({ key: "crsr_n1", name: "N1", priority: 0 });
  for (let i = 0; i < 10; i++) {
    const x = pool.select();
    assert.notEqual(x.name, "N1", "fresh-account slow start: in the pool < 5 min, never picked");
  }
});

test("selection: reservation forces switching, release restores", () => {
  const o1 = pool.all().find((a) => a.name === "O1");
  const o2 = pool.all().find((a) => a.name === "O2");
  while (o1.inflight) pool.release(o1);
  while (o2.inflight) pool.release(o2);
  const x1 = pool.select();
  assert.notEqual(x1.name, "N1", "old accounts beat ramp-up fresh ones");
  const x2 = pool.select();
  assert.notEqual(x1.id, x2.id, "a selected account has high inflight; the next must switch");
  pool.release(x1);
  assert.equal(pool.select().id, x1.id, "after release it is lowest-inflight again and wins");
});

test("selection: lower rpm in the last 60s wins", () => {
  const o1 = pool.all().find((a) => a.name === "O1");
  o1.requestTimes.push(Date.now(), Date.now(), Date.now(), Date.now(), Date.now());
  assert.equal(pool.select().name, "O2", "fewer requests in the last 60s wins");
});

test("selection: stale rpm entries outside the window don't count", () => {
  const o2 = pool.all().find((a) => a.name === "O2");
  o2.requestTimes.push(Date.now() - 120 * 1000);
  pool.release(o2); // return the last select's reservation so both are even (inflight beats rpm)
  assert.equal(pool.select().name, "O2", "expired entries get pruned");
});

test("selection: cooling accounts don't participate", () => {
  const o1 = pool.all().find((a) => a.name === "O1");
  pool.reportFailure(o1, mkErr({ name: "RateLimitError", status: 429 }));
  assert.equal(pool.select().name, "O2");
});

// ── P0: tiered cooldowns (replacing the flat 10-min) ────
const mk429 = (o = {}) =>
  Object.assign(new Error("rate limited"), { name: "RateLimitError", status: 429, ...o });
const gap = (a) => a.cooldownUntil - Date.now();

test("cooldown: a 429 escalates 5s -> 10s -> 15s with the streak", () => {
  const cd = new pool.Account({ key: "crsr_cd1", name: "cooling" });
  pool.reportFailure(cd, mk429());
  assert.ok(gap(cd) >= 4000 && gap(cd) <= 6000, `first 429 cooldown ~=5s, actual ${gap(cd)}ms`);
  pool.reportFailure(cd, mk429());
  assert.ok(gap(cd) >= 9000 && gap(cd) <= 11000, `second ~=10s, actual ${gap(cd)}ms`);
  pool.reportFailure(cd, mk429());
  assert.ok(gap(cd) >= 14000 && gap(cd) <= 16000, `third ~=15s, actual ${gap(cd)}ms`);
});

test("cooldown: one success resets the streak back to 5s", () => {
  const cd = new pool.Account({ key: "crsr_cd1", name: "cooling" });
  pool.reportFailure(cd, mk429());
  pool.reportFailure(cd, mk429());
  pool.reportSuccess(cd, null);
  assert.equal(cd.rateLimitStreak, 0, "one success resets the streak");
  pool.reportFailure(cd, mk429());
  assert.ok(gap(cd) >= 4000 && gap(cd) <= 6000, "reset -> back to 5s");
});

test("cooldown: 5xx fixed at 30s, no escalation", () => {
  const cd5 = new pool.Account({ key: "crsr_cd2" });
  pool.reportFailure(cd5, Object.assign(new Error("boom"), { name: "ServerError", status: 503 }));
  assert.ok(gap(cd5) >= 29000 && gap(cd5) <= 31000, `actual ${gap(cd5)}ms`);
});

test("cooldown: 401 has none (probe-managed); session auth keeps the 10 min window", () => {
  const cda = new pool.Account({ key: "crsr_cd3" });
  pool.reportFailure(cda, Object.assign(new Error("Invalid User API Key"), { name: "AuthenticationError", status: 401 }));
  assert.equal(cda.cooldownUntil, null, "401 doesn't cooldown (probe manages it; semantics unchanged)");
  const cds = new pool.Account({ key: "crsr_cd4" });
  pool.reportFailure(cds, new Error("run error: Authentication error If you are logged in, try logging out and back in."));
  assert.ok(cds.cooldownUntil - Date.now() >= 9.5 * 60 * 1000, "session auth failure keeps the long cooldown (10 min)");
});

test("cooldown: a 429's Retry-After (capped 600s) overrides the streak math", () => {
  const ra = new pool.Account({ key: "crsr_ra1" });
  pool.reportFailure(ra, mk429({ retryAfter: "300" }));
  assert.ok(gap(ra) >= 299_000 && gap(ra) <= 301_000, `RA 300s honored, actual ${gap(ra)}ms`);
  const cap = new pool.Account({ key: "crsr_ra2" });
  pool.reportFailure(cap, mk429({ retryAfter: "1000" }));
  assert.ok(gap(cap) >= 599_000 && gap(cap) <= 601_000, `RA capped at 600s, actual ${gap(cap)}ms`);
  const weak = new pool.Account({ key: "crsr_ra3" });
  pool.reportFailure(weak, mk429({ retryAfter: "2" }));
  assert.ok(gap(weak) >= 4_000 && gap(weak) <= 6_000, "a tiny RA never shortens the 5s floor");
  assert.equal(ra.rateLimitStreak, 1, "the streak still escalates for the next no-RA hit");
});

test("decay: the 429 streak erodes with minutes since the last 429", () => {
  const d1 = new pool.Account({ key: "crsr_dec1" });
  d1.rateLimitStreak = 10;
  d1.lastRateLimitAt = Date.now() - 20 * 60 * 1000; // 20 min -> 4 points decayed
  pool.reportFailure(d1, mk429());
  assert.equal(d1.rateLimitStreak, 7, "10 - 4 (decay) + 1 (this hit)");
  assert.ok(gap(d1) >= 34_000 && gap(d1) <= 36_000, `7 x 5s = 35s, actual ${gap(d1)}ms`);
  const d2 = new pool.Account({ key: "crsr_dec2" });
  d2.rateLimitStreak = 18;
  d2.lastRateLimitAt = Date.now() - 90 * 60 * 1000; // 90 min -> fully eroded
  pool.reportFailure(d2, mk429());
  assert.equal(d2.rateLimitStreak, 1, "long-quiet account is back to the base");
});

test("decay: view shows the effective streak; success clears the decay anchor", () => {
  const d3 = new pool.Account({ key: "crsr_dec3" });
  d3.rateLimitStreak = 6;
  d3.lastRateLimitAt = Date.now() - 5 * 60 * 1000;
  assert.equal(d3.view().rateLimitStreak, 5, "the panel shows the decayed value");
  pool.reportSuccess(d3, null);
  assert.equal(d3.rateLimitStreak, 0, "a success clears the streak and its anchor");
  assert.equal(d3.lastRateLimitAt, null);
});

test("cooldown: 403 penalizes 20s per hit; 6 consecutive hits disable", () => {
  const s1 = new pool.Account({ key: "crsr_403a" });
  const mk403 = () => mkErr({ name: "UnknownAgentError", status: 403, code: "feature_unavailable" });
  for (let i = 1; i <= 5; i++) {
    const v = pool.reportFailure(s1, mk403());
    assert.equal(v, Verdict.RETRY_OTHER, "the 403 verdict is unchanged");
    assert.equal(s1.disabled, false, `hit ${i} only cools`);
    assert.equal(s1.suspiciousStreak, i);
    assert.ok(gap(s1) >= 18_000 && gap(s1) <= 22_000, `20s soft-risk cooldown, actual ${gap(s1)}ms`);
  }
  pool.reportFailure(s1, mk403());
  assert.equal(s1.disabled, true, "the 6th consecutive 403 disables");
  assert.equal(s1.suspiciousStreak, 6);
  const s2 = new pool.Account({ key: "crsr_403b" });
  pool.reportFailure(s2, mk403());
  pool.reportSuccess(s2, null);
  assert.equal(s2.suspiciousStreak, 0, "a success resets the 403 count");
});

test("401-split: a 401 on a worked key cools briefly; two consecutive disable", () => {
  const w1 = new pool.Account({ key: "crsr_401a" });
  w1.runs = 5; // has served requests before
  const mk401 = () => mkErr({ name: "AuthenticationError", status: 401 });
  const v = pool.reportFailure(w1, mk401());
  assert.equal(v, Verdict.DISABLE_AND_RETRY, "the verdict domain is unchanged");
  assert.equal(w1.disabled, false, "first 401 on a worked key is transient");
  assert.equal(w1.authFailStreak, 1);
  assert.ok(gap(w1) >= 44_000 && gap(w1) <= 46_000, `45s transient cooldown, actual ${gap(w1)}ms`);
  pool.reportFailure(w1, mk401());
  assert.equal(w1.disabled, true, "the second consecutive 401 disables");
  const w2 = new pool.Account({ key: "crsr_401b" });
  w2.runs = 3;
  pool.reportFailure(w2, mk401());
  pool.reportSuccess(w2, null);
  assert.equal(w2.authFailStreak, 0, "a success resets the 401 counter");
});

// ── cooldown expiry recovery (the full loop, not just "cooldown set") ──
test("recovery: a cooling account is excluded, released on expiry", () => {
  const o1 = pool.all().find((a) => a.name === "O1");
  const o2 = pool.all().find((a) => a.name === "O2");
  o1.cooldownUntil = Date.now() + 60_000; // pin o1 to cooling, removing time races
  pool.reportFailure(o2, mk429());
  assert.notEqual(pool.select().name, "O2", "a cooling account never participates in selection");
  o2.cooldownUntil = Date.now() - 1; // fake expiry
  assert.equal(pool.select().name, "O2", "expired cooldown -> put back automatically");
});

test("recovery: the stale cooldown timestamp is cleared on release", () => {
  const o2 = pool.all().find((a) => a.name === "O2");
  assert.equal(o2.cooldownUntil, null, "the panel must not show old values");
});

test("recovery: autoDisabled accounts release only via tryRelease, not releaseCooled", () => {
  // releaseCooled's plain-cooldown cleanup must not touch autoDisabled
  // accounts (those belong to tryRelease).
  const ses2 = new pool.Account({ key: "crsr_ses2" });
  pool.reportFailure(ses2, new Error("run error: Authentication error If you are logged in, try logging out and back in."));
  ses2.cooldownUntil = Date.now() - 1;
  const sesBefore = ses2.cooldownUntil;
  pool.releaseCooled();
  assert.equal(ses2.cooldownUntil, sesBefore, "autoDisabled accounts are not cleared by the else-if");
  assert.equal(ses2.tryRelease(), true, "they release themselves on expiry");
});

// ── D1: half-open gradual recovery ─────────────────────
test("half-open: thaw enters the gate; one trial per selection round", () => {
  write([
    { name: "H1", key: "crsr_h1", priority: 0 },
    { name: "H2", key: "crsr_h2", priority: 0 },
  ]);
  pool.loadAccounts();
  const h1 = pool.all().find((a) => a.name === "H1");
  const h2 = pool.all().find((a) => a.name === "H2");
  for (const a of pool.all()) a.addedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  pool.reportFailure(h1, mk429());
  pool.reportFailure(h2, mk429());
  h1.cooldownUntil = Date.now() - 1; // both expired
  h2.cooldownUntil = Date.now() - 1;
  const p1 = pool.select();
  assert.ok(p1.halfOpen, "a thawed account is half-open, not fully re-admitted");
  assert.equal(p1.cooldownUntil, null, "the expired timestamp is cleared on thaw");
  const p2 = pool.select();
  assert.equal(p2.id, p1.id, "one half-open candidate per round: the probe is serial, never a flood");
  assert.ok(h2.halfOpen, "the other thawed account waits its turn");
  assert.equal(pool.select(pool.all().map((a) => a.id)), null, "excludes still apply");
});

test("half-open: 3 consecutive successes fully re-admit; a failure re-cooldowns with 1.5^n", () => {
  const h1 = pool.all().find((a) => a.name === "H1");
  pool.reportSuccess(h1, null);
  pool.reportSuccess(h1, null);
  assert.ok(h1.halfOpen, "still probing after 2 successes");
  pool.reportSuccess(h1, null);
  assert.equal(h1.halfOpen, false, "3 consecutive successes fully re-admit");
  assert.equal(h1.halfOpenAttempts, 0, "recovery clears the backoff counter");

  // Failure path: an isolated Account to keep the pool intact.
  const f = new pool.Account({ key: "crsr_ho1" });
  f.halfOpen = true;
  pool.reportFailure(f, mk429());
  assert.ok(f.halfOpen, "a failed probe stays half-open");
  assert.equal(f.halfOpenAttempts, 1);
  assert.ok(gap(f) >= 7_000 && gap(f) <= 8_000, `5s x 1.5 = 7.5s, actual ${gap(f)}ms`);
  pool.reportFailure(f, mk429());
  assert.equal(f.halfOpenAttempts, 2);
  assert.ok(gap(f) >= 22_000 && gap(f) <= 23_500, `10s (streak 2) x 1.5^2 = 22.5s, actual ${gap(f)}ms`);
  pool.reportFailure(f, mk429());
  assert.equal(f.halfOpenAttempts, 3);
  assert.ok(gap(f) >= 50_000 && gap(f) <= 52_000, `15s (streak 3) x 1.5^3 = 50.6s, actual ${gap(f)}ms`);
});

test("half-open: a 401 while probing also backs off (the transient path)", () => {
  const g = new pool.Account({ key: "crsr_ho2" });
  g.runs = 4;
  g.halfOpen = true;
  pool.reportFailure(g, mkErr({ name: "AuthenticationError", status: 401 }));
  assert.equal(g.disabled, false, "401 transient path while half-open");
  assert.ok(gap(g) >= 67_000 && gap(g) <= 69_000, `45s x 1.5 = 67.5s, actual ${gap(g)}ms`);
});

// ── P0: Retry-After parsing ─────────────────────────────
test("retryAfter: plain seconds, fractions round up, numeric header", () => {
  assert.equal(pool.parseRetryAfter(mkErr({ status: 429, retryAfter: "30" })), 30);
  assert.equal(pool.parseRetryAfter(mkErr({ status: 429, headers: { "retry-after": "5.5" } })), 6, "fractions round up");
  assert.equal(pool.parseRetryAfter(mkErr({ status: 429, headers: { "Retry-After": 12 } })), 12);
});

test("retryAfter: absent, non-numeric, or zero -> null", () => {
  assert.equal(pool.parseRetryAfter(mkErr({ status: 429 })), null, "no RA -> null");
  assert.equal(pool.parseRetryAfter(mkErr({ status: 429, retryAfter: "abc" })), null, "non-numeric -> null");
  assert.equal(pool.parseRetryAfter(mkErr({ status: 429, retryAfter: 0 })), null, "0 seconds is meaningless");
});

test("retryAfter: ms values convert to seconds", () => {
  // Defense against SDK unit drift.
  assert.equal(pool.parseRetryAfter(mkErr({ status: 429, retryAfter: 7200000 })), 7200);
});

test("retryAfter: classifyError carries RA only for 429/5xx; permanent states never", () => {
  assert.equal(pool.classifyError(mkErr({ status: 429, retryAfter: "17" })).retryAfterSecs, 17);
  assert.equal(pool.classifyError(mkErr({ status: 429, retryAfter: "17" })).verdict, Verdict.RETRY_OTHER);
  assert.equal(pool.classifyError(mkErr({ status: 503, retryAfter: "9" })).retryAfterSecs, 9, "5xx with RA parses too (for passthrough)");
  assert.equal(pool.classifyError(mkErr({ name: "AuthenticationError", status: 401, retryAfter: "9" })).retryAfterSecs, null, "auth failure never carries RA");
  assert.equal(pool.classifyError(mkErr({ status: 400, retryAfter: "9" })).retryAfterSecs, null, "permanent errors never carry RA");
  assert.equal(pool.classifyError(mkErr({ status: 400, retryAfter: "9" })).verdict, Verdict.RETURN);
});

test("retryAfter: classify's verdict domain is unchanged (name-only 429 switches too)", () => {
  assert.equal(pool.classify(mkErr({ status: 429, retryAfter: "17" })), Verdict.RETRY_OTHER);
  assert.equal(pool.classify(mkErr({ name: "RateLimitError" })), Verdict.RETRY_OTHER, "name-only 429 without status still switches");
  assert.equal(pool.classifyError(mkErr({ name: "RateLimitError", retryAfter: "5" })).retryAfterSecs, 5, "name-only 429 parses RA too");
});

// ── D4: pool-exhausted Retry-After ─────────────────────
test("poolExhaustedRetryAfter: earliest thaw, clamped 10..600s", () => {
  write([
    { name: "E1", key: "crsr_e1", priority: 0 },
    { name: "E2", key: "crsr_e2", priority: 0 },
  ]);
  pool.loadAccounts();
  const e1 = pool.all().find((a) => a.name === "E1");
  const e2 = pool.all().find((a) => a.name === "E2");
  e1.cooldownUntil = Date.now() + 5_000;
  e2.cooldownUntil = Date.now() + 200_000;
  assert.equal(pool.poolExhaustedRetryAfter(), 10, "5s clamps up to the 10s floor");
  e1.cooldownUntil = Date.now() + 900_000;
  e2.cooldownUntil = Date.now() + 1_200_000;
  assert.equal(pool.poolExhaustedRetryAfter(), 600, "15 min clamps down to the 600s cap");
  e1.cooldownUntil = Date.now() + 200_000;
  e2.cooldownUntil = Date.now() + 300_000;
  assert.equal(pool.poolExhaustedRetryAfter(), 200, "in range: the earliest thaw wins");
  e1.cooldownUntil = Date.now() - 1_000;
  assert.equal(pool.poolExhaustedRetryAfter(), 300, "expired timestamps don't count");
  e1.autoDisabled = true;
  assert.equal(pool.poolExhaustedRetryAfter(), 300, "disabled accounts don't contribute");
});

test("poolExhaustedRetryAfter: null when nothing will thaw", () => {
  write([]);
  pool.loadAccounts();
  assert.equal(pool.poolExhaustedRetryAfter(), null, "empty pool -> null (RA is moot)");
});

// ── P0: failover backoff + RA passthrough (full relay path) ──
// Stub Agent.create / Cursor.models.list (same call-time property trick as
// Cursor.me above) and run the whole engine.handle — fully offline.
const { Agent } = await import("@cursor/sdk");
const realCreate = Agent.create;
const realModelsList = Cursor.models.list;
Cursor.models.list = async () => [{ id: "claude-opus-5", aliases: [], parameters: [] }];

const engine = await import("./src/relay.mjs");
const adapter = {
  parse: () => ({ stream: false, id: "msg_1", publicModel: "claude-opus-5", prompt: "hi", tools: null, resume: null }),
  makeSink: () => { throw new Error("should not reach makeSink"); },
  feed: () => 0,
  finishNonStream: () => { throw new Error("should not reach finishNonStream"); },
  callIdPrefix: "call_",
};
const runHandle = async () => {
  const headers = {};
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    writeHead() {}, write() {}, end() {},
  };
  let status = null;
  await engine.handle(adapter, {}, res, {
    respondError: (r, s) => { status = s; },
  });
  return { status, headers };
};

test("failover: 429 exhaustion never returns 429 outward, RA never passes through", async () => {
  // Cursor kills sessions on 429.
  Agent.create = async () => {
    throw Object.assign(new Error("rate limited"), { name: "RateLimitError", status: 429, retryAfter: "1" });
  };
  const r1 = await runHandle();
  assert.notEqual(r1.status, 429, "never return 429 outward");
  assert.equal(r1.headers["Retry-After"], undefined, "a 429's RA must never pass through as a 5xx fallback");
});

test("failover: on 5xx exhaustion, the RA reaches the response header", async () => {
  write([
    { name: "G1", key: "crsr_g1", priority: 0 },
    { name: "G2", key: "crsr_g2", priority: 0 },
  ]);
  pool.loadAccounts();
  for (const a of pool.all()) a.addedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  Agent.create = async () => {
    throw Object.assign(new Error("upstream down"), { name: "ServerError", status: 503, retryAfter: "9" });
  };
  const r2 = await runHandle();
  assert.ok(r2.status === 502 || r2.status === 503, `failover exhaustion -> 502/503 (not 429), actual ${r2.status}`);
  assert.equal(r2.headers["Retry-After"], "9");
});

test("failover: a success releases every reservation", async () => {
  for (const a of pool.all()) {
    a.cooldownUntil = null;
    a.cooldownReason = null;
  }
  const okAdapter = {
    ...adapter,
    makeSink: () => ({ text() {}, toolCall() {}, finish() {}, fail() {}, closed: false, parts: [] }),
    finishNonStream: () => {},
  };
  Agent.create = async () => ({
    send: async () => ({
      stream: async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
      },
      wait: async () => ({ status: "finished", result: "" }),
    }),
  });
  const okRes = {
    headers: {},
    setHeader: (k, v) => { okRes.headers[k] = v; },
    writeHead() {}, write() {}, end() {},
  };
  let okStatus = null;
  await engine.handle(okAdapter, {}, okRes, {
    respondError: (r, s) => { okStatus = s; },
  });
  assert.equal(okStatus, null, "the success path must not error");
  for (const a of pool.all()) {
    assert.equal(a.inflight, 0, `${a.name} has ${a.inflight} left`);
  }
});

test("failover: makeSink throwing still releases the reservation", async () => {
  // Consume never starts; the reservation must still be returned.
  const okAdapter = {
    ...adapter,
    makeSink: () => ({ text() {}, toolCall() {}, finish() {}, fail() {}, closed: false, parts: [] }),
    finishNonStream: () => {},
  };
  const boomAdapter = { ...okAdapter, makeSink: () => { throw new Error("sink boom"); } };
  let boomErr = null;
  await engine.handle(boomAdapter, {}, { headers: {}, setHeader() {}, writeHead() {}, write() {}, end() {} }, { respondError: () => {} }).then(
    () => { boomErr = "should not succeed"; },
    (e) => { boomErr = e.message; },
  );
  assert.match(boomErr, /sink boom/);
  for (const a of pool.all()) {
    assert.equal(a.inflight, 0, `${a.name} has ${a.inflight} left`);
  }
});

test("failover: empty pool -> 503 without RA", async () => {
  // No account to switch to; Retry-After is moot.
  write([]);
  pool.loadAccounts();
  const r3 = await runHandle();
  assert.equal(r3.status, 503);
  assert.equal(r3.headers["Retry-After"], undefined);
  Agent.create = realCreate;
  Cursor.models.list = realModelsList;
  Cursor.me = realMe2;
});

test("failover: pool exhausted by cooldowns -> 503 with Retry-After", async () => {
  // Accounts exist but every one is cooling: the client needs to know when
  // to come back, or it hammers the 503.
  write([
    { name: "R1", key: "crsr_r1", priority: 0 },
    { name: "R2", key: "crsr_r2", priority: 0 },
  ]);
  pool.loadAccounts();
  for (const a of pool.all()) {
    a.addedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    a.cooldownUntil = Date.now() + 120_000; // both cooling: nothing selectable
  }
  Agent.create = async () => { throw new Error("no account should be tried"); };
  const r = await runHandle();
  assert.equal(r.status, 503);
  assert.equal(r.headers["Retry-After"], "120", "the earliest thaw reaches the client");
  Agent.create = realCreate;
});

// ── P1: 429 typing (transient vs quota exhaustion) ────
test("setup: offline stubs for the P1/P2 sections", () => {
  // The failover section restored the real SDK; these sections need
  // Cursor.me / Cursor.models.list offline again (same call-time trick).
  // Must live inside a test: a module-level assignment would clobber the
  // meImpl routing the earlier add/probe tests rely on.
  Cursor.me = async (o) => {
    if (String(o.apiKey).includes("bad")) {
      throw Object.assign(new Error("Invalid User API Key"), { name: "AuthenticationError", status: 401 });
    }
    return { userEmail: o.apiKey.slice(-4) + "@example.com", apiKeyName: "batch" };
  };
  Cursor.models.list = async () => [{ id: "claude-opus-5", aliases: [], parameters: [] }];
});

test("429-typing: quota wording DISABLES the account for good (no cooldown resurrection)", () => {
  const q1 = new pool.Account({ key: "crsr_qt1" });
  const v = pool.reportFailure(q1, mkErr({ name: "RateLimitError", status: 429, message: "You have exceeded your usage limit for this model" }));
  assert.equal(v, Verdict.RETRY_OTHER, "the verdict domain is unchanged");
  assert.equal(q1.disabled, true, "quota exhaustion must disable the account (live bug: 30-min cooldown resurrected it and every client kept hitting usage errors)");
  assert.equal(q1.autoRecoverable, false, "the prober must never re-admit a quota-spent account");
  assert.equal(q1.cooldownUntil, null, "no cooldown timestamp left behind (releaseCooled would resurrect it)");
  assert.match(q1.disabledReason ?? "", /quota/i, "the reason must be recorded");
  assert.equal(q1.rateLimitStreak, 0, "quota exhaustion is not a rate-limit streak");
  assert.equal(q1.lastRateLimitAt, null);
  const q2 = new pool.Account({ key: "crsr_qt2" });
  pool.reportFailure(q2, mkErr({ name: "RateLimitError", status: 429, message: "billing spend limit reached" }));
  assert.equal(q2.disabled, true, "spend wording also types as quota (disabled, not cooldown)");
  const q3 = new pool.Account({ key: "crsr_qt3" });
  const info = pool.classifyError(mkErr({ name: "RateLimitError", status: 429, message: "quota exceeded" }));
  assert.equal(info.verdict, Verdict.RETRY_OTHER);
  assert.equal(info.quota, true, "classifyError marks the quota kind");
  const q4 = new pool.Account({ key: "crsr_qt4" });
  pool.reportFailure(q4, mkErr({ name: "RateLimitError", status: 429, code: "usage_limit_exceeded" }));
  assert.equal(q4.disabled, true, "the usage_limit_exceeded code types as quota even without a message (disabled)");
});

test("429-typing: plain rate limiting keeps the 5s x streak escalation", () => {
  const t1 = new pool.Account({ key: "crsr_tt1" });
  pool.reportFailure(t1, mkErr({ name: "RateLimitError", status: 429, message: "rate limited" }));
  assert.ok(gap(t1) >= 4_000 && gap(t1) <= 6_000, `transient stays at 5s, actual ${gap(t1)}ms`);
  assert.equal(t1.rateLimitStreak, 1);
  pool.reportFailure(t1, mkErr({ name: "RateLimitError", status: 429, message: "rate limited" }));
  assert.ok(gap(t1) >= 9_000 && gap(t1) <= 11_000, "second hit escalates to 10s");
  assert.equal(pool.classifyError(mkErr({ status: 429, message: "rate limited" })).quota, undefined, "transient 429s carry no quota mark");
  assert.equal(pool.classifyError(mkErr({ status: 429, message: "rate limit exceeded" })).quota, undefined, "'exceeded' is not 'exhausted'");
  const c = new pool.Account({ key: "crsr_tt2" });
  pool.reportFailure(c, mkErr({ status: 429, message: "concurrency limit exhausted, retry shortly" }));
  assert.ok(gap(c) >= 4_000 && gap(c) <= 6_000, "'exhausted' without quota context is a transient throttle");
});

test("429-typing: quota on a half-open account disables it outright", () => {
  const h = new pool.Account({ key: "crsr_qh1" });
  h.halfOpen = true;
  pool.reportFailure(h, mkErr({ status: 429, message: "monthly quota exhausted" }));
  assert.equal(h.disabled, true, "quota exhaustion during half-open probing disables, not re-cooldowns");
  assert.equal(h.halfOpen, false, "half-open state must be cleared on disable");
  assert.equal(h.cooldownUntil, null, "no resurrection path left");
});

// ── P1: bare resource_exhausted (gRPC code 8) ────────
test("resource_exhausted: model-gate wording returns to the client, throttle wording fails over", () => {
  assert.equal(
    pool.classify(mkErr({ status: 429, code: "resource_exhausted", message: "model not allowed for your account, please upgrade" })),
    Verdict.RETURN,
    "a gated account must not pin the whole pool",
  );
  assert.equal(
    pool.classify(mkErr({ status: 429, code: "resource_exhausted", message: "model restricted on this plan" })),
    Verdict.RETURN,
  );
  assert.equal(
    pool.classify(mkErr({ status: 429, code: "resource_exhausted", message: "rate limit exceeded" })),
    Verdict.RETRY_OTHER,
    "a real throttle still fails over",
  );
  const g = new pool.Account({ key: "crsr_re1" });
  pool.reportFailure(g, mkErr({ status: 429, code: "resource_exhausted", message: "model not allowed, upgrade" }));
  assert.equal(g.cooldownUntil, null, "gate cases don't cooldown the account");
  assert.equal(g.disabled, false);
  const up = new pool.Account({ key: "crsr_re4" });
  pool.reportFailure(up, mkErr({ status: 429, code: "resource_exhausted", message: "You have hit your maximum rate. Upgrade your plan to increase your limits" }));
  assert.ok(gap(up) >= 4_000 && gap(up) <= 6_000, "'upgrade your plan' rate-limit copy is a throttle, not a gate");
  const t = new pool.Account({ key: "crsr_re2" });
  pool.reportFailure(t, mkErr({ status: 429, code: "resource_exhausted", message: "rate limit exceeded" }));
  assert.ok(gap(t) >= 4_000 && gap(t) <= 6_000, "throttle resource_exhausted gets the 5s cooldown");
  const q = new pool.Account({ key: "crsr_re3" });
  pool.reportFailure(q, mkErr({ status: 429, code: "resource_exhausted", message: "monthly quota exhausted" }));
  assert.equal(q.disabled, true, "quota-wording resource_exhausted disables the account");
  assert.equal(q.cooldownUntil, null, "no cooldown timestamp (releaseCooled must not resurrect it)");
});

// ── P1: new spec error codes ──────────────────────────
test("codes: client-side codes RETURN, transient codes RETRY_OTHER", () => {
  assert.equal(pool.classify(mkErr({ status: 409, code: "agent_id_conflict" })), Verdict.RETURN);
  assert.equal(pool.classify(mkErr({ status: 409, code: "agent_archived" })), Verdict.RETURN);
  assert.equal(pool.classify(mkErr({ status: 403, code: "service_account_required" })), Verdict.RETURN);
  assert.equal(pool.classify(mkErr({ status: 400, code: "stream_unavailable" })), Verdict.RETRY_OTHER, "stream_unavailable switches even on a 4xx");
  assert.equal(pool.classify(mkErr({ status: 403, code: "feature_unavailable" })), Verdict.RETRY_OTHER, "usage-403 stays account-scoped (existing behavior)");
});

// ── P2: region-block fallback ─────────────────────────
test("region: a region-blocked account fails over with no cooldown, stays in rotation", () => {
  write([
    { name: "RgA", key: "crsr_rga", priority: 0 },
    { name: "RgB", key: "crsr_rgb", priority: 0 },
  ]);
  pool.loadAccounts();
  for (const a of pool.all()) a.addedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const a = pool.all().find((x) => x.name === "RgA");
  const b = pool.all().find((x) => x.name === "RgB");
  const info = pool.classifyError(mkErr({ status: 400, message: "model claude-opus-5 is not supported in your region" }));
  assert.equal(info.verdict, Verdict.RETRY_OTHER, "one account's region block must switch, not RETURN");
  assert.equal(info.regionBlocked, true);
  assert.equal(
    pool.classifyError(mkErr({ status: 400, message: "model claude-opus-5 is unavailable in your region" })).regionBlocked,
    true,
    "'unavailable in your region' is the same block",
  );
  const v = pool.reportFailure(a, mkErr({ status: 400, message: "not supported in your region" }));
  assert.equal(v, Verdict.RETRY_OTHER);
  assert.equal(a.cooldownUntil, null, "no cooldown: the account may serve other models");
  assert.equal(a.disabled, false, "never disabled");
  assert.equal(a.suspiciousStreak, 0, "and never suspicious");
  assert.equal(pool.select([b.id]).id, a.id, "the region-blocked account remains in rotation");
});

test("region: every account region-blocked -> explicit 502, not 503", async () => {
  write([
    { name: "Rg1", key: "crsr_rg1", priority: 0 },
    { name: "Rg2", key: "crsr_rg2", priority: 0 },
  ]);
  pool.loadAccounts();
  for (const a of pool.all()) a.addedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const realCreateRegion = Agent.create;
  Agent.create = async () => {
    throw Object.assign(new Error("model claude-opus-5 is not supported in your region"), { status: 400 });
  };
  const r = await runHandle();
  assert.equal(r.status, 502, "region exhaustion is a client-facing 502 (with the message), never a 503");
  for (const a of pool.all()) {
    assert.equal(a.cooldownUntil, null, `no account is cooled by a region block (${a.name})`);
  }
  Agent.create = realCreateRegion;
});

// ── P2: batchOps single-write merge ───────────────────
test("batchOps: 500 ids = one file write (merge, not per-id serialization)", async () => {
  const big = Array.from({ length: 500 }, (_, i) => ({ name: `K${i}`, key: `crsr_k${i}` }));
  write(big);
  pool.loadAccounts();
  const ids = pool.all().map((a) => a.id);
  assert.equal(ids.length, 500);

  const events = [];
  const watcher = fs.watch(dir, (_ev, fn) => {
    if (String(fn ?? "").includes("stats") || String(fn ?? "").includes("accounts")) events.push(fn);
  });
  try {
    const dis = await pool.batchOps(ids, "disable");
    assert.equal(dis.ok.length, 500);
    assert.ok(pool.all().every((a) => a.disabled), "all 500 disabled");
    const del = await pool.batchOps(ids, "delete");
    assert.equal(del.ok.length, 500);
    assert.equal(pool.all().length, 0, "pool emptied in one pass");
    assert.deepEqual(readFile(), [], "the accounts file holds exactly the final state");
    await new Promise((r) => setTimeout(r, 200)); // let FSEvents drain
  } finally {
    watcher.close();
  }
  assert.ok(events.length < 50, `batched writes, not per-id: saw ${events.length} file events (per-id would be ~3000)`);
});

// ── P2: addAccount write serialization ────────────────
test("write-queue: concurrent adds both land (no lost update)", async () => {
  write([]);
  pool.loadAccounts();
  const [a1, a2] = await Promise.all([
    pool.addAccount({ key: "crsr_wq1", name: "W1" }),
    pool.addAccount({ key: "crsr_wq2", name: "W2" }),
  ]);
  assert.ok(a1.id && a2.id);
  assert.deepEqual(readFile().map((x) => x.key).sort(), ["crsr_wq1", "crsr_wq2"], "both keys persisted");
  assert.equal(pool.all().length, 2);
});

test("write-queue: the same key raced twice -> one 409, no duplicate row", async () => {
  const [r1, r2] = await Promise.allSettled([
    pool.addAccount({ key: "crsr_wq3" }),
    pool.addAccount({ key: "crsr_wq3" }),
  ]);
  const okCount = [r1, r2].filter((r) => r.status === "fulfilled").length;
  assert.equal(okCount, 1, "exactly one add wins");
  const fail = [r1, r2].find((r) => r.status === "rejected");
  assert.equal(fail.reason.httpStatus, 409);
  assert.equal(readFile().filter((x) => x.key === "crsr_wq3").length, 1, "the file has the key exactly once");
});

test("write-queue: an in-flight add never resurrects a concurrently removed account", async () => {
  write([
    { name: "R", key: "crsr_race" },
    { name: "Other", key: "crsr_race2" },
  ]);
  pool.loadAccounts();
  const r = pool.all().find((x) => x.key === "crsr_race");
  const slowMe = Cursor.me;
  Cursor.me = async (o) => {
    await new Promise((res) => setTimeout(res, 50)); // hold the add's validation open
    return slowMe(o);
  };
  const adding = pool.addAccount({ key: "crsr_race3" });
  await new Promise((res) => setTimeout(res, 10)); // let the add reach the network wait
  pool.removeAccount(r.id); // sync remove lands while the add is mid-validation
  const result = await adding;
  Cursor.me = slowMe;
  assert.ok(result.id);
  const keys = readFile().map((x) => x.key);
  assert.ok(!keys.includes("crsr_race"), "the removed account must not come back");
  assert.ok(keys.includes("crsr_race3"), "the add still lands");
});

test("batchOps: a failed delete write leaves both file and pool untouched", async () => {
  write([
    { name: "D1", key: "crsr_d1" },
    { name: "D2", key: "crsr_d2" },
  ]);
  pool.loadAccounts();
  const ids = pool.all().map((a) => a.id);
  fs.chmodSync(dir, 0o500); // read-only dir: the tmp file cannot be created
  let err = null;
  try {
    await pool.batchOps(ids, "delete");
  } catch (e) {
    err = e;
  }
  fs.chmodSync(dir, 0o700); // restore, or the cleanup rmSync fails
  assert.ok(err, "the write failure must surface");
  assert.equal(pool.all().length, 2, "the pool is untouched when the write fails");
  assert.equal(readFile().length, 2, "the file is untouched too");
});

// ── P2: ledger.accounts cap ───────────────────────────
test("ledger: per-account entries are capped at 200, least-recently-active evicted", () => {
  pool.resetAggForTest();
  for (let i = 0; i < 210; i++) pool.recordRequest("m", true, 1, `cap-${i}`);
  assert.equal(pool.getStats().accounts.length, 200, "the cap holds");
  pool.recordRequest("cap-0", true, 1, "cap-0"); // reactivate the evicted-oldest
  pool.recordRequest("m", true, 1, "cap-210");   // push one more over the cap
  const ids = pool.getStats().accounts.map((a) => a.id);
  assert.equal(ids.length, 200);
  assert.ok(ids.includes("cap-0"), "a recently-active entry survives");
  assert.ok(!ids.includes("cap-10"), "the least-recently-active entry is evicted");
});

// ── P2: pool event subscriptions ───────────────────────
test("pool events: disable / cooldown / half-open transitions fire", () => {
  const events = [];
  const unsub = pool.subscribePoolEvents((e) => events.push(e));
  try {
    const a = new pool.Account({ key: "crsr_evt1", name: "evt1" });
    pool.reportFailure(a, mkErr({ name: "AuthenticationError", status: 401 }));
    assert.equal(events.at(-1).event, "disabled", "a 401 disable must fire");
    assert.equal(events.at(-1).id, a.id);
    assert.equal(events.at(-1).name, "evt1");
    assert.match(events.at(-1).reason ?? "", /AuthenticationError/);

    const b = new pool.Account({ key: "crsr_evt2" });
    pool.reportFailure(b, mkErr({ name: "RateLimitError", status: 429, message: "rate limited" }));
    assert.equal(events.at(-1).event, "cooldown", "a 429 cooldown must fire");
    assert.equal(events.at(-1).cooldownUntil, b.cooldownUntil);

    // A session-auth failure disables with a cooldown (autoRecoverable=false);
    // once it expires, tryRelease re-admits into the half-open gate.
    pool.reportFailure(b, new Error("run error: Authentication error If you are logged in, try logging out and back in."));
    assert.equal(events.at(-1).event, "disabled", "a session auth failure disables");
    assert.equal(b.autoDisabled, true);
    b.cooldownUntil = Date.now() - 1;
    assert.equal(b.tryRelease(), true);
    assert.equal(events.at(-1).event, "half-open", "cooldown expiry re-admits into the half-open gate");
  } finally {
    unsub();
  }
});

test("pool events: recovery fires on consecutive successes and on probe", async () => {
  const events = [];
  const unsub = pool.subscribePoolEvents((e) => events.push(e));
  const prevMe = Cursor.me;
  try {
    const a = new pool.Account({ key: "crsr_evt3" });
    a.halfOpen = true;
    a.halfOpenStreak = config.halfOpenSuccesses - 1;
    pool.reportSuccess(a, {});
    assert.equal(events.at(-1).event, "recovered", "N consecutive successes fully re-admit");
    assert.equal(a.halfOpen, false);

    Cursor.me = async () => ({ userEmail: "back@example.com", apiKeyName: "k" });
    const b = new pool.Account({ key: "crsr_evt4" });
    b.autoDisabled = true;
    b.autoRecoverable = true;
    await pool.probe(b);
    assert.equal(events.at(-1).event, "recovered", "a successful probe re-admits");
    assert.equal(events.at(-1).reason, "probe");
    assert.equal(b.disabled, false);

    Cursor.me = async () => { throw Object.assign(new Error("x"), { name: "AuthenticationError", status: 401 }); };
    const c = new pool.Account({ key: "crsr_evt5" });
    await pool.probe(c);
    assert.equal(events.at(-1).event, "disabled", "a failing probe disables");
    assert.match(events.at(-1).reason ?? "", /probe/);
  } finally {
    Cursor.me = prevMe;
    unsub();
  }
});

// ── P3: addedAt rank cache (bench bottleneck 2) ────────
test("select: the addedAt cache ranks identically and follows mutations", async () => {
  // Regression: rankVector used to Date.parse(addedAt) on every sort
  // comparison (535µs/select @200 accounts). The cached addedAtMs must
  // (a) rank the ramp dimension exactly as before and (b) invalidate when
  // addedAt is mutated directly — a stale cache would lock an aged account
  // out of selection forever.
  write([
    { name: "C1", key: "crsr_c1", priority: 0 },
    { name: "C2", key: "crsr_c2", priority: 0 },
  ]);
  pool.loadAccounts();
  const c1 = pool.all().find((a) => a.name === "C1");
  const c2 = pool.all().find((a) => a.name === "C2");
  c1.addedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  c2.addedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  // Both outside the grace window: full tie -> round-robin.
  const seen = new Set();
  for (let i = 0; i < 2; i++) seen.add(pool.select().name);
  assert.deepEqual([...seen].sort(), ["C1", "C2"], "aged accounts are both pickable");

  // A fresh account (inside the 5-min ramp) must sort last, as before.
  await pool.addAccount({ key: "crsr_c3", name: "C3", priority: 0 });
  for (let i = 0; i < 6; i++) {
    assert.notEqual(pool.select().name, "C3", "fresh-account slow start must hold with the cache");
  }

  // Direct mutation invalidates the cache: an aged C3 re-enters contention.
  const c3 = pool.all().find((a) => a.name === "C3");
  c3.addedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const seen2 = new Set();
  for (let i = 0; i < 3; i++) seen2.add(pool.select().name);
  assert.ok(seen2.has("C3"), "a mutated addedAt must be re-ranked, not served stale");
});

await run();
fs.rmSync(dir, { recursive: true, force: true });

if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`account pool: all passed (${passed.length} tests)`);
