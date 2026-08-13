import { performance } from "node:perf_hooks"

export function pct(sorted, p) {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[i]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function runLoad({ url, init, concurrency, warmupMs = 2000, durationMs = 5000 }) {
  const lat = []
  let errors = 0
  let measuring = false
  let stop = false

  async function worker() {
    while (!stop) {
      const t0 = performance.now()
      try {
        const res = await fetch(url, init)
        await res.arrayBuffer()
        if (measuring) {
          if (res.ok) lat.push(performance.now() - t0)
          else errors += 1
        }
      } catch {
        if (measuring) errors += 1
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await sleep(warmupMs)
  measuring = true
  const begin = performance.now()
  await sleep(durationMs)
  measuring = false
  stop = true
  await Promise.all(workers)

  const wall = (performance.now() - begin) / 1000
  const sorted = [...lat].sort((a, b) => a - b)
  return {
    concurrency,
    requests: lat.length,
    errors,
    reqs: lat.length / wall,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  }
}

const TOOL_INITIAL = {
  model: "claude-opus-5",
  stream: true,
  messages: [{ role: "user", content: "what is the weather like" }],
  tools: [{ type: "function", function: { name: "weather", description: "query the weather", parameters: { type: "object", properties: { q: { type: "string" } } } } }],
}

export async function runToolLoad({ base, concurrency, warmupMs = 2000, durationMs = 5000 }) {
  const lat = []
  let errors = 0
  let measuring = false
  let stop = false
  const url = base + "/v1/chat/completions"
  const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  async function doTurn() {
    const t0 = performance.now()
    const res = await fetch(url, json(TOOL_INITIAL))
    const text = await res.text()
    const ids = []
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue
      const data = line.slice(6).trim()
      if (!data || data === "[DONE]") continue
      const obj = JSON.parse(data)
      const calls = obj.choices?.[0]?.delta?.tool_calls
      if (calls) for (const c of calls) if (c.id) ids.push(c.id)
    }
    if (!res.ok || !ids.length) {
      if (measuring) errors += 1
      return
    }
    const follow = await fetch(url, json({
      model: "claude-opus-5",
      stream: false,
      messages: [
        { role: "user", content: "what is the weather like" },
        { role: "assistant", content: null, tool_calls: [{ id: ids[0], type: "function", function: { name: "weather", arguments: "{}" } }] },
        { role: "tool", tool_call_id: ids[0], content: "sunny 25c" },
      ],
    }))
    await follow.text()
    if (measuring) {
      if (follow.ok) lat.push(performance.now() - t0)
      else errors += 1
    }
  }

  const workers = Array.from({ length: concurrency }, async () => {
    while (!stop) await doTurn()
  })
  await sleep(warmupMs)
  measuring = true
  const begin = performance.now()
  await sleep(durationMs)
  measuring = false
  stop = true
  await Promise.all(workers)

  const wall = (performance.now() - begin) / 1000
  const sorted = [...lat].sort((a, b) => a - b)
  return {
    concurrency,
    requests: lat.length,
    errors,
    reqs: lat.length / wall,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  }
}
