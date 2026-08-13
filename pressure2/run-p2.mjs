// P2 performance driver: boots the real server (src/ untouched) on port
// 8105 with an EMPTY account pool + the mock SDK hook + monitor + fetch
// stub, then runs the six required load surfaces:
//
//   S1  concurrent SSE /admin/logs (50/100/200) + log storm — frame
//       delivery per subscriber, throughput, RSS
//   S2  concurrent account ops (add / enable-disable / probe @ 20/50) —
//       wall time, file integrity (JSON valid + row count exact)
//   S3  mixed load: 50 concurrent streaming data-plane + 50 concurrent
//       /admin/status for 60s — degradation curve
//   S4  slow clients: SSE consumers that never read — memory bounded?
//       writableLength drop path working?
//   S5  connection storm: 100 open/close per second for 30s — fd/timer
//       leakage via handles before/after
//   S6  update-check hammering: many /admin/update/check in 60s — ttlCache
//       effect via mock fetch call count
//
// Evidence: pressure2/metrics.csv (monitor), pressure2/results.json,
// pressure2/p2.log, pressure2/p2-server.err.log. Full report in
// pressure2/report.md after the run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const PORT = 8105;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIR = path.join(ROOT, "pressure2");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cspk-p2-"));
const CLIENT_KEY = "p2-client";
const ADMIN_KEY = "p2-admin";

fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync(DIR)) {
  if (f.startsWith("ctl-log.done.") || f === "ctl-log.json" || f === "ctl-mock.json") fs.rmSync(path.join(DIR, f), { force: true });
}
fs.rmSync(path.join(DIR, "metrics.csv"), { force: true });
fs.rmSync(path.join(DIR, "fetch-count.json"), { force: true });
fs.rmSync(path.join(DIR, "results.json"), { force: true });
fs.rmSync(path.join(DIR, "phases.jsonl"), { force: true });

const logFd = fs.openSync(path.join(DIR, "p2.log"), "w");
const plog = (msg) => {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  fs.writeSync(logFd, line + "\n");
  console.log(line);
};

fs.writeFileSync(path.join(DIR, "phases.jsonl"), "");
const phase = (name, note = "") => {
  fs.appendFileSync(path.join(DIR, "phases.jsonl"), JSON.stringify({ ts: Date.now(), phase: name, note }) + "\n");
  plog(`== PHASE ${name} ${note}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverRssMb = () => {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(server.pid)], { encoding: "utf8" }).trim();
    return Number(out) / 1024;
  } catch {
    return -1;
  }
};
const lsofCount = () => {
  try {
    const out = execFileSync("lsof", ["-p", String(server.pid), "-a", "-d", "0-65535"], { encoding: "utf8" });
    return out.trim().split("\n").length - 1;
  } catch (err) {
    plog(`lsof failed: ${err.message}`);
    return -1;
  }
};
const fetchCount = () => {
  try {
    return fs.readFileSync(path.join(DIR, "fetch-count.json"), "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
const lastHandles = () => {
  const lines = fs.readFileSync(path.join(DIR, "metrics.csv"), "utf8").trim().split("\n");
  const last = lines[lines.length - 1];
  const m = /^(?:[^,]*,){8}(.+)\|.+$/.exec(last ?? "");
  return m ? JSON.parse(m[1]) : null;
};

// ── HTTP helpers ──

let cookie = "";
async function api(method, p, body, opts = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, text, headers: res.headers, ms: opts._t ? Date.now() - opts._t : 0 };
}

const timed = (method, p, body, headers) => {
  const _t = Date.now();
  return api(method, p, body, { headers, _t });
};

// ── Server lifecycle ──

let server = null;
function spawnServer() {
  const accountsFile = path.join(TMP, "accounts.json");
  fs.writeFileSync(accountsFile, JSON.stringify([])); // EMPTY pool
  fs.writeFileSync(path.join(TMP, "runtime-config.json"), "{}");
  const env = {
    ...process.env,
    CURSOR_PORT: String(PORT),
    CURSOR_HOST: "127.0.0.1",
    CURSOR_ACCOUNTS: accountsFile,
    CURSOR_CLIENT_KEYS: CLIENT_KEY,
    CURSOR_ADMIN_KEY: ADMIN_KEY,
    CURSOR_PROBE_INTERVAL_MS: "0",
    CURSOR_TURN_IDLE_TIMEOUT_MS: "20000",
    CURSOR_TOOL_RESULT_TIMEOUT_MS: "30000",
    CURSOR_LOG_LEVEL: "info",
    CURSOR_WORKSPACE: path.join(TMP, "work"),
    CSPK_PRESSURE_DIR: DIR,
  };
  fs.mkdirSync(path.join(TMP, "work"), { recursive: true });
  const errFd = fs.openSync(path.join(DIR, "p2-server.err.log"), "w");
  const nullFd = fs.openSync("/dev/null", "w");
  server = spawn(process.execPath, [
    "--import", "./pressure/mock-hook.mjs",
    "--import", "./pressure/monitor.mjs",
    "--import", "./pressure2/fetch-hook.mjs",
    "boot.mjs",
  ], { cwd: ROOT, env, stdio: ["ignore", nullFd, errFd] });
  server.on("exit", (code, sig) => plog(`server exited code=${code} sig=${sig}`));
}

async function waitReady() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/ping`);
      if (r.status === 200) return;
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not become ready in time");
    await sleep(200);
  }
}

