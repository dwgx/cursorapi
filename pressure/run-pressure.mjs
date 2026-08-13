// Pressure driver: boots the real server (src/ untouched) on port 8103 with
// the mock SDK hook + monitor, then runs the seven pressure phases:
//
//   P0  baseline: 60s of no load
//   P1  mixed load for 10 min (20/s /admin/status + big log every 5s +
//       occasional data-plane requests)
//   P2  SSE subscriber leak: 50 /admin/logs connections, close all, 60s wait
//   P3  log ring buffer: 100k entries with 100KB payloads
//   P4  timer leak: panel polling / probe / heartbeat / update-status round
//   P5  byToolCall table: 1000 real tool round-trips
//   P6  fd/handle check before shutdown (lsof)
//
// Evidence: pressure/metrics.csv (5s samples), pressure/phases.jsonl,
// pressure/server.err.log, pressure/pressure.log. Read pressure/report.md
// after the run for the analysis.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const PORT = 8104;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIR = path.join(ROOT, "pressure");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cspk-pressure-"));
const CLIENT_KEY = "pressure-client";
const ADMIN_KEY = "pressure-admin";

const logFile = path.join(DIR, "pressure.log");
const logFd = fs.openSync(logFile, "a");
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
  return { status: res.status, json, text, headers: res.headers };
}

const chat = (body) =>
  api("POST", "/v1/chat/completions", body, { headers: { authorization: `Bearer ${CLIENT_KEY}` } });

// ── Server lifecycle ──

let server = null;
function spawnServer() {
  const accountsFile = path.join(TMP, "accounts.json");
  fs.writeFileSync(accountsFile, JSON.stringify([{ name: "pressure", key: "crsr_pressure_0001" }]));
  fs.writeFileSync(path.join(TMP, "runtime-config.json"), "{}");
  const env = {
    ...process.env,
    CURSOR_PORT: String(PORT),
    CURSOR_HOST: "127.0.0.1",
    CURSOR_ACCOUNTS: accountsFile,
    CURSOR_CLIENT_KEYS: CLIENT_KEY,
    CURSOR_ADMIN_KEY: ADMIN_KEY,
    CURSOR_PROBE_INTERVAL_MS: "30000",
    CURSOR_TURN_IDLE_TIMEOUT_MS: "20000",
    CURSOR_TOOL_RESULT_TIMEOUT_MS: "30000",
    CURSOR_LOG_LEVEL: "info",
    CURSOR_WORKSPACE: path.join(TMP, "work"),
    CSPK_PRESSURE_DIR: DIR,
  };
  fs.mkdirSync(path.join(TMP, "work"), { recursive: true });
  const errFd = fs.openSync(path.join(DIR, "server.err.log"), "w");
  // stdout -> /dev/null: the ring+stdout share the emit path, and 100k big
  // entries would write ~800MB to a log file; the ring stays intact (evidence
  // via /admin/logs/export). stderr keeps boot errors visible.
  const nullFd = fs.openSync("/dev/null", "w");
  server = spawn(process.execPath, [
    "--import", "./pressure/mock-hook.mjs",
    "--import", "./pressure/monitor.mjs",
    "boot.mjs",
  ], { cwd: ROOT, env, stdio: ["ignore", nullFd, errFd] });
  server.on("exit", (code, sig) => plog(`server exited code=${code} sig=${sig}`));
}

