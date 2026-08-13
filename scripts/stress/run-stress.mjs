// Stress-test orchestrator. Spawns the server on port 8102 with the mock
// SDK preload (stress-hooks.mjs), runs six scenarios against it, samples the
// metrics sidecar (8103) throughout, and writes raw results to
// scripts/stress/results/scenarios.json.
//
// Run: node scripts/stress/run-stress.mjs
// Reads: nothing. Writes: results/scenarios.json (overwritten).

import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 8102;
const SIDECAR = 8103;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "stress-admin";
const CLIENT = "sk-stress";
const AUTH_ADMIN = { authorization: `Bearer ${ADMIN}` };
const AUTH_CLIENT = { authorization: `Bearer ${CLIENT}` };
const RESULTS_DIR = path.join(import.meta.dirname, "results");
const RSS_GUARD = 1_400 * 1024 * 1024; // abort a scenario if the server RSS passes this

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-stress-"));
const accountsFile = path.join(dir, "accounts.json");
fs.writeFileSync(accountsFile, "[]\n", "utf8");

const outPath = path.join(RESULTS_DIR, "server.stdout.log");
const errPath = path.join(RESULTS_DIR, "server.stderr.log");
const outFd = fs.openSync(outPath, "w");
const errFd = fs.openSync(errPath, "w");

const results = { meta: {}, scenarios: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── server lifecycle ──

const child = spawn(process.execPath, ["--import", path.join(import.meta.dirname, "stress-hooks.mjs"), "src/app.mjs"], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    INVOCATION_ID: undefined,
    PM2_USAGE: undefined,
    pm_id: undefined,
    CURSOR_PORT: String(PORT),
    CURSOR_HOST: "127.0.0.1",
    CURSOR_ACCOUNTS: accountsFile,
    CURSOR_ADMIN_KEY: ADMIN,
    CURSOR_CLIENT_KEYS: CLIENT,
    CURSOR_PROBE_INTERVAL_MS: "0",
    CURSOR_OTA_ENABLED: "false",
    CURSOR_LOG_LEVEL: "info",
    CURSOR_WORKSPACE: dir,
  },
  stdio: ["ignore", outFd, errFd],
});
child.unref?.();

function cleanup() {
  try {
    child.kill("SIGKILL");
  } catch {}
  try {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  } catch {}
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await rawGet(`${BASE}/ping`);
      if (r.status === 200) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("server did not come up");
}

// ── HTTP helpers (node:http; undici limits would cap SSE concurrency) ──

function rawReq(method, url, { headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
        agent,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          res.status = res.statusCode;
          res.body = Buffer.concat(chunks).toString("utf8");
          resolve(res);
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

const rawGet = (url, opts) => rawReq("GET", url, opts);
async function jsonReq(method, url, body, extra = {}) {
  const t0 = Date.now();
  const res = await rawReq(method, url, { ...extra, body });
  let parsed = null;
  try {
    parsed = JSON.parse(res.body || "null");
  } catch {}
  return { status: res.status, ms: Date.now() - t0, json: parsed };
}
const getJson = (url, h) => jsonReq("GET", url, null, { headers: h });
const postJson = (url, body, h) => jsonReq("POST", url, body, { headers: h });

// SSE client: counts data frames / first-frame latency; `read:false` leaves
// the socket paused (simulates a non-reading slow client).
function sseOpen(url, { headers, read = true, body } = {}) {
  const c = {
    frames: 0,
    dataFrames: 0,
    firstFrameMs: null,
    t0: Date.now(),
    closed: false,
    onFirst: () => {},
    destroy() {
      try {
        c.req.destroy();
      } catch {}
    },
  };
  c.req = http.request(new URL(url), { headers, method: body ? "POST" : "GET" }, (res) => {
    c.res = res;
    if (!read) {
      res.pause();
      return;
    }
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const seg = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        c.frames += 1;
        if (seg.startsWith("data: ")) {
          c.dataFrames += 1;
          if (c.firstFrameMs === null) c.firstFrameMs = Date.now() - c.t0;
        }
      }
    });
  });
  c.req.on("close", () => {
    c.closed = true;
  });
  if (body) c.req.write(typeof body === "string" ? body : JSON.stringify(body));
  c.req.end();
  return c;
}

