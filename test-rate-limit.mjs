// Data-plane rate limiting: per-IP fixed window behind auth. Unit tests
// exercise the limiter semantics with an injectable short window; one
// spawned server (bench/server.mjs, mock SDK, no network) verifies the real
// HTTP surface: 429 + Retry-After, and per-IP buckets through
// X-Forwarded-For.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// app.mjs boots on import (listens, starts the prober, pre-warms the
// catalog). Tame the environment first: ephemeral port, empty pool — the
// catalog pre-warm then fails fast without touching the network, and the
// prober has no account to visit.
process.env.CURSOR_PORT = "0";
process.env.CURSOR_HOST = "127.0.0.1";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-rate-test-"));
const accountsFile = path.join(dir, "accounts.json");
fs.writeFileSync(accountsFile, "[]", "utf8");
process.env.CURSOR_ACCOUNTS = accountsFile;
process.env.CURSOR_PROBE_INTERVAL_MS = "0";
process.env.CURSOR_CLIENT_KEYS = "sk-test";
process.env.CURSOR_RATE_LIMIT_PER_MIN = "0";

const { config } = await import("./src/settings.mjs");
const { clientIp, isPublicIp, createRateLimiter } = await import("./src/app.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (xff, socket = "127.0.0.1") => ({
  headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  socket: { remoteAddress: socket },
});

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

// ── client identity ─────────────────────────────────────
test("clientIp: socket address when there is no X-Forwarded-For", () => {
  assert.equal(clientIp(req()), "127.0.0.1");
  assert.equal(clientIp(req(undefined, "::1")), "::1");
  assert.equal(clientIp({ headers: {} }), "", "no socket at all must not throw");
});

test("clientIp: XFF ignored entirely without a trusted proxy", () => {
  config.trustedProxy = [];
  assert.equal(clientIp(req("1.2.3.4")), "127.0.0.1", "no proxy configured: socket wins");
  assert.equal(clientIp(req("1.2.3.4, 5.6.7.8")), "127.0.0.1", "a chain is ignored too");
  assert.equal(clientIp(req("::ffff:1.2.3.4")), "127.0.0.1", "mapped IPv6 XFF is ignored");
  assert.equal(clientIp(req(undefined, "2001:db8::1")), "2001:db8::1", "socket IPv6 passes through");
});

test("clientIp: XFF believed only from a trusted proxy, rightmost public segment", () => {
  config.trustedProxy = ["127.0.0.1"];
  assert.equal(clientIp(req("1.2.3.4")), "1.2.3.4", "trusted peer: rightmost public hop believed");
  assert.equal(clientIp(req("1.2.3.4, 5.6.7.8")), "5.6.7.8", "a chain resolves to the last hop");
  assert.equal(clientIp(req("1.2.3.4 ,")), "1.2.3.4", "trailing whitespace is trimmed");
  assert.equal(clientIp(req("::ffff:9.9.9.9")), "9.9.9.9", "mapped IPv6 XFF normalizes");
  config.trustedProxy = [];
});

test("clientIp: forged private / bogus XFF falls back to the socket", () => {
  config.trustedProxy = ["127.0.0.1"];
  const forged = [
    "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "127.0.0.1", "169.254.1.1", "100.64.1.1", "0.0.0.0",
    "224.0.0.1", "300.1.2.3", "not-an-ip", "::1", "fe80::1", "fc00::1",
  ];
  for (const xff of forged) {
    assert.equal(clientIp(req(xff)), "127.0.0.1", `XFF ${xff} must not be trusted`);
  }
  config.trustedProxy = [];
});

test("clientIp: an untrusted socket peer is not believed even with XFF", () => {
  config.trustedProxy = ["203.0.113.5"];
  assert.equal(clientIp(req("1.2.3.4", "10.0.0.9")), "10.0.0.9", "socket not in the trust list: XFF ignored");
  config.trustedProxy = [];
});

