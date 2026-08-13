// Pressure-test @cursor/sdk fake + load hook.
//
// Same mechanism as test-relay-hook.mjs (registerHooks rewrites every import
// of "@cursor/sdk"), but made for load testing:
// - runs are finite: stream() yields one assistant chunk + usage and ends
// - tool round-trips work end-to-end: every Nth send calls the client's
//   custom tool execute() (which suspends the turn), and the stream only
//   continues once the client returns the result — mirroring the real SDK
//   agent loop
// - behaviour is driven by pressure/ctl-mock.json, written by the pressure
//   driver between phases (seq-guarded)
//
// Loaded via: node --import ./pressure/mock-hook.mjs boot.mjs

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";

const PRESSURE_DIR = process.env.CSPK_PRESSURE_DIR ?? path.join(process.cwd(), "pressure");
const CTL_FILE = path.join(PRESSURE_DIR, "ctl-mock.json");

export const mock = {
  runs: [],
  cancels: [],
  lastCustomTools: null,
  sendCount: 0,
  toolCalls: 0,
};

let lastCtl = { seq: 0, toolEveryN: 4, textLen: 200 };
function readCtl() {
  try {
    const raw = JSON.parse(fs.readFileSync(CTL_FILE, "utf8"));
    if (typeof raw?.seq === "number" && raw.seq > lastCtl.seq) lastCtl = { ...lastCtl, ...raw };
  } catch {
    // not written yet or mid-write; keep the previous control state
  }
  return lastCtl;
}

class FakeRun {
  constructor() {
    this.id = `run-${mock.runs.length + 1}`;
    this.agentId = "agent-1";
    this.status = "running";
    this.cancelled = false;
    this._withTool = false;
    this._ctl = null;
    mock.runs.push(this);
  }
  supports(op) {
    return ["stream", "wait", "cancel", "conversation"].includes(op);
  }
  async cancel() {
    this.cancelled = true;
    this.status = "cancelled";
    mock.cancels.push(this);
  }
  async *stream() {
    if (this._withTool && mock.lastCustomTools) {
      const name = Object.keys(mock.lastCustomTools)[0];
      mock.toolCalls += 1;
      // The SDK agent loop: calling the custom tool suspends the turn until
      // the client returns the result (tool-relay turn.delegate promise).
      const p = mock.lastCustomTools[name].execute(
        { query: `pressure-q-${mock.toolCalls}` },
        { toolCallId: `pt-${mock.toolCalls}` },
      );
      await p;
    }
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: `pressure-reply-${this.id}`.padEnd(this._ctl.textLen ?? 200, "x") }] },
    };
    yield { type: "usage", usage: { inputTokens: 123, outputTokens: 45 } };
    this.status = "finished";
  }
  async wait() {
    return { id: this.id, status: this.status };
  }
}

class FakeAgent {
  constructor() {
    this.agentId = "agent-1";
  }
  async send(_prompt, opts = {}) {
    mock.lastCustomTools = opts?.local?.customTools ?? null;
    const run = new FakeRun();
    mock.sendCount += 1;
    const ctl = readCtl();
    run._ctl = ctl;
    run._withTool = Boolean(mock.lastCustomTools) && mock.sendCount % ctl.toolEveryN === 0;
    return run;
  }
  close() {}
  reload() {}
  async [Symbol.asyncDispose]() {}
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

export const Cursor = {
  me: async () => ({ userEmail: "pressure@mock.local" }),
  models: {
    list: async () => [
      {
        id: "claude-opus-5",
        displayName: "Claude Opus 5",
        aliases: [],
        parameters: [
          { id: "fast", values: [{ value: "false" }, { value: "true" }] },
          { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
        ],
      },
    ],
  },
};

// proxy-tunnel.mjs imports this; a no-op keeps the proxy injectable at boot.
export const configureCursorSdk = () => {};

const sdkUrl = import.meta.resolve("@cursor/sdk");
const fakeUrl = new URL("./mock-hook.mjs", import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(sdkUrl)) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `import { Agent, Cursor, configureCursorSdk } from ${JSON.stringify(fakeUrl)}; export { Agent, Cursor, configureCursorSdk };`,
    };
  },
});
