import fs from "node:fs"
import { performance } from "node:perf_hooks"
import { registerHooks } from "node:module"

const sdkUrl = import.meta.resolve("@cursor/sdk")
const fakeUrl = new URL("./mock-sdk.mjs", import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(sdkUrl)) return nextLoad(url, context)
    return {
      format: "module",
      shortCircuit: true,
      source: `import { Agent, Cursor, configureCursorSdk } from ${JSON.stringify(fakeUrl)}; export { Agent, Cursor, configureCursorSdk };`,
    }
  },
})

const ACCOUNTS = "/tmp/bench-micro-accounts.json"
process.env.CURSOR_ACCOUNTS = ACCOUNTS
process.env.CURSOR_WORKSPACE = "/tmp/bench-workspace"
process.env.CURSOR_PROBE_INTERVAL_MS = "0"

const pool = await import("../src/keys.mjs")

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({ name: `a${i}`, key: `crsr_micro_${i}` }))
}

function bench(label, fn, budgetMs = 500) {
  const t0 = performance.now()
  let iters = 0
  while (performance.now() - t0 < budgetMs) {
    fn()
    iters += 1
  }
  const ms = performance.now() - t0
  const per = (ms / iters) * 1000
  console.log(`${label}: ${iters} iters in ${ms.toFixed(0)}ms -> ${per.toFixed(2)}us/iter`)
  return per
}

for (const n of [2, 10, 50, 200]) {
  fs.writeFileSync(ACCOUNTS, JSON.stringify(makeAccounts(n)), "utf8")
  pool.loadAccounts()
  bench(`select+release (pool=${n})`, (i) => {
    const a = pool.select()
    pool.release(a)
  }, 700)
}

const iso = new Date().toISOString()
bench("Date.parse control (ISO string)", () => Date.parse(iso), 300)
bench("Date.parse x86 (ISO string)", () => {
  for (let i = 0; i < 86; i++) Date.parse(iso)
}, 300)

fs.writeFileSync(ACCOUNTS, JSON.stringify(makeAccounts(2)), "utf8")
pool.loadAccounts()
const acc = pool.all()[0]
const usage = { inputTokens: 10, outputTokens: 5 }
bench("reportSuccess+recordRequest", () => {
  pool.reportSuccess(acc, usage)
  pool.recordRequest("claude-opus-5", true, 5, acc.id, usage)
}, 500)

const { renderPrompt } = await import("../src/format.mjs")
const small = [{ role: "user", content: "hello" }]
const big = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message number ${i} with some text` }))
bench("renderPrompt (1 msg)", () => renderPrompt(small), 500)
bench("renderPrompt (40 msgs)", () => renderPrompt(big), 500)

const { normalizeTools } = await import("../src/openai.mjs")
const tool = [{ type: "function", function: { name: "weather", description: "x", parameters: { type: "object", properties: { q: { type: "string" } } } } }]
bench("normalizeTools (1 tool)", () => normalizeTools(tool), 500)
