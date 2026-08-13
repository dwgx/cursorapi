// HTTP entry: routing, auth, lifecycle.
// Route groups: /ping liveness, /admin/* management, /v1/* data plane.

// Guard and proxy injection must precede all business code.
import "./guard.mjs";
import { injectProxy } from "./proxy-tunnel.mjs";
injectProxy(process.env.CURSOR_PROXY ?? "");

import http from "node:http";
import zlib from "node:zlib";
import { handleMessages } from "./anthropic.mjs";
import { shutdownActiveStreams } from "./stream.mjs";
import { SESSION_COOKIE, authMode, extractKey, isAdmin, isAdminSecret, isClient } from "./guard-auth.mjs";
import { assertConfig, config } from "./settings.mjs";
import { getConfig, getConfigView, setConfig as setConfigHot } from "./runtime-settings.mjs";
import * as guard from "./guard.mjs";
import { readBody, respondError, respondJson, respondText, ttlCache } from "./http-helpers.mjs";
import { LOG_LEVELS, log, recentLogs, subscribeLogs } from "./logger.mjs";
import { describeCatalogError, getCatalog, listAdminModels, listModels, listModelsAnthropic } from "./catalog.mjs";
import { handleChat } from "./openai.mjs";
import * as pool from "./keys.mjs";
import { cookie, createSession, destroySession, penaltyMs, resetPenalty } from "./sessions.mjs";
import { loginPage, page, snapshot } from "./ui.mjs";
import * as update from "./updater.mjs";

const routePath = (req) => (req.url ?? "/").split("?")[0];
const ACCOUNT_ID = /^\/admin\/accounts\/([a-f0-9]{6,})(\/[a-z]+)?$/;

// ── Session domain: login / logout ──

