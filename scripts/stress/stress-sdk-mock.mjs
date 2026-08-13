// In-memory @cursor/sdk fake for the stress harness.
//
// The server process is started with `node --import stress-hooks.mjs`, which
// registers a load hook rewriting every import of "@cursor/sdk" to this file
// (same technique as test-relay-hook.mjs, but as a preload so the real
// src/ tree is untouched). The fake is runtime-configurable through the
// metrics sidecar (GET/PUT /mock) so one server instance can serve all six
// stress scenarios: quick non-streaming runs for log storms, paced streaming
// runs for the data plane, and long-running streams for slow clients.

const napped = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

export const state = {
  // Mock behaviour, tuned per scenario via PUT /mock on the sidecar.
  config: {
    // "quick": stream() returns immediately (one usage event).
    // "stream": textEvents x eventIntervalMs, each textLen chars.
    // "duration": emit text until streamMs has elapsed.
    mode: "quick",
    textEvents: 60,
    eventIntervalMs: 25,
    textLen: 40,
    streamMs: 45_000,
    // Artificial latency for Cursor.me (account add / probe cost).
    meLatencyMs: 0,
  },
  // Counters, read via GET /counters on the sidecar.
  fetchCalls: 0,
  fetchUrls: {},
  runs: 0,
  events: 0,
  meCalls: 0,
  modelsCalls: 0,
  activeRuns: 0,
  activeAgents: 0,
};

export class FakeRun {
  constructor() {
    this.id = `run-${state.runs + 1}`;
    this.agentId = "agent-1";
    this.status = "running";
    this.cancelled = false;
    this._abort = false;
    state.runs += 1;
    state.activeRuns += 1;
  }
  supports(op) {
    return ["stream", "wait", "cancel", "conversation"].includes(op);
  }
  unsupportedReason() {
    return undefined;
  }
  async cancel() {
    this.cancelled = true;
    this.status = "cancelled";
    this._abort = true;
  }
  async *stream() {
    try {
      const c = state.config;
      if (c.mode === "quick") return;
      const total = c.mode === "duration" ? Infinity : c.textEvents;
      const start = Date.now();
      const body = "x".repeat(Math.max(1, c.textLen));
      for (let i = 0; i < total; i++) {
        if (this._abort) break;
        if (c.mode === "duration" && Date.now() - start >= c.streamMs) break;
        if (c.eventIntervalMs > 0) await napped(c.eventIntervalMs);
        if (this._abort) break;
        state.events += 1;
        yield { type: "assistant", message: { content: [{ type: "text", text: body }] } };
      }
      yield { type: "usage", usage: { inputTokens: 128, outputTokens: 256 } };
    } finally {
      state.activeRuns -= 1;
    }
  }
  async wait() {
    if (this.cancelled) return { id: this.id, status: "cancelled" };
    return { id: this.id, status: "finished", result: "mock result" };
  }
}

export class FakeAgent {
  constructor() {
    this.agentId = "agent-1";
    state.activeAgents += 1;
  }
  async send(_prompt, _opts = {}) {
    return new FakeRun();
  }
  close() {
    state.activeAgents -= 1;
  }
  reload() {}
  async [Symbol.asyncDispose]() {
    this.close();
  }
  async getUsage() {
    return {};
  }
  async listArtifacts() {
    return [];
  }
  async downloadArtifact() {
    return Buffer.alloc(0);
  }
}

export const Agent = {
  async create() {
    return new FakeAgent();
  },
};

// proxy-tunnel.mjs imports this when a proxy is configured; the stress
// instance runs proxy-less, so a no-op is the honest mock.
export function configureCursorSdk() {}

const MODELS = [
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    aliases: [],
    parameters: [
      { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
      { id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
    ],
  },
];

export const Cursor = {
  async me({ apiKey } = {}) {
    state.meCalls += 1;
    if (state.config.meLatencyMs > 0) await napped(state.config.meLatencyMs);
    const tag = String(apiKey ?? "?").slice(-8) || "?";
    return {
      userEmail: `stress-${tag}@example.com`,
      apiKeyName: `stress-key-${tag}`,
      createdAt: new Date().toISOString(),
    };
  },
  models: {
    list: async () => {
      state.modelsCalls += 1;
      return MODELS;
    },
  },
};