async function adminLogin() {
  const r = await api("POST", "/admin/login", { key: ADMIN_KEY });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  const token = /cursorapi_sess=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1];
  if (!token) throw new Error("no session cookie");
  cookie = `cursorapi_sess=${token}`;
  plog("admin login ok");
}

function setMockCtl(ctl) {
  fs.writeFileSync(path.join(DIR, "ctl-mock.json"), JSON.stringify(ctl));
}

async function ingestLogs(seq, count, sizeKB) {
  fs.writeFileSync(path.join(DIR, "ctl-log.json"), JSON.stringify({ seq, count, sizeKB }));
  const done = path.join(DIR, `ctl-log.done.${seq}`);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (fs.existsSync(done)) return JSON.parse(fs.readFileSync(done, "utf8"));
    if (Date.now() > deadline) throw new Error(`log ingestion ${seq} timed out`);
    await sleep(100);
  }
}

// ── SSE client: count data: frames without parsing anything heavier ──

function openSse({ consume = true, slowMs = 0 } = {}) {
  return fetch(`${BASE}/admin/logs`, { headers: { cookie } }).then((res) => {
    if (res.status !== 200) throw new Error(`SSE open failed: ${res.status}`);
    const reader = res.body.getReader();
    let frames = 0;
    let bytes = 0;
    let closed = false;
    const state = { frames: () => frames, bytes: () => bytes, closed: () => closed };
    const pump = async () => {
      try {
        for (;;) {
          if (slowMs) await sleep(slowMs);
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          frames += countFrames(Buffer.from(value).toString("utf8"));
        }
      } catch {
        // aborted or dropped
      }
      closed = true;
    };
    if (consume) void pump();
    return {
      ...state,
      close: () => reader.cancel().catch(() => {}),
      startSlow: () => void pump(),
    };
  });
}

let sseBuf = "";
function countFrames(chunk) {
  sseBuf += chunk;
  let n = 0;
  let idx;
  while ((idx = sseBuf.indexOf("\n\n")) >= 0) {
    const frame = sseBuf.slice(0, idx);
    sseBuf = sseBuf.slice(idx + 2);
    if (frame.startsWith("data:")) n += 1;
  }
  return n;
}

// ── Statistics ──

