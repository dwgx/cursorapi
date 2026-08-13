import { spawn } from "node:child_process"
import fs from "node:fs"
import { runLoad } from "./load.mjs"
import { analyze } from "./analyze-profile.mjs"

const PORT = 8102
const BASE = `http://127.0.0.1:${PORT}`
const ACCOUNTS = "/tmp/bench-accounts.json"
const PROF_DIR = "/tmp/bench-cpuprof"

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

fs.mkdirSync(PROF_DIR, { recursive: true })
for (const f of fs.readdirSync(PROF_DIR)) fs.rmSync(`${PROF_DIR}/${f}`, { force: true })

const child = spawn(process.execPath, ["--cpu-prof", "--cpu-prof-dir=" + PROF_DIR, new URL("./server.mjs", import.meta.url).pathname], {
  env: { ...process.env, BENCH_PORT: String(PORT), BENCH_ACCOUNTS: ACCOUNTS, BENCH_LOG_LEVEL: "warn" },
  stdio: ["ignore", "pipe", "pipe"],
})
child.stdout.on("data", (d) => process.stdout.write(d))
child.stderr.on("data", (d) => process.stderr.write(d))

const deadline = Date.now() + 20000
while (!(await ping())) {
  if (child.exitCode !== null) throw new Error("profiled server exited early")
  if (Date.now() > deadline) throw new Error("profiled server did not become ready")
  await sleep(200)
}

const jsonInit = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const CHAT_BODY = { model: "claude-opus-5", stream: false, messages: [{ role: "user", content: "hello, tell me a joke" }] }

const r = await runLoad({
  url: BASE + "/v1/chat/completions",
  init: jsonInit(CHAT_BODY),
  concurrency: 20,
  warmupMs: 3000,
  durationMs: 20000,
})
console.log(`profiled load: ${r.reqs.toFixed(1)} req/s, p50=${r.p50.toFixed(1)}ms p95=${r.p95.toFixed(1)}ms p99=${r.p99.toFixed(1)}ms err=${r.errors}`)

child.kill("SIGTERM")
await Promise.race([
  new Promise((resolve) => child.once("exit", resolve)),
  sleep(3000).then(() => child.kill("SIGKILL")),
])

const files = fs.readdirSync(PROF_DIR).filter((f) => f.endsWith(".cpuprofile"))
if (!files.length) throw new Error("no cpuprofile written")
const prof = analyze(`${PROF_DIR}/${files[0]}`)

console.log(`\nprofile: ${files[0]}, total sampled ${prof.totalMs.toFixed(0)}ms`)
console.log("rank | self ms | self % | incl ms | function")
console.log("-----|---------|--------|---------|---------")
prof.top.forEach((e, i) => {
  const rel = e.key.replace(/^file:\/\/.*?\/cursorapi\//, "")
  console.log(`${i + 1} | ${e.selfMs.toFixed(1)} | ${e.selfPct.toFixed(1)} | ${e.inclMs.toFixed(1)} | ${rel}`)
})
