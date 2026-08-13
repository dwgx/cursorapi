// Account pool: file-backed storage, ranked selection, error triage,
// tiered cooldowns, liveness probing, usage aggregation, batch admin.
// Depends on settings/logger only; never touches the protocol layer.
// Invariants: exports never carry plaintext keys; all writes are atomic;
// runtime state (counts, disable, cooldown) survives hot reloads.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Cursor } from "@cursor/sdk";
import { config } from "./settings.mjs";
import { errShape, log } from "./logger.mjs";

// ── Failure triage ─────────────────────────────────────────────

/** Disposition of a failed call. */
export const Verdict = {
  /** Fail over to another account; the client never sees this failure. */
  RETRY_OTHER: "retry_other",
  /** Account is dead: disable it, then fail over. */
  DISABLE_AND_RETRY: "disable_and_retry",
  /** No switch can help (bad params, unsupported model): return as-is. */
  RETURN: "return",
};

/** Both 429 signals count: structured errors carry status, some only name.
 * gRPC code 8 (resource_exhausted) is a throttle signal too — the SDK maps
 * it to the string "resource_exhausted". */
function isThrottled(s) {
  return s.status === 429 || s.name === "RateLimitError" || s.code === "resource_exhausted";
}

/**
 * Quota-exhaustion wording ("exceeded your usage limit", "spend limit",
 * "credit") means a long-term condition, not a rate-limit blip. The code
 * usage_limit_exceeded is authoritative when the message is empty.
 * "exhausted" alone is not enough — "concurrency limit exhausted" is a
 * transient throttle — it must sit next to a quota/billing word.
 */
export function isQuotaExhaustion(e) {
  const s = errShape(e);
  if (s.code === "usage_limit_exceeded") return true;
  const msg = s.message;
  // "upgrade to increase your usage limits" is the standard rate-limit
  // hint (reviewer M2): quota words next to an upgrade suggestion must NOT
  // count as exhaustion, or a normal throttle would put the account into a
  // 30-minute cooldown during peak load.
  if (/upgrade.{0,40}(increase|raise|extend|get).{0,40}limit/i.test(msg)) return false;
  if (/quota|usage[_ -]?limit|spend|credit/i.test(msg)) return true;
  return /(quota|usage|credit|spend|billing|allowance|budget).{0,20}(exhausted|exceeded|reached|spent)|(exhausted|exceeded|reached|spent).{0,20}(quota|usage|credit|spend|billing|allowance|budget)/i.test(
    msg,
  );
}

/**
 * Model region-block: the account is fine, the region is wrong for this
 * model. Another account (different region) may serve it — so this is a
 * failover signal, never a disable. Recognized by message: the canonical
 * phrasings are "not supported in your region" and the region-routing
 * "This region is not yet available for your team".
 */
export function isRegionBlocked(e) {
  return /not supported in your region|unavailable in (your|this) region|region (is )?not (yet )?available|not available in (your|this) region/i.test(
    errShape(e).message,
  );
}

/**
 * Model-gate messages on resource_exhausted: the plan cannot run this
 * model. "upgrade" alone is a rate-limit hint ("upgrade to increase your
 * limits") — it must point at a model.
 */
function isModelGateError(message) {
  return /model (not allowed|restricted)|not permitted|upgrade.{0,40}model|(access|use|run|enable).{0,30}model/i.test(
    String(message ?? ""),
  );
}

/**
 * New codes from the cloud-agents spec (2026-08). `code` is authoritative
 * over status: 409 agent_id_conflict is a client config problem, not a
 * failover-able 4xx; stream_unavailable must switch even when it rides a 4xx.
 */
const CODE_VERDICTS = {
  agent_id_conflict: Verdict.RETURN,       // client-chosen agentId clash
  agent_archived: Verdict.RETURN,          // the referenced agent no longer exists
  service_account_required: Verdict.RETURN, // pool keys are user keys; switching cannot help
  feature_unavailable: Verdict.RETRY_OTHER, // account-scoped capability (e.g. usage 403)
  stream_unavailable: Verdict.RETRY_OTHER,  // transient: another run may do better
};

/**
 * Link-level timeouts: no status, no retryable flag, just a name/code.
 * They are transient — another account or endpoint may do better.
 */
function isTimeoutShape(s) {
  return (
    /^(AbortError|TimeoutError|ETIMEDOUT|Timeout)$/.test(s.name)
    || s.code === "ETIMEDOUT"
    || s.code === "ABORT_ERR"
  );
}

/**
 * Retry-After (seconds) from an SDK error. Looked up in the error's own
 * fields and raw headers; fractions round up, only positive numbers count.
 * Values above 3600 are treated as milliseconds and converted down.
 * (SDK field units are ambiguous — header values are always seconds; the
 * heuristic favors the SDK-ms reading, pinned by tests.)
 */
export function parseRetryAfter(e) {
  const raw =
    e?.retryAfter ?? e?.retryAfterSecs ?? e?.headers?.["retry-after"] ?? e?.headers?.["Retry-After"];
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 3600 ? Math.ceil(n / 1000) : Math.ceil(n);
}

/** Classify a failure into { verdict, retryAfterSecs }. */
export function classifyError(e) {
  const s = errShape(e);

  // Dead key: precise signal, disable outright.
  if (s.status === 401 || s.name === "AuthenticationError") {
    return { verdict: Verdict.DISABLE_AND_RETRY, retryAfterSecs: null };
  }

  // Session-level auth failure: the run stream replies error while the key
  // stays valid at the API level. Only the message can be matched; keep the
  // match narrow (under-disable is visible, over-disable is not).
  if (isSessionAuthError(s.message)) {
    return { verdict: Verdict.DISABLE_AND_RETRY, retryAfterSecs: null };
  }

  // Model region-block: model-scoped, not account-scoped. Fail over (another
  // region may serve it) with no cooldown; if every account reports it, the
  // pool-exhausted response surfaces the region message itself (502), never
  // a 503. Checked before the throttle rules — a gated 429 is not a blip.
  if (isRegionBlocked(s.message)) {
    return { verdict: Verdict.RETRY_OTHER, retryAfterSecs: null, regionBlocked: true };
  }

  // gRPC code 8 (resource_exhausted) is ambiguous: a free account gated off
  // a model reports it with an "upgrade/not allowed" message — a client
  // error no account switch can fix, and one that would otherwise pin the
  // whole pool (every account RETRY_OTHERs into a cooldown) — while a
  // genuine throttle carries rate/quota wording and deserves failover.
  if (s.code === "resource_exhausted") {
    if (isModelGateError(s.message)) {
      return { verdict: Verdict.RETURN, retryAfterSecs: null };
    }
    return {
      verdict: Verdict.RETRY_OTHER,
      retryAfterSecs: parseRetryAfter(e),
      ...(isQuotaExhaustion(e) ? { quota: true } : {}),
    };
  }

  // Spec error codes: `code` wins over status (see CODE_VERDICTS).
  const codeVerdict = CODE_VERDICTS[s.code];
  if (codeVerdict) {
    return {
      verdict: codeVerdict,
      retryAfterSecs: codeVerdict === Verdict.RETRY_OTHER ? parseRetryAfter(e) : null,
      // Keep the quota mark consistent with reportFailure's own check.
      ...(codeVerdict === Verdict.RETRY_OTHER && isQuotaExhaustion(e) ? { quota: true } : {}),
    };
  }

  // Retry-After only applies to transient errors; permanent ones never carry it.
  const retryAfterSecs = isThrottled(s) || (s.status ?? 0) >= 500 ? parseRetryAfter(e) : null;

  // 429 typing: quota-exhaustion wording means long-term, not a blip — mark
  // it so reportFailure can pick the long cooldown over the streak math.
  if (isThrottled(s)) {
    return {
      verdict: Verdict.RETRY_OTHER,
      retryAfterSecs,
      ...(isQuotaExhaustion(e) ? { quota: true } : {}),
    };
  }

  // Trust the SDK's own retryability flag.
  if (s.isRetryable === true) {
    return { verdict: Verdict.RETRY_OTHER, retryAfterSecs };
  }

  // Account-level 403, upstream jitter, timeouts: another account may do
  // better.
  if (s.status === 403 || (s.status ?? 0) >= 500 || isTimeoutShape(s)) {
    return { verdict: Verdict.RETRY_OTHER, retryAfterSecs };
  }

  // Bad params, unsupported model, etc.: switching cannot save these.
  return { verdict: Verdict.RETURN, retryAfterSecs: null };
}

