// Pressure-test in-process monitor, injected via `node --import`.
//
// Two jobs:
// 1. Sample RSS / heap / handles / timers / fds / byToolCall table size every
//    5s into pressure/metrics.csv (the byToolCall size comes from the real
//    module singleton via dynamic import — no src/ changes needed).
// 2. Execute log-ingestion commands written by the driver to
//    pressure/ctl-log.json ({seq, count, sizeKB}) by calling the real
//    logger.mjs `log` object directly — the ring buffer's 1000-slot cap and
//    8KB truncation are exercised with real entries.

import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";

const dir = process.env.CSPK_PRESSURE_DIR ?? path.join(process.cwd(), "pressure");
const metricsFile = path.join(dir, "metrics.csv");
const logCtlFile = path.join(dir, "ctl-log.json");
const doneFile = (seq) => path.join(dir, `ctl-log.done.${seq}`);
const startedAt = Date.now();
let lastSeq = -1;

fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(metricsFile)) {
  fs.writeFileSync(metricsFile, "ts,sec,rssMb,heapUsedMb,heapTotalMb,externalMb,fdCount,byToolCall,handles,resources\n");
}
fs.writeFileSync(path.join(dir, "monitor.ready"), JSON.stringify({ ts: startedAt, pid: process.pid }));

function countBy(arr) {
  const out = {};
  for (const x of arr) out[x] = (out[x] ?? 0) + 1;
  return out;
}

async function tick() {
  const mem = process.memoryUsage();
  const hs = v8.getHeapStatistics();

  let byToolCall = -1;
  try {
    byToolCall = (await import("../src/tool-relay.mjs")).pendingToolCalls();
  } catch (err) {
    byToolCall = -2;
  }

  let handles = {};
  try {
    for (const h of process._getActiveHandles()) {
      const n = h.constructor?.name ?? "?";
      handles[n] = (handles[n] ?? 0) + 1;
    }
  } catch {}

  let resources = {};
  try {
    resources = countBy(process.getActiveResourcesInfo());
  } catch {}

  let fdCount = -1;
  try {
    fdCount = fs.readdirSync("/dev/fd").length;
  } catch {}

  // Log-ingestion command handling (sync loop; sampling pauses while it runs).
  try {
    const ctl = JSON.parse(fs.readFileSync(logCtlFile, "utf8"));
    if (typeof ctl?.seq === "number" && ctl.seq > lastSeq) {
      lastSeq = ctl.seq;
      const { log } = await import("../src/logger.mjs");
      const msg = ctl.sizeKB ? "P".repeat(ctl.sizeKB * 1024) : "pressure-log-entry";
      const t0 = Date.now();
      const count = ctl.count ?? 1;
      for (let i = 0; i < count; i++) log.info(msg);
      fs.writeFileSync(
        doneFile(ctl.seq),
        JSON.stringify({ seq: ctl.seq, count, ms: Date.now() - t0, rssAfterMb: Math.round(process.memoryUsage().rss / 1048576) }),
      );
    }
  } catch {
    // control file absent or mid-write; skip this round
  }

  fs.appendFileSync(
    metricsFile,
    [
      Date.now(),
      Math.round((Date.now() - startedAt) / 1000),
      Math.round(mem.rss / 1048576),
      Math.round(mem.heapUsed / 1048576),
      Math.round(mem.heapTotal / 1048576),
      Math.round(mem.external / 1048576),
      fdCount,
      byToolCall,
    ].join(",") + "," + JSON.stringify(handles) + "|" + JSON.stringify(resources) + "\n",
  );
}

void tick();
setInterval(tick, 5000);
