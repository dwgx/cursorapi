// OpenAI chat/completions wire framing: SSE writer, collecting sink, and the
// non-streaming body. Usage shapes convert here — the relay feeds SDK-style
// counts, the wire needs prompt_tokens.

import crypto from "node:crypto";
import { toOpenAiUsage } from "./format.mjs";

// Active SSE streams, for graceful shutdown (SIGTERM writes an error frame
// + [DONE] instead of hard-cutting mid-stream; windsurf sse-registry).
export const ACTIVE_STREAMS = new Set();
export function shutdownActiveStreams(message = "server shutting down") {
  for (const w of ACTIVE_STREAMS) {
    try {
      w.fail(message);
    } catch {
      // ignore: the socket may already be gone
    }
  }
}

export function newCompletionId() {
  return "chatcmpl-" + crypto.randomBytes(12).toString("hex");
}

// One SSE data frame, without the `data: ` prefix.
function buildChunk(id, created, model, delta, finishReason) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// OpenAI tool-call payload shared by stream chunks and the final message.
function toolCallPayload(call) {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}),
    },
  };
}

export class SseWriter {
  constructor(res, { id, model }) {
    this.res = res;
    this.id = id;
    this.model = model;
    this.created = Math.floor(Date.now() / 1000);
    this.closed = false;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store", // never cache SSE anywhere (proxy pitfalls)
      Connection: "keep-alive",
      // Reverse proxies (nginx/Caddy) buffer by default, which turns a
      // stream into "long spinner, then everything at once".
      "X-Accel-Buffering": "no",
    });
    ACTIVE_STREAMS.add(this);
    this.heartbeat = setInterval(() => {
      // SSE comment line: clients ignore it, proxies see bytes flowing
      // (keeps idle timers alive during slow reasoning; windsurf chat.js).
      if (!this.closed && !res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    this.heartbeat.unref?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    ACTIVE_STREAMS.delete(this);
  }

  send(obj) {
    if (this.closed) return;
    this.res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }


  role() {
    this.send(buildChunk(this.id, this.created, this.model, { role: "assistant", content: "" }, null));
  }

  text(t) {
    if (!t) return;
    this.emitted = true;
    this.send(buildChunk(this.id, this.created, this.model, { content: t }, null));
  }

  /** A whole tool call per chunk; ascending index suffices for OpenAI. */
  toolCall(index, call) {
    this.emitted = true;
    this.send(buildChunk(this.id, this.created, this.model, { tool_calls: [{ index, ...toolCallPayload(call) }] }, null));
  }

  finish(reason = "stop", usage = null) {
    if (this.closed) return;
    const chunk = buildChunk(this.id, this.created, this.model, {}, reason);
    const u = toOpenAiUsage(usage);
    if (u) chunk.usage = u;
    this.send(chunk);
    this.res.write("data: [DONE]\n\n");
    this.res.end();
    this.close();
  }

  /**
   * Failed after the stream started: the status code is long gone.
   * windsurf's decision point (chat.js:6436-6451):
   *  - content already emitted -> clean synthetic stop (+[DONE]): the
   *    client got a partial answer, an error frame would confuse it;
   *  - nothing emitted yet        -> proper error frame + [DONE]: the
   *    client can surface it programmatically (no error-in-text hack).
   */
  fail(message) {
    if (this.closed) return;
    if (this.emitted) {
      this.finish("stop");
      return;
    }
    this.send({ error: { message, type: "api_error", code: "upstream_error" } });
    this.res.write("data: [DONE]\n\n");
    this.res.end();
    this.close();
  }
}

/** Non-streaming twin of SseWriter: same interface, collects instead of sends. */
export class CollectSink {
  constructor() {
    this.parts = [];
    this.toolCalls = [];
    this.finishReason = null;
    this.usage = null;
    this.closed = false;
  }

  role() {}

  text(t) {
    if (t) this.parts.push(t);
  }

  toolCall(_i, call) {
    this.toolCalls.push(call);
  }

  finish(reason, usage) {
    this.finishReason = reason;
    this.usage = toOpenAiUsage(usage);
    this.closed = true;
  }

  fail(msg) {
    this.text(`\n[cursorapi] ${msg}\n`);
    this.finish("stop");
  }

  get content() {
    return this.parts.join("");
  }
}

export function nonStreamBody({ id, model, content, toolCalls, finishReason, usage }) {
  const message = { role: "assistant", content: content ?? "" };
  if (toolCalls?.length) {
    message.tool_calls = toolCalls.map(toolCallPayload);
    message.content = content || null;
  }
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