// ── metrics ──

function sampler(intervalMs = 500) {
  const series = [];
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      series.push(await getJson(`http://127.0.0.1:${SIDECAR}/metrics`).then((r) => r.json));
    } catch {}
    setTimeout(tick, intervalMs);
  };
  setTimeout(tick, 0);
  return {
    stop: () => {
      stopped = true;
    },
    series,
  };
}

async function counters() {
  return (await getJson(`http://127.0.0.1:${SIDECAR}/counters`)).json;
}
async function putMock(cfg) {
  return (await jsonReq("PUT", `http://127.0.0.1:${SIDECAR}/mock`, cfg)).json;
}
async function metricsNow() {
  return (await getJson(`http://127.0.0.1:${SIDECAR}/metrics`)).json;
}
function lsofCount() {
  try {
    const out = execFileSync("lsof", ["-p", String(child.pid)], { timeout: 8000, encoding: "utf8" });
    return out.split("\n").filter((l) => l.trim()).length;
  } catch {
    return null;
  }
}

function rssMB(b) {
  return Math.round(b / 1024 / 1024);
}
const stats = (arr) => {
  if (!arr.length) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: s.length,
    min: q(0),
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: q(1),
    avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
};

// Fire `n` chat completions concurrently, each fully read; returns per-req
// {ttfbMs, totalMs, frames, status}.
async function chatBurst(n, { stream = true, timeoutMs = 30000, agent } = {}) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    runs.push(
      (async () => {
        const body = JSON.stringify({
          model: "claude-opus-5",
          messages: [{ role: "user", content: "stress" }],
          stream,
        });
        return new Promise((resolve, reject) => {
          const t0 = Date.now();
          const req = http.request(new URL(`${BASE}/v1/chat/completions`), {
            method: "POST",
            headers: { ...AUTH_CLIENT, "content-type": "application/json" },
            agent,
          }, (res) => {
            let ttfb = null;
            let frames = 0;
            let buf = "";
            let total = 0;
            res.on("data", (chunk) => {
              total = Date.now() - t0;
              if (ttfb === null) ttfb = total;
              buf += chunk.toString("utf8");
              let idx;
              while ((idx = buf.indexOf("\n\n")) >= 0) {
                const seg = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (seg.startsWith("data: ")) frames += 1;
              }
            });
            res.on("end", () => resolve({ ttfbMs: ttfb, totalMs: Date.now() - t0, frames, status: res.statusCode }));
          });
          req.on("error", reject);
          req.write(body);
          req.end();
          setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
        });
      })(),
    );
  }
  return Promise.allSettled(runs).then((rs) =>
    rs.map((r) => (r.status === "fulfilled" ? r.value : { error: String(r.reason) })),
  );
}

// ── scenario bookkeeping ──

