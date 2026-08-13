// Static config: env vars -> defaults, evaluated once at process start.
// Account pool and admin credentials live in the accounts file and the
// hot-override tier (runtime-settings.mjs), not in env vars.
// Malformed env values throw at boot rather than degrade silently.

import path from "node:path";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} is not an integer: ${raw}`);
  return n;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function envList(name) {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envJsonObject(name) {
  try {
    const raw = process.env[name];
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const config = {
  port: envInt("CURSOR_PORT", 8008),
  host: process.env.CURSOR_HOST ?? "127.0.0.1",

  // Pool file lives in its own hot-reloadable path — accounts come and go,
  // env vars would force a rebuild per change.
  accountsPath: process.env.CURSOR_ACCOUNTS ?? "/data/accounts.json",

  // Cap on accounts cycled per request: past ~3 failures it is a mass
  // outage, and more retries just waste time.
  maxAccountAttempts: envInt("CURSOR_MAX_ACCOUNT_ATTEMPTS", 3),

  // Health probe interval via Cursor.me() (read-only). 401 = dead key.
  // 0 = disabled. Quota cannot be checked (getUsage returns 403), so
  // probing only answers "is this key still valid".
  probeIntervalMs: envInt("CURSOR_PROBE_INTERVAL_MS", 30 * 60 * 1000),

  // Tiered cooldowns: 429 escalates as base x streak (5s -> 10s -> ...)
  // capped at max, one success resets; 5xx is a fixed short window;
  // session auth failure keeps a long window.
  cooldown429BaseMs: envInt("CURSOR_COOLDOWN_429_BASE_MS", 5 * 1000),
  cooldown429MaxMs: envInt("CURSOR_COOLDOWN_429_MAX_MS", 90 * 1000),
  cooldown5xxMs: envInt("CURSOR_COOLDOWN_5XX_MS", 30 * 1000),
  cooldownAuthMs: envInt("CURSOR_COOLDOWN_AUTH_MS", 10 * 60 * 1000),
  // A 401 on a key that has served requests before is transient (one-off
  // jitter, IP churn); first hit cools briefly instead of disabling, two
  // consecutive ones disable outright.
  cooldown401Ms: envInt("CURSOR_COOLDOWN_401_MS", 45 * 1000),
  // 403 soft-risk penalty: a short cooling window per hit; repeated hits
  // (suspiciousStreak) escalate to a disable.
  cooldown403Ms: envInt("CURSOR_COOLDOWN_403_MS", 20 * 1000),
  // Half-open recovery: consecutive successes needed to fully re-admit a
  // cooldown-expired account (one trial probe per selection round).
  halfOpenSuccesses: envInt("CURSOR_HALF_OPEN_SUCCESSES", 3),
  // 429 streak decay: one point per N minutes since the last 429.
  rateLimitDecayMinutes: envInt("CURSOR_RATE_LIMIT_DECAY_MINUTES", 5),
  // Quota-exhaustion 429s ("usage limit exceeded", "spend limit"): a
  // long-term condition — auth-style long cooldown, no trial retries.
  cooldownQuotaMs: envInt("CURSOR_COOLDOWN_QUOTA_MS", 30 * 60 * 1000),

  // Client auth keys (comma-separated). Empty = open — only acceptable on
  // localhost, this gateway fronts paid Cursor accounts.
  clientKeys: envList("CURSOR_CLIENT_KEYS"),

  // Admin password; empty = reuse clientKeys. Separate key keeps clients
  // from seeing pool internals.
  adminKey: process.env.CURSOR_ADMIN_KEY ?? "",

  // External model-name prefix; empty = raw Cursor ids.
  prefix: process.env.CURSOR_PREFIX ?? "",

  // Agent working directory. Tool-relay mode disables the built-in file
  // tools; the SDK still requires a workspace.
  workspace: path.resolve(process.env.CURSOR_WORKSPACE ?? "/work"),

  // Upstream HTTP proxy (e.g. http://127.0.0.1:10808). The SDK's HTTP/2
  // transport ignores system proxies, so when set we force HTTP/1.1 +
  // CONNECT tunnels (proxy-tunnel.mjs). Empty = direct.
  proxy: process.env.CURSOR_PROXY ?? "",

  // Stream tool activity as text (visible in self-managed mode).
  showToolActivity: envBool("CURSOR_SHOW_TOOLS", true),

  // Per-model default parameters for bare model names:
  // {"claude-opus-5":"[1m]"} — Cursor's 300k default context runs out on
  // long sessions (Claude Code), this fixes it client-side.
  modelDefaults: envJsonObject("CURSOR_MODEL_DEFAULTS"),

  // Max idle time per turn (no event flowing), not wall-clock duration:
  // long thinking/answer phases emit nothing for a long while.
  turnIdleTimeoutMs: envInt("CURSOR_TURN_IDLE_TIMEOUT_MS", 10 * 60 * 1000),

  // How long to wait for the IDE to return a tool result — it may be
  // waiting on user approval.
  toolResultTimeoutMs: envInt("CURSOR_TOOL_RESULT_TIMEOUT_MS", 10 * 60 * 1000),

  logLevel: process.env.CURSOR_LOG_LEVEL ?? "info",
};

export function assertConfig() {
  const problems = [];
  if (!config.clientKeys.length && config.host !== "127.0.0.1") {
    problems.push(
      `CURSOR_CLIENT_KEYS is unset while listening on ${config.host} — `
      + "that exposes the whole pool of Cursor accounts to the world. Set the keys, or listen only on 127.0.0.1.",
    );
  }
  if (!config.adminKey && config.clientKeys.length) {
    problems.push(
      "CURSOR_ADMIN_KEY is unset; the admin interface and status page will reuse the client keys — "
      + "clients would see how many accounts you have and whose each one is.",
    );
  }
  return problems;
}
