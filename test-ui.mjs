// Admin UI: actually **run** the page's scripts and verify what they
// requested the way a browser would. After the 2026-08-12 deployment the
// page served 200 HTML yet was blank — relative fetch("status") from
// /admin resolved to /status and 401'd. Browser URL semantics are the
// test, not grep over the HTML.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

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

const ADMIN = "adm-" + Math.random().toString(16).slice(2);
const PORT = 39000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
// No trailing slash — that is exactly the case under test.
const PAGE_URL = `${BASE}/admin`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-ui-"));
const accountsPath = path.join(dir, "accounts.json");
fs.writeFileSync(accountsPath, JSON.stringify([
  { name: "测试号", key: "crsr_" + "a".repeat(48), priority: 0 },
]));

const child = spawn(process.execPath, ["src/app.mjs"], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    // CI runners may run under systemd — supervisor detection must stay
    // off for the restart test (expects 409 without a supervisor).
    INVOCATION_ID: undefined,
    PM2_USAGE: undefined,
    pm_id: undefined,
    CURSOR_PORT: String(PORT),
    CURSOR_HOST: "127.0.0.1",
    CURSOR_ACCOUNTS: accountsPath,
    CURSOR_ADMIN_KEY: ADMIN,
    CURSOR_CLIENT_KEYS: "sk-test",
    CURSOR_PROBE_INTERVAL_MS: "0", // no probing: fake keys, probing would hit the real network
    CURSOR_LOG_LEVEL: "error",
    CURSOR_READ_BODY_TIMEOUT_MS: "500", // the 60s default is 500ms here so the timeout tests finish fast
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let childErr = "";
child.stderr.on("data", (b) => { childErr += b; });

// The SSE drop test boots a second instance with the log-flood preload.
let child2 = null;
let sseDir = null;

function cleanup() {
  try { child.kill("SIGKILL"); } catch {}
  try { child2?.kill("SIGKILL"); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  try { fs.rmSync(sseDir, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  await new Promise((r) => setTimeout(r, 100));
  try { up = (await fetch(`${BASE}/ping`)).ok; } catch {}
}
assert.ok(up, `service did not come up. stderr:\n${childErr}`);

const auth = { authorization: "Bearer " + ADMIN };
let html = "";

// ── the page itself ─────────────────────────────────────
test("page: /admin and /admin/ serve HTML to admins", async () => {
  for (const u of [`${BASE}/admin`, `${BASE}/admin/`]) {
    const r = await fetch(u, { headers: auth });
    assert.equal(r.status, 200, `${u} should serve the page`);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/, `${u} should be HTML`);
  }
  html = await (await fetch(PAGE_URL, { headers: auth })).text();
});

test("page: no route carries WWW-Authenticate — the native login dialog must never pop", async () => {
  // It used to be 401 + WWW-Authenticate: Basic and let the browser pop a
  // dialog that clashes with the UI, offers no guidance, and **cannot be
  // exited** (Basic credentials have no "logout"). Now unauthenticated page
  // visits get the login page (200), and APIs get 401 JSON.
  for (const p of ["/admin", "/admin/", "/admin/status", "/admin/models", "/admin/nonsense"]) {
    const r = await fetch(`${BASE}${p}`);
    assert.equal(r.headers.get("www-authenticate"), null, `${p} must not carry WWW-Authenticate`);
  }
});

test("page: unauthenticated visits get the login page, not 401", async () => {
  const anon = await fetch(PAGE_URL);
  assert.equal(anon.status, 200);
  const anonHtml = await anon.text();
  assert.match(anonHtml, /管理口令/, "that must be a login page");
  assert.ok(!anonHtml.includes("crsr_"), "the login page must not carry any pool info");
  assert.equal((await fetch(`${BASE}/admin/status`)).status, 401, "APIs without a session still 401");
});

// ── login / logout round trip ───────────────────────────
test("login: wrong password -> 401 and no cookie", async () => {
  const bad = await fetch(`${BASE}/admin/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "猜的" }),
  });
  assert.equal(bad.status, 401, "wrong password must be refused");
  assert.equal(bad.headers.get("set-cookie"), null, "refused -> no cookie");
});

test("login: right password -> session cookie with HttpOnly, SameSite, Path", async () => {
  const good = await fetch(`${BASE}/admin/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: ADMIN }),
  });
  assert.equal(good.status, 200);
  const setCookie = good.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /cursorapi_sess=[\w-]+/, "must issue a session cookie");
  assert.match(setCookie, /HttpOnly/i, "otherwise XSS reads the session directly");
  assert.match(setCookie, /SameSite=Strict/i, "against CSRF");
  assert.match(setCookie, /Path=\/admin/i, "don't spread the cookie onto /v1");
  // On plain HTTP, adding Secure makes the browser refuse the cookie,
  // showing up as "logged in, then bounced back to the login page".
  assert.ok(!/Secure/i.test(setCookie), "no HTTPS -> no Secure");

  const sess = { cookie: /cursorapi_sess=[^;]+/.exec(setCookie)[0] };
  assert.equal((await fetch(`${BASE}/admin/status`, { headers: sess })).status, 200, "with the cookie it must get in");
  const pageBySess = await fetch(PAGE_URL, { headers: sess });
  assert.match(await pageBySess.text(), /号池/, "with the cookie, the main page (not the login page) comes back");
});

