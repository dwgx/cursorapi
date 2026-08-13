// Turn orchestration: pick an account, launch the run with failover, wait for
// the sink, then bill. Protocol-agnostic — adapters own the wire formats.
//
// Invariants: failover stops once output has started; usage is recorded only
// when a turn truly ends (tool round-trips are not turns); a pool reservation
// is released exactly once per run.

import { Agent } from "@cursor/sdk";
import { config } from "./settings.mjs";
import { errShape, log } from "./logger.mjs";
import { resolveModel } from "./catalog.mjs";
import * as pool from "./keys.mjs";
import { RelayTurn, buildCustomTools } from "./tool-relay.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Background-poll sleep: the watcher that uses it must never keep the
// process alive by itself — it is a sidekick, not a reason to stay up.
const nap = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

const isThrottled = (e) => {
  const s = errShape(e);
  return s.status === 429 || s.name === "RateLimitError";
};

const idleMins = () => Math.round(config.turnIdleTimeoutMs / 60000);

// Fallback ceiling for consume's stream loop. An upstream that dies without
// ending its stream also swallows cancel() (same dead transport), so the
// loop hangs and the account's in-flight reservation leaks for the rest of
// the process's life. Twice the idle budget plus the per-call tool budget
// (30 min at defaults) sits far above any legal turn — a normal turn ends
// consume itself long before, so this is never the main path. Summed (not
// maxed) so raising either budget scales the ceiling with it.
const consumeDeadlineMs = () => 2 * config.turnIdleTimeoutMs + config.toolResultTimeoutMs;

// SDK usage -> the four aggregate fields (missing fields count as 0).
function usageFields(u) {
  return {
    input: u?.inputTokens ?? 0,
    output: u?.outputTokens ?? 0,
    cacheRead: u?.cacheReadTokens ?? 0,
    cacheWrite: u?.cacheWriteTokens ?? 0,
  };
}

// ── launch: account selection with failover ──

// Cap on one create+send. A hung upstream (create ~6s cold start, send can
// hang on a dead connection) must not pin the account's in-flight slot
// forever: after this, the attempt is treated like any other launch failure.
const launchTimeoutMs = () => Math.min(60_000, 2 * config.turnIdleTimeoutMs);

// Race `p` against a deadline. The timeout error is a TimeoutError so the
// pool classifies it as transient — failover, never a hard return.
function withTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Best-effort run cancellation. The SDK refuses cancels on already-terminal
// runs, and network failures happen; neither may disturb the caller's flow —
// the quota burn is already over, only the log matters.
async function cancelRun(run) {
  if (!run || typeof run.cancel !== "function") return;
  try {
    if (typeof run.supports === "function" && !run.supports("cancel")) return;
    await run.cancel();
    log.info(`run ${run.id} cancelled`);
  } catch (err) {
    log.warn(`run ${run.id} cancel failed: ${errShape(err).message}`);
  }
}