// Keep `concurrency` chat requests in flight continuously for `durationMs`;
// returns per-request latency stats (each worker issues requests serially).
async function sustainedStorm({ concurrency, durationMs, timeoutMs, agent }) {
  const totals = [];
  const ttfb = [];
  let fired = 0;
  let errors = 0;
  const tEnd = Date.now() + durationMs;
  const worker = async () => {
    while (Date.now() < tEnd) {
      const r = await chatBurst(1, { stream: false, timeoutMs, agent });
      const v = r[0];
      fired += 1;
      if (v.error || v.status !== 200) errors += 1;
      if (v.totalMs != null) totals.push(v.totalMs);
      if (v.ttfbMs != null) ttfb.push(v.ttfbMs);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { fired, errors, totalMs: stats(totals), ttfbMs: stats(ttfb) };
}

async function scenario(name, fn) {
  results.scenarios[name] = {};
  const s = results.scenarios[name];
  s.before = await metricsNow();
  s.countersBefore = await counters();
  s.beforeLsof = lsofCount();
  const samp = sampler();
  s.rssSeriesMB = samp.series; // live: filled by the sampler while fn runs
  const guard = { tripped: false };
  const guardCheck = setInterval(async () => {
    try {
      const m = await metricsNow();
      if (m.rss > RSS_GUARD) {
        guard.tripped = true;
        guard.rss = m.rss;
      }
    } catch {}
  }, 1000);
  try {
    await fn(s);
  } finally {
    clearInterval(guardCheck);
    samp.stop();
    await sleep(500);
    s.after = await metricsNow();
    s.afterLsof = lsofCount();
    s.rssSeriesMB = s.rssSeriesMB.map((m) => ({
      t: m.uptimeMs,
      rss: rssMB(m.rss),
      heap: rssMB(m.heapUsed),
      sockets: m.handles.sockets,
      timers: m.handles.timers,
      fds: m.fds,
    }));
    s.rssDeltaMB = (s.after.rss - s.before.rss) / 1024 / 1024;
    if (guard.tripped) s.oomGuard = { tripped: true, rssMB: rssMB(guard.rss) };
    fs.writeFileSync(path.join(RESULTS_DIR, "scenarios.json"), JSON.stringify(results, null, 2));
  }
  return s;
}

// ── scenarios ──

async function s0() {
  // S0: baseline. Warm catalog first (boot pre-warm covers it), then measure.
  const s = results.scenarios.s0;
  const lat = [];
  for (let i = 0; i < 10; i++) {
    const r = await getJson(`${BASE}/admin/status`, AUTH_ADMIN);
    lat.push(r.ms);
  }
  s.statusLatencyMs = stats(lat);
  s.baselineRssMB = rssMB(s.before.rss);
  s.countersBefore = await counters();
}

async function s2AddAccounts(s, n, label) {
  const keys = [];
  for (let i = 0; i < n; i++) keys.push("crsr_" + (label + i).padStart(6, "0") + Math.random().toString(16).slice(2, 14));
  const t0 = Date.now();
  const res = await Promise.allSettled(
    keys.map((key) => postJson(`${BASE}/admin/accounts`, { key, name: `acc-${label}-${key.slice(-4)}` }, AUTH_ADMIN)),
  );
  const wall = Date.now() - t0;
  const lat = res.map((r) => (r.status === "fulfilled" ? r.value.ms : -1));
  const errors = res.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && r.value.status !== 200));
  const errBodies = errors.map((r) =>
    r.status === "rejected" ? String(r.reason) : JSON.stringify(r.value.json ?? r.value.status),
  );
  return { label, n, wallMs: wall, latencyMs: stats(lat), errors: errBodies, keys };
}

function fileVerify() {
  const text = fs.readFileSync(accountsFile, "utf8");
  let parsed = null;
  let corrupt = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    corrupt = String(e);
  }
  const ids = new Set();
  let dups = 0;
  for (const it of parsed ?? []) {
    const id = String(it.key ?? "");
    if (ids.has(id)) dups += 1;
    ids.add(id);
  }
  return { corrupt, count: parsed?.length ?? -1, dups, bytes: Buffer.byteLength(text) };
}