test("login: behind HTTPS (X-Forwarded-Proto) the cookie must be Secure", async () => {
  const https = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
    body: JSON.stringify({ key: ADMIN }),
  });
  assert.match(https.headers.get("set-cookie") ?? "", /Secure/i);
});

test("logout: the session dies immediately", async () => {
  const good = await fetch(`${BASE}/admin/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: ADMIN }),
  });
  const sess = { cookie: /cursorapi_sess=[^;]+/.exec(good.headers.get("set-cookie") ?? "")[0] };
  await fetch(`${BASE}/admin/logout`, { method: "POST", headers: sess });
  assert.equal((await fetch(`${BASE}/admin/status`, { headers: sess })).status, 401);
});

test("requests route: 401 unauthenticated, 200 with items for admins", async () => {
  const anon = await fetch(`${BASE}/admin/requests`);
  assert.equal(anon.status, 401, "APIs without a session 401");
  const r = await fetch(`${BASE}/admin/requests`, { headers: auth });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.items), "items array");
  const small = await fetch(`${BASE}/admin/requests?limit=3`, { headers: auth });
  assert.ok((await small.json()).items.length <= 3, "limit is honored");
  const huge = await fetch(`${BASE}/admin/requests?limit=9999`, { headers: auth });
  assert.ok((await huge.json()).items.length <= 500, "limit is capped at 500");
  const garbage = await fetch(`${BASE}/admin/requests?limit=abc`, { headers: auth });
  assert.ok((await garbage.json()).items.length <= 50, "garbage limit falls back to the default");
});

test("readBody: a stalled request body gets 408, never a hang", async () => {
  // One byte then silence: the server must cut the read off at the deadline
  // (500ms in the test env) with a 408 instead of holding the connection.
  const t0 = Date.now();
  const r = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({ start(c) { c.enqueue(Buffer.from('{"key":"x')); } }),
    duplex: "half",
  });
  assert.equal(r.status, 408, "a slow body must be 408");
  assert.ok(Date.now() - t0 < 10_000, "the deadline must fire, not hang");
  assert.equal((await fetch(`${BASE}/ping`)).ok, true, "the server must still serve after cutting the connection");
});

test("page: the HTML never contains a raw key", () => {
  assert.ok(!html.includes("crsr_aaa"), "page HTML must not contain raw keys");
});

// ── fake DOM + execute the page script ──────────────────
/** The smallest DOM this page needs. Add what's missing; no jsdom — installing a whole browser for one test isn't worth it. */
function makeEl(id) {
  const el = {
    id, value: "", disabled: false, className: "", title: "",
    textContent: "", innerHTML: "", style: {}, dataset: {}, checked: false,
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    focus() {},
  };
  return el;
}
const els = new Map();
const $ = (id) => {
  if (!els.has(id)) els.set(id, makeEl(id));
  return els.get(id);
};

let sandbox = null;
let asked = [];
let accId = null;
// perform 的响应可替换：默认 200；失败场景测试把它换成 409 / 挂起的 gate
let performMock = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });

test("script: executes in a fake DOM and every core UI action fires its endpoint", async () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, "no <script> found in the page");

  const realStatus = await (await fetch(`${BASE}/admin/status`, { headers: auth })).json();
  assert.equal(realStatus.accounts.length, 1, "the test pool must have exactly one account");
  accId = realStatus.accounts[0].id;

  asked = [];
  sandbox = {
    document: {
      getElementById: $,
      // Sidebar nav: two real elements so go()'s highlight logic runs
      // (.dataset / .className).
      querySelectorAll: () => [
        Object.assign(makeEl("nav1"), { dataset: { v: "pool" } }),
        Object.assign(makeEl("nav2"), { dataset: { v: "models" } }),
      ],
      createElement: (t) => makeEl(t),
    },
    location: { origin: BASE, hash: "", reload: () => {}, replace: () => {} },
    window: { addEventListener: () => {} },
    confirm: () => true,
    setInterval: () => 0,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    Date, Math, String, Number, JSON, console,
    fetch: async (url, init) => {
      asked.push({ url, init });
      // The page expects specific response shapes per endpoint; feed it
      // matching ones, which also exercises "does rendering real data
      // throw". Backend still evolving in parallel: logs/stats/config/
      // update/export may not have real routes yet, so mock the contract
      // shapes; SSE is mocked as plain JSON (no res.body) and the page must
      // tolerate it by showing placeholders instead of crashing.
      let reqBody = null;
      try { reqBody = init && init.body ? JSON.parse(init.body) : null; } catch { reqBody = null; }
      const u = String(url);
      // perform 的响应由 performMock 完整提供（ok/status/text 都要真）——
      // 错误分类靠真实 status，包装层写死 200 会把 409 吞掉
      if (u.includes("update/perform")) return performMock();
      const body = u.includes("models") ? { models: [{ id: "claude-opus-5", parameters: [{ id: "fast", values: ["true", "false"] }] }] }
        : u.includes("stats") ? {
            totals: { requests: 1234, success: 1200, errors: 34, tokens: { input: 100000, output: 50000, cacheRead: 20000, cacheWrite: 8000 } },
            models: [
              { id: "claude-opus-5", requests: 900, success: 880, errors: 20, avgMs: 1200 },
              { id: "gpt-5", requests: 334, success: 320, errors: 14, avgMs: 800 },
            ],
            hourlyBuckets: [
              { t: "09:00", requests: 10, success: 9, errors: 1 },
              { t: "10:00", requests: 22, success: 21, errors: 1 },
              { t: "11:00", requests: 15, success: 14, errors: 1 },
            ],
          }
        : u.includes("update/check") ? { mode: "docker", current: "0.1.0", latest: "0.2.0", behind: 1, hasUpdate: true }
        : u.includes("update/status") ? { state: "idle", message: "" }
        : u.includes("requests") ? { items: [
              { ts: 1720000000000, model: "claude-opus-5", accountId: "acc_12345678", accountName: "测试号", success: true, ms: 812, tokens: { input: 1200, output: 340, cacheRead: 50, cacheWrite: 0 } },
              { ts: 1720000000100, model: "gpt-5", accountId: "acc_87654321", success: false, ms: 3001, error: "rate limit exceeded" },
            ] }
        : u.includes("config") ? { config: {
              prefix: "", maxAccountAttempts: 3, probeIntervalMs: 1800000, showToolActivity: true,
              turnIdleTimeoutMs: 600000, toolResultTimeoutMs: 600000, logLevel: "info",
              clientKeys: "sk-test", host: "127.0.0.1", port: 8008,
              accountsPath: "/data/accounts.json", workspace: "/work",
            }, restartFields: ["host", "port", "accountsPath"] }
        : u.includes("/probe") ? { ok: true, account: realStatus.accounts[0] }
        : u.includes("reload") ? { total: 1, added: 0, removed: 0 }
        : u.includes("batch") ? (reqBody && reqBody.ids ? { ok: reqBody.ids.length, failed: 0 } : { added: [], failed: [{ key: "crsr_x…y", reason: "无效" }], total: 1 })
        : u.includes("export") ? { ok: true, count: 1 }
        : realStatus;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: "admin-page.js" });

  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();               // the load() at the bottom of the script
  await sandbox.load();         // render real data: wrong field names blow up here

  await sandbox.go("models");
  await settle();
  await sandbox.go("conn");
  await sandbox.go("pool");
  await sandbox.toggle(accId, true);
  await sandbox.probe(accId);
  await sandbox.reload();
  await sandbox.delNow(accId);

  sandbox.addOpen();
  $("ak").value = "not-a-key";  // fails format check -> server 400s before touching the network; the test needs no internet
  await sandbox.addSubmit();

  sandbox.batchOpen();
  $("bk").value = "not-a-key-1\nnot-a-key-2";
  await sandbox.batchSubmit();

  sandbox.editOpen(accId);
  $("en").value = "改个名";
  $("ep").value = "3";
  await sandbox.editSubmit(accId);
  await settle();
});

test("script: the new panels — accounts / logs / stats / settings / update", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await sandbox.go("accounts");
  await settle();
  sandbox.toggleSelectAll(true);              // select all -> batch bar appears
  await sandbox.batchOp("disable");           // bulk op {ids,op}
  await settle();
  sandbox.toggleSelectAll(false);             // clear selection
  await sandbox.exportAccounts();             // triggers /admin/accounts/export
  await settle();
  await sandbox.go("logs");                   // SSE stream (mock without body -> placeholder, no crash)
  await settle();
  sandbox.exportLogs("jsonl");                // triggers /admin/logs/export
  await settle();
  await sandbox.go("stats");                  // KPI + canvas + rankings
  await settle();
  await sandbox.go("settings");               // config form backfill
  await settle();
  $("cf-prefix").value = "x-";
  await sandbox.saveCfg();                    // PUT /admin/config
  await settle();
  sandbox.setTab("upd");                      // update tab
  await settle();
  await sandbox.doUpdateNow();                // POST /admin/update/perform（确认模态的直接执行入口）
  await settle();
});

// ── 左下角 / 头部按钮布局 ─────────────────────────────
test("page: footer has 退出登录 + 设置, header carries the theme toggle", () => {
  const footer = /<div class="footer-actions">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  assert.ok(footer.includes("退出登录"), "the footer button must read 退出登录, not 注销");
  assert.ok(footer.includes('onclick="logout()"'), "logout handler must survive the rename");
  assert.ok(footer.includes("设置") && footer.includes('onclick="go(\'settings\')"'), "footer must carry a 设置 button");
  assert.ok(!footer.includes('id="tb"'), "the theme toggle must leave the footer");
  const header = /<div class="page-header">([\s\S]*?)<\/section/.exec(html)?.[1] ?? "";
  assert.ok(header.includes('id="tb"'), "the theme toggle must live in the page header");
  assert.ok(header.includes("toggleTheme()"), "the header toggle must still call toggleTheme");
});

// ── 日志页最近请求表 ───────────────────────────────────
test("logs view: 最近请求 table renders rows and expands inline detail", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 60));
  await sandbox.go("logs");
  await settle();
  const v = $("view-logs").innerHTML;
  assert.ok(v.includes("最近请求"), "logs view must carry a 最近请求 section");
  assert.ok(v.includes("一个请求一行"), "the section subtitle must describe the table");
  assert.ok(v.includes("/admin/requests"), "the section must name its data source");
  const t = $("req-table").innerHTML;
  assert.ok(t.includes("claude-opus-5"), "a mocked request row must render: " + t);
  assert.ok(t.includes("测试号"), "accountName must win over accountId: " + t);
  assert.ok(t.includes("acc_8765"), "fallback shows the first 8 chars of accountId: " + t);
  assert.ok(t.includes("rate limit exceeded"), "failure rows must carry the error in a title: " + t);
  assert.ok(t.includes('<span class="badge success">成功</span>'), "success rows get a green badge: " + t);
  assert.ok(t.includes('<span class="badge error"'), "failure rows get a red badge: " + t);
  sandbox.reqRow(0);
  const t2 = $("req-table").innerHTML;
  assert.ok(t2.includes("detail-row"), "clicking a row must expand its detail: " + t2);
  assert.ok(t2.includes("Token 缓存读"), "the detail must show all token fields: " + t2);
});

// ── 统计页图例 ─────────────────────────────────────────
test("stats view: both chart cards carry a legend with interval totals", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await sandbox.go("stats");
  await settle();
  const v = $("view-stats").innerHTML;
  const n = (v.match(/class="chart-legend"/g) || []).length;
  assert.ok(n >= 2, "both chart cards must carry a legend, got " + n);
  assert.ok(v.includes("cl-val"), "legends must show the interval total: " + v);
  assert.ok(v.includes("93.6%"), "the success-rate legend must carry the range total: " + v);
});

// ── 接入信息页复制按钮 ─────────────────────────────────
test("conn view: copy buttons render and copyText tolerates a clipboard-less sandbox", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await sandbox.go("conn");
  await settle();
  const v = $("view-conn").innerHTML;
  const n = (v.match(/onclick="copyText\(\d+\)"/g) || []).length;
  assert.ok(n >= 5, "expected at least 5 copy buttons (2 base URL + 2 curl + 1 env), got " + n);
  sandbox.copyText(0); // must not throw: no navigator / clipboard / execCommand in the sandbox
});

test("update: a 409 perform renders a readable error bar, and an unchanged version reads as rollback", async () => {
  const old = performMock;
  performMock = () => ({
    ok: false, status: 409,
    text: async () => JSON.stringify({ error: { message: "[cursorapi] OTA update is in progress (lock held)", type: "api_error", code: 409 } }),
  });
  try {
    await sandbox.doUpdateNow();
    assert.ok($("upd-view").innerHTML.includes('id="upd-error"'), "a 409 must render an error bar in the update area");
    assert.ok(
      $("upd-view").innerHTML.includes("另一个更新正在进行"),
      "409 must read as a lock conflict, not the raw message: " + $("upd-view").innerHTML,
    );
    await sandbox.checkUpdate();              // perform 前版本 0.1.0 未变 -> 回滚提示
    assert.ok(
      $("upd-view").innerHTML.includes("已自动回滚"),
      "version unchanged after a failed perform must read as a rollback: " + $("upd-view").innerHTML,
    );
  } finally { performMock = old; }
});

test("update: while perform runs the button disables with an in-progress label; it recovers after", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const old = performMock;
  performMock = () => gate.then(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }));
  try {
    const p = sandbox.doUpdateNow();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal($("updgo").disabled, true, "the perform button must disable while updating");
    assert.ok(($("updgo").innerHTML || "").includes("更新执行中"), "the button must show an in-progress label: " + $("updgo").innerHTML);
    assert.ok(($("updst").innerHTML || "").includes("spinner"), "a light status strip must show while updating: " + $("updst").innerHTML);
    release();
    await p;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal($("updgo").disabled, false, "the perform button must re-enable after the call settles");
  } finally { release && release(); performMock = old; }
});

// ── the login page's script runs too ────────────────────
test("login script: clicking enter sends exactly one POST to /admin/login", async () => {
  // The same relative-path bug class re-occurs here.
  const anonHtml = await (await fetch(PAGE_URL)).text();
  const lscript = /<script>([\s\S]*?)<\/script>/.exec(anonHtml)?.[1];
  assert.ok(lscript, "no <script> in the login page");
  const hit = [];
  const el = makeEl("k");
  el.addEventListener = () => {};
  const lbox = {
    document: { getElementById: (id) => (id === "k" ? el : makeEl(id)) },
    location: { replace: () => {}, reload: () => {} },
    JSON, String, console,
    fetch: async (url, init) => { hit.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
  };
  vm.createContext(lbox);
  vm.runInContext(lscript, lbox, { filename: "login-page.js" });
  el.value = "口令";
  await lbox.go();
  assert.equal(hit.length, 1, "clicking enter must send exactly one login request");
  const u = new URL(hit[0].url, PAGE_URL);
  assert.equal(u.pathname, "/admin/login", `login request went to ${u.pathname}`);
  assert.equal((hit[0].init?.method ?? "").toUpperCase(), "POST");
  assert.ok(JSON.parse(hit[0].init.body).key === "口令", "the password goes in the body, not the URL (URLs end up in logs)");
});

// ── M1：请求表刷新风暴 ─────────────────────────────────
test("M1: maybeRefreshRequests never overlaps and backs off after failures", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 30));
  sandbox.reqBusy = false; sandbox.reqFailAt = 0; sandbox.reqAt = 0; sandbox.reqData = null;
  const n0 = asked.length;
  sandbox.maybeRefreshRequests();
  assert.equal(asked.length, n0 + 1, "empty cache must refresh immediately");
  await settle();
  assert.ok(sandbox.reqAt > 0, "reqAt must be updated on completion, not start");
  assert.equal(sandbox.reqFailAt, 0, "a successful load must clear the failure backoff");
  const n1 = asked.length;
  sandbox.reqFailAt = Date.now() - 5000;   // inside the 10s backoff window
  sandbox.reqAt = 0;
  sandbox.maybeRefreshRequests();
  assert.equal(asked.length, n1, "within the 10s backoff no refresh may fire");
  sandbox.reqFailAt = 0;
  sandbox.maybeRefreshRequests();
  assert.equal(asked.length, n1 + 1, "after the backoff a refresh must fire");
  sandbox.reqBusy = true;
  sandbox.maybeRefreshRequests();
  assert.equal(asked.length, n1 + 1, "busy must suppress a second in-flight request");
  sandbox.reqBusy = false;
  await settle();
});

// ── M2：切区间后图例合计值同步重算 ─────────────────────
test("M2: switching the chart range recomputes the legend totals", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await sandbox.go("stats");
  await settle();
  const buckets = [];
  for (let i = 0; i < 48; i++) buckets.push({ t: "h" + i, requests: 1, success: 1, errors: 0 });
  sandbox.statsData.hourlyBuckets = buckets;
  sandbox.drawCharts();
  assert.equal($("lr-req").textContent, "24", "24h legend must total the last 24 buckets");
  sandbox.chartRange("6h");
  assert.equal($("lr-req").textContent, "6", "6h legend must total the last 6 buckets");
  sandbox.chartRange("30d");
  assert.equal($("lr-req").textContent, "48", "30d legend must total all buckets");
  assert.equal($("lr-suc").textContent, "100%", "the success-rate legend must follow too");
  sandbox.chartRange("24h");
  assert.equal($("lr-req").textContent, "24", "back on 24h the legend must match again");
});

// ── 账号搜索 ────────────────────────────────────────────
test("accounts: the toolbar search filters rows by name/email/key/id", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await sandbox.go("accounts");
  await settle();
  assert.ok($("view-accounts").innerHTML.includes('id="af-q"'), "the accounts toolbar must carry a search input");
  sandbox.data.accounts = [
    { id: "acc_one", name: "测试号", email: "a@x.com", maskedKey: "crsr_1111…", priority: 0, runs: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: null },
    { id: "acc_two", name: "另一个号", email: "b@x.com", maskedKey: "crsr_2222…", priority: 0, runs: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: null },
  ];
  $("af-q").value = "另一个";
  sandbox.onAcctSearch();
  await new Promise((r) => setTimeout(r, 300));   // debounce is 200ms
  let t = $("acct-table").innerHTML;
  assert.ok(t.includes("acc_two"), "the matching row must stay: " + t);
  assert.ok(!t.includes("acc_one"), "non-matching rows must be filtered out: " + t);
  $("af-q").value = "crsr_2222";                   // masked-key match
  sandbox.onAcctSearch();
  await new Promise((r) => setTimeout(r, 300));
  t = $("acct-table").innerHTML;
  assert.ok(t.includes("acc_two") && !t.includes("acc_one"), "masked key must be searchable");
  $("af-q").value = "";
  sandbox.onAcctSearch();
  await new Promise((r) => setTimeout(r, 300));
  t = $("acct-table").innerHTML;
  assert.ok(t.includes("acc_one") && t.includes("acc_two"), "empty query must restore all rows");
});

// ── ESC 退出登录 ────────────────────────────────────────
test("ESC: no open modal -> askConfirm logout; open modal or other keys are ignored", async () => {
  $("modal").innerHTML = "";
  sandbox.onKeyDown({ key: "Escape" });
  assert.ok($("modal").innerHTML.includes("确认操作"), "ESC must pop the confirm modal");
  assert.ok($("modal").innerHTML.includes("退出登录"), "the confirm must mention logout");
  sandbox.closeModal();
  sandbox.onKeyDown({ keyCode: 27 });
  assert.ok($("modal").innerHTML.includes("确认操作"), "legacy keyCode 27 must be recognized too");
  sandbox.closeModal();
  $("modal").innerHTML = "already-open";
  sandbox.onKeyDown({ key: "Escape" });
  assert.equal($("modal").innerHTML, "already-open", "ESC must not disturb an open modal");
  sandbox.onKeyDown({ key: "Enter" });
  assert.equal($("modal").innerHTML, "already-open", "other keys must be ignored");
  sandbox.closeModal();
});

// ── 冷却倒计时 ──────────────────────────────────────────
test("accounts: cooldown renders a live countdown; coolFmt follows H:MM:SS / MM:SS", async () => {
  assert.equal(sandbox.coolFmt(10925000), "3:02:05", ">1h must be H:MM:SS");
  assert.equal(sandbox.coolFmt(65000), "01:05", "<=1h must be MM:SS");
  assert.equal(sandbox.coolFmt(0), "00:00", "zero stays zero");
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await sandbox.go("accounts");
  await settle();
  const id = sandbox.data.accounts[0].id;
  sandbox.data.accounts[0].cooldownUntil = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  sandbox.renderAccountsTable();
  sandbox.toggleExp(id);
  const t = $("acct-table").innerHTML;
  assert.ok(t.includes("cool-cd"), "the expanded detail must carry a countdown cell: " + t.slice(0, 120));
  assert.ok(t.includes("冷却中 剩余"), "the cell must read 冷却中 剩余 ...");
  assert.ok(t.includes('data-cu="'), "the cell must keep the absolute cooldown time for the ticker");
  delete sandbox.data.accounts[0].cooldownUntil;
  sandbox.toggleExp(id);
});

// ── 日志断流自动重连 ────────────────────────────────────
test("logs: a dropped stream schedules exponential-backoff reconnect; nostream/stop/abort do not", async () => {
  assert.equal(typeof sandbox.scheduleLogRetry, "function", "auto-reconnect must exist");
  const oldFetch = sandbox.fetch;
  sandbox.view = "logs";
  sandbox.logRetryTimer = null;
  sandbox.logRetryDelay = 0;
  const wait = () => new Promise((r) => setTimeout(r, 40));
  try {
    sandbox.fetch = async () => { throw new Error("network down"); };
    sandbox.startLogs();
    await wait();
    assert.ok(sandbox.logRetryTimer !== null, "a drop on the logs view must schedule a retry");
    assert.equal(sandbox.logRetryDelay, 2000, "first retry waits 2s");
    clearTimeout(sandbox.logRetryTimer); sandbox.logRetryTimer = null;
    sandbox.logRetryDelay = 16000;
    sandbox.scheduleLogRetry();
    assert.equal(sandbox.logRetryDelay, 30000, "backoff must cap at 30s");
    clearTimeout(sandbox.logRetryTimer); sandbox.logRetryTimer = null;
    sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" }); // no body -> nostream
    sandbox.startLogs();
    await wait();
    assert.equal(sandbox.logRetryTimer, null, "nostream is permanent, no retry scheduled");
    sandbox.fetch = async () => { throw new Error("network down"); };
    sandbox.startLogs();
    await wait();
    assert.ok(sandbox.logRetryTimer !== null, "drop again to arm a pending retry");
    sandbox.stopLogs();
    assert.equal(sandbox.logRetryTimer, null, "leaving the logs view must cancel the pending retry");
    sandbox.view = "logs";
    sandbox.fetch = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
    sandbox.startLogs();
    await wait();
    assert.equal(sandbox.logRetryTimer, null, "a manual abort must not schedule a retry");
  } finally {
    sandbox.fetch = oldFetch;
    if (sandbox.logRetryTimer) { clearTimeout(sandbox.logRetryTimer); sandbox.logRetryTimer = null; }
    sandbox.logRetryDelay = 0;
  }
});

// ── coverage ────────────────────────────────────────────
test("coverage: every endpoint and HTTP method is exercised", () => {
  const paths = asked.map((a) => String(a.url));
  for (const need of ["status", "models", "reload", "/disabled", "/probe", "accounts/batch", "stats", "config", "update/check", "update/perform", "logs/export", "accounts/export"]) {
    assert.ok(paths.some((p) => p.includes(need)), `never triggered ${need}; this entry is untested`);
  }
  const methods = new Set(asked.map((a) => (a.init?.method ?? "GET").toUpperCase()));
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    assert.ok(methods.has(m), `never triggered a ${m} request`);
  }
});

test("contract: new endpoints stay inside /admin/ with the right request shapes", () => {
  // /admin/stats, /admin/config, /admin/update/* and /admin/accounts/export
  // routes are live and get replayed against the real service. The two
  // below stay excluded:
  //   - /admin/logs: the SSE stream never closes; replay would hang. Path
  //     correctness is covered by the pathname assertions.
  //   - POST /admin/accounts/batch with {ids,op}: the new bulk-op contract;
  //     the live service would treat it as an import and 400. URL is shared
  //     with the import shape, whose path correctness is already covered.
  for (const { url, init } of asked) {
    const u = new URL(String(url), PAGE_URL);
    assert.ok(u.pathname.startsWith("/admin/"), `new-contract endpoints must stay inside /admin/: ${JSON.stringify(url)}`);
    const b = (() => { try { return init?.body ? JSON.parse(init.body) : null; } catch { return null; } })();
    if (String(url).includes("accounts/batch") && b && Array.isArray(b.ids)) {
      assert.ok(typeof b.op === "string", `bulk ops need an op field: ${JSON.stringify(b)}`);
    }
    if (String(url).includes("config") && (init?.method ?? "GET").toUpperCase() === "PUT") {
      assert.ok(b && Object.keys(b).length > 0, "PUT /admin/config must carry fields");
    }
  }
});

test("replay: page requests resolve per browser semantics and hit the live service", async () => {
  // DELETE replays last: it really deletes the account, and replayed first
  // it would 404 every later request for the same account — testing ordering
  // problems instead of path problems.
  const NEW_CONTRACT = ["/admin/logs"];
  const isDel = (a) => (a.init?.method ?? "GET").toUpperCase() === "DELETE";
  const isNewContract = (a) =>
    NEW_CONTRACT.some((p) => String(a.url).includes(p))
    || (() => {
      try {
        const b = a.init?.body ? JSON.parse(a.init.body) : null;
        return b && Array.isArray(b.ids); // the new-contract bulk op {ids,op}
      } catch { return false; }
    })();
  const replay = [...asked.filter((a) => !isDel(a) && !isNewContract(a)), ...asked.filter(isDel)];

  for (const { url, init } of replay) {
    const resolved = new URL(url, PAGE_URL);
    assert.ok(
      resolved.pathname.startsWith("/admin/"),
      `page request ${JSON.stringify(url)} resolved to ${resolved.pathname} — outside the admin surface.\n`
      + `  The page hangs at ${PAGE_URL} (no trailing slash), so relative paths drop their last segment. Use absolute /admin/xxx paths.`,
    );
    const r = await fetch(resolved, { ...init, headers: { ...(init?.headers ?? {}), ...auth } });
    // 401 = landed outside the admin surface (the very bug being tested);
    // 404 = route missing or wrong method. 400 is allowed: the add-account
    // entries use deliberately invalid keys, and the server rejecting them
    // is exactly the proof the route works.
    assert.ok(
      ![401, 404].includes(r.status),
      `page request ${init?.method ?? "GET"} ${JSON.stringify(url)} -> ${resolved.pathname} -> ${r.status}`
      + ` (${await r.text()})`,
    );
  }
});

// ── dead pool ───────────────────────────────────────────
test("dead pool: upstream problems are 502, never masquerading as an auth failure", async () => {
  // The test pool holds fake keys, so pulling the model catalog is
  // inevitably rejected by Cursor with 401. If that upstream 401 was passed
  // through verbatim as the response code, the browser would pop a re-login
  // dialog — the account is dead and the operator thinks they mistyped
  // their password. Upstream problems are always 5xx.
  const dead = await fetch(`${BASE}/admin/models`, { headers: auth });
  assert.equal(dead.status, 502, "upstream/pool problems must be 502");
  assert.notEqual(dead.status, 401, "a 401 would kick the user back to the login page");
});

// ── add route ───────────────────────────────────────────
test("add route: invalid keys are rejected with 400 and never persisted", async () => {
  const addRoute = await fetch(`${BASE}/admin/accounts`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ key: "not-a-key" }),
  });
  assert.equal(addRoute.status, 400, "the add route must exist and reject invalid keys");
  assert.match((await addRoute.json()).error.message, /crsr_/, "the error must explain what a key looks like");

  const onDisk = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
  assert.ok(!JSON.stringify(onDisk).includes("not-a-key"), "invalid keys must never reach the accounts file");
});

// ── restart (P2) ────────────────────────────────────────
// No supervisor in the test env: restartNow() must REFUSE (drain would
// make the process exit naturally with nothing to pull it back up).
test("restart: POST /admin/restart -> 409 without a supervisor, service stays up", async () => {
  const r = await fetch(`${BASE}/admin/restart`, { method: "POST", headers: auth });
  assert.equal(r.status, 409, "no supervisor -> honest 409 instead of claiming a restart");
  const j = await r.json();
  assert.equal(j.ok, false);
  // The service must keep serving.
  const alive = await fetch(`${BASE}/ping`);
  assert.equal(alive.status, 200, "service must keep serving after a refused restart");
});

// ── gzip (bench bottleneck 3) ────────────────────────────
test("page: gzip served to gzip-capable clients, plaintext otherwise", async () => {
  // Raw node:http, not fetch — undici adds its own accept-encoding and
  // decompresses transparently; here the wire bytes are the assertion.
  const getRaw = (headers) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: PORT, path: "/admin", method: "GET", headers },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  const gz = await getRaw({ "accept-encoding": "gzip", authorization: `Bearer ${ADMIN}` });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers["content-encoding"], "gzip", "a gzip-capable client gets gzip");
  assert.ok(gz.body.length < 70_000, `~143KB page compresses to ~51KB; got ${gz.body.length}`);
  assert.match(zlib.gunzipSync(gz.body).toString("utf8"), /号池/, "the decompressed page is the real page");
  const plain = await getRaw({ authorization: `Bearer ${ADMIN}` });
  assert.equal(plain.headers["content-encoding"], undefined, "no accept-encoding -> plaintext");
  assert.ok(plain.body.length > 100_000, `plaintext stays large: ${plain.body.length}`);
  assert.match(plain.body.toString("utf8"), /号池/);
  const loginGz = await getRaw({ "accept-encoding": "gzip" }); // unauthenticated -> the login page
  assert.equal(loginGz.headers["content-encoding"], "gzip");
  assert.match(zlib.gunzipSync(loginGz.body).toString("utf8"), /管理口令/, "the login page compresses too");
});

// ── perform error passthrough (pressure-ota A-1) ─────────
test("perform: a held OTA lock reads as 409, not a flattened 500", async () => {
  // The perform route is not wrapped in run(); its httpStatus errors used
  // to reach the top-level catch and be rewritten to 500. A stale lock file
  // is a deterministic, offline trigger: acquireUpdateLock throws before
  // any network/git work.
  const lock = path.join(import.meta.dirname, ".ota-lock");
  fs.writeFileSync(lock, "", "utf8");
  try {
    const r = await fetch(`${BASE}/admin/update/perform`, { method: "POST", headers: auth });
    assert.equal(r.status, 409, "a lock conflict must read as 409, not 500");
    assert.match((await r.json()).error.message, /OTA update is in progress|another OTA update/);
  } finally {
    fs.rmSync(lock, { force: true });
  }
});

// ── SSE drop cap (pressure2 S1) ──────────────────────────
// A second instance with the log-flood preload: the cap (checked BEFORE
// frame serialization) is only observable with a real flood against a
// non-reading subscriber.
const SSE_PORT = 40000 + Math.floor(Math.random() * 900);
const SSE_BASE = `http://127.0.0.1:${SSE_PORT}`;
sseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-ui-sse-"));
const sseCtl = path.join(sseDir, "flood-ctl.json");
const sseDone = path.join(sseDir, "flood-done");
fs.writeFileSync(path.join(sseDir, "accounts.json"), "[]");
child2 = spawn(process.execPath, ["--import", "./test-fixtures/log-flood.mjs", "src/app.mjs"], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    // CI runners may run under systemd — supervisor detection must stay off.
    INVOCATION_ID: undefined,
    PM2_USAGE: undefined,
    pm_id: undefined,
    CURSOR_PORT: String(SSE_PORT),
    CURSOR_HOST: "127.0.0.1",
    CURSOR_ACCOUNTS: path.join(sseDir, "accounts.json"),
    CURSOR_ADMIN_KEY: ADMIN,
    CURSOR_CLIENT_KEYS: "sk-test",
    CURSOR_PROBE_INTERVAL_MS: "0",
    CURSOR_LOG_LEVEL: "info", // the flood uses log.warn; it must pass the cutoff
    CURSOR_LOG_FLOOD_CTL: sseCtl,
    CURSOR_LOG_FLOOD_DONE: sseDone,
  },
  // stdout -> /dev/null: a full pipe nobody drains would backpressure the
  // synchronous flood loop and skew the drop behavior.
  stdio: ["ignore", "ignore", "pipe"],
});
let child2Err = "";
child2.stderr.on("data", (b) => { child2Err += b; });

test("sse: over-cap frames are dropped, never queued (cap fires before serialization)", async () => {
  let up2 = false;
  for (let i = 0; i < 100 && !up2; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { up2 = (await fetch(`${SSE_BASE}/ping`)).ok; } catch {}
  }
  assert.ok(up2, `SSE instance did not come up. stderr:\n${child2Err}`);

  // Connect and deliberately do NOT read: a slow subscriber whose socket
  // queue passes the 256KB cap must get frames dropped server-side.
  const sse = await fetch(`${SSE_BASE}/admin/logs`, { headers: auth });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(sse.headers.get("content-encoding"), null, "SSE must never be compressed");

  // Flood 1000 x ~1KB entries through the real emit path (cap x 4).
  const seq = Date.now();
  fs.writeFileSync(sseCtl, JSON.stringify({ seq, count: 1000, sizeKB: 1 }));
  let flooded = false;
  for (let i = 0; i < 100 && !flooded; i++) {
    await new Promise((r) => setTimeout(r, 50));
    flooded = fs.existsSync(`${sseDone}.${seq}`);
  }
  assert.ok(flooded, "the flood must complete");

  // Drain what actually arrived within a bounded window (the stream never
  // closes; the buffered payload lands within milliseconds).
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let dataFrames = 0;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const read = reader.read().then(({ done, value }) => ({ done, value }));
    const got = await Promise.race([read, new Promise((r) => setTimeout(() => r("quiet"), 300))]);
    if (got === "quiet") continue;
    if (got.done) break;
    buf += dec.decode(got.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (frame.startsWith("data: ")) {
        dataFrames += 1;
        JSON.parse(frame.slice(6)); // every delivered frame must be valid JSON
      }
    }
  }
  assert.ok(dataFrames >= 1, `replay/live frames must arrive; got ${dataFrames}`);
  assert.ok(
    dataFrames < 1000,
    `over-cap frames must be dropped, not queued: got ${dataFrames} of the 1000-frame flood`,
  );
  assert.equal((await fetch(`${SSE_BASE}/ping`)).status, 200, "the service stays healthy after the storm");
});

await run();
const methods = new Set(asked.map((a) => (a.init?.method ?? "GET").toUpperCase()));
if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  cleanup();
  process.exit(1);
}
console.log(`admin UI: all passed (${passed.length} tests; page sent ${asked.length} requests, covering ${[...methods].sort().join("/")}, all resolving inside /admin/)`);
cleanup();
process.exit(0);