/** Verdict only; external callers depend on this shape. */
export function classify(e) {
  return classifyError(e).verdict;
}

/** "Authentication error" reported inside the run event stream. */
export function isSessionAuthError(message) {
  return /authentication error/i.test(String(message ?? ""));
}

// ── Identity helpers ─────────────────────────────────────────────

/** Stable account id: key digest, not name — names change, hashes don't. */
function digestId(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function redactKey(key) {
  return key.length > 14 ? `${key.slice(0, 10)}…${key.slice(-4)}` : "…";
}

// ── Account model ────────────────────────────────────────────────

export class Account {
  constructor(raw) {
    this.key = String(raw.key ?? "").trim();
    this.id = digestId(this.key);
    this.name = raw.name ?? "";
    this.priority = Number.isFinite(raw.priority) ? raw.priority : 0;
    this.login = raw.login ?? null;
    this.password = raw.password ?? null;
    /** Hard-disable from the config file; runtime auto-disable lives apart so hot reload cannot resurrect a dead account. */
    this.configDisabled = raw.disabled === true;
    this.autoDisabled = false;
    this.disabledReason = null;
    /** Whether probing can lift the auto-disable. Probe only sees API-level death; session failures are invisible to it. */
    this.autoRecoverable = false;
    /** Re-admit for one retry at this time. null = no cooldown retry. */
    this.cooldownUntil = null;
    /** Cooldown cause, for the panel. */
    this.cooldownReason = null;
    /** Consecutive 429 count; drives cooldown escalation, reset by success. */
    this.rateLimitStreak = 0;
    /** When the last 429 landed; streak decays with the gap to it. */
    this.lastRateLimitAt = null;
    /**
     * Half-open recovery gate: cooldown expired but the account is not yet
     * trusted back. One trial probe per selection round; 3 consecutive
     * successes fully re-admit, a failure re-cooldowns with 1.5^n backoff.
     */
    this.halfOpen = false;
    /** Consecutive successes while half-open. */
    this.halfOpenStreak = 0;
    /** Half-open probe failures; drives the 1.5^n backoff. */
    this.halfOpenAttempts = 0;
    /** Consecutive 403 soft-risk hits; >= 6 disables. */
    this.suspiciousStreak = 0;
    /** Consecutive 401s on a previously-working key; >= 2 disables. */
    this.authFailStreak = 0;
    /** Requests in flight; reserved synchronously by select(). */
    this.inflight = 0;
    /** Request start times from the last 60s (rpm dimension source). */
    this.requestTimes = [];

    // In-process usage accounting (persisted by saveStats).
    this.runs = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.failures = 0;
    this.lastUsedAt = null;
    this.lastError = null;
    this.addedAt = new Date().toISOString();

    // Identity pulled from Cursor.me() (free, read-only).
    this.identity = null;
  }

  get disabled() {
    return this.configDisabled || this.autoDisabled;
  }

  /** Cooldown expired — time to try it again. */
  get cooledDown() {
    return this.cooldownUntil != null && Date.now() >= this.cooldownUntil;
  }

  /** Shape for the status page. Never includes the raw key. */
  view() {
    return {
      id: this.id,
      name: this.name || this.identity?.apiKeyName || "(unnamed)",
      maskedKey: redactKey(this.key),
      email: this.identity?.userEmail ?? null,
      keyCreatedAt: this.identity?.createdAt ?? null,
      /** Hand-entered login email, distinct from the key-derived one above. */
      login: this.login,
      /** Reported as exists-or-not only; the value never leaves the server. */
      hasPassword: Boolean(this.password),
      priority: this.priority,
      disabled: this.disabled,
      disabledBy: this.configDisabled ? "config" : this.autoDisabled ? "auto" : null,
      disabledReason: this.disabledReason,
      autoRecoverable: this.autoRecoverable,
      cooldownUntil: this.cooldownUntil,
      cooldownReason: this.cooldownReason,
      halfOpen: this.halfOpen,
      halfOpenStreak: this.halfOpenStreak,
      halfOpenAttempts: this.halfOpenAttempts,
      suspiciousStreak: this.suspiciousStreak,
      authFailStreak: this.authFailStreak,
      /** Decayed at read time so the panel shows the effective streak. */
      rateLimitStreak: decayedStreak(this, Date.now()),
      inflight: this.inflight,
      runs: this.runs,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      failures: this.failures,
      lastUsedAt: this.lastUsedAt,
      lastError: this.lastError,
    };
  }

  /**
   * Re-admit when the cooldown expires — into the half-open gate, not a full
   * return: one trial per selection round, N consecutive successes to fully
   * recover. Lives here (not in a loop) so it is testable on a lone Account.
   */
  tryRelease() {
    if (!this.autoDisabled || !this.cooledDown) return false;
    this.autoDisabled = false;
    this.cooldownUntil = null;
    this.cooldownReason = null;
    this.disabledReason = null;
    this.halfOpen = true;
    emitPoolEvent(this, "half-open", { reason: "cooldown over" });
    return true;
  }
}

// ── Module state & file utilities ────────────────────────────────

const pool = new Map(); // id -> Account
let rrCursor = 0;
let usageFlushTimer = null;
let ledgerFlushTimer = null;

function usagePath() {
  return path.join(path.dirname(config.accountsPath), "cursorapi-stats.json");
}

/** Atomic JSON write: tmp + fsync + rename; a crash never leaves half a file. */
function atomicDump(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(obj), "utf8");
    fs.fsyncSync(fd);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// ── Usage aggregation (dimensional: total / model / account / hour) ─

const AGG_FILENAME = "cursorapi-agg-stats.json";
/** Hourly bucket retention ceiling (30 days). */
const BUCKET_LIMIT = 720;
/** Per-account ledger retention: key rotation would grow this map forever. */
const ACCOUNTS_LEDGER_LIMIT = 200;

const ledger = {
  totals: { requests: 0, success: 0, errors: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  models: new Map(),   // modelId -> {requests, success, errors, msSum, msCount}
  accounts: new Map(), // accountId -> {requests, success, errors}
  buckets: new Map(),  // "YYYY-MM-DDTHH:00" -> {requests, success, errors, msSum, msCount}
};

function ledgerPath() {
  return path.join(path.dirname(config.accountsPath), AGG_FILENAME);
}

/** Current hourly bucket key (local timezone). */
function hourStamp(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

/** Record one request into the hourly bucket; prune the oldest past the cap. */
function tallyHour(success, durationMs) {
  const key = hourStamp();
  let b = ledger.buckets.get(key);
  if (!b) {
    b = { requests: 0, success: 0, errors: 0, msSum: 0, msCount: 0 };
    ledger.buckets.set(key, b);
    if (ledger.buckets.size > BUCKET_LIMIT) {
      const oldest = [...ledger.buckets.keys()].sort()[0];
      ledger.buckets.delete(oldest);
    }
  }
  b.requests += 1;
  if (success) b.success += 1;
  else b.errors += 1;
  if (Number.isFinite(durationMs)) {
    b.msSum += durationMs;
    b.msCount += 1;
  }
}

/** Load persisted aggregation; missing/unreadable means start from zero. */
function restoreLedger() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ledgerPath(), "utf8"));
  } catch {
    return;
  }
  const t = raw?.totals;
  if (t) {
    ledger.totals.requests = t.requests ?? 0;
    ledger.totals.success = t.success ?? 0;
    ledger.totals.errors = t.errors ?? 0;
    ledger.totals.tokens = {
      input: t.tokens?.input ?? 0,
      output: t.tokens?.output ?? 0,
      cacheRead: t.tokens?.cacheRead ?? 0,
      cacheWrite: t.tokens?.cacheWrite ?? 0,
    };
  }
  for (const [id, m] of Object.entries(raw?.models ?? {})) {
    ledger.models.set(id, {
      requests: m.requests ?? 0,
      success: m.success ?? 0,
      errors: m.errors ?? 0,
      msSum: m.msSum ?? 0,
      msCount: m.msCount ?? 0,
    });
  }
  for (const [id, a] of Object.entries(raw?.accounts ?? {})) {
    ledger.accounts.set(id, { requests: a.requests ?? 0, success: a.success ?? 0, errors: a.errors ?? 0, at: a.at ?? 0 });
  }
  // Enforce the cap at restore too, or a long-lived stats file would sit
  // above it until enough key rotation happened to evict.
  if (ledger.accounts.size > ACCOUNTS_LEDGER_LIMIT) {
    const keep = [...ledger.accounts.entries()]
      .sort((x, y) => (y[1].at ?? 0) - (x[1].at ?? 0))
      .slice(0, ACCOUNTS_LEDGER_LIMIT);
    ledger.accounts = new Map(keep);
  }
  for (const [k, b] of Object.entries(raw?.buckets ?? {})) {
    ledger.buckets.set(k, {
      requests: b.requests ?? 0,
      success: b.success ?? 0,
      errors: b.errors ?? 0,
      msSum: b.msSum ?? 0,
      msCount: b.msCount ?? 0,
    });
  }
}