// Try accounts until one accepts the run. Failures before the stream starts
// are invisible to the client, so switching is still safe; once the run is
// out, switching would glue two brains into one answer.
//
// Backoff: 429 with Retry-After sleeps per RA (capped at 60s), 429 without
// doubles 1s->8s, anything else waits a fixed 300ms.
async function launch({ model, prompt, tools, callIdPrefix }) {
  const tried = [];
  let lastErr = null;
  let backoffMs = 0;

  for (let i = 0; i < config.maxAccountAttempts; i++) {
    const account = pool.select(tried);
    if (!account) break;
    tried.push(account.id);

    const turn = new RelayTurn();
    turn.account = account;
    if (callIdPrefix) turn.callIdPrefix = callIdPrefix;

    let attempt = null;
    try {
      // Relay only when tools actually registered — buildCustomTools may
      // block the whole set, and tools:["mcp"] with nothing behind it would
      // leave the agent unarmed.
      const customTools = tools?.length ? buildCustomTools(tools, turn) : null;
      const relay = Boolean(customTools && Object.keys(customTools).length);

      attempt = (async () => {
        const agent = await Agent.create({
          apiKey: account.key,
          model,
          local: { cwd: config.workspace, settingSources: [] },
          // "mcp" is the tool-family whitelist the relayed tools hang under,
          // not an MCP server config.
          ...(relay ? { tools: ["mcp"] } : {}),
        });

        const run = relay
          ? await agent.send(prompt, { local: { customTools } })
          : await agent.send(prompt);
        return { agent, run };
      })();

      const session = await withTimeout(attempt, launchTimeoutMs(), "agent launch");

      log.info(
        `[${relay ? "relay" : "self"}] ${model.id} | account ${account.name || account.id}`
        + `${i ? ` | attempt ${i + 1}` : ""} | prompt ${prompt.length} chars`
        + `${relay ? ` | client tools ${Object.keys(customTools).length}` : ""}`,
      );
      return { account, agent: session.agent, run: session.run, turn };
    } catch (err) {
      lastErr = err;
      // If the attempt lands after the timeout gave up on it, its run would
      // burn quota with nobody consuming it — best-effort cancel.
      if (attempt) void attempt.then(({ run }) => cancelRun(run)).catch(() => {});
      // The run never started, so this reservation ends here.
      pool.release(account);
      const verdict = pool.reportFailure(account, err);
      if (verdict === pool.Verdict.RETURN) throw err; // unfixable; surface it
      const info = pool.classifyError(err);
      if (isThrottled(err)) {
        if (info.retryAfterSecs != null) await sleep(Math.min(info.retryAfterSecs, 60) * 1000);
        else {
          backoffMs = backoffMs ? Math.min(backoffMs * 2, 8000) : 1000;
          await sleep(backoffMs);
        }
      } else {
        await sleep(300);
      }
    }
  }

  const throttled = isThrottled(lastErr);
  // Client-facing message stays generic: no pool size ("tried N accounts")
  // and no upstream error text (may carry request ids / internal details).
  // The per-account detail is already in the logs (reportFailure logs the
  // full errShape for every failed attempt).
  const e = new Error(
    tried.length
      ? "all accounts failed; the pool is temporarily unavailable (details in the server logs)"
      : "no usable Cursor account in the pool",
  );
  // The pool absorbed every 429 and still lost. Say so with the retryable
  // semantics Claude Code understands: 429 + rate_limit_error + a pool-local
  // Retry-After. The upstream's own 429/RA never rides along — clients treat
  // a foreign RA as session-killing.
  if (throttled && tried.length) {
    e.statusCode = 429;
    e.retryAfterSecs = pool.poolExhaustedRetryAfter() ?? 10;
  } else {
    e.statusCode = tried.length ? 502 : 503;
  }
  e.cause = lastErr;
  // Forward Retry-After only from 5xx with an upstream RA; the 429 case set
  // its own pool-local RA above.
  if (lastErr) {
    const info = pool.classifyError(lastErr);
    if (info.retryAfterSecs != null && !isThrottled(lastErr)) {
      e.retryAfterSecs = info.retryAfterSecs;
    }
  }
  // Pool exhausted (nothing was even tried): the earliest thawing cooldown,
  // so clients stop hammering the 503.
  if (!tried.length) {
    const ra = pool.poolExhaustedRetryAfter();
    if (ra != null) e.retryAfterSecs = ra;
  }
  throw e;
}

// ── wait ──

// Wait until the sink closes (turn finished / client gone) or the idle
// budget runs out, whichever comes first. Event-driven: the closed promise
// races a deadline timer that re-arms on every activity touch — no polling,
// so non-streaming requests reply the instant the run finishes instead of
// waiting out a fixed 200ms slice (bench: 207ms -> ~5ms p50).
async function waitTurn(closed, turn) {
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (turn.onActivity === arm) turn.onActivity = null;
      resolve(v);
    };
    const arm = () => {
      if (settled) return;
      clearTimeout(timer);
      const remain = config.turnIdleTimeoutMs - (Date.now() - turn.lastActivityAt);
      // NO unref: an unref'd timer does not fire in a process whose only
      // work is a pending top-level await (tests), hanging waitTurn forever.
      timer = setTimeout(() => {
        if (settled) return;
        // The run may have finished during the final wait()/seal phase
        // (no activity touches happen there): a completed turn is a
        // success, not an idle failure — otherwise normal wraps get
        // mis-billed and cancelled (reviewer M1).
        if (turn.finished) {
          finish(true);
          return;
        }
        finish(false);
      }, Math.max(1, remain));
    };
    turn.onActivity = arm;
    void closed.then(() => finish(true));
    arm();
  });
}

// ── abandonment watch ──

