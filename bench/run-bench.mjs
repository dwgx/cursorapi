import { spawn } from "node:child_process"
import fs from "node:fs"
import { performance } from "node:perf_hooks"
import { runLoad, runToolLoad, pct } from "./load.mjs"

const PORT = 8101
const BASE = `http://127.0.0.1:${PORT}`
const ACCOUNTS = "/tmp/bench-accounts.json"
const RESULTS = new URL("./results.json", import.meta.url).pathname

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ping() {
  try {
    const res = await fetch(BASE + "/ping")
    await res.arrayBuffer()
    return res.ok
  } catch {
    return false
  }
}

async function spawnServer(logLevel) {
  const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
    env: { ...process.env, BENCH_PORT: String(PORT), BENCH_ACCOUNTS: ACCOUNTS, BENCH_LOG_LEVEL: logLevel },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (d) => process.stdout.write(`[server:${logLevel}] ${d}`))
  child.stderr.on("data", (d) => process.stderr.write(`[server:${logLevel}] ${d}`))
  const deadline = Date.now() + 20000
  while (!(await ping())) {
    if (child.exitCode !== null) throw new Error("server exited early")
    if (Date.now() > deadline) throw new Error("server did not become ready")
    await sleep(200)
  }
  return child
}

async function killServer(child) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    sleep(3000).then(() => child.kill("SIGKILL")),
  ])
}

function summary(r) {
  return {
    concurrency: r.concurrency,
    requests: r.requests,
    errors: r.errors,
    reqs: Number(r.reqs.toFixed(1)),
    p50: Number(r.p50.toFixed(1)),
    p95: Number(r.p95.toFixed(1)),
    p99: Number(r.p99.toFixed(1)),
    max: Number(r.max.toFixed(1)),
  }
}

const results = { env: { node: process.version, cpu: "Apple M2", platform: process.platform }, phases: {} }

async function run(name, fn, warmupMs) {
  const t0 = performance.now()
  const out = await fn()
  results.phases[name] = out
  console.log(`[done] ${name} in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${out.reqs} req/s (err=${out.errors})`)
}

if (!fs.existsSync(ACCOUNTS)) {
  fs.writeFileSync(ACCOUNTS, JSON.stringify([{ name: "bench-a", key: "crsr_bench_a" }, { name: "bench-b", key: "crsr_bench_b" }]), "utf8")
}

console.log("=== bench start ===")
const serverInfo = await spawnServer("info")
console.log("server (logLevel=info) ready")

const CONC_HTTP = [1, 10, 50, 200]
const CONC_DATA = [1, 5, 20]

const only = (process.env.BENCH_ONLY ?? "").split(",").filter(Boolean)

const want = (name) => !only.length || only.includes(name)

for (const c of CONC_HTTP) {
  if (!want("ping")) break
  await run(`ping:${c}`, () => runLoad({ url: BASE + "/ping", concurrency: c, warmupMs: c === 1 ? 500 : 1500 }))
}
for (const c of CONC_HTTP) {
  if (!want("status")) break
  await run(`admin-status:${c}`, () => runLoad({ url: BASE + "/admin/status", concurrency: c, warmupMs: c === 1 ? 500 : 1500 }))
}
for (const c of CONC_HTTP) {
  if (!want("page")) break
  await run(`admin-page:${c}`, () => runLoad({ url: BASE + "/admin", concurrency: c, warmupMs: c === 1 ? 500 : 1500 }))
}
for (const c of CONC_HTTP) {
  if (!want("models")) break
  await run(`v1-models:${c}`, () => runLoad({ url: BASE + "/v1/models", concurrency: c, warmupMs: c === 1 ? 500 : 1500 }))
}

const jsonInit = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const CHAT_BODY = { model: "claude-opus-5", stream: false, messages: [{ role: "user", content: "hello, tell me a joke" }] }
const CHAT_STREAM_BODY = { ...CHAT_BODY, stream: true }

for (const c of CONC_DATA) {
  if (!want("chat")) break
  await run(`chat-nonstream:${c}`, () => runLoad({ url: BASE + "/v1/chat/completions", init: jsonInit(CHAT_BODY), concurrency: c, warmupMs: c === 1 ? 500 : 1500 }))
}
for (const c of CONC_DATA) {
  if (!want("chat")) break
  await run(`chat-stream:${c}`, () => runLoad({ url: BASE + "/v1/chat/completions", init: jsonInit(CHAT_STREAM_BODY), concurrency: c, warmupMs: c === 1 ? 500 : 1500 }))
}
for (const c of CONC_DATA) {
  if (!want("tool")) break
  await run(`tool-relay:${c}`, () => runToolLoad({ base: BASE, concurrency: c, warmupMs: c === 1 ? 500 : 1500 }))
}

if (want("chat")) {
  await killServer(serverInfo)
  console.log("server (info) stopped")

  const serverWarn = await spawnServer("warn")
  console.log("server (logLevel=warn) ready")
  await run(`chat-nonstream-20-warn`, () => runLoad({ url: BASE + "/v1/chat/completions", init: jsonInit(CHAT_BODY), concurrency: 20, warmupMs: 1500 }))
  await killServer(serverWarn)
  console.log("server (warn) stopped")
}

fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2))
console.log(`raw results -> ${RESULTS}`)

function table(rows, cols) {
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)))
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(" | ")
  const sep = widths.map((w) => "-".repeat(w)).join(" | ")
  const out = [line(cols), sep]
  for (const r of rows) out.push(line(r))
  return out.join("\n")
}

const p = results.phases
console.log("\n=== HTTP 基础吞吐 (logLevel=info) ===")
for (const [name, label] of [["ping", "/ping"], ["admin-status", "/admin/status"], ["admin-page", "/admin (HTML)"], ["v1-models", "/v1/models"]]) {
  if (!p[`${name}:1`]) continue
  console.log(`\n## ${label}`)
  console.log(table(CONC_HTTP.map((c) => { const s = summary(p[`${name}:${c}`]); return [s.concurrency, s.reqs, s.p50, s.p95, s.p99, s.max, s.errors] }), ["conc", "req/s", "p50ms", "p95ms", "p99ms", "maxms", "err"]))
}

console.log("\n=== 数据面 (mock SDK, logLevel=info) ===")
for (const [name, label] of [["chat-nonstream", "chat non-stream"], ["chat-stream", "chat stream"], ["tool-relay", "tool relay (2 req/turn)"]]) {
  if (!p[`${name}:1`]) continue
  console.log(`\n## ${label}`)
  console.log(table(CONC_DATA.map((c) => { const s = summary(p[`${name}:${c}`]); return [s.concurrency, s.reqs, s.p50, s.p95, s.p99, s.max, s.errors] }), ["conc", "req/s", "p50ms", "p95ms", "p99ms", "maxms", "err"]))
}

if (p["chat-nonstream:20"] && p["chat-nonstream-20-warn"]) {
  console.log("\n### logLevel 对比 (chat non-stream @20)")
  console.log(table([["info", summary(p["chat-nonstream:20"]).reqs, summary(p["chat-nonstream:20"]).p95], ["warn", summary(p["chat-nonstream-20-warn"]).reqs, summary(p["chat-nonstream-20-warn"]).p95]], ["logLevel", "req/s", "p95ms"]))
}