function persistLedger() {
  const out = {
    totals: { ...ledger.totals, tokens: { ...ledger.totals.tokens } },
    models: Object.fromEntries(
      [...ledger.models.entries()].map(([id, m]) => [id, { ...m }]),
    ),
    accounts: Object.fromEntries(
      [...ledger.accounts.entries()].map(([id, a]) => [id, { ...a }]),
    ),
    buckets: Object.fromEntries(
      [...ledger.buckets.entries()].map(([k, b]) => [k, { ...b }]),
    ),
  };
  try {
    atomicDump(ledgerPath(), out);
  } catch (err) {
    log.warn(`failed to write aggregate stats: ${err?.message}`);
  }
}

/** Debounced persist: losing the last ~10s of counts is fine. */
function scheduleLedgerDump() {
  if (ledgerFlushTimer) return;
  ledgerFlushTimer = setTimeout(() => {
    ledgerFlushTimer = null;
    persistLedger();
  }, 10_000);
  ledgerFlushTimer.unref?.();
}

// Test helpers: clear the aggregation and flush immediately (the normal
// path is debounced, and tests cannot wait 10 seconds).
export function resetAggForTest() {
  ledger.totals = { requests: 0, success: 0, errors: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  ledger.models.clear();
  ledger.accounts.clear();
  ledger.buckets.clear();
}
export function flushAggNow() {
  if (ledgerFlushTimer) {
    clearTimeout(ledgerFlushTimer);
    ledgerFlushTimer = null;
  }
  persistLedger();
}

/**
 * Request-level accounting hook (once per turn from relay.mjs).
 * Tokens may be omitted; they count as 0.
 */
export function recordRequest(model, success, durationMs, accountId, tokens = {}) {
  const t = ledger.totals;
  t.requests += 1;
  if (success) t.success += 1;
  else t.errors += 1;
  const tok = t.tokens;
  tok.input += tokens?.input ?? 0;
  tok.output += tokens?.output ?? 0;
  tok.cacheRead += tokens?.cacheRead ?? 0;
  tok.cacheWrite += tokens?.cacheWrite ?? 0;

  tallyHour(success, durationMs);

  if (model) {
    let m = ledger.models.get(model);
    if (!m) {
      m = { requests: 0, success: 0, errors: 0, msSum: 0, msCount: 0 };
      ledger.models.set(model, m);
    }
    m.requests += 1;
    if (success) m.success += 1;
    else m.errors += 1;
    if (Number.isFinite(durationMs)) {
      m.msSum += durationMs;
      m.msCount += 1;
    }
  }
  if (accountId) {
    let a = ledger.accounts.get(accountId);
    if (!a) {
      a = { requests: 0, success: 0, errors: 0, at: Date.now() };
      ledger.accounts.set(accountId, a);
      // Key rotation (remove old + add new) grows this map one entry per
      // replaced key; evict the least-recently-active entry past the cap.
      if (ledger.accounts.size > ACCOUNTS_LEDGER_LIMIT) {
        let oldest = null;
        for (const [id, entry] of ledger.accounts) {
          if (!oldest || (entry.at ?? 0) < (oldest[1].at ?? 0)) oldest = [id, entry];
        }
        if (oldest) ledger.accounts.delete(oldest[0]);
      }
    }
    a.at = Date.now();
    a.requests += 1;
    if (success) a.success += 1;
    else a.errors += 1;
  }
  scheduleLedgerDump();
}

/** GET /admin/stats response. */
export function getStats() {
  const models = [...ledger.models.entries()]
    .map(([id, m]) => ({
      id,
      requests: m.requests,
      success: m.success,
      errors: m.errors,
      avgMs: m.msCount ? Math.round(m.msSum / m.msCount) : 0,
    }))
    .sort((a, b) => b.requests - a.requests);
  const accounts = [...ledger.accounts.entries()]
    .map(([id, a]) => ({ id, requests: a.requests, success: a.success, errors: a.errors }))
    .sort((a, b) => b.requests - a.requests);
  const hourlyBuckets = [...ledger.buckets.entries()]
    .map(([ts, b]) => ({
      ts,
      requests: b.requests,
      success: b.success,
      errors: b.errors,
      avgMs: b.msCount ? Math.round(b.msSum / b.msCount) : 0,
    }))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return {
    totals: { ...ledger.totals, tokens: { ...ledger.totals.tokens } },
    models,
    accounts,
    hourlyBuckets,
  };
}

// Load historical aggregation once at module load (config.accountsPath is
// already pinned by the test/entry before the import).
restoreLedger();

/**
 * Retry-After (seconds) for the pool-exhausted 503: the earliest moment any
 * cooling account thaws, clamped 10s..600s. null when nothing will ever thaw
 * (no cooling accounts — e.g. an empty pool) — then a Retry-After is moot.
 */
export function poolExhaustedRetryAfter() {
  const now = Date.now();
  let earliest = Infinity;
  for (const a of pool.values()) {
    if (a.disabled || a.cooldownUntil == null) continue;
    if (a.cooldownUntil > now) earliest = Math.min(earliest, a.cooldownUntil);
  }
  if (!Number.isFinite(earliest)) return null;
  return Math.min(600, Math.max(10, Math.ceil((earliest - now) / 1000)));
}

// ── Pool persistence ─────────────────────────────────────────────

/**
 * Persist per-account usage. Mandatory: the run count is the service's only
 * usage record; memory-only would zero it on every restart.
 */
function persistUsage() {
  const out = {};
  for (const a of pool.values()) {
    out[a.id] = {
      runs: a.runs,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      failures: a.failures,
      lastUsedAt: a.lastUsedAt,
      autoDisabled: a.autoDisabled,
      disabledReason: a.disabledReason,
      autoRecoverable: a.autoRecoverable,
      cooldownUntil: a.cooldownUntil,
      cooldownReason: a.cooldownReason,
      rateLimitStreak: a.rateLimitStreak,
      lastRateLimitAt: a.lastRateLimitAt,
      halfOpen: a.halfOpen,
      halfOpenStreak: a.halfOpenStreak,
      halfOpenAttempts: a.halfOpenAttempts,
      suspiciousStreak: a.suspiciousStreak,
      authFailStreak: a.authFailStreak,
    };
  }
  try {
    atomicDump(usagePath(), out);
  } catch (err) {
    log.warn(`failed to write usage stats: ${err?.message}`);
  }
}

/** Debounced persist: writing per request is wasted IO; losing ~10s is fine. */
function scheduleUsageDump() {
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null;
    persistUsage();
  }, 10_000);
  usageFlushTimer.unref?.();
}