// The abandonment window: how long to wait for the client to return tool
// results while nothing is attached before the run is cancelled. Defaults
// to the turn idle budget clamped to 30-60s — long enough for slow
// client-side tool execution (a 30s Bash fits), short enough to catch
// abandonment well before the per-call toolResultTimeoutMs. An env
// override shortens it verbatim (labs, tests, aggressive deployments).
function abandonWindowMs() {
  const raw = process.env.CURSOR_TOOL_ABANDON_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.min(60_000, Math.max(30_000, Math.round(config.turnIdleTimeoutMs / 2)));
}

// After tool calls go out, the sink closes until the client's next request
// attaches; while it is closed, no request handler is polling the turn. A
// client that never comes back (disconnect, or took the calls and walked
// away) leaves the run suspended on unresolved tool calls — burning quota
// and pinning the account for the whole toolResultTimeoutMs (10 min). This
// watch cancels the run after a much shorter window.
//
// Two signals, both measured while nothing is attached (sink closed):
// - pending calls exist and activity stopped for the window (abandoned);
// - all pending calls were rejected by their own timers, so the run has no
//   results left to wait for.
//
// Activity, not wall time, is the clock — a client that keeps attaching
// resets it.
async function watchAbandoned(turn, account) {
  const limit = abandonWindowMs();
  let wasWaiting = false;
  for (;;) {
    if (turn.finished) return;
    if (turn.waiting) {
      wasWaiting = true;
      if (!turn.sink && Date.now() - turn.lastActivityAt >= limit) {
        log.warn(`client never returned tool results within ${Math.round(limit / 1000)}s; cancelling the run`);
        abandon(turn, account, "client abandoned the turn");
        return;
      }
    } else if (wasWaiting && !turn.sink) {
      log.warn("all tool results timed out with no client attached; cancelling the run");
      abandon(turn, account, "tool result timeout");
      return;
    } else {
      wasWaiting = false;
    }
    await nap(1000);
  }
}

// Abandonment ends the turn as a failure: report it, then cancel the run so
// consume's finally releases the account.
function abandon(turn, account, reason) {
  pool.reportFailure(account, new Error(reason));
  void cancelRun(turn.run);
}

// ── finalize: accounting ──

// Bill one completed turn. Tool boundaries return from waitTurn but are not
// turns — only a real end (handle or resumeTurn) lands here.
function settle(turn, model, startAt, acct) {
  if (!turn.finished || !acct) return;
  const clean = !turn.error;
  if (!clean) pool.reportFailure(acct, new Error(turn.error));
  else pool.reportSuccess(acct, turn.usage);
  const ms = Date.now() - startAt;
  pool.recordRequest(model, clean, ms, acct.id, usageFields(turn.usage));
  pool.pushRecentRequest({
    ts: new Date().toISOString(),
    model,
    accountId: acct.id,
    success: clean,
    ms,
    tokens: usageFields(turn.usage),
    ...(turn.error ? { error: turn.error } : {}),
  });
}

// ── entry ──