async function s2(s) {
  // S2: concurrent account operations. meLatencyMs=5 simulates upstream cost.
  await putMock({ meLatencyMs: 5 });
  s.add20 = await s2AddAccounts(s, 20, "a");
  s.fileAfter20 = fileVerify();
  s.add50 = await s2AddAccounts(s, 50, "b");
  s.fileAfter50 = fileVerify();
  const status = (await getJson(`${BASE}/admin/status`, AUTH_ADMIN)).json;
  const ids = status.accounts.map((a) => a.id);
  s.ids = ids;
  s.idsCount = ids.length;
  const batchRound = async (op) => {
    const t0 = Date.now();
    const res = await Promise.allSettled(
      Array.from({ length: 10 }, () => postJson(`${BASE}/admin/accounts/batch`, { ids, op }, AUTH_ADMIN)),
    );
    const ok = res.every((r) => r.status === "fulfilled" && r.value.status === 200);
    return { op, wallMs: Date.now() - t0, allOk: ok, bodies: res.map((r) => (r.status === "fulfilled" ? r.value.json : null)) };
  };
  s.batchDisable = await batchRound("disable");
  s.batchEnable = await batchRound("enable");
  s.batchProbe = await batchRound("probe");
  const after = (await getJson(`${BASE}/admin/status`, AUTH_ADMIN)).json;
  s.stateAfter = {
    total: after.accounts.length,
    disabled: after.accounts.filter((a) => a.disabled).length,
    withIdentity: after.accounts.filter((a) => a.email).length,
  };
  // Mixed concurrent adds + deletes (removeAccount is NOT on the write queue).
  const delIds = ids.slice(0, 20);
  const addKeys = [];
  for (let i = 0; i < 20; i++) addKeys.push("crsr_m" + String(i).padStart(4, "0") + Math.random().toString(16).slice(2, 14));
  const t0 = Date.now();
  const mixed = await Promise.allSettled([
    ...addKeys.map((key) => postJson(`${BASE}/admin/accounts`, { key, name: `acc-mixed-${key.slice(-4)}` }, AUTH_ADMIN)),
    ...delIds.map((id) => jsonReq("DELETE", `${BASE}/admin/accounts/${id}`, null, { headers: AUTH_ADMIN })),
  ]);
  s.mixed = {
    wallMs: Date.now() - t0,
    addOk: mixed.slice(0, 20).filter((r) => r.status === "fulfilled" && r.value.status === 200).length,
    delOk: mixed.slice(20).filter((r) => r.status === "fulfilled" && r.value.status === 200).length,
    errors: mixed
      .filter((r) => r.status === "rejected" || (r.status === "fulfilled" && r.value.status !== 200))
      .map((r) => (r.status === "rejected" ? String(r.reason) : `${r.value.status} ${r.value.body?.slice(0, 120)}`))
      .slice(0, 10),
  };
  s.fileAfterMixed = fileVerify();
  await putMock({ meLatencyMs: 0 });
}