async function waitReady() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/ping`);
      if (r.status === 200) {
        plog(`server ready after ${Date.now() - startTs}ms`);
        return;
      }
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not become ready in time");
    await sleep(200);
  }
}

async function adminLogin() {
  const r = await api("POST", "/admin/login", { key: ADMIN_KEY });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  const sc = r.headers.get("set-cookie") ?? "";
  const token = /cursorapi_sess=([^;]+)/.exec(sc)?.[1];
  if (!token) throw new Error(`no session cookie in login response: ${r.text}`);
  cookie = `cursorapi_sess=${token}`;
  plog("admin login ok");
}

function setMockCtl(ctl) {
  fs.writeFileSync(path.join(DIR, "ctl-mock.json"), JSON.stringify(ctl));
}

async function ingestLogs(seq, count, sizeKB) {
  fs.writeFileSync(path.join(DIR, "ctl-log.json"), JSON.stringify({ seq, count, sizeKB }));
  const done = path.join(DIR, `ctl-log.done.${seq}`);
  const deadline = Date.now() + (count > 10_000 ? 300_000 : 30_000);
  for (;;) {
    if (fs.existsSync(done)) return JSON.parse(fs.readFileSync(done, "utf8"));
    if (Date.now() > deadline) throw new Error(`log ingestion ${seq} timed out`);
    await sleep(250);
  }
}

// ── Sampling helpers ──

function sampleWindow(sec, label) {
  const lines = fs.readFileSync(path.join(DIR, "metrics.csv"), "utf8").trim().split("\n").slice(1);
  const rows = lines.map((l) => {
    const m = l.match(/^(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+),(.+)\|(.+)$/);
    if (!m) return null;
    return { ts: +m[1], s: +m[2], rss: +m[3], hu: +m[4], ht: +m[5], ex: +m[6], fd: +m[7], btc: +m[8], handles: JSON.parse(m[9]), res: JSON.parse(m[10]) };
  }).filter(Boolean);
  if (!rows.length) return null;
  const a = rows[0];
  const b = rows[rows.length - 1];
  plog(`${label}: rss ${a.rss}->${b.rss} MB | heapUsed ${a.hu}->${b.hu} MB | fd ${a.fd}->${b.fd} | byToolCall ${a.btc}->${b.btc}`);
  plog(`${label} handles: ${JSON.stringify(a.handles)} -> ${JSON.stringify(b.handles)}`);
  plog(`${label} resources: ${JSON.stringify(a.res)} -> ${JSON.stringify(b.res)}`);
  return { first: a, last: b, rows };
}

function lsofCount() {
  try {
    const out = execFileSync("lsof", ["-p", String(server.pid), "-a", "-d", "0-65535"], { encoding: "utf8" });
    const n = out.trim().split("\n").length - 1;
    plog(`lsof: ${n} open fds for pid ${server.pid}`);
    return n;
  } catch (err) {
    plog(`lsof failed: ${err.message}`);
    return -1;
  }
}

// ── Phases ──

async function phase1() {
  phase("P1", "mixed load 10min");
  let ok = 0, err = 0, dropped = 0, inflight = 0;
  const pump = setInterval(() => {
    if (inflight >= 10) {
      dropped += 1;
      return;
    }
    inflight += 1;
    api("GET", "/admin/status")
      .then(() => (ok += 1))
      .catch(() => (err += 1))
      .finally(() => (inflight -= 1));
  }, 50);

  const t0 = Date.now();
  let bigLogSeq = 10;
  let dataReq = 0;
  try {
    while (Date.now() - t0 < 600_000) {
      await sleep(1000);
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (elapsed % 5 === 0) {
        bigLogSeq += 1;
        await ingestLogs(bigLogSeq, 1, 64);
      }
      if (elapsed % 30 === 0) {
        dataReq += 1;
        const isToolRound = dataReq % 4 === 0;
        if (isToolRound) setMockCtl({ seq: dataReq, toolEveryN: 1 });
        const r = await chat({
          model: "claude-opus-5",
          messages: [{ role: "user", content: `pressure data request #${dataReq}` }],
          tools: isToolRound ? [{
            type: "function",
            function: { name: "pressure_tool", description: "pressure tool", parameters: { type: "object", properties: { query: { type: "string" } } } },
          }] : undefined,
          stream: false,
        });
        if (isToolRound) {
          const tc = r.json?.choices?.[0]?.message?.tool_calls?.[0];
          if (tc) {
            await chat({
              model: "claude-opus-5",
              messages: [
                { role: "user", content: `pressure data request #${dataReq}` },
                { role: "tool", tool_call_id: tc.id, content: "round-trip ok" },
              ],
              stream: false,
            });
          }
          setMockCtl({ seq: dataReq + 1000, toolEveryN: 1_000_000 });
        }
        plog(`P1 data req #${dataReq} -> ${r.status}${isToolRound ? " (tool round)" : ""}`);
      }
    }
  } finally {
    clearInterval(pump);
  }
  plog(`P1 done: status ok=${ok} err=${err} dropped=${dropped}`);
}

async function openSse() {
  const res = await fetch(`${BASE}/admin/logs`, { headers: { cookie } });
  if (res.status !== 200) throw new Error(`SSE open failed: ${res.status}`);
  const reader = res.body.getReader();
  let bytes = 0;
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
    } catch {}
  })();
  return { reader, close: () => reader.cancel().catch(() => {}) };
}