/** Restore persisted runtime state; keeps disable/cooldown across restarts. */
function restoreUsage() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(usagePath(), "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") log.warn(`failed to read usage stats: ${err?.message}`);
    return;
  }
  for (const [id, s] of Object.entries(raw ?? {})) {
    const a = pool.get(id);
    if (!a) continue;
    a.runs = s.runs ?? 0;
    a.inputTokens = s.inputTokens ?? 0;
    a.outputTokens = s.outputTokens ?? 0;
    a.failures = s.failures ?? 0;
    a.lastUsedAt = s.lastUsedAt ?? null;
    a.autoDisabled = s.autoDisabled === true;
    a.disabledReason = s.disabledReason ?? null;
    a.autoRecoverable = s.autoRecoverable === true;
    a.cooldownUntil = Number.isFinite(s.cooldownUntil) ? s.cooldownUntil : null;
    a.cooldownReason = s.cooldownReason ?? null;
    a.rateLimitStreak = s.rateLimitStreak ?? 0;
    a.lastRateLimitAt = Number.isFinite(s.lastRateLimitAt) ? s.lastRateLimitAt : null;
    a.halfOpen = s.halfOpen === true;
    a.halfOpenStreak = s.halfOpenStreak ?? 0;
    a.halfOpenAttempts = s.halfOpenAttempts ?? 0;
    a.suspiciousStreak = s.suspiciousStreak ?? 0;
    a.authFailStreak = s.authFailStreak ?? 0;
  }
}

/**
 * Read the accounts file, normalizing both shapes: plain array and
 * {accounts:[...]} wrapper. Writes preserve whichever shape the user chose.
 */
