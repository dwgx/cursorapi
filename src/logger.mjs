// Logging: level-filtered stdout + a ring buffer backing /admin/logs.
// logLevel is hot-reloadable; the threshold is cached in memory (lastLevel
// plus a version bumped by onHotChange) so the emit path never reads disk.

import { getField, onHotChange } from "./runtime-settings.mjs";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
export const LOG_LEVELS = LEVELS;

// Per-entry field budget: bounds the 1000-slot ring — a big payload must
// not pin ~100KB per slot. Truncation is byte-exact at a UTF-8 boundary.
const MAX_FIELD_BYTES = 8 * 1024;

// Cut a string to a byte budget without splitting a UTF-8 code point.
function truncateUtf8(s, maxBytes) {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  const buf = Buffer.from(s);
  let pos = maxBytes - 1;
  if ((buf[pos] & 0xc0) === 0x80) {
    // Cut inside a multi-byte char: walk back to its lead byte.
    while (pos > 0 && (buf[pos - 1] & 0xc0) === 0x80) pos--;
    pos -= 1;
  }
  const lead = buf[pos];
  let len = 1;
  if ((lead & 0xe0) === 0xc0) len = 2;
  else if ((lead & 0xf0) === 0xe0) len = 3;
  else if ((lead & 0xf8) === 0xf0) len = 4;
  const end = pos + len <= maxBytes ? maxBytes : pos;
  return buf.subarray(0, end).toString("utf8");
}

// Ring buffer: newest 1000 entries for /admin/logs SSE and export;
// subscribers receive entries live. Slot = written % RING_CAP, so a single
// monotonic counter tracks both fill state and the oldest entry.
const RING_CAP = 1000;
const ring = new Array(RING_CAP);
let written = 0;
const subscribers = new Set();

function append(entry) {
  ring[written % RING_CAP] = entry;
  written += 1;
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // A subscriber (SSE writer) failure must not break business logging.
    }
  }
}

/** Subscribe to live logs; returns an unsubscribe function. */
export function subscribeLogs(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** The n most recent entries, chronological. */
export function recentLogs(n = RING_CAP) {
  const count = Math.min(n, written, RING_CAP);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(ring[(written - count + i) % RING_CAP]);
  }
  return out;
}

// The threshold is cached, not read from disk per emit: a synchronous file
// read on every log call blocks the event loop (20k filtered debug logs
// measured ~650ms). lastLevel + logLevelVersion track the hot-config state;
// PUT /admin/config refreshes the cache through onHotChange.
let logLevelVersion = 0;
let lastLevel;

onHotChange((keys) => {
  if (keys.has("logLevel")) {
    logLevelVersion += 1;
    lastLevel = getField("logLevel");
  }
});

function cutoff() {
  // First use reads once, so a logLevel in runtime-config.json at boot wins.
  if (lastLevel === undefined) {
    lastLevel = getField("logLevel");
    logLevelVersion = 1;
  }
  return LEVELS[lastLevel] ?? LEVELS.info;
}

// Escape control characters for the line-based stdout view: a message
// containing raw newlines must never forge extra log lines (one log call =
// one line), and ANSI escapes must not colorize/pollute the terminal. The
// ring buffer keeps messages raw — JSON.stringify already re-escapes them
// for SSE and the jsonl export, and the UI renders multiline text as-is.
function escapeLine(s) {
  return s.replace(/[\x00-\x1f\x7f]/g, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

function emit(level, msg, extra) {
  if (LEVELS[level] > cutoff()) return;
  const ts = new Date();
  const sMsg = truncateUtf8(String(msg), MAX_FIELD_BYTES);
  const sExtra =
    extra === undefined ? undefined : truncateUtf8(typeof extra === "string" ? extra : JSON.stringify(extra), MAX_FIELD_BYTES);
  const tail = sExtra === undefined ? "" : " " + sExtra;
  process.stdout.write(`${ts.toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${escapeLine(sMsg)}${escapeLine(tail)}\n`);
  append({ ts: ts.toISOString(), level, msg: sMsg, extra: tail ? tail.trim() : undefined });
}

export const log = {
  error: (m, e) => emit("error", m, e),
  warn: (m, e) => emit("warn", m, e),
  info: (m, e) => emit("info", m, e),
  debug: (m, e) => emit("debug", m, e),
};

// Render any value as one readable line. String(v) on plain objects yields
// "[object Object]" — the information vanishes without an error.
export function describe(v) {
  if (v == null) return String(v);
  if (typeof v === "string") return v;
  if (typeof v?.message === "string" && v.message) return v.message;
  try {
    const s = JSON.stringify(v);
    if (s && s !== "{}" && s !== "[]") return s;
  } catch {
    // Circular refs etc.: fall through to String() below.
  }
  return String(v);
}

// Split an SDK error into its raw fields, verbatim — quota exhaustion has
// never been observed, so every field is kept so the first sighting is
// recognizable without a redesign.
export function errShape(e) {
  return {
    name: e?.name ?? e?.constructor?.name ?? "Error",
    code: e?.code ?? null,
    status: e?.status ?? e?.statusCode ?? null,
    isRetryable: e?.isRetryable ?? null,
    endpoint: e?.endpoint ?? null,
    operation: e?.operation ?? null,
    message: describe(e).slice(0, 500),
  };
}