// `Secure` rides X-Forwarded-Proto: hard-coding it breaks plain-http local
// debugging (the browser then refuses the cookie).
function cookieAttrs(req, maxAgeSec) {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const secure = proto === "https" ? "; Secure" : "";
  return `Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

function writeJsonOk(res, extra = {}) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify({ ok: true }));
}

async function handleLogin(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  } catch (err) {
    if (err?.httpStatus) {
      // readBody timeouts carry httpStatus 408; pass them through verbatim.
      respondError(res, err.httpStatus, err.message, err.code ?? "api_error");
      return;
    }
    respondError(res, 400, "request body is not valid JSON", "bad_request");
    return;
  }
  const key = String(body?.key ?? "");
  if (!isAdminSecret(key)) {
    // Delayed failure throttles brute force without ever locking the admin
    // out (locking lets anyone lock the panel with a few random tries).
    await new Promise((r) => setTimeout(r, penaltyMs()));
    respondError(res, 401, "wrong password", "authentication_error");
    return;
  }
  resetPenalty();
  const { token, maxAgeSec } = createSession();
  writeJsonOk(res, { "Set-Cookie": `${SESSION_COOKIE}=${token}; ${cookieAttrs(req, maxAgeSec)}` });
  log.info("admin login succeeded");
}

function handleLogout(req, res) {
  destroySession(cookie(req.headers, SESSION_COOKIE));
  writeJsonOk(res, { "Set-Cookie": `${SESSION_COOKIE}=; ${cookieAttrs(req, 0)}` });
}

// Login/logout run before the auth gate; everything else needs a session.
async function handleSession(req, res, path) {
  if (path === "/admin/login" && req.method === "POST") {
    await handleLogin(req, res);
    return true;
  }
  if (path === "/admin/logout" && req.method === "POST") {
    handleLogout(req, res);
    return true;
  }
  return false;
}

// ── Admin domain ──

// The two admin pages are constants (~156KB) — gzip them once and reuse:
// at ~800 req/s under load the flat page was the loopback/GC bottleneck
// (bench report, /admin page). SSE is never compressed: streamLogs writes
// its own event-stream headers and must not be wrapped.
const GZIP_CACHE_LIMIT = 8;
const gzipCache = new Map();
function gzipCached(html) {
  let buf = gzipCache.get(html);
  if (!buf) {
    buf = zlib.gzipSync(html);
    gzipCache.set(html, buf);
    if (gzipCache.size > GZIP_CACHE_LIMIT) gzipCache.delete(gzipCache.keys().next().value);
  }
  return buf;
}

function writeHtml(req, res, html) {
  if (/gzip/.test(String(req.headers["accept-encoding"] ?? ""))) {
    const body = gzipCached(html);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Encoding": "gzip",
      "Content-Length": body.length,
      "Vary": "Accept-Encoding",
    });
    res.end(body);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// Pages get the login page (200); APIs get 401 JSON. Never send
// WWW-Authenticate — the native browser dialog cannot be exited.
function denyOrShowLogin(req, res, path) {
  if (path === "/admin" || path === "/admin/") {
    writeHtml(req, res, loginPage());
    return;
  }
  respondError(res, 401, "please log in first", "authentication_error");
}

function adminTools(req, res) {
  const readJson = async () => JSON.parse((await readBody(req)).toString("utf8") || "{}");
  // Pool ops report their own status (400 bad key / 404 missing / 409
  // duplicate) via the httpStatus marker; unrecognized sources are 500 and
  // never masquerade as auth failures.
  const run = async (fn) => {
    try {
      respondJson(res, 200, await fn());
    } catch (err) {
      respondError(res, err?.httpStatus ?? 500, err?.message ?? String(err));
    }
  };
  return { readJson, run };
}

async function dispatchAdmin(req, res, path) {
  if (await handleSession(req, res, path)) return;
  if (!isAdmin(req.headers)) {
    denyOrShowLogin(req, res, path);
    return;
  }
  if (path === "/admin" || path === "/admin/") {
    writeHtml(req, res, page());
    return;
  }
  const { readJson, run } = adminTools(req, res);
  if (await servePoolRoutes(req, res, path, readJson, run)) return;
  if (await serveConfigRoutes(req, res, path, readJson, run)) return;
  if (await serveStatsRoutes(req, res, path)) return;
  if (await serveUpdateRoutes(req, res, path, run)) return;
  if (await serveLogRoutes(req, res, path)) return;
  if (await serveAccountRoutes(req, res, path, readJson, run)) return;
  respondError(res, 404, `unknown admin endpoint ${req.method} ${path}`);
}

// Pool: status, models, reload, accounts (single + batch + export).
async function servePoolRoutes(req, res, path, readJson, run) {
  if (path === "/admin/status" && req.method === "GET") {
    respondJson(res, 200, await snapshot());
    return true;
  }
  if (path === "/admin/models" && req.method === "GET") {
    // Catalog fetches borrow a pool key; a dead pool is upstream trouble
    // (502), not a bad request.
    await run(async () => {
      try {
        return { models: await listAdminModels() };
      } catch (err) {
        throw Object.assign(new Error(describeCatalogError(err)), { httpStatus: 502 });
      }
    });
    return true;
  }
  if (path === "/admin/reload" && req.method === "POST") {
    await run(() => pool.loadAccounts());
    return true;
  }
  if (path === "/admin/accounts/batch" && req.method === "POST") {
    await run(async () => {
      const b = await readJson();
      // {ids, op} bulk ops; {items} legacy bulk import.
      if (Array.isArray(b.ids) && typeof b.op === "string") return pool.batchOps(b.ids, b.op);
      return pool.addAccounts(b.items);
    });
    return true;
  }
  if (path === "/admin/accounts/export" && req.method === "GET") {
    const date = new Date().toISOString().slice(0, 10);
    const payload = pool.exportAccounts();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="cursorapi-accounts-${date}.json"`,
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(payload, null, 2));
    return true;
  }
  if (path === "/admin/accounts" && req.method === "POST") {
    await run(async () => pool.addAccount(await readJson()));
    return true;
  }
  return false;
}

// Config: view + partial hot update (restart-only fields land in restartFields).
async function serveConfigRoutes(req, res, path, readJson, run) {
  if (path === "/admin/config" && req.method === "GET") {
    respondJson(res, 200, getConfigView());
    return true;
  }
  if (path === "/admin/config" && req.method === "PUT") {
    await run(async () => setConfigHot(await readJson()));
    return true;
  }
  return false;
}

async function serveStatsRoutes(req, res, path) {
  if (path === "/admin/stats" && req.method === "GET") {
    respondJson(res, 200, pool.getStats());
    return true;
  }
  if (path === "/admin/requests" && req.method === "GET") {
    const raw = new URL(req.url, "http://localhost").searchParams.get("limit");
    const n = Number.parseInt(raw ?? "", 10);
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 50;
    respondJson(res, 200, { items: pool.listRecentRequests(limit) });
    return true;
  }
  return false;
}

// Update checks hit GitHub (mirror chain); 60s of staleness is a fine
// trade for not hammering upstream when several admin tabs check at once.
const UPDATE_CHECK_TTL_MS = 60_000;
const checkUpdateCached = ttlCache(() => update.checkUpdate(), UPDATE_CHECK_TTL_MS);