test("clientIp: IPv4-mapped IPv6 normalizes; public IPv6 passes", () => {
  assert.equal(isPublicIp("1.2.3.4"), true);
  assert.equal(isPublicIp("10.0.0.1"), false);
  assert.equal(isPublicIp("2001:db8::1"), true);
  assert.equal(isPublicIp("fe80::1"), false);
});

// ── limiter semantics (injectable window) ───────────────
test("rate limit: off by default (0) — everything passes", () => {
  config.rateLimitPerMin = 0;
  const lim = createRateLimiter({ windowMs: 100 });
  for (let i = 0; i < 50; i++) assert.equal(lim.check(req()), null);
});

test("rate limit: same IP over the limit is refused; different IPs are independent", () => {
  config.rateLimitPerMin = 2;
  const lim = createRateLimiter({ windowMs: 100 });
  const a = req();
  const b = req(undefined, "127.0.0.2");
  assert.equal(lim.check(a), null);
  assert.equal(lim.check(a), null);
  const ra = lim.check(a);
  assert.ok(ra != null && ra > 0 && ra <= 100, `third same-IP request must be refused, got ${ra}`);
  assert.equal(lim.check(b), null, "a different IP has its own budget");
  assert.equal(lim.check(b), null);
  assert.ok(lim.check(b) != null);
});

test("rate limit: window expiry restores the budget", async () => {
  config.rateLimitPerMin = 2;
  const lim = createRateLimiter({ windowMs: 100 });
  const r = req();
  assert.equal(lim.check(r), null);
  assert.equal(lim.check(r), null);
  assert.ok(lim.check(r) != null, "over the limit inside the window");
  await sleep(150);
  assert.equal(lim.check(r), null, "a fresh window re-admits the IP");
});

test("rate limit: XFF cannot split buckets without a trusted proxy", () => {
  config.rateLimitPerMin = 2;
  config.trustedProxy = [];
  const lim = createRateLimiter({ windowMs: 100 });
  // No trusted proxy: every request lands in the socket bucket regardless
  // of XFF — a client cannot earn a fresh bucket per forged header value.
  const r = req("1.2.3.4");
  assert.equal(lim.check(r), null);
  assert.equal(lim.check(r), null);
  assert.ok(lim.check(r) != null, "forged public XFF must share the socket budget");
  assert.ok(lim.check(req("5.6.7.8")) != null, "another forged XFF is still the same socket");
  // With a trusted proxy, the rightmost public hop is its own bucket.
  config.trustedProxy = ["127.0.0.1"];
  const lim2 = createRateLimiter({ windowMs: 100 });
  assert.equal(lim2.check(req("1.2.3.4")), null);
  assert.equal(lim2.check(req("1.2.3.4")), null);
  assert.ok(lim2.check(req("1.2.3.4")) != null, "1.2.3.4 exhausts its own budget");
  assert.equal(lim2.check(req("5.6.7.8")), null, "another public XFF is a separate bucket");
  const forged = req("10.0.0.9");
  assert.equal(lim2.check(forged), null);
  assert.equal(lim2.check(forged), null);
  assert.ok(lim2.check(forged) != null, "a private XFF cannot dodge the socket budget");
  config.trustedProxy = [];
});

test("rate limit: cap bounds the map — the oldest bucket is evicted", () => {
  config.rateLimitPerMin = 1;
  const lim = createRateLimiter({ windowMs: 100, cap: 2 });
  const a = req(undefined, "1.1.1.1");
  const b = req(undefined, "2.2.2.2");
  const c = req(undefined, "3.3.3.3");
  assert.equal(lim.check(a), null);
  assert.equal(lim.check(b), null);
  assert.equal(lim.size(), 2);
  lim.check(c);
  assert.equal(lim.size(), 2, "past the cap the oldest bucket is evicted");
  assert.equal(lim.check(a), null, "an evicted IP is forgotten");
});