// Run one full request. The adapter supplies parse / makeSink / feed /
// finishNonStream plus the tool-call id prefix.
export async function handle(adapter, body, res, { respondError }) {
  let req;
  try {
    req = adapter.parse(body);
  } catch (err) {
    respondError(res, err.statusCode ?? 400, err.message);
    return;
  }
  if (req.error) {
    respondError(res, req.status ?? 400, req.error);
    return;
  }

  const flow = { stream: req.stream, id: req.id, model: req.publicModel };

  // Tool-result follow-up: resume the original turn, no selection, no new run.
  // Must run first — treated as fresh, it would spawn a wasted run while the
  // original one hangs on its result.
  if (req.resume) {
    await resumeTurn(adapter, req, res, flow);
    return;
  }

  let model;
  try {
    model = await resolveModel(req.publicModel);
  } catch (err) {
    respondError(res, err.statusCode ?? 502, err.message);
    return;
  }

  const startAt = Date.now();
  let session;
  try {
    session = await launch({
      model,
      prompt: req.prompt,
      tools: req.tools,
      callIdPrefix: adapter.callIdPrefix,
    });
  } catch (err) {
    const s = errShape(err);
    // No account to attribute — count the failed request as pool-less.
    pool.recordRequest(flow.model, false, Date.now() - startAt, null);
    // Header must land before respondError's writeHead merges it in.
    if (err.retryAfterSecs != null) res.setHeader("Retry-After", String(err.retryAfterSecs));
    respondError(res, err.statusCode ?? s.status ?? 502, s.message);
    return;
  }

  const { account, run, turn } = session;
  // resumeTurn (the next request of a tool round-trip) needs the run to
  // cancel on its own idle timeout — the launch object is long gone by then.
  turn.run = run;

  // The run starts before the sink exists, so pre-stream failures never leak.
  let out;
  let end;
  try {
    out = adapter.makeSink(res, flow);
    end = turn.attach(out);
  } catch (err) {
    // No consume will run, so the reservation must go back here or this
    // account's in-flight count is stuck forever.
    pool.release(account);
    throw err;
  }
  // Reservation outlives the run by however long consume takes; the finally
  // covers client-disconnect and run-error paths that never report back.
  // Guarded by a deadline: if the upstream dies without ending its stream
  // (cancel() rides the same dead transport), consume hangs and the slot
  // would leak forever. The deadline forces the finally to run — it only
  // fires when nothing else could release the reservation; a normal turn
  // settles consume first and the timer is cleared.
  const consumeStarted = Date.now();
  const consumeDone = turn.consume(run);
  const consumeDeadline = new Promise((resolve) => {
    const timer = setTimeout(() => {
      log.error(
        `run ${run.id} stream hung past ${Math.round(consumeDeadlineMs() / 60000)} min`
        + ` (account ${account.name || account.id}, model ${flow.model},`
        + ` after ${Math.round((Date.now() - consumeStarted) / 1000)}s); releasing the reservation`,
      );
      // Best-effort cancel so a hung consume loop gets a chance to unwind;
      // the reservation release below is what actually unblocks the pool.
      void cancelRun(run);
      resolve();
    }, consumeDeadlineMs());
    timer.unref?.();
    consumeDone.finally(() => clearTimeout(timer));
  });
  void Promise.race([consumeDone, consumeDeadline]).finally(() => pool.release(account));
  // Client-abandonment watch: cancels the run when tool calls go unanswered
  // while nothing is attached (see watchAbandoned).
  void watchAbandoned(turn, account);

  const completed = await waitTurn(end, turn);
  if (!completed) {
    log.warn(`no activity for ${idleMins()} minutes, giving up on this turn`);
    out.fail(`This turn had no activity for ${idleMins()} minutes; giving up.`);
    // Non-streaming idle timeout: the collecting sink never touches res —
    // without an explicit end the client hangs until its own timeout
    // (reviewer M2).
    if (!flow.stream) {
      try {
        respondError(res, 504, `upstream turn idle timeout after ${idleMins()} minutes`, "upstream_timeout");
      } catch {
        // res may already be gone; the failure was logged above
      }
    }
    pool.reportFailure(account, new Error("turn idle timeout"));
    // The run would otherwise keep going, burning quota for a turn nobody
    // is watching anymore; consume's finally releases the account when the
    // cancellation lands.
    void cancelRun(run);
    return;
  }

  settle(turn, flow.model, startAt, account);

  if (!flow.stream) adapter.finishNonStream(res, out, flow);
}

// Feed client tool results back into the running turn.
async function resumeTurn(adapter, req, res, flow) {
  const startAt = Date.now();
  const { turn, results } = req.resume;
  const out = adapter.makeSink(res, flow);
  const end = turn.attach(out);

  const fed = adapter.feed(turn, results);
  if (!fed) {
    // Matched the turn but cannot feed it — say so instead of hanging forever.
    const msg = "matched a pending tool call, but this batch carries no usable result";
    log.error(msg);
    out.fail(msg);
    return;
  }
  log.info(`received ${fed} tool result(s) from the client; run continues`);

  const completed = await waitTurn(end, turn);
  if (!completed) {
    log.warn(`no activity for ${idleMins()} minutes, giving up on this turn`);
    out.fail(`This turn had no activity for ${idleMins()} minutes; giving up.`);
    // Non-streaming round-trip: the collecting sink never touches res —
    // end it explicitly or the client hangs (reviewer M2, same as handle).
    if (!flow.stream) {
      try {
        respondError(res, 504, `upstream turn idle timeout after ${idleMins()} minutes`, "upstream_timeout");
      } catch {
        // res may already be gone; the failure was logged above
      }
    }
    // Bill the hang as a failure like handle's idle path does — an idle
    // round-trip is still a failed turn for the pool's stats.
    pool.reportFailure(turn.account, new Error("turn idle timeout"));
    // Same reasoning as handle's idle timeout: a hung round-trip must not
    // keep the run (and the account's in-flight slot) burning.
    void cancelRun(turn.run);
    return;
  }

  settle(turn, flow.model, startAt, turn.account);

  if (!flow.stream) adapter.finishNonStream(res, out, flow);
}