async function s1(s) {
  // S1: concurrent SSE /admin/logs + log storms (debug level -> ~2 lines/req).
  const put = await jsonReq("PUT", `${BASE}/admin/config`, { logLevel: "debug" }, { headers: AUTH_ADMIN });
  s.logLevelPut = { status: put.status, json: put.json };
  const exportCount = async () => {
    const res = await rawGet(`${BASE}/admin/logs/export`, { headers: AUTH_ADMIN });
    return res.body.split("\n").filter((l) => l.trim()).length;
  };
  // Fresh connections per request: keep-alive reuse across 200+ streams
  // would smear the numbers (and the storm must not queue on the pool).
  const stormAgent = new http.Agent({ keepAlive: false, maxSockets: 200 });
  const bootEntries = await exportCount();
  const WAVES = 6;
  const PER_WAVE = 50;
  // Expected frames per client: 50 replay + WAVES*PER_WAVE requests x 2 log
  // lines (relay info + request debug). Export happens AFTER clients close,
  // so the export's own debug line never leaks into delivery counts.
  const expected = 50 + WAVES * PER_WAVE * 2;

  for (const N of [50, 100, 200]) {
    const t0 = Date.now();
    const clients = [];
    for (let i = 0; i < N; i++) clients.push(sseOpen(`${BASE}/admin/logs`, { headers: AUTH_ADMIN }));
    const issued = Date.now() - t0;
    const waveTimes = [];
    for (let w = 0; w < WAVES; w++) {
      const wt = Date.now();
      await chatBurst(PER_WAVE, { stream: false, agent: stormAgent });
      waveTimes.push(Date.now() - wt);
      await sleep(30);
    }
    await sleep(300);
    const frames = clients.map((c) => c.dataFrames);
    for (const c of clients) c.destroy();
    await sleep(200);
    const endEntries = await exportCount();
    s[`sseRead_${N}`] = {
      issueMs: issued,
      firstFrameMs: stats(clients.map((c) => c.firstFrameMs).filter((v) => v !== null)),
      framesPerClient: stats(frames),
      expectedPerClient: expected,
      deliveredAtLeast: frames.filter((f) => f >= expected).length,
      deliveryPct: Math.round((frames.filter((f) => f >= expected).length / clients.length) * 1000) / 10,
      endEntries,
      bootEntries,
      waveTimesMs: stats(waveTimes),
    };
    await sleep(300);
  }

  // Non-reading clients: 100 paused SSE sockets + heavy sustained storm.
  // The 1MB/subscriber drop cap must keep server RSS bounded.
  await putMock({ meLatencyMs: 0 });
  const slow = [];
  for (let i = 0; i < 100; i++) slow.push(sseOpen(`${BASE}/admin/logs`, { headers: AUTH_ADMIN, read: false }));
  const storm = await sustainedStorm({
    concurrency: 250,
    durationMs: 25_000,
    timeoutMs: 10_000,
    agent: stormAgent,
  });
  const rssPeak = Math.max(...s.rssSeriesMB.map((m) => m.rss));
  for (const c of slow) c.destroy();
  await sleep(800);
  const mAfter = await metricsNow();
  s.sseSlow = {
    stormMs: 25_000,
    chatRequests: storm.fired,
    errors: storm.errors,
    clients: 100,
    totalMs: storm.totalMs,
    ttfbMs: storm.ttfbMs,
    rssPeakMB: rssMB(rssPeak),
    rssAfterCloseMB: rssMB(mAfter.rss),
    droppedWarnings: 0, // filled below from the server log
  };
  // count "too slow" warnings in server output
  try {
    const txt = fs.readFileSync(outPath, "utf8");
    s.sseSlow.droppedWarnings = txt.split("log SSE subscriber is too slow").length - 1;
  } catch {}
  const put2 = await jsonReq("PUT", `${BASE}/admin/config`, { logLevel: "info" }, { headers: AUTH_ADMIN });
  s.logLevelRestore = put2.status;
}

async function s3(s) {
  // S3: mixed data plane — C streaming chats + C sustained status requests.
  await putMock({ mode: "stream", textEvents: 60, eventIntervalMs: 25, textLen: 40, meLatencyMs: 0 });
  const levels = {};
  for (const C of [10, 30, 50]) {
    const chats = [];
    const statusLats = [];
    let statusCount = 0;
    let statusRunning = true;
    (async () => {
      while (statusRunning) {
        const batch = [];
        for (let i = 0; i < C; i++) {
          batch.push(getJson(`${BASE}/admin/status`, AUTH_ADMIN));
        }
        const rs = await Promise.allSettled(batch);
        for (const r of rs) {
          statusLats.push(r.status === "fulfilled" ? r.value.ms : -1);
          statusCount += 1;
        }
      }
    })();
    const t0 = Date.now();
    const roundResults = [];
    for (let round = 0; round < 4; round++) {
      roundResults.push(await chatBurst(C, { stream: true }));
    }
    const chatMs = Date.now() - t0;
    statusRunning = false;
    await sleep(300);
    const all = roundResults.flat();
    const ok = all.filter((r) => !r.error && r.status === 200);
    levels[`c${C}`] = {
      chatWallMs: chatMs,
      chatTotal: all.length,
      chatOk: ok.length,
      chatErrors: all.filter((r) => r.error || r.status !== 200).slice(0, 5).map((r) =>
        r.error ?? `status=${r.status}`),
      ttfbMs: stats(ok.map((r) => r.ttfbMs).filter((v) => v !== null)),
      totalMs: stats(ok.map((r) => r.totalMs)),
      framesPerChat: stats(ok.map((r) => r.frames)),
      status: {
        requests: statusCount,
        latencyMs: stats(statusLats),
      },
    };
    await sleep(1500);
  }
  s.levels = levels;
}

