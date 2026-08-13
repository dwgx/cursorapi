// Minimal HTTP response/request helpers. No business logic.
// Errors use the OpenAI error envelope, which client SDKs parse.

// Total budget for reading a request body: a slow-loris client trickling
// bytes must not hold a connection forever (server.requestTimeout is 0 —
// the data plane streams). Env-tunable so tests can exercise the deadline.
const READ_BODY_TIMEOUT_MS = Number.parseInt(process.env.CURSOR_READ_BODY_TIMEOUT_MS ?? "", 10) || 60_000;

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

export function respondJson(res, status, obj) {
  const body = JSON.stringify(obj);
  send(
    res,
    status,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  );
}

/** OpenAI-style error body; client SDKs mostly parse this shape. */
export function respondError(res, status, message, type = "api_error") {
  respondJson(res, status, { error: { message: `[cursorapi] ${message}`, type, code: status } });
}

export function respondText(res, status, text) {
  send(res, status, { "Content-Type": "text/plain; charset=utf-8" }, text);
}

/**
 * Read the whole request body, capped so an oversized body cannot blow up
 * memory. A body that does not finish within READ_BODY_TIMEOUT_MS is cut
 * off: the deadline rejects with a 408 error (httpStatus marker) while the
 * socket is still alive so the caller can answer, then the connection is
 * destroyed a beat later — a fully stalled client never delivers another
 * chunk, so the pending read only unblocks on that teardown.
 */
export function readBody(req, limitBytes = 64 * 1024 * 1024) {
  let timedOut = false;
  let killTimer = null;
  const read = (async () => {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        if (timedOut) throw readTimeoutError();
        size += chunk.length;
        if (size > limitBytes) {
          req.destroy();
          throw new Error(`request body exceeds ${Math.round(limitBytes / 1024 / 1024)}MB`);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      // Completed (or over-size aborted): the pending kill is moot.
      clearTimeout(killTimer);
    }
  })();
  const deadline = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      // The caller must be able to flush its 408 first; the abandoned read
      // is only unblocked by the socket teardown a beat later.
      killTimer = setTimeout(() => req.destroy(), 500);
      reject(readTimeoutError());
    }, READ_BODY_TIMEOUT_MS);
    read.then(() => clearTimeout(timer), () => clearTimeout(timer));
  });
  return Promise.race([read, deadline]);
}

function readTimeoutError() {
  return Object.assign(new Error("request body read timed out"), { httpStatus: 408, code: "request_timeout" });
}

/**
 * Memoize an async fn for ttlMs; concurrent callers share one in-flight
 * promise, so N simultaneous requests cause one upstream hit. Failures are
 * never cached — the next call retries the upstream.
 */
export function ttlCache(fn, ttlMs) {
  let cached = null; // { at, value }
  let inFlight = null;
  return () => {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (!inFlight) {
      inFlight = fn()
        .then((value) => {
          cached = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}