function readStore() {
  let text;
  try {
    text = fs.readFileSync(config.accountsPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { missing: true, wrapped: false, list: [] };
    throw new Error(`failed to read the accounts file: ${err?.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`the accounts file is not valid JSON: ${err?.message}`);
  }
  if (Array.isArray(raw)) return { missing: false, wrapped: false, list: raw };
  if (Array.isArray(raw?.accounts)) return { missing: false, wrapped: true, root: raw, list: raw.accounts };
  throw new Error("bad accounts file format: expected an array, or { accounts: [...] }");
}

/**
 * Write the accounts file via tmp + rename. Atomic (no half-written pool on
 * crash) and needs only directory write permission. The tmp file is created
 * 0600 and fsynced before the rename — same durability as atomicDump; a
 * crash right after the rename must not leave a zeroed pool behind.
 */
function writeStore(file) {
  const out = file.wrapped ? { ...file.root, accounts: file.list } : file.list;
  const tmp = `${config.accountsPath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(config.accountsPath), { recursive: true });
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  try {
    fs.renameSync(tmp, config.accountsPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

/**
 * Load the pool from the file. Repeatable (hot reload): existing accounts
 * keep runtime state — only name/priority/config-disabled are refreshed.
 */
export function loadAccounts() {
  const file = readStore();
  if (file.missing) {
    log.warn(`accounts file not found: ${config.accountsPath} (pool empty; all requests will 503)`);
    return { total: 0, added: 0, removed: 0 };
  }
  const list = file.list;

  const seen = new Set();
  const fresh = [];
  for (const item of list) {
    const key = String(item?.key ?? "").trim();
    if (!key) {
      log.warn("pool entry without a key, skipped");
      continue;
    }
    const id = digestId(key);
    seen.add(id);
    const exist = pool.get(id);
    if (exist) {
      exist.name = item.name ?? exist.name;
      exist.priority = Number.isFinite(item.priority) ? item.priority : exist.priority;
      exist.configDisabled = item.disabled === true;
    } else {
      const a = new Account(item);
      pool.set(id, a);
      fresh.push(a);
    }
  }
  const added = fresh.length;

  let removed = 0;
  for (const id of [...pool.keys()]) {
    if (!seen.has(id)) {
      pool.delete(id);
      removed += 1;
    }
  }

  if (added || removed) restoreUsage();
  log.info(`pool loaded: ${pool.size} accounts (added ${added}, removed ${removed})`);

  // Fetch identity for fresh accounts right away (Cursor.me, read-only) so
  // the status page is not blank until the next probe round. Fire-and-forget.
  for (const a of fresh) void probe(a);

  return { total: pool.size, added, removed };
}

/** Usable (non-disabled) account count. */
export function availableCount() {
  return [...pool.values()].filter((a) => !a.disabled).length;
}

export function all() {
  return [...pool.values()];
}

export function get(id) {
  return pool.get(id) ?? null;
}

// ── Selection ────────────────────────────────────────────────────

const GRACE_WINDOW_MS = 5 * 60 * 1000;
const SLIDE_WINDOW_MS = 60 * 1000;

/** Requests started in the last 60s (sliding window, pruned on read). */
function slidingLoad(a, now) {
  const t = a.requestTimes;
  while (t.length && now - t[0] > SLIDE_WINDOW_MS) t.shift();
  return t.length;
}

/**
 * Cached Date.parse of addedAt. rankVector compares it on every sort
 * comparison (bench: 1.57µs @2 accounts -> 535µs @200, ~3400 reparses per
 * select) — reparsing the ISO string each time was the pool's dominant
 * selection cost. The cache invalidates when the string itself changes
 * (hot reload / test mutation), so the ramp semantics never go stale.
 */
function addedAtMs(a) {
  if (a._addedAtSrc !== a.addedAt) {
    a._addedAtSrc = a.addedAt;
    a._addedAtMs = Date.parse(a.addedAt);
  }
  return a._addedAtMs;
}

/** 5-dimensional rank: (health, ramp, inflight, rpm, priority). */
function rankVector(a, now) {
  return [
    a.disabled ? 1 : 0,
    now - addedAtMs(a) < GRACE_WINDOW_MS ? 1 : 0,
    a.inflight,
    slidingLoad(a, now),
    a.priority,
  ];
}

function vectorCompare(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

/** A cooldown time is set and has not yet arrived. */
function coolingNow(a, now) {
  return a.cooldownUntil != null && a.cooldownUntil > now;
}

/**
 * Re-admit cooldown-expired accounts — into the half-open gate, never a full
 * flood (a burst of freshly-thawed accounts is exactly what re-triggers the
 * upstream risk control). Runs before selection, not in the prober: probing
 * granularity (30 min) would stretch cooldowns (10 min) and lag recovery.
 * Also clears expired transient cooldown timestamps so the panel does not
 * show stale times.
 */
export function releaseCooled() {
  const now = Date.now();
  for (const a of pool.values()) {
    if (a.tryRelease()) {
      log.info(`account ${a.name || a.id} cooldown over, half-open (one trial probe per round)`);
    } else if (!a.autoDisabled && a.cooldownUntil != null && a.cooldownUntil <= now) {
      a.cooldownUntil = null;
      a.cooldownReason = null;
      a.halfOpen = true;
    }
  }
}

/** Release one in-flight reservation. Anti-negative: double release cannot drive it below zero. */
export function release(account) {
  if (account.inflight > 0) account.inflight -= 1;
}

/**
 * Pick an account. Disabled/cooling/excluded accounts are dropped outright;
 * the rest rank by (health, ramp, inflight, rpm, priority) and ties
 * round-robin. At most one half-open account participates per call — the
 * gradual-recovery gate. Selection reserves inflight and records the rpm
 * slot synchronously, closing the "selected but not yet used" window.
 */
export function select(exclude = []) {
  releaseCooled();
  const now = Date.now();
  let halfOpenBudget = 1;
  const candidates = [...pool.values()].filter((a) => {
    if (exclude.includes(a.id)) return false;
    if (a.disabled) return false;
    if (coolingNow(a, now)) return false;
    if (a.halfOpen) {
      if (halfOpenBudget <= 0) return false;
      halfOpenBudget -= 1;
    }
    return true;
  });
  if (!candidates.length) return null;

  // Flush all sliding windows once up front so rankVector stays a pure read
  // — a comparator with side effects depends on sort implementation details.
  for (const a of candidates) slidingLoad(a, now);
  candidates.sort((x, y) => vectorCompare(rankVector(x, now), rankVector(y, now)));
  const top = rankVector(candidates[0], now);
  const tier = candidates.filter((a) => vectorCompare(rankVector(a, now), top) === 0);
  const picked = tier[rrCursor++ % tier.length];
  picked.inflight += 1;
  picked.requestTimes.push(now);
  return picked;
}

// ── State-transition events ─────────────────────────────

// Account state changes (auto-disable, cooldown, recovery) broadcast to
// subscribers the moment they happen. Optional complement to the status
// page's heartbeat polling; a consumer that misses an event re-syncs on
// the next poll anyway.
const poolEventSubscribers = new Set();

/**
 * Subscribe to account state transitions. fn receives
 * { id, name, event, reason?, ... } where event is one of:
 *   "disabled"  — auto-disabled (failure or probe verdict)
 *   "cooldown"  — entered a cooldown (reason + cooldownUntil included)
 *   "half-open" — cooldown over, re-admitted into the half-open gate
 *   "recovered" — fully re-admitted (successes or probe)
 * Returns an unsubscribe function. Listener failures are swallowed.
 */
export function subscribePoolEvents(fn) {
  poolEventSubscribers.add(fn);
  return () => poolEventSubscribers.delete(fn);
}

function emitPoolEvent(account, event, extra = {}) {
  if (!poolEventSubscribers.size) return;
  const payload = { id: account.id, name: account.name || null, event, ...extra };
  for (const fn of poolEventSubscribers) {
    try {
      fn(payload);
    } catch {
      // A listener failure must not break pool logic.
    }
  }
}

// ── Run accounting ───────────────────────────────────────────────

/** One successful call. `usage` is the run stream's usage event (may be absent). */
export function reportSuccess(account, usage) {
  account.runs += 1;
  account.failures = 0;
  // One success resets the 429 escalation (only consecutive 429s accumulate).
  account.rateLimitStreak = 0;
  account.lastRateLimitAt = null;
  account.authFailStreak = 0;
  account.suspiciousStreak = 0;
  // Half-open: N consecutive successes fully re-admit; any failure re-cooldowns.
  if (account.halfOpen) {
    account.halfOpenStreak += 1;
    if (account.halfOpenStreak >= config.halfOpenSuccesses) {
      account.halfOpen = false;
      account.halfOpenStreak = 0;
      account.halfOpenAttempts = 0;
      log.info(`account ${account.name || account.id} recovered after ${config.halfOpenSuccesses} successful probes`);
      emitPoolEvent(account, "recovered", { reason: "half-open successes" });
    }
  }
  account.lastUsedAt = new Date().toISOString();
  account.inputTokens += usage?.inputTokens ?? 0;
  account.outputTokens += usage?.outputTokens ?? 0;
  scheduleUsageDump();
}

/**
 * D2: the 429 streak decays with time — 1 point per decay window since the
 * last 429 — so a long-since-quiet account does not sit at the 90s cap
 * forever. Read-time and idempotent: the result depends only on
 * lastRateLimitAt, never on how often this is called.
 */
function decayedStreak(account, now) {
  if (!account.rateLimitStreak || account.lastRateLimitAt == null) return account.rateLimitStreak;
  const elapsedWindows = Math.floor(
    (now - account.lastRateLimitAt) / (config.rateLimitDecayMinutes * 60 * 1000),
  );
  return Math.max(0, account.rateLimitStreak - elapsedWindows);
}

/**
 * D1: a failed half-open probe re-cooldowns with base x 1.5^n backoff,
 * capped at the 429 ceiling — each failure buys the account more quiet time.
 */
function applyHalfOpenBackoff(account, baseMs) {
  account.halfOpenStreak = 0;
  account.halfOpenAttempts += 1;
  const ms = Math.min(baseMs * Math.pow(1.5, account.halfOpenAttempts), config.cooldown429MaxMs);
  account.cooldownUntil = Date.now() + ms;
  account.cooldownReason = `half-open retry ${account.halfOpenAttempts} failed, backoff ${Math.round(ms / 1000)}s`;
}

/**
 * One failure. Returns the disposition.
 *
 * Tiered cooldowns: 429 escalates base x streak capped at max (or honors
 * Retry-After when present); 403 soft-risk penalizes 20s per hit, 6
 * consecutive hits disable; 5xx is a fixed short cooldown; auth failures
 * take the disable branch (probe-recoverable when API-level). A 401 on a
 * key that has served requests is treated as transient (short cooldown),
 * two consecutive ones disable.
 */
export function reportFailure(account, err) {
  const shape = errShape(err);
  const info = classifyError(err);
  const verdict = info.verdict;

  account.failures += 1;
  account.lastUsedAt = new Date().toISOString();
  account.lastError = { at: account.lastUsedAt, verdict, ...shape };

  log.warn(`account ${account.name || account.id} call failed -> ${verdict}`, shape);

  // D3: a 401 on a key that has served requests is transient (one-off jitter,
  // IP churn) — short cooldown and retry instead of an immediate disable.
  // Two consecutive ones fall through to the disable path. Fresh keys
  // (runs == 0) keep the old behavior: disable outright.
  const isApi401 = shape.status === 401 || shape.name === "AuthenticationError";
  if (verdict === Verdict.DISABLE_AND_RETRY && isApi401 && account.runs > 0 && !account.autoDisabled) {
    account.authFailStreak += 1;
    if (account.authFailStreak < 2) {
      account.cooldownUntil = Date.now() + config.cooldown401Ms;
      account.cooldownReason = `401 transient cooldown ${Math.round(config.cooldown401Ms / 1000)}s (hit ${account.authFailStreak})`;
      if (account.halfOpen) applyHalfOpenBackoff(account, config.cooldown401Ms);
      emitPoolEvent(account, "cooldown", { reason: account.cooldownReason, cooldownUntil: account.cooldownUntil });
      scheduleUsageDump();
      return verdict;
    }
  }

  if (verdict === Verdict.DISABLE_AND_RETRY) {
    // D1: a disable ends the half-open probe cycle outright.
    account.halfOpen = false;
    account.halfOpenStreak = 0;
    account.halfOpenAttempts = 0;
    account.autoDisabled = true;
    // Structured errors concatenate name/status/code; a bare in-run Error
    // yields a lone "Error", so fall back to the message for those.
    const tag = [shape.name, shape.status, shape.code].filter(Boolean).join(" ").trim();
    account.disabledReason = tag === "Error" ? shape.message.slice(0, 120) : tag;
    // Only API-level failures are verifiable back by probing; session
    // failures (invisible to me()) retry through the cooldown instead.
    account.autoRecoverable = isApi401;
    account.cooldownUntil = account.autoRecoverable ? null : Date.now() + config.cooldownAuthMs;
    account.cooldownReason = account.autoRecoverable ? null : "auth failure cooldown";
    log.error(
      `account ${account.name || account.id} auto-disabled: ${account.disabledReason}` +
        (account.autoRecoverable
          ? " (probe can re-enable)"
          : ` (auto-retried in ${Math.round(config.cooldownAuthMs / 60000)} min)`),
    );
    emitPoolEvent(account, "disabled", { reason: account.disabledReason, autoRecoverable: account.autoRecoverable });
  } else if (verdict === Verdict.RETRY_OTHER && !account.autoDisabled) {
    // Region-block is model-scoped, not account-scoped: no cooldown and no
    // disable — the account keeps serving other models. Failover keeps
    // trying the rest of the pool; pool exhaustion then surfaces the region
    // error itself (502), never a 503.
    if (!info.regionBlocked) {
      if (isThrottled(shape)) {
      if (isQuotaExhaustion(err)) {
        // Quota exhaustion is an account-level FACT, not a transient: a
        // cooldown resurrects the account in 30 min and every client
        // request slams the spent account again (live bug: operator
        // disabled it, it came back on its own, all clients 429/usage).
        // Disable it for good — only a manual re-enable (or a real
        // top-up) brings it back; the prober never re-admits it
        // (autoRecoverable=false).
        applyDisabled(account, true);
        account.disabledReason = "usage limit exhausted (quota)";
        persistUsage();
        emitPoolEvent(account, "disabled", { reason: account.disabledReason });
      } else {
          // D2: the streak first decays with the gap since the last 429.
          account.rateLimitStreak = decayedStreak(account, Date.now()) + 1;
          account.lastRateLimitAt = Date.now();
          // D5: an explicit Retry-After (capped at 600s) overrides the streak math.
          const ra = parseRetryAfter(err);
          const raMs = ra == null ? 0 : Math.min(ra, 600) * 1000;
          const ms = Math.max(
            Math.min(config.cooldown429BaseMs * account.rateLimitStreak, config.cooldown429MaxMs),
            raMs,
          );
          account.cooldownUntil = Date.now() + ms;
          account.cooldownReason = `rate-limit cooldown ${Math.round(ms / 1000)}s (hit ${account.rateLimitStreak})`;
          if (account.halfOpen) applyHalfOpenBackoff(account, ms);
          emitPoolEvent(account, "cooldown", { reason: account.cooldownReason, cooldownUntil: account.cooldownUntil });
        }
      } else if (shape.status === 403) {
        // D6: 403 soft-risk penalty — short cooldown per hit, 6 consecutive
        // hits disable (soft-ban). The 403 verdict itself is unchanged.
        account.suspiciousStreak += 1;
        if (account.suspiciousStreak >= 6) {
          account.halfOpen = false;
          account.halfOpenStreak = 0;
          account.halfOpenAttempts = 0;
          account.autoDisabled = true;
          account.disabledReason = `403 soft-risk (${account.suspiciousStreak} consecutive hits)`;
          account.autoRecoverable = false;
          account.cooldownUntil = Date.now() + config.cooldownAuthMs;
          account.cooldownReason = "403 soft-ban cooldown";
          log.error(
            `account ${account.name || account.id} auto-disabled: ${account.disabledReason}`
              + ` (auto-retried in ${Math.round(config.cooldownAuthMs / 60000)} min)`,
          );
          emitPoolEvent(account, "disabled", { reason: account.disabledReason, autoRecoverable: false });
        } else {
          account.cooldownUntil = Date.now() + config.cooldown403Ms;
          account.cooldownReason = `403 soft-risk cooldown ${Math.round(config.cooldown403Ms / 1000)}s (hit ${account.suspiciousStreak})`;
          if (account.halfOpen) applyHalfOpenBackoff(account, config.cooldown403Ms);
          emitPoolEvent(account, "cooldown", { reason: account.cooldownReason, cooldownUntil: account.cooldownUntil });
        }
      } else if ((shape.status ?? 0) >= 500) {
        account.cooldownUntil = Date.now() + config.cooldown5xxMs;
        account.cooldownReason = `upstream 5xx cooldown ${Math.round(config.cooldown5xxMs / 1000)}s`;
        if (account.halfOpen) applyHalfOpenBackoff(account, config.cooldown5xxMs);
        emitPoolEvent(account, "cooldown", { reason: account.cooldownReason, cooldownUntil: account.cooldownUntil });
      }
    }
  }

  scheduleUsageDump();
  return verdict;
}

// ── Admin operations ─────────────────────────────────────────────

/**
 * Error carrying its own HTTP status, so callers need not guess 400 vs 409.
 * The field is `httpStatus`, not `status`: SDK errors also carry `status`
 * (the upstream's code), and one name would leak a dead-pool-key 401 to the
 * browser as an admin-authentication 401.
 */
function httpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

// ── Accounts-file write serialization ─────────────────────────────

/**
 * Serialize read-modify-write cycles on the accounts file. Concurrent
 * addAccount/addAccounts calls each read the file, mutate their copy and
 * write it back; without serialization the second writer overwrites the
 * first's rows (lost update). A rejected task never wedges the chain.
 */
let fileWriteQueue = Promise.resolve();
function enqueueFileWrite(task) {
  const run = fileWriteQueue.then(task, task);
  fileWriteQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Validate one pending account until "safe to persist". Shared by add-account
 * and bulk import so both paths apply the same criteria. `taken` holds ids
 * already claimed in this batch, blocking the same key twice in one go.
 */
async function vetCandidate({ key, name, priority, login: loginEmail, password }, taken) {
  const k = String(key ?? "").trim();
  if (!k) throw httpError(400, "key must not be empty");
  if (!/^crsr_/.test(k)) throw httpError(400, "does not look like a Cursor API key (should start with crsr_)");

  const id = digestId(k);
  const inPool = pool.get(id);
  if (inPool) throw httpError(409, `already in the pool: ${inPool.name || inPool.id}`);
  if (taken?.has(id)) throw httpError(409, "duplicate within this batch");

  let me;
  try {
    me = await Cursor.me({ apiKey: k });
  } catch (err) {
    const s = errShape(err);
    if (s.status === 401 || s.name === "AuthenticationError") {
      throw httpError(400, "this key is invalid (Cursor returned 401)");
    }
    throw httpError(502, `Cursor errored during validation: ${s.name} ${s.status ?? ""}`.trim());
  }

  const entry = { name: String(name ?? "").trim() || me.apiKeyName || me.userEmail || "", key: k };
  const p = Number(priority);
  if (Number.isFinite(p) && p !== 0) entry.priority = p;
  // Login fields are written only when provided; an unfilled field stays
  // absent entirely. They exist because keys expire — at that point you must
  // log back in, and "which account does this key belong to" is what the key
  // alone cannot answer.
  const login = String(loginEmail ?? "").trim();
  if (login) entry.login = login;
  if (password) entry.password = String(password);
  return { id, entry, me };
}

/**
 * Add one account: validate the key first, then persist. Write-then-validate
 * would leave a dead key in the file, re-loaded on every restart, whose only
 * fate is hitting a 401 on some real client request. Duplicate checks go to
 * the file too: it may have been hand-edited but not yet reloaded.
 * The read-modify-write runs on the file write queue — concurrent adds must
 * not lose each other's rows — and the file is read fresh *after* the slow
 * validation, so a concurrent removeAccount/updateAccount is never
 * overwritten by a stale copy (validation has no file-state dependency).
 */
export function addAccount(args = {}) {
  return enqueueFileWrite(() => addAccountSerial(args));
}

async function addAccountSerial({ key, name, priority, login, password } = {}) {
  const { id, entry, me } = await vetCandidate({ key, name, priority, login, password }, null);

  const file = readStore();
  const inFile = new Set(file.list.map((it) => digestId(String(it?.key ?? "").trim())));
  if (inFile.has(id)) {
    throw httpError(409, "this key is already in the accounts file (maybe hand-added; click reload to pick it up)");
  }

  file.list.push(entry);
  writeStore(file);
  loadAccounts();

  const added = pool.get(id);
  // loadAccounts' probe above is async; fill in the identity we already
  // fetched so the UI is not left with an empty email right after adding.
  if (added) added.identity = me;

  log.info(`added ${entry.name || id} (${me.userEmail ?? "?"}); pool now ${pool.size}`);
  return { id, name: entry.name, email: me.userEmail ?? null, total: pool.size };
}

/**
 * Bulk import: validate one by one, write once. One bad key does not affect
 * the rest — expired keys are normal in spreadsheet pastes.
 * Queued like addAccount: the whole read-modify-write is one serialized unit.
 */
export function addAccounts(items) {
  return enqueueFileWrite(() => addAccountsSerial(items));
}

async function addAccountsSerial(items) {
  if (!Array.isArray(items) || !items.length) throw httpError(400, "no keys to import");
  if (items.length > 200) throw httpError(400, `200 max per batch; you sent ${items.length}`);

  // Validate everything first (network calls, no file-state dependency); the
  // read-modify-write then runs as one synchronous block, so a concurrent
  // removeAccount/updateAccount can never be overwritten by a stale copy.
  const taken = new Set(); // in-batch duplicates only
  const pending = [];      // {id, entry, me}
  const failed = [];
  for (const item of items) {
    try {
      const { id, entry, me } = await vetCandidate(item, taken);
      taken.add(id);
      pending.push({ id, entry, me });
    } catch (err) {
      failed.push({ key: redactKey(String(item?.key ?? "").trim()), reason: err.message });
    }
  }

  const file = readStore();
  const inFile = new Set(file.list.map((it) => digestId(String(it?.key ?? "").trim())));
  const added = [];
  for (const { id, entry, me } of pending) {
    if (inFile.has(id)) {
      failed.push({ key: redactKey(entry.key), reason: "already in the accounts file" });
      continue;
    }
    inFile.add(id);
    file.list.push(entry);
    added.push({ id, name: entry.name, email: me.userEmail ?? null, me });
  }

  if (added.length) {
    writeStore(file);
    loadAccounts();
    for (const a of added) {
      const acc = pool.get(a.id);
      if (acc) acc.identity = a.me;
      delete a.me;
    }
  }
  log.info(`bulk import: ${added.length} added, ${failed.length} failed; pool now ${pool.size}`);
  return { added, failed, total: pool.size };
}

/**
 * Remove an account from file and memory. Usage records go with it: re-adding
 * the same key must not resurface phantom old counts.
 */
export function removeAccount(id) {
  const a = pool.get(id);
  if (!a) throw httpError(404, "no such account");

  const file = readStore();
  const before = file.list.length;
  file.list = file.list.filter((it) => digestId(String(it?.key ?? "").trim()) !== id);
  if (file.list.length !== before) writeStore(file);

  pool.delete(id);
  persistUsage();
  log.info(`removed ${a.name || id}; pool now ${pool.size}`);
  return { id, total: pool.size };
}

/** Rename / change priority. The key cannot change — that is a different account. */
export function updateAccount(id, { name, priority } = {}) {
  const a = pool.get(id);
  if (!a) throw httpError(404, "no such account");

  const file = readStore();
  const row = file.list.find((it) => digestId(String(it?.key ?? "").trim()) === id);
  if (!row) throw httpError(409, "this account is not in the accounts file (maybe hand-removed); reload first");

  if (name !== undefined) {
    row.name = String(name).trim();
    a.name = row.name;
  }
  if (priority !== undefined) {
    const p = Number(priority);
    if (!Number.isFinite(p)) throw httpError(400, "priority must be a number");
    a.priority = p;
    if (p === 0) delete row.priority;
    else row.priority = p;
  }
  writeStore(file);
  return a.view();
}

// ── Probing ──────────────────────────────────────────────────────

/** Probe a single account manually: for the UI's "just changed the key" moment. */
export async function probeOne(id) {
  const a = pool.get(id);
  if (!a) throw httpError(404, "no such account");
  const ok = await probe(a);
  return { ok, account: a.view() };
}

/**
 * Apply a manual enable/disable to one account — state only, no persistence.
 * Shared by setDisabled and batchOps so a 500-id batch mutates memory once
 * and writes once instead of 500 full serializations.
 */
function applyDisabled(a, disabled) {
  if (disabled) {
    a.autoDisabled = true;
    // Manual disable must stick: the prober only auto-re-enables accounts
    // marked autoRecoverable, and a manual disable is not that (reviewer M3).
    a.autoRecoverable = false;
    a.disabledReason = "disabled manually";
    // A disabled account must not resurrect through the cooldown path:
    // releaseCooled() flips expired-cooldown accounts to half-open — if a
    // manual disable leaves a future cooldownUntil behind, the account
    // comes back on its own next selection round (live bug: operator
    // disabled a spent account, it re-appeared and every client request
    // kept hitting the usage error).
    a.cooldownUntil = null;
    a.cooldownReason = null;
    a.halfOpen = false;
    a.halfOpenStreak = 0;
    a.halfOpenAttempts = 0;
  } else {
    a.autoDisabled = false;
    a.disabledReason = null;
    a.autoRecoverable = false;
    a.cooldownUntil = null;
    a.cooldownReason = null;
    a.failures = 0;
    // A manual enable is a deliberate full re-admission, not a probe.
    a.halfOpen = false;
    a.halfOpenStreak = 0;
    a.halfOpenAttempts = 0;
  }
}

/** Admin control: manually enable/disable. Enable also clears auto-disable state. */
export function setDisabled(id, disabled) {
  const a = pool.get(id);
  if (!a) return false;
  applyDisabled(a, disabled);
  persistUsage();
  return true;
}

/**
 * Probe: ask Cursor.me() "is this key still valid?" — read-only, no run, no
 * quota — and refresh the account identity. Only API-level death is visible
 * here, and only autoRecoverable accounts are re-enabled by it; session
 * failures return 200 forever and must not be re-admitted this way.
 */
export async function probe(account) {
  try {
    const me = await Cursor.me({ apiKey: account.key });
    account.identity = me;
    if (account.autoDisabled && account.autoRecoverable) {
      account.autoDisabled = false;
      account.disabledReason = null;
      account.autoRecoverable = false;
      account.cooldownUntil = null;
      account.cooldownReason = null;
      // The probe itself verified the key at the API level — full re-admission.
      account.halfOpen = false;
      account.halfOpenStreak = 0;
      account.halfOpenAttempts = 0;
      log.info(`account ${account.name || account.id} recovered by probe, re-enabled`);
      emitPoolEvent(account, "recovered", { reason: "probe" });
    }
    return true;
  } catch (err) {
    const shape = errShape(err);
    log.warn(`account ${account.name || account.id} probe failed`, shape);
    if (shape.status === 401 || shape.name === "AuthenticationError") {
      account.autoDisabled = true;
      account.disabledReason = `probe: ${shape.name} ${shape.status}`;
      // What probing detects, probing can verify back.
      account.autoRecoverable = true;
      account.lastError = { at: new Date().toISOString(), verdict: Verdict.DISABLE_AND_RETRY, ...shape };
      emitPoolEvent(account, "disabled", { reason: account.disabledReason, autoRecoverable: true });
      persistUsage();
    }
    return false;
  }
}

/**
 * Start the probing scheduler. Accounts are spaced 300ms apart so one
 * endpoint is never hammered concurrently. The first round runs
 * unconditionally at 2s — identity is a side effect of probing, and the
 * status page needs it even when periodic probing is disabled.
 */
export function startProber(intervalMs) {
  const tick = async () => {
    for (const a of all()) {
      await probe(a);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  setTimeout(() => void tick(), 2000).unref?.();

  if (intervalMs <= 0) {
    log.info("periodic probing disabled (CURSOR_PROBE_INTERVAL_MS=0); identity fetched once at startup");
    return;
  }
  setInterval(() => void tick(), intervalMs).unref?.();
  log.info(`probing enabled: every ${Math.round(intervalMs / 60000)} min (Cursor.me, no quota cost)`);
}

// ── Batch & export ───────────────────────────────────────────────

/**
 * Batch operations (the {ids, op} shape of POST /admin/accounts/batch).
 * Executed serially: bulk-probing Cursor in parallel is rate-limiting
 * yourself. One failure does not affect the rest; each item gets its own
 * reason.
 */
export async function batchOps(ids, op) {
  const OPS = ["disable", "enable", "probe", "delete"];
  if (!OPS.includes(op)) throw httpError(400, `unknown operation ${op} (available: ${OPS.join(", ")})`);
  if (!Array.isArray(ids) || !ids.length) throw httpError(400, "ids must not be empty");
  if (ids.length > 500) throw httpError(400, `500 max per batch; you sent ${ids.length}`);

  const ok = [];
  const failed = [];
  for (const id of ids) {
    try {
      const account = pool.get(id);
      if (!account) throw httpError(404, "no such account");
      switch (op) {
        case "disable":
          applyDisabled(account, true);
          break;
        case "enable":
          applyDisabled(account, false);
          break;
        case "probe":
          await probe(account);
          break;
        case "delete":
          break; // pool.delete deferred until the file write succeeded
      }
      ok.push(id);
    } catch (err) {
      failed.push({ id, reason: err?.message ?? String(err) });
    }
  }

  // One write for the whole batch, not one per id: 500 ids used to mean 500
  // full serializations + fsyncs of both files. Deletes rewrite the accounts
  // file through the write queue (read-modify-write, like addAccount) and
  // only then drop the accounts from memory — a failed write leaves both
  // file and pool untouched, never a half-applied delete.
  if (ok.length) {
    if (op === "delete") {
      const doomed = new Set(ok);
      await enqueueFileWrite(() => {
        const file = readStore();
        if (!file.missing) {
          file.list = file.list.filter((it) => !doomed.has(digestId(String(it?.key ?? "").trim())));
          writeStore(file);
        }
      });
      for (const id of ok) pool.delete(id);
    }
    persistUsage();
  }
  return { ok, failed };
}

/**
 * Export all accounts (GET /admin/accounts/export). Never exports plaintext
 * keys — only masks; for the real thing, read the file on the server.
 */
export function exportAccounts() {
  const list = all().map((a) => ({
    id: a.id,
    email: a.identity?.userEmail ?? a.login ?? null,
    maskedKey: redactKey(a.key),
    priority: a.priority,
    status: a.disabled ? "disabled" : "active",
    lastUsedAt: a.lastUsedAt,
    addedAt: a.addedAt,
    runs: a.runs,
    tokens: { input: a.inputTokens, output: a.outputTokens },
  }));
  return { _exportedAt: new Date().toISOString(), count: list.length, accounts: list };
}

/** Write the counts down before exit; don't lose the tail end. */
export function flush() {
  if (usageFlushTimer) clearTimeout(usageFlushTimer);
  usageFlushTimer = null;
  persistUsage();
  if (ledgerFlushTimer) clearTimeout(ledgerFlushTimer);
  ledgerFlushTimer = null;
  persistLedger();
}
