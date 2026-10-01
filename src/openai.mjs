// OpenAI /v1/chat/completions adapter: request parsing + response shaping.
//
// The relay is wire-agnostic and shared; this file is the entire OpenAI side
// of the seam. Key invariants: tool ids echo back as `call_`, usage keeps the
// SDK's raw shape until the sink converts it, and tool results arrive as
// standalone `role:"tool"` messages.

import { renderPrompt, toOpenAiUsage } from "./format.mjs";
import * as engine from "./relay.mjs";
import { respondError, respondJson } from "./http-helpers.mjs";
import { log } from "./logger.mjs";
import { CollectSink, SseWriter, newCompletionId, nonStreamBody } from "./stream.mjs";
import { feedResults, lookupTurn } from "./tool-relay.mjs";

/**
 * OpenAI tools[] -> protocol-neutral `{name, description, parameters}`.
 *
 * Only `type:"function"` fits the neutral shape; free-text tools
 * (`type:"custom"`, Anthropic server tools) are logged and dropped — silence
 * would look like "why doesn't the model use this tool".
 */
export function normalizeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const kept = [];
  const dropped = [];
  for (const raw of tools) {
    const def = raw?.function;
    if (!def?.name) {
      dropped.push(raw?.type ?? "(no type)");
      continue;
    }
    kept.push({ name: def.name, description: def.description ?? "", parameters: def.parameters });
  }
  if (dropped.length) log.warn(`skipped ${dropped.length} non-function tools: ${dropped.join(", ")}`);
  return kept.length ? kept : null;
}

/**
 * Dig tool results out of this batch: `role:"tool"` messages keyed by
 * tool_call_id. Returns null with no trailing tool results, `{turn, results}`
 * when an id matches a live turn, `{orphan: [ids]}` when trailing results
 * exist but nothing is live. The caller starts a new run for the orphan
 * case so Claude Code compact/follow-up is not aborted with 400.
 */
function messagesAfterLastAssistant(messages) {
  let start = 0;
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      start = i + 1;
      break;
    }
  }
  return (messages ?? []).slice(start);
}

function digToolResults(messages) {
  const results = [];
  let turn = null;
  for (const m of messagesAfterLastAssistant(messages)) {
    if (m?.role !== "tool" || !m.tool_call_id) continue;
    results.push({ id: m.tool_call_id, content: m.content, isError: m.is_error === true });
    turn = turn ?? lookupTurn(m.tool_call_id);
  }
  if (!results.length) return null;
  return turn ? { turn, results } : { orphan: results.map((r) => r.id) };
}

const adapter = {
  callIdPrefix: "call_",

  parse(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (!messages.length) return { error: "messages must not be empty", status: 400 };

    const resume = digToolResults(messages);
    if (resume?.orphan) {
      log.warn(`stale tool_result id(s) ${resume.orphan.join(", ")}; starting a new run`);
    }

    return {
      stream: body?.stream === true,
      id: newCompletionId(),
      publicModel: body?.model,
      prompt: renderPrompt(messages),
      tools: normalizeTools(body?.tools),
      resume: resume && resume.turn ? { turn: resume.turn, results: resume.results } : null,
    };
  },

  makeSink(res, { stream, id, model }) {
    if (!stream) return new CollectSink();
    const w = new SseWriter(res, { id, model });
    w.role();
    return w;
  },

  feed: feedResults,

  finishNonStream(res, sink, { id, model }) {
    respondJson(res, 200, nonStreamBody({
      id,
      model,
      content: sink.content,
      toolCalls: sink.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      finishReason: sink.finishReason ?? "stop",
      usage: sink.usage,
    }));
  },
};

/** POST /v1/chat/completions */
export function handleChat(body, res) {
  return engine.handle(adapter, body, res, {
    respondError: (r, s, m) => respondError(
      r, s, m,
      s === 400 ? "invalid_request_error"
        : s === 429 ? "rate_limit_error"
        : s === 503 ? "service_unavailable"
        : "api_error",
    ),
  });
}

export { toOpenAiUsage };
