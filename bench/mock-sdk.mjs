export const mock = {
  runs: [],
  createDelayMs: 0,
  runDelayMs: 0,
  toolRoundTrip: true,
  lastCustomTools: null,
  usage: { inputTokens: 10, outputTokens: 5 },
}

const napped = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() })

export class FakeRun {
  constructor(customTools) {
    this.id = `run-${mock.runs.length + 1}`
    this.status = "running"
    this._abort = false
    this._customTools = customTools ?? null
    mock.runs.push(this)
  }
  supports(op) {
    return ["stream", "wait", "cancel", "conversation"].includes(op)
  }
  unsupportedReason() {
    return undefined
  }
  async cancel() {
    this.status = "cancelled"
    this._abort = true
  }
  async *stream() {
    if (mock.runDelayMs) await napped(mock.runDelayMs)
    if (this._customTools && mock.toolRoundTrip) {
      const name = Object.keys(this._customTools)[0]
      const tool = this._customTools[name]
      const exec = tool.execute({ q: "bench" }, { toolCallId: `sdk-${this.id}` })
      yield { type: "assistant", message: { content: [{ type: "text", text: "calling tool" }] } }
      await exec
      yield { type: "assistant", message: { content: [{ type: "text", text: "the answer is 42" }] } }
      yield { type: "usage", usage: mock.usage }
    } else {
      yield { type: "assistant", message: { content: [{ type: "text", text: "mock reply" }] } }
      yield { type: "usage", usage: mock.usage }
    }
  }
  async wait() {
    return { id: this.id, status: this.status === "cancelled" ? "cancelled" : "finished" }
  }
}

export class FakeAgent {
  async send(_prompt, opts = {}) {
    mock.lastCustomTools = opts?.local?.customTools ?? null
    return new FakeRun(mock.lastCustomTools)
  }
  close() {}
  reload() {}
  async [Symbol.asyncDispose]() {}
  async getUsage() {
    return {}
  }
  async listArtifacts() {
    return []
  }
  async downloadArtifact() {
    return Buffer.alloc(0)
  }
}

export const Agent = {
  async create() {
    if (mock.createDelayMs) await napped(mock.createDelayMs)
    return new FakeAgent()
  },
}

export const Cursor = {
  me: async () => ({ userEmail: "bench@example.com" }),
  models: {
    list: async () => [
      { id: "claude-opus-5", displayName: "Claude Opus 5", aliases: [], parameters: [] },
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", aliases: ["sonnet"], parameters: [] },
    ],
  },
}

export function configureCursorSdk() {}
