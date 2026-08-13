// Preload for the stress harness (`node --import ./stress-hooks.mjs src/app.mjs`).
// Three jobs, all without touching src/:
//
// 1. Rewrite "@cursor/sdk" to the in-memory fake (stress-sdk-mock.mjs) so the
//    data plane runs against a mock, exactly like test-relay-hook.mjs.
// 2. Replace global fetch with a counting stub that answers GitHub tags
//    (needed to count upstream hits for the /admin/update/check ttlCache
//    scenario). Only "/tags" URLs are stubbed; everything else falls through
//    to the real fetch (safety, should anything else use it).
// 3. Run a metrics/control sidecar on 8103: /metrics (RSS, handles, sockets,
//    fds), /counters (SDK + fetch counters), PUT /mock (retune the fake).

import { registerHooks } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { state } from "./stress-sdk-mock.mjs";

const SIDECAR_PORT = 8103;

const sdkUrl = import.meta.resolve("@cursor/sdk");
const fakeUrl = pathToFileURL(path.join(import.meta.dirname, "stress-sdk-mock.mjs")).href;

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(sdkUrl)) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `import { Agent, Cursor, configureCursorSdk } from ${JSON.stringify(fakeUrl)}; export { Agent, Cursor, configureCursorSdk };`,
    };
  },
});

// ── fetch counter / GitHub tags stub ──

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  state.fetchCalls += 1;
  const u = String(url);
  state.fetchUrls[u] = (state.fetchUrls[u] ?? 0) + 1;
  if (u.includes("/tags")) {
    return new Response(
      JSON.stringify([
        { name: "v0.1.3", commit: { sha: "aaa" }, zipball_url: "z", tarball_url: "t" },
        { name: "v0.1.2", commit: { sha: "bbb" }, zipball_url: "z", tarball_url: "t" },
        { name: "v0.1.1", commit: { sha: "ccc" }, zipball_url: "z", tarball_url: "t" },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return realFetch(url, init);
};

// ── metrics sidecar ──

function handleSnapshot() {
  const hs = process._getActiveHandles?.() ?? [];
  const sockets = hs.filter((h) => typeof h?.remotePort === "number");
  const servers = hs.filter((h) => typeof h?.localPort === "number" && typeof h?.remotePort !== "number");
  const timers = hs.filter((h) => h?.constructor?.name === "Timeout");
  let fds = null;
  try {
    fds = fs.readdirSync("/dev/fd").length;
  } catch {
    // /dev/fd unavailable; callers fall back to lsof
  }
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers ?? null,
    handles: { total: hs.length, sockets: sockets.length, servers: servers.length, timers: timers.length },
    activeRequests: process._getActiveRequests?.().length ?? null,
    fds,
    fetchCalls: state.fetchCalls,
  };
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/metrics") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handleSnapshot()));
      return;
    }
    if (url.pathname === "/counters") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          runs: state.runs,
          events: state.events,
          meCalls: state.meCalls,
          modelsCalls: state.modelsCalls,
          activeRuns: state.activeRuns,
          activeAgents: state.activeAgents,
          fetchCalls: state.fetchCalls,
          fetchUrls: state.fetchUrls,
          config: state.config,
        }),
      );
      return;
    }
    if (url.pathname === "/mock" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.config));
      return;
    }
    if (url.pathname === "/mock" && req.method === "PUT") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          Object.assign(state.config, JSON.parse(body || "{}"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(state.config));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  })
  .listen(SIDECAR_PORT, "127.0.0.1");