// OTA: check / status / perform / restart (perform is gated by CURSOR_OTA_ENABLED).
async function serveUpdateRoutes(req, res, path, run) {
  if (path === "/admin/update/check" && req.method === "GET") {
    await run(() => checkUpdateCached());
    return true;
  }
  if (path === "/admin/update/status" && req.method === "GET") {
    respondJson(res, 200, { mode: update.detectMode(), ...guard.readStatus() });
    return true;
  }
  if (path === "/admin/update/perform" && req.method === "POST") {
    if (!update.otaEnabled()) {
      respondError(res, 403, "OTA disabled: set CURSOR_OTA_ENABLED=true to allow updates");
      return true;
    }
    // Reply first (the frontend must show "restarting soon"), then restart.
    const r = await update.performUpdate();
    respondJson(res, 200, r);
    if (r.restart) setTimeout(() => void update.restartNow(), 500);
    return true;
  }
  if (path === "/admin/restart" && req.method === "POST") {
    // Honest check first: without a supervisor a restart is impossible —
    // reply 409 instead of claiming "restarting" and doing nothing
    // (reviewer m7). With a supervisor: reply, then exit(75) for it to
    // pull the process back up.
    if (!update.canRestart()) {
      respondJson(res, 409, { ok: false, message: "无 supervisor，无法自动重启；请用 systemd/PM2/Docker 托管后重试" });
      return true;
    }
    respondJson(res, 200, { ok: true, message: "重启已触发" });
    setTimeout(() => void update.restartNow(), 500);
    return true;
  }
  return false;
}

// Logs: SSE stream (50 replayed + heartbeat) and file export. Auth rides the
// existing /admin session cookie on the same origin.
async function serveLogRoutes(req, res, path) {
  if (path === "/admin/logs" && req.method === "GET") {
    streamLogs(req, res);
    return true;
  }
  if (path === "/admin/logs/export" && req.method === "GET") {
    exportLogs(req, res);
    return true;
  }
  return false;
}

const SSE_BUFFER_CAP = 256 * 1024; // per-subscriber write queue; past this, drop frames