async function s4(s) {
  // S4: slow clients on the data plane — open streamed chats, never read.
  // The data-plane SseWriter has no per-subscriber cap (unlike /admin/logs);
  // the socket buffer grows without bound while the client never reads.
  // Running streams keep the mock config they started with, so switching to
  // quick mode mid-test only affects the fast-clients' runs.
  const rssStart = await metricsNow();
  s.rssStartMB = rssMB(rssStart.rss);
  await putMock({ mode: "quick" });
  s.fastBaseline = await chatBurst(3, { stream: true });
  await putMock({ mode: "duration", streamMs: 45_000, eventIntervalMs: 2, textLen: 300, meLatencyMs: 0 });
  const slow = [];
  for (let i = 0; i < 20; i++) {
    slow.push(
      sseOpen(`${BASE}/v1/chat/completions`, {
        headers: { ...AUTH_CLIENT, "content-type": "application/json" },
        read: false,
        body: { model: "claude-opus-5", messages: [{ role: "user", content: "slow" }], stream: true },
      }),
    );
  }
  await sleep(10_000);
  await putMock({ mode: "quick" });
  s.fastDuringSlow = await chatBurst(3, { stream: true });
  await sleep(35_000);
  for (const c of slow) c.destroy();
  await sleep(5_000);
  const mEnd = await metricsNow();
  s.slowClients = 20;
  s.rssPeakMB = Math.max(...s.rssSeriesMB.map((m) => rssMB(m.rss)));
  s.rssEndMB = rssMB(mEnd.rss);
  s.rssGrowthMB = s.rssPeakMB - s.rssStartMB;
  s.rssReleasedMB = s.rssPeakMB - s.rssEndMB;
  const cAfter = await counters();
  s.eventsDuringS4 = cAfter.events - (results.scenarios.s4.countersBefore?.events ?? 0);
  s.activeRunsAfter = cAfter.activeRuns;
}

async function s5(s) {
  // S5: connection storm — 100 open/close per second x 30s across /ping,
  // /admin/status and 1-frame /admin/logs SSE connections (agent:false).
  const before = s.before;
  s.fdBefore = s.beforeLsof;
  const t0 = Date.now();
  let made = 0;
  let okCount = 0;
  const kinds = ["ping", "status", "sse"];
  const INTERVAL_MS = 10; // 100/s
  while (made < 3000) {
    const next = t0 + made * INTERVAL_MS;
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    const kind = kinds[made % kinds.length];
    if (kind === "sse") {
      const c = sseOpen(`${BASE}/admin/logs`, { headers: AUTH_ADMIN, read: true });
      const done = new Promise((resolve) => {
        const t = setInterval(() => {
          if (c.firstFrameMs !== null || c.closed) {
            clearInterval(t);
            resolve();
          }
        }, 2);
        setTimeout(() => {
          clearInterval(t);
          resolve();
        }, 1000);
      });
      await done;
      c.destroy();
      okCount += 1;
    } else {
      const r = await rawReq("GET", kind === "ping" ? `${BASE}/ping` : `${BASE}/admin/status`, {
        headers: AUTH_ADMIN,
        agent: false,
      });
      if (r.status === 200) okCount += 1;
    }
    made += 1;
  }
  s.connections = made;
  s.ok = okCount;
  const mEnd = await metricsNow();
  s.fdAfter = lsofCount();
  s.fdDelta = (s.fdAfter ?? 0) - (s.fdBefore ?? 0);
  s.socketsAfter = mEnd.handles.sockets;
  s.timersAfter = mEnd.handles.timers;
  s.rssDeltaMB = (mEnd.rss - s.before.rss) / 1024 / 1024;
}

