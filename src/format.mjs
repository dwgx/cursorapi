// OpenAI message list -> single prompt string, plus usage mapping.
// Pure functions: no I/O, no layer dependencies.

/** Collapse OpenAI content (string or multimodal array) into plain text. */
export function flatten(content) {
  return Array.isArray(content)
    ? content.map(textOf).join("")
    : typeof content === "string"
      ? content
      : content == null
        ? ""
        : String(content);
}

// One content part -> text. Images leave a position marker only: the SDK's
// prompt is plain text, so dropping them would orphan the sentence around
// them.
function textOf(part) {
  if (typeof part === "string") return part;
  if (part?.type === "text") return part.text ?? "";
  if (part?.type === "image_url") return "[image]";
  return "";
}

/**
 * Render the whole conversation as one prompt.
 *
 * The last non-system message is the question to answer now; everything
 * before it becomes labelled history inside <conversation-so-far>, so the
 * model can tell the current instruction from old turns.
 */
export function renderPrompt(messages) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => stripBillingHeaders(flatten(m.content)))
    .filter(Boolean);
  const others = messages.filter((m) => m.role !== "system");
  const last = others[others.length - 1];
  const history = others.slice(0, -1);

  const parts = [];
  if (system.length) parts.push(system.join("\n\n"), "");
  if (history.length) {
    parts.push("<conversation-so-far>");
    for (const m of history) {
      const text = stripBillingHeaders(flatten(m.content));
      if (!text) continue;
      parts.push(`${speakerOf(m.role)}: ${text}`);
    }
    parts.push("</conversation-so-far>", "");
  }
  parts.push(stripBillingHeaders(flatten(last?.content)));
  return parts.join("\n");
}

/**
 * Drop Claude Code's per-request billing header line(s) from a text blob.
 *
 * Claude Code sends `x-anthropic-billing-header: cc_version=…; cch=<hash>` as
 * the system[0] text block, and `cch=` changes on every request. Pasted
 * verbatim into the prompt, each turn presents a brand-new prefix to the
 * upstream — its prompt cache never hits, and costs go up 5-10x.
 */
export function stripBillingHeaders(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*x-anthropic-billing-header\s*:/i.test(line))
    .join("\n");
}

// Role -> label in the history block.
function speakerOf(role) {
  if (role === "assistant") return "Assistant";
  if (role === "tool") return "ToolResult";
  return "User";
}

/** SDK usage event -> OpenAI usage field. */
export function toOpenAiUsage(u) {
  if (!u) return null;
  const prompt = u.inputTokens ?? 0;
  const completion = u.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.totalTokens ?? prompt + completion,
    prompt_tokens_details: {
      cached_tokens: u.cacheReadTokens ?? 0,
      cache_creation_input_tokens: u.cacheWriteTokens ?? 0,
    },
  };
}