function percentiles(msArr) {
  if (!msArr.length) return { n: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const s = [...msArr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    min: Math.round(s[0]),
    p50: Math.round(q(0.5)),
    p95: Math.round(q(0.95)),
    p99: Math.round(q(0.99)),
    max: Math.round(s[s.length - 1]),
    mean: Math.round(msArr.reduce((a, b) => a + b, 0) / msArr.length),
  };
}

const results = { meta: { port: PORT, emptyPoolAtBoot: true, startedAt: new Date().toISOString() }, s1: [], s2: {}, s3: {}, s4: {}, s5: {}, s6: {} };

// ══════════════════════ S1: SSE streams + log storm ══════════════════════

async function s1() {
  phase("S1", "SSE 50/100/200 + log storm");
  let seq = 100;
  const storm = 3000;
  for (const n of [50, 100, 200]) {
    plog(`S1: opening ${n} consuming SSE connections`);
    const conns = [];
    for (let i = 0; i < n; i++) conns.push(await openSse());
    await sleep(1500);
    const rss0 = serverRssMb();
    const t0 = Date.now();
    const ingest = await ingestLogs(seq++, storm, 1);
    const t1 = Date.now();
    const rss1 = serverRssMb();
    await sleep(2000);
    const frames = conns.map((c) => c.frames());
    const fmin = Math.min(...frames);
    const fmax = Math.max(...frames);
    const favg = Math.round(frames.reduce((a, b) => a + b, 0) / frames.length);
    plog(
      `S1 n=${n}: ingest ${storm} x 1KB in ${ingest.ms}ms (${Math.round((storm / (t1 - t0)) * 1000)}/s) ` +
      `| rss ${rss0.toFixed(1)} -> ${rss1.toFixed(1)} MB | frames min/avg/max ${fmin}/${favg}/${fmax} (expected ${storm + 50})`,
    );
    results.s1.push({
      n, storm, ingestMs: ingest.ms, ingestRatePerS: Math.round((storm / (t1 - t0)) * 1000),
      rssBeforeMb: rss0, rssAfterMb: rss1, framesMin: fmin, framesAvg: favg, framesMax: fmax,
      expectedFrames: storm + 50,
    });
    for (const c of conns) await c.close();
    await sleep(2000);
  }
}

// ══════════════════════ S2: concurrent account ops ══════════════════════

function verifyAccountsFile(expected) {
  const raw = fs.readFileSync(path.join(TMP, "accounts.json"), "utf8");
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${err.message}`, length: -1 };
  }
  if (!Array.isArray(list)) return { ok: false, reason: "not an array", length: -1 };
  const keys = list.map((a) => String(a.key ?? ""));
  const uniq = new Set(keys);
  const bad = keys.filter((k) => !/^crsr_/.test(k));
  return {
    ok: list.length === expected && uniq.size === list.length && bad.length === 0,
    reason: list.length !== expected ? `length ${list.length} != ${expected}` : uniq.size !== list.length ? "duplicate keys" : bad.length ? "bad key shape" : "ok",
    length: list.length,
    unique: uniq.size === list.length,
  };
}

async function s2() {
  phase("S2", "account ops 20/50");
  const crypto = await import("node:crypto");
  const addN = async (keys) => {
    const t0 = Date.now();
    const results_ = await Promise.all(keys.map((key) => timed("POST", "/admin/accounts", { key })));
    const wall = Date.now() - t0;
    const fails = results_.filter((r) => r.status !== 200);
    return { wall, fails: fails.map((f) => f.status), ms: results_.map((r) => r.ms) };
  };

  const run20 = await addN(Array.from({ length: 20 }, (_, i) => `crsr_p2_${String(i + 1).padStart(4, "0")}`));
  plog(`S2 add x20: wall ${run20.wall}ms, statuses ${run20.fails.length ? run20.fails.join(",") : "all 200"}, verify ${JSON.stringify(verifyAccountsFile(20))}`);
  results.s2.add20 = { wallMs: run20.wall, perReqMs: percentiles(run20.ms), verify: verifyAccountsFile(20) };

  const run50 = await addN(Array.from({ length: 50 }, (_, i) => `crsr_p2_${String(i + 21).padStart(4, "0")}`));
  plog(`S2 add x50: wall ${run50.wall}ms, statuses ${run50.fails.length ? run50.fails.join(",") : "all 200"}, verify ${JSON.stringify(verifyAccountsFile(70))}`);
  results.s2.add50 = { wallMs: run50.wall, perReqMs: percentiles(run50.ms), verify: verifyAccountsFile(70) };

  const allKeys = Array.from({ length: 70 }, (_, i) => `crsr_p2_${String(i + 1).padStart(4, "0")}`);
  const allIds = allKeys.map((k) => crypto.createHash("sha256").update(k).digest("hex").slice(0, 12));

  const toggle = async (ids_, disabled) => {
    const t0 = Date.now();
    const rs = await Promise.all(ids_.map((id) => timed("POST", `/admin/accounts/${id}/disabled`, { disabled })));
    return { wall: Date.now() - t0, fails: rs.filter((r) => r.status !== 200).map((r) => r.status), ms: rs.map((r) => r.ms) };
  };
  const t20 = await toggle(allIds.slice(0, 20), true);
  plog(`S2 disable x20: wall ${t20.wall}ms, fails ${t20.fails.length}, verify ${JSON.stringify(verifyAccountsFile(70))}`);
  results.s2.disable20 = { wallMs: t20.wall, perReqMs: percentiles(t20.ms), verify: verifyAccountsFile(70) };

  const t50 = await toggle(allIds, true);
  const e50 = await toggle(allIds, false);
  plog(`S2 disable x50: wall ${t50.wall}ms fails ${t50.fails.length} | enable x50: wall ${e50.wall}ms fails ${e50.fails.length} | verify ${JSON.stringify(verifyAccountsFile(70))}`);
  results.s2.disable50 = { wallMs: t50.wall, perReqMs: percentiles(t50.ms), verify: verifyAccountsFile(70) };
  results.s2.enable50 = { wallMs: e50.wall, perReqMs: percentiles(e50.ms), verify: verifyAccountsFile(70) };

  const probe = async (ids_) => {
    const t0 = Date.now();
    const rs = await Promise.all(ids_.map((id) => timed("POST", `/admin/accounts/${id}/probe`, {})));
    return { wall: Date.now() - t0, fails: rs.filter((r) => r.status !== 200).map((r) => r.status), ms: rs.map((r) => r.ms) };
  };
  const p20 = await probe(allIds.slice(0, 20));
  const p50 = await probe(allIds);
  plog(`S2 probe x20: wall ${p20.wall}ms fails ${p20.fails.length} | probe x50: wall ${p50.wall}ms fails ${p50.fails.length}`);
  results.s2.probe20 = { wallMs: p20.wall, perReqMs: percentiles(p20.ms) };
  results.s2.probe50 = { wallMs: p50.wall, perReqMs: percentiles(p50.ms) };

  const mixed = async () => {
    const t0 = Date.now();
    const jobs = [];
    for (const id of allIds.slice(0, 20)) jobs.push(timed("POST", `/admin/accounts/${id}/disabled`, { disabled: true }));
    for (const id of allIds.slice(20, 40)) jobs.push(timed("POST", `/admin/accounts/${id}/disabled`, { disabled: false }));
    for (const id of allIds.slice(40, 70)) jobs.push(timed("POST", `/admin/accounts/${id}/probe`, {}));
    const rs = await Promise.all(jobs);
    return { wall: Date.now() - t0, fails: rs.filter((r) => r.status !== 200).map((r) => r.status), ms: rs.map((r) => r.ms) };
  };
  const mix = await mixed();
  plog(`S2 mixed 20d+20e+30p: wall ${mix.wall}ms fails ${mix.fails.length} | verify ${JSON.stringify(verifyAccountsFile(70))}`);
  results.s2.mixed = { wallMs: mix.wall, perReqMs: percentiles(mix.ms), verify: verifyAccountsFile(70) };
}

// ══════════════════════ S3: mixed load ══════════════════════

async function s3() {
  phase("S3", "50 stream + 50 status for 60s");
  const DURATION = 60_000;
  const r = await timed("POST", "/v1/chat/completions", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "warmup" }],
    stream: true,
  }, { authorization: `Bearer ${CLIENT_KEY}` });
  plog(`S3 warmup stream: status ${r.status}`);

  const dataMs = [];
  const statusMs = [];
  let dataOk = 0;
  let dataFail = 0;
  let statusOk = 0;
  let statusFail = 0;
  const buckets = [];
  let dataRunning = true;
  let statusRunning = true;

  const workerData = async () => {
    while (dataRunning) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_KEY}` },
          body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "s3" }], stream: true }),
        });
        await res.body?.cancel();
        if (res.status === 200) dataOk += 1;
        else dataFail += 1;
      } catch {
        dataFail += 1;
      }
      dataMs.push(Date.now() - t0);
    }
  };
  const workerStatus = async () => {
    while (statusRunning) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE}/admin/status`, { headers: { cookie } });
        await res.text();
        if (res.status === 200) statusOk += 1;
        else statusFail += 1;
      } catch {
        statusFail += 1;
      }
      statusMs.push(Date.now() - t0);
    }
  };

  const t0 = Date.now();
  const w1 = Array.from({ length: 50 }, () => workerData());
  const w2 = Array.from({ length: 50 }, () => workerStatus());

  // rolling count of completed requests per 15s window
  const windows = [];
  let markD = 0;
  let markS = 0;
  const windowTimer = setInterval(() => {
    windows.push({
      t: Math.round((Date.now() - t0) / 1000),
      dataDone: dataMs.length - markD,
      statusDone: statusMs.length - markS,
    });
    markD = dataMs.length;
    markS = statusMs.length;
  }, 15_000);
  await sleep(DURATION);
  dataRunning = false;
  statusRunning = false;
  clearInterval(windowTimer);
  await Promise.all([...w1, ...w2]);
  const total = Date.now() - t0;

  const dp = percentiles(dataMs);
  const sp = percentiles(statusMs);
  plog(
    `S3 done ${total}ms: data ok=${dataOk} fail=${dataFail} ${dp.n} reqs p50=${dp.p50}ms p95=${dp.p95} p99=${dp.p99} ` +
    `(${Math.round(dp.n / (total / 1000))}/s) | status ok=${statusOk} fail=${statusFail} p50=${sp.p50} p95=${sp.p95} p99=${sp.p99} (${Math.round(sp.n / (total / 1000))}/s)`,
  );
  results.s3 = {
    durationMs: total,
    data: { ...dp, ok: dataOk, fail: dataFail, rps: Math.round(dp.n / (total / 1000)) },
    status: { ...sp, ok: statusOk, fail: statusFail, rps: Math.round(sp.n / (total / 1000)) },
    windows,
  };
  plog(`S3 windows: ${JSON.stringify(windows)}`);
}

// ══════════════════════ S4: slow clients ══════════════════════

async function s4() {
  phase("S4", "slow clients (never-read + trickle)");
  const never = [];
  for (let i = 0; i < 5; i++) never.push(await openSse({ consume: false }));
  const trickle = await openSse({ consume: false, slowMs: 500 });
  trickle.startSlow();
  plog("S4: 5 never-read + 1 trickle (500ms) SSE connections open");

  const rssTrace = [];
  const sampler = setInterval(() => rssTrace.push(serverRssMb()), 1000);
  const rss0 = serverRssMb();
  const ingest = await ingestLogs(900, 20_000, 1);
  await sleep(3000);
  clearInterval(sampler);
  const rssTail = serverRssMb();
  const trickleFrames = trickle.frames();
  plog(
    `S4: ingest 20000x1KB in ${ingest.ms}ms | rss ${rss0.toFixed(1)} -> peak ${Math.max(...rssTrace).toFixed(1)} -> tail ${rssTail.toFixed(1)} MB ` +
    `| trickle frames ${trickleFrames} (expected 20050 if no drop)`,
  );
  results.s4 = {
    ingestMs: ingest.ms,
    rssBeforeMb: rss0,
    rssPeakMb: Math.max(...rssTrace),
    rssTailMb: rssTail,
    rssTrace,
    trickleFrames,
    expectedFrames: 20_050,
  };
  for (const c of never) await c.close();
  await trickle.close();
  await sleep(2000);
}

// ══════════════════════ S5: connection storm ══════════════════════

async function s5() {
  phase("S5", "100 open/close per s x 30s");
  const beforeRss = serverRssMb();
  const beforeLsof = lsofCount();
  const beforeHandles = lastHandles();
  let seq = 950;
  const logPump = setInterval(() => {
    fs.writeFileSync(path.join(DIR, "ctl-log.json"), JSON.stringify({ seq: seq++, count: 10, sizeKB: 1 }));
  }, 1000);
  const t0 = Date.now();
  let opened = 0;
  let failed = 0;
  const stormTimer = setInterval(() => {
    for (let i = 0; i < 10; i++) {
      openSse()
        .then((c) => {
          opened += 1;
          setTimeout(() => c.close(), 20 + Math.floor(Math.random() * 30));
        })
        .catch(() => (failed += 1));
    }
  }, 100);
  await sleep(30_000);
  clearInterval(stormTimer);
  clearInterval(logPump);
  await sleep(5000);
  const afterRss = serverRssMb();
  const afterLsof = lsofCount();
  const afterHandles = lastHandles();
  const wall = Date.now() - t0;
  plog(
    `S5: ${opened} opened / ${failed} failed in ${wall}ms (${Math.round(opened / (wall / 1000))}/s) ` +
    `| rss ${beforeRss.toFixed(1)} -> ${afterRss.toFixed(1)} MB | lsof ${beforeLsof} -> ${afterLsof} | handles ${JSON.stringify(beforeHandles)} -> ${JSON.stringify(afterHandles)}`,
  );
  results.s5 = {
    opened, failed, wallMs: wall, ratePerS: Math.round(opened / (wall / 1000)),
    rssBeforeMb: beforeRss, rssAfterMb: afterRss,
    lsofBefore: beforeLsof, lsofAfter: afterLsof,
    handlesBefore: beforeHandles, handlesAfter: afterHandles,
  };
}

// ══════════════════════ S6: update-check hammering ══════════════════════

async function s6() {
  phase("S6", "update/check hammering, ttlCache");
  const hammer = async (n) => {
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: n }, () => timed("GET", "/admin/update/check")));
    const wall = Date.now() - t0;
    const fails = rs.filter((r) => r.status !== 200);
    return { wall, ms: rs.map((r) => r.ms), fails: fails.map((f) => `${f.status}:${f.text.slice(0, 80)}`) };
  };

  const a = await hammer(50);
  const fcA = fetchCount();
  plog(`S6 burst-50: wall ${a.wall}ms p50=${percentiles(a.ms).p50} p95=${percentiles(a.ms).p95} fails=${a.fails.length} | fetch calls so far ${fcA}`);
  await sleep(3000);
  const b = await hammer(50);
  const fcB = fetchCount();
  plog(`S6 burst-50 +3s (ttl hit): wall ${b.wall}ms p50=${percentiles(b.ms).p50} | fetch calls ${fcB} (should still be ${fcA})`);
  await sleep(58_000); // cross the 60s TTL
  const c = await hammer(1);
  const fcC = fetchCount();
  plog(`S6 single +61s (ttl expired): wall ${c.wall}ms | fetch calls ${fcC} (should be ${fcB + 1})`);
  results.s6 = {
    burst50: { wallMs: a.wall, perReqMs: percentiles(a.ms), fails: a.fails },
    burst50After3s: { wallMs: b.wall, perReqMs: percentiles(b.ms), fails: b.fails },
    singleAfter61s: { wallMs: c.wall, perReqMs: percentiles(c.ms), fails: c.fails },
    fetchCounts: { afterBurstA: fcA, afterBurstB: fcB, afterSingleC: fcC },
  };
}

// ══════════════════════ main ══════════════════════

const tGlobal = Date.now();
async function main() {
  phase("P0", "boot + empty pool baseline");
  spawnServer();
  await waitReady();
  await adminLogin();
  setMockCtl({ seq: 1, toolEveryN: 1_000_000 });
  await sleep(10_000);
  plog(`P0: rss ${serverRssMb().toFixed(1)} MB, lsof ${lsofCount()}, fetch calls ${fetchCount()}`);

  await s1();
  await s2();
  await s3();
  await s4();
  await s5();
  await s6();

  phase("P7", "final");
  await sleep(5000);
  plog(`final: rss ${serverRssMb().toFixed(1)} MB, lsof ${lsofCount()}`);
  results.meta.finishedAt = new Date().toISOString();
  results.meta.totalRunMs = Date.now() - tGlobal;
  fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(results, null, 2));
  plog(`total run ${Math.round((Date.now() - tGlobal) / 1000)}s; results in pressure2/results.json`);
}

main()
  .then(() => {
    server?.kill("SIGTERM");
    plog("driver done");
  })
  .catch((err) => {
    plog(`FATAL: ${err.stack ?? err}`);
    server?.kill("SIGKILL");
    process.exitCode = 1;
  });
