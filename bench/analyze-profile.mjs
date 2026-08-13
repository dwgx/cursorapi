import fs from "node:fs"

export function analyze(profilePath) {
  const prof = JSON.parse(fs.readFileSync(profilePath, "utf8"))
  const byId = new Map()
  for (const n of prof.nodes) byId.set(n.id, n)
  const parents = new Map()
  for (const n of prof.nodes) {
    for (const c of n.children ?? []) parents.set(c, n.id)
  }

  const self = new Map()
  const inclusive = new Map()
  const selfTotal = prof.timeDeltas.reduce((a, b) => a + b, 0)

  const keyOf = (n) => {
    const f = n.callFrame
    return `${f.url ?? "?"}:${f.functionName ?? "(anon)"}`
  }

  for (let i = 0; i < prof.samples.length; i++) {
    const leafId = prof.samples[i]
    const delta = prof.timeDeltas[i]
    const leaf = byId.get(leafId)
    if (!leaf) continue
    const k = keyOf(leaf)
    self.set(k, (self.get(k) ?? 0) + delta)
    let cur = leafId
    while (cur !== undefined) {
      const node = byId.get(cur)
      if (!node) break
      const kk = keyOf(node)
      inclusive.set(kk, (inclusive.get(kk) ?? 0) + delta)
      cur = parents.get(cur)
    }
  }

  const selfMs = [...self.entries()].map(([k, v]) => ({ key: k, selfMs: v / 1000, selfPct: (v / selfTotal) * 100 }))
  const inclMs = [...inclusive.entries()].map(([k, v]) => ({ key: k, inclMs: v / 1000 }))
  const inclMap = new Map(inclMs.map((e) => [e.key, e]))
  selfMs.sort((a, b) => b.selfMs - a.selfMs)
  return {
    totalMs: selfTotal / 1000,
    top: selfMs.slice(0, 25).map((e) => ({ ...e, inclMs: (inclMap.get(e.key)?.inclMs ?? 0) })),
  }
}