async function phase2() {
  phase("P2", "SSE 50 conns");
  await sleep(15_000);
  sampleWindow(15, "P2 before");
  const conns = [];
  for (let i = 0; i < 50; i++) {
    conns.push(await openSse());
    if (i % 10 === 9) plog(`P2 opened ${i + 1}/50 SSE`);
  }
  await sleep(30_000);
  sampleWindow(30, "P2 50 open");
  for (const c of conns) await c.close();
  plog("P2 all SSE closed, waiting 60s");
  await sleep(60_000);
  sampleWindow(60, "P2 after 60s");
}

async function phase3() {
  phase("P3", "ring 100k x 100KB");
  const before = sampleWindow(0, "P3 before");
  const r = await ingestLogs(999, 100_000, 100);
  plog(`P3 ingestion: ${r.count} entries in ${r.ms}ms, rssAfter=${r.rssAfterMb}MB`);
  await sleep(5000);
  const after = sampleWindow(5, "P3 after");

  const exp = await api("GET", "/admin/logs/export");
  const lines = exp.text.trim().split("\n");
  const entries = lines.map((l) => JSON.parse(l));
  const msgBytes = entries.map((e) => Buffer.byteLength(e.msg));
  plog(`P3 export: ${lines.length} lines (ring cap 1000)`);
  plog(`P3 export: max msg ${Math.max(...msgBytes)} bytes, min ${Math.min(...msgBytes)}, avg ${Math.round(msgBytes.reduce((a, b) => a + b, 0) / msgBytes.length)}`);
  fs.writeFileSync(path.join(DIR, "p3-export-sample.json"), JSON.stringify(entries.slice(0, 3), null, 2));
}

async function phase4() {
  phase("P4", "timers round");
  await sleep(10_000);
  sampleWindow(10, "P4 before");
  for (let i = 0; i < 50; i++) {
    await api("GET", "/admin");
  }
  await api("GET", "/admin/update/status");
  const accs = await api("GET", "/admin/status");
  const firstId = accs.json?.accounts?.[0]?.id;
  if (firstId) await api("POST", `/admin/accounts/${firstId}/probe`, {});
  const sse = await openSse();
  await sleep(20_000); // one 15s heartbeat passes
  await sse.close();
  await api("POST", "/admin/logout", {});
  await sleep(10_000);
  sampleWindow(10, "P4 after");
  cookie = "";
  const login = await api("POST", "/admin/login", { key: ADMIN_KEY });
  const token = /cursorapi_sess=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  cookie = `cursorapi_sess=${token}`;
}

async function phase5() {
  phase("P5", "byToolCall 1000 round-trips");
  setMockCtl({ seq: 2000, toolEveryN: 1 });
  const t0 = Date.now();
  let fail = 0;
  const tools = [{
    type: "function",
    function: { name: "pressure_tool", description: "pressure tool", parameters: { type: "object", properties: { query: { type: "string" } } } },
  }];
  for (let i = 0; i < 1000; i++) {
    const a = await chat({
      model: "claude-opus-5",
      messages: [{ role: "user", content: `round ${i}` }],
      tools,
      stream: false,
    });
    const tc = a.json?.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc) {
      fail += 1;
      plog(`P5 round ${i}: no tool_call (status ${a.status}): ${a.text.slice(0, 200)}`);
      continue;
    }
    const b = await chat({
      model: "claude-opus-5",
      messages: [
        { role: "user", content: `round ${i}` },
        { role: "tool", tool_call_id: tc.id, content: `result ${i}` },
      ],
      stream: false,
    });
    if (b.status !== 200) {
      fail += 1;
      plog(`P5 round ${i}: resume status ${b.status}: ${b.text.slice(0, 200)}`);
    }
    if (i % 100 === 99) plog(`P5 ${i + 1}/1000 done (${Date.now() - t0}ms)`);
  }
  plog(`P5 done in ${Date.now() - t0}ms, fails=${fail}`);
  await sleep(10_000);
  sampleWindow(10, "P5 after");
}

async function main() {
  globalThis.startTs = Date.now();
  phase("P0", "boot + baseline");
  spawnServer();
  await waitReady();
  await adminLogin();
  setMockCtl({ seq: 1, toolEveryN: 1_000_000 });
  lsofCount();
  await sleep(60_000); // baseline with no load
  sampleWindow(60, "P0 baseline");

  await phase1();
  lsofCount();

  await phase2();
  lsofCount();

  await phase3();

  await phase4();
  lsofCount();

  await phase5();

  phase("P6", "final samples");
  await sleep(15_000);
  sampleWindow(15, "P6 final");
  lsofCount();
  plog(`total run: ${Math.round((Date.now() - startTs) / 1000)}s, tmpdir=${TMP}`);
  plog(`runs=${server ? "" : ""}`);
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