// ── integration: the real HTTP surface (spawned server) ──
const benchServer = fileURLToPath(new URL("./bench/server.mjs", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [benchServer], {
    env: { ...process.env, ...env, BENCH_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errBuf = "";
  child.stderr.on("data", (d) => { errBuf += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode != null) {
      throw new Error(`server exited early (${child.exitCode}): ${errBuf}`);
    }
    try {
      const r = await fetch(`${base}/ping`);
      if (r.status === 200) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`server did not come up: ${errBuf}`);
    await sleep(100);
  }
  return { child, base };
}

async function stopServer(child) {
  if (child.exitCode == null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(3000)]);
    if (child.exitCode == null) child.kill("SIGKILL");
  }
}

async function chat(base, headers = {}) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: r.status, retryAfter: r.headers.get("retry-after"), body: await r.json() };
}

function intAccountsFile(name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify([{ name: "int-a", key: "crsr_int_a" }]), "utf8");
  return file;
}

test("http: over the limit answers 429 with Retry-After and a JSON error body", async () => {
  const { child, base } = await startServer({
    BENCH_ACCOUNTS: intAccountsFile("int-accounts.json"),
    CURSOR_RATE_LIMIT_PER_MIN: "2",
  });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await chat(base);
      assert.equal(r.status, 200, `request ${i + 1} must pass`);
    }
    const over = await chat(base);
    assert.equal(over.status, 429, "the third same-IP request must be refused");
    assert.ok(Number.parseInt(over.retryAfter ?? "", 10) >= 1, `Retry-After must be set, got ${over.retryAfter}`);
    assert.equal(over.body?.error?.type, "rate_limit_error");
    assert.equal(over.body?.error?.code, 429);
  } finally {
    await stopServer(child);
  }
});

test("http: XFF does not split buckets without a trusted proxy", async () => {
  const { child, base } = await startServer({
    BENCH_ACCOUNTS: intAccountsFile("int-accounts2.json"),
    CURSOR_RATE_LIMIT_PER_MIN: "2",
  });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await chat(base);
      assert.equal(r.status, 200, `socket-bucket request ${i + 1} must pass`);
    }
    // No trusted proxy configured: even a public XFF lands in the socket
    // bucket — forging headers cannot reset the window.
    const forged = await chat(base, { "x-forwarded-for": "9.9.9.9" });
    assert.equal(forged.status, 429, "a public XFF must share the exhausted socket bucket");
  } finally {
    await stopServer(child);
  }
});

test("http: a trusted proxy's XFF earns its own bucket", async () => {
  const { child, base } = await startServer({
    BENCH_ACCOUNTS: intAccountsFile("int-accounts4.json"),
    CURSOR_RATE_LIMIT_PER_MIN: "2",
    CURSOR_TRUSTED_PROXY: "127.0.0.1",
  });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await chat(base);
      assert.equal(r.status, 200, `socket-bucket request ${i + 1} must pass`);
    }
    const proxied = await chat(base, { "x-forwarded-for": "9.9.9.9" });
    assert.equal(proxied.status, 200, "a public XFF through a trusted proxy earns its own bucket");
    const forged = await chat(base, { "x-forwarded-for": "10.0.0.1" });
    assert.equal(forged.status, 429, "a private XFF falls back to the exhausted socket bucket");
  } finally {
    await stopServer(child);
  }
});

test("http: the limit defaults to off — nothing is refused", async () => {
  const { child, base } = await startServer({
    BENCH_ACCOUNTS: intAccountsFile("int-accounts3.json"),
  });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await chat(base);
      assert.equal(r.status, 200, `request ${i + 1} must pass with the limiter off`);
    }
  } finally {
    await stopServer(child);
  }
});

await run();
fs.rmSync(dir, { recursive: true, force: true });
if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`rate limit: all passed (${passed.length} tests)`);
// app.mjs keeps an ephemeral listener alive in this process — exit explicitly.
process.exit(0);
