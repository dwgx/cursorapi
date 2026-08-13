// In-memory @cursor/sdk fake for test-relay-cancel.mjs.
//
// The relay's resource-release paths (run.cancel on idle timeout /
// abandonment / launch timeout) can only be exercised by observing the SDK;
// the real SDK needs a live Cursor account. test-relay-cancel.mjs registers
// a load hook (node:module registerHooks) that rewrites every import of
// "@cursor/sdk" to the fake below, so relay.mjs / catalog.mjs / keys.mjs
// run against an SDK whose calls are recorded in `mock` for the test to
// assert on. Zero new deps.

export const mock = {
  cancels: [],        // every run.cancel() call, in order
  runs: [],           // every run the fake created
  createDelayMs: 0,   // Agent.create latency (launch-timeout test)
  fireTool: null,     // async fn called once by the first stream() pull
  finishAfterTool: false, // end the stream right after fireTool (a run that completes during a tool round-trip)
  deadStream: false,  // upstream death: the stream never ends and cancel() is ineffective
  lastCustomTools: null,
  pendingExec: null,  // the last execute() promise, for the test to swallow
};

const napped = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

export class FakeRun {
  constructor() {
    this.id = `run-${mock.runs.length + 1}`;
    this.agentId = "agent-1";
    this.status = "running";
    this.cancelled = false;
    this._abort = false;
    mock.runs.push(this);
  }
  supports(op) {
    return ["stream", "wait", "cancel", "conversation"].includes(op);
  }
  unsupportedReason() {
    return undefined;
  }
  async cancel() {
    if (mock.deadStream) {
      // Mirror a dead upstream: the cancel is recorded but cannot reach
      // the stream — no abort flag, no status change.
      mock.cancels.push(this);
      return;
    }
    // Mirror the SDK: cancel() ends the run; the stream loop observes the
    // abort and terminates, and wait() then reports "cancelled".
    this.cancelled = true;
    this.status = "cancelled";
    this._abort = true;
    mock.cancels.push(this);
  }
  async *stream() {
    if (mock.deadStream) {
      // The run never ends; only the test's flag (reset for the next test)
      // can stop this generator.
      while (mock.deadStream) await napped(20);
      return;
    }
    if (mock.fireTool && !this._fired) {
      this._fired = true;
      mock.fireTool();
      if (mock.finishAfterTool) {
        // Give the 80ms batch flush time to deliver the tool call and
        // close the sink before the run ends — a real SDK would too.
        await napped(150);
        return;
      }
    }
    while (!this._abort) await napped(20);
  }
  async wait() {
    return { id: this.id, status: this.status };
  }
}

export class FakeAgent {
  constructor() {
    this.agentId = "agent-1";
  }
  async send(_prompt, opts = {}) {
    mock.lastCustomTools = opts?.local?.customTools ?? null;
    return new FakeRun();
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
    if (mock.createDelayMs) await napped(mock.createDelayMs);
    return new FakeAgent();
  },
};

export const Cursor = {
  me: async () => ({ userEmail: "relay-test@example.com" }),
  models: {
    list: async () => [
      { id: "claude-opus-5", displayName: "Claude Opus 5", aliases: [], parameters: [] },
    ],
  },
};