async function s6(s) {
  // S6: /admin/update/check concurrency — the 60s ttlCache must collapse
  // concurrent hits into one upstream (GitHub) request.
  const c0 = await counters();
  s.fetchCallsBefore = c0.fetchCalls;
  const burst = async (n) => {
    const rs = await Promise.allSettled(
      Array.from({ length: n }, () => getJson(`${BASE}/admin/update/check`, AUTH_ADMIN)),
    );
    const statuses = {};
    for (const r of rs) {
      const st = r.status === "fulfilled" ? r.value.status : "rejected";
      statuses[st] = (statuses[st] ?? 0) + 1;
    }
    return { statuses, bodies: rs.map((r) => (r.status === "fulfilled" ? r.value.json : null)) };
  };
  s.burst1 = await burst(20);
  const c1 = await counters();
  s.fetchCallsAfterBurst1 = c1.fetchCalls;
  s.burst1BodiesIdentical = s.burst1.bodies.every((b) => JSON.stringify(b) === JSON.stringify(s.burst1.bodies[0]));
  await sleep(3000);
  s.burst2 = await burst(10);
  const c2 = await counters();
  s.fetchCallsAfterBurst2 = c2.fetchCalls;
  s.ttlHit = c2.fetchCalls === c1.fetchCalls;
  await sleep(61_000);
  s.burst3 = await burst(1);
  const c3 = await counters();
  s.fetchCallsAfterBurst3 = c3.fetchCalls;
  s.firstBody = s.burst1.bodies[0];
}

// ── main ──

async function main() {
  results.meta = {
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    repoRoot: REPO_ROOT,
    server: { port: PORT, sidecar: SIDECAR, accountsFile, pid: null },
    env: {
      CURSOR_PORT: PORT,
      CURSOR_HOST: "127.0.0.1",
      CURSOR_ACCOUNTS: accountsFile,
      CURSOR_ADMIN_KEY: ADMIN,
      CURSOR_CLIENT_KEYS: CLIENT,
      CURSOR_PROBE_INTERVAL_MS: 0,
      CURSOR_OTA_ENABLED: "false",
      CURSOR_LOG_LEVEL: "info",
    },
  };
  console.log("[stress] booting server…");
  await waitUp();
  results.meta.server.pid = child.pid;
  console.log(`[stress] up (pid ${child.pid}); baseline…`);
  await sleep(2000);
  await scenario("s0", s0);
  console.log("[stress] s0 baseline done");
  await scenario("s2", s2);
  console.log("[stress] s2 accounts done");
  await scenario("s1", s1);
  console.log("[stress] s1 sse/logs done");
  await scenario("s3", s3);
  console.log("[stress] s3 mixed data plane done");
  await scenario("s4", s4);
  console.log("[stress] s4 slow clients done");
  await scenario("s5", s5);
  console.log("[stress] s5 connection storm done");
  await scenario("s6", s6);
  console.log("[stress] s6 update check done");
  results.meta.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(RESULTS_DIR, "scenarios.json"), JSON.stringify(results, null, 2));
  console.log(`[stress] done -> ${RESULTS_DIR}/scenarios.json`);
  child.kill("SIGTERM");
  await sleep(1500);
  cleanup();
}

main().catch(async (err) => {
  console.error("[stress] FAILED:", err);
  try {
    const tail = fs.readFileSync(errPath, "utf8").split("\n").slice(-30).join("\n");
    console.error("--- server stderr tail ---\n" + tail);
  } catch {}
  cleanup();
  process.exit(1);
});
