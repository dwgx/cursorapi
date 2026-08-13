process.env.CURSOR_PORT = process.env.BENCH_PORT ?? "8101"
process.env.CURSOR_HOST = "127.0.0.1"
process.env.CURSOR_ACCOUNTS = process.env.BENCH_ACCOUNTS ?? "/tmp/bench-accounts.json"
process.env.CURSOR_WORKSPACE = "/tmp/bench-workspace"
process.env.CURSOR_PROBE_INTERVAL_MS = "0"
process.env.CURSOR_PROXY = ""
process.env.CURSOR_CLIENT_KEYS = ""
process.env.CURSOR_ADMIN_KEY = ""
process.env.CURSOR_ALLOW_SUBAGENTS = "true"
if (process.env.BENCH_LOG_LEVEL) process.env.CURSOR_LOG_LEVEL = process.env.BENCH_LOG_LEVEL

import fs from "node:fs"
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

fs.mkdirSync(process.env.CURSOR_WORKSPACE, { recursive: true })
const accountsFile = process.env.CURSOR_ACCOUNTS
if (!fs.existsSync(accountsFile)) {
  fs.writeFileSync(
    accountsFile,
    JSON.stringify([{ name: "bench-a", key: "crsr_bench_a" }, { name: "bench-b", key: "crsr_bench_b" }]),
    "utf8",
  )
}

await import("../src/app.mjs")