function streamLogs(req, res) {
  req.socket.setKeepAlive?.(true);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  for (const e of recentLogs(50)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  // A slow subscriber must not pin unbounded memory in the socket queue:
  // past the cap, drop frames for this subscriber (counted, warned once)
  // instead of growing the buffer. The cap check runs BEFORE the frame is
  // built — an over-cap storm must not pay for serializing strings it will
  // throw away (pressure2: 200 subscribers x 3000 frames was ~720MB of
  // wasted JSON.stringify at the old 1MB cap).
  let dropped = 0;
  const writeFrame = (makeFrame) => {
    if (res.writableEnded) return;
    if (res.writableLength > SSE_BUFFER_CAP) {
      dropped += 1;
      if (dropped === 1) log.warn("log SSE subscriber is too slow; dropping frames to bound memory");
      return;
    }
    res.write(makeFrame());
  };
  const hb = setInterval(() => writeFrame(() => ": heartbeat\n\n"), 15_000);
  const unsub = subscribeLogs((e) => writeFrame(() => `data: ${JSON.stringify(e)}\n\n`));
  req.on("close", () => {
    clearInterval(hb);
    unsub();
  });
}

function exportLogs(req, res) {
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const level = (q.get("level") ?? "").trim();
  const fmt = q.get("format") === "txt" ? "txt" : "jsonl";
  const want = LOG_LEVELS[level];
  const entries = recentLogs(1000).filter((e) => (want === undefined ? true : LOG_LEVELS[e.level] <= want));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `cursorapi-logs-${stamp}.${fmt}`;
  const body =
    fmt === "txt"
      ? entries.map((e) => `${e.ts} [${e.level.toUpperCase()}] ${e.msg}${e.extra ? " " + e.extra : ""}`).join("\n") + "\n"
      : entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  res.writeHead(200, {
    "Content-Type": fmt === "txt" ? "text/plain; charset=utf-8" : "application/x-ndjson; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// Per-account ops: PATCH/DELETE (rename / priority / remove), /disabled, /probe.
async function serveAccountRoutes(req, res, path, readJson, run) {
  const match = ACCOUNT_ID.exec(path);
  if (!match) return false;
  const id = match[1];
  const sub = match[2] ?? "";
  if (!sub && req.method === "PATCH") {
    await run(async () => pool.updateAccount(id, await readJson()));
    return true;
  }
  if (!sub && req.method === "DELETE") {
    await run(async () => pool.removeAccount(id));
    return true;
  }
  if (sub === "/disabled" && req.method === "POST") {
    await run(async () => {
      if (!pool.setDisabled(id, (await readJson()).disabled === true)) {
        throw Object.assign(new Error("no such account"), { httpStatus: 404 });
      }
      return { ok: true };
    });
    return true;
  }
  if (sub === "/probe" && req.method === "POST") {
    await run(async () => pool.probeOne(id));
    return true;
  }
  if (sub === "/secret" && req.method === "GET") {
    // Admin-only reveal: the panel copies the full key on click. The
    // export endpoint stays masked by design — this is the single,
    // auditable, per-account reveal path.
    await run(async () => {
      const a = pool.get(id);
      if (!a) throw Object.assign(new Error("no such account"), { httpStatus: 404 });
      return { key: a.key };
    });
    return true;
  }
  return false;
}

// ── Data-plane rate limiting (per-IP fixed window) ──

const RATE_WINDOW_MS = 60_000;
const RATE_IP_CAP = 10_000;

/** IPv4-mapped IPv6 ("::ffff:1.2.3.4") is the dual-stack socket form; the
 * same client must not split into two buckets depending on how it arrived. */
function normalizeIp(ip) {
  const m4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(String(ip));
  return m4 ? m4[1] : String(ip);
}

/**
 * Public-address check for X-Forwarded-For. Only clearly-public addresses
 * are trusted as a client identity; private/loopback/link-local ranges are
 * trivially forgeable by any client behind the same proxy, so they fall
 * back to the socket address.
 */
export function isPublicIp(ip) {
  const v = normalizeIp(ip);
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (parts) {
    const a = +parts[1];
    const b = +parts[2];
    const c = +parts[3];
    const d = +parts[4];
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false;           // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;  // 172.16/12
    if (a === 192 && b === 168) return false;           // 192.168/16
    if (a >= 224) return false;                         // multicast + reserved
    return true;
  }
  if (v.includes(":")) {
    const low = v.toLowerCase();
    if (low === "::" || low === "::1") return false;
    if (/^f[cd]/.test(low) || /^fe[89ab]/.test(low)) return false; // ULA / link-local
    return true;
  }
  return false;
}

/**
 * The identity a request is rate-limited under. X-Forwarded-For is only
 * believed when the socket peer is a configured trusted proxy
 * (CURSOR_TRUSTED_PROXY): an untrusted client can forge any public IP in
 * XFF and earn a fresh bucket per request, so without a trusted proxy the
 * socket address is the identity. Through a trusted proxy, only the
 * rightmost segment is believed, and only when it is a public address — a
 * forged private/loopback segment falls back to the socket address.
 */
export function clientIp(req) {
  const sock = normalizeIp(req.socket?.remoteAddress ?? "");
  const trusted = config.trustedProxy;
  if (!trusted || !trusted.includes(sock)) return sock;
  const hops = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fwd = hops[hops.length - 1];
  if (fwd && isPublicIp(fwd)) return normalizeIp(fwd);
  return sock;
}

/**
 * Per-IP fixed-window counter. `check` returns null when the request is
 * allowed and the ms until the window resets when it is over. The bucket
 * map is capped: past `cap` tracked IPs, expired windows are swept and the
 * oldest survivors evicted, so a spoofing flood cannot grow memory forever.
 * The window is injectable so tests can run the 60s cycle in milliseconds.
 */
export function createRateLimiter({ windowMs = RATE_WINDOW_MS, cap = RATE_IP_CAP } = {}) {
  const buckets = new Map(); // ip -> { count, resetAt }
  return {
    check(req, now = Date.now()) {
      const limit = config.rateLimitPerMin;
      if (!(limit > 0)) return null;
      const ip = clientIp(req);
      let b = buckets.get(ip);
      if (!b || now >= b.resetAt) {
        b = { count: 0, resetAt: now + windowMs };
        buckets.set(ip, b);
      }
      b.count += 1;
      if (buckets.size > cap) {
        for (const [k, x] of buckets) {
          if (now >= x.resetAt) buckets.delete(k);
          if (buckets.size <= cap) break;
        }
        if (buckets.size > cap) {
          for (const k of buckets.keys()) {
            buckets.delete(k);
            if (buckets.size <= cap) break;
          }
        }
      }
      return b.count > limit ? b.resetAt - now : null;
    },
    size() {
      return buckets.size;
    },
  };
}

const rateLimiter = createRateLimiter();

// ── Data domain ──

async function serveModels(req, res) {
  try {
    // x-api-key clients get the Anthropic shape; Bearer clients get the
    // OpenAI shape. One catalog, two views.
    const isAnthropic = req.headers["x-api-key"] !== undefined;
    respondJson(res, 200, isAnthropic ? { data: await listModelsAnthropic() } : { object: "list", data: await listModels() });
  } catch (err) {
    // Brief for clients: the full upstream error text goes to the logs.
    respondError(res, 502, describeCatalogError(err, true));
  }
}

async function serveProtocol(req, res, isChat) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (err) {
    if (err?.httpStatus) {
      // readBody timeouts carry httpStatus 408; pass them through verbatim.
      respondError(res, err.httpStatus, err.message, err.code ?? "api_error");
      return;
    }
    respondError(res, 400, `failed to parse request body: ${err.message}`, "invalid_request_error");
    return;
  }
  await (isChat ? handleChat(body, res) : handleMessages(body, res));
}

async function dispatchData(req, res, path) {
  if (!isClient(req.headers)) {
    respondError(res, 401, "missing or invalid API Key", "authentication_error");
    return;
  }
  // Per-IP window on the data plane (the admin plane keeps its own
  // login-delay penalty). After auth, before processing: a keyless flood
  // never counts, and a 10k rps client is stopped before the pool sees it.
  const retryAfterMs = rateLimiter.check(req);
  if (retryAfterMs != null) {
    res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    respondError(res, 429, "rate limit exceeded for this IP", "rate_limit_error");
    return;
  }
  if (path === "/v1/models" && req.method === "GET") {
    await serveModels(req, res);
    return;
  }
  // The two protocol entries; /v1/messages serves Anthropic-only upstreams
  // (e.g. k2cc relays) and lets native clients like Claude Code connect.
  if ((path === "/v1/chat/completions" || path === "/v1/messages") && req.method === "POST") {
    await serveProtocol(req, res, path === "/v1/chat/completions");
    return;
  }
  respondError(res, 404, `unknown path ${path}`, "invalid_request_error");
}

// ── Server ──

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const path = routePath(req);
  try {
    if (path === "/ping") {
      respondText(res, 200, "ok\n");
      return;
    }
    if (path === "/admin" || path.startsWith("/admin/")) {
      await dispatchAdmin(req, res, path);
      return;
    }
    await dispatchData(req, res, path);
  } catch (err) {
    log.error(`${req.method} ${path} failed: ${err?.stack ?? err}`);
    // Errors carrying their own httpStatus (OTA lock conflicts 409, mirror
    // failures 502, ...) pass through verbatim — a client must be able to
    // tell "conflict / rejected" from "server fault" (pressure-ota A-1).
    if (!res.headersSent) respondError(res, err?.httpStatus ?? 500, String(err?.message ?? err));
    else res.end();
  } finally {
    // Streaming responses keep writing past this point; only finished ones are timed.
    if (res.writableEnded) {
      log.debug(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

// Long-lived streaming responses must not hit Node's defaults.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 75_000;

// Hot config (runtime-config.json) lands before listen so the port and probe
// interval reflect final values.
getConfig();
for (const p of assertConfig()) log.warn(p);

try {
  pool.loadAccounts();
} catch (err) {
  log.error(`accounts pool failed to load: ${err.message}`);
}

pool.startProber(config.probeIntervalMs);

// OTA restart: flush accounting, then drain in-flight requests before exit.
update.setRestartHandler(async () => {
  pool.flush();
  await new Promise((resolve) => {
    server.close(() => resolve());
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 10_000);
    timer.unref?.();
  });
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log.info(`received ${sig}, persisting usage stats and exiting`);
    // Active SSE streams get an error frame + [DONE] instead of a hard cut
    // (windsurf sse-registry; clients can surface "server shut down").
    shutdownActiveStreams("server shutting down");
    pool.flush();
    process.exit(0);
  });
}

server.on("error", (err) => {
  // Listen failed (port taken etc.): exit loudly. The boot counter stays —
  // this is a startup crash and the guard must count it.
  log.error(`HTTP server failed to start: ${err.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  guard.clearBootAttempts();
  log.info(`CursorAPI is up at http://${config.host}:${config.port}`);
  log.info(`  pool: ${pool.availableCount()}/${pool.all().length} available · ${config.accountsPath}`);
  log.info(`  auth: ${authMode()}`);
  log.info(`  status page: http://${config.host}:${config.port}/admin`);
  // Pre-warm the catalog: surfaces a dead pool at startup, not on first use.
  getCatalog().catch((err) => log.warn(describeCatalogError(err)));
  // 30s stable -> health marker + rollback point cleanup (OTA confirmation).
  setTimeout(() => guard.confirmHealth(), 30_000).unref?.();
});
