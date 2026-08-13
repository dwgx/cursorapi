// Test fixture, not shipped as a test: a --import preload that floods the
// app's REAL logger emit path on a file signal, for the /admin/logs SSE
// drop-count test (the pressure2 ctl-log mechanism, minus the metrics).
// Because the app imports the same logger module instance, entries pushed
// here reach the same subscribers (the SSE writer in app.mjs).
//
// Usage: node --import ./test-fixtures/log-flood.mjs src/app.mjs
// Env:  CURSOR_LOG_FLOOD_CTL  — JSON spec file { seq, count, sizeKB }
//       CURSOR_LOG_FLOOD_DONE — marker dir; "<done>.<seq>" means "flooded"
import fs from "node:fs";

const ctlPath = process.env.CURSOR_LOG_FLOOD_CTL;
const donePath = process.env.CURSOR_LOG_FLOOD_DONE;
if (!ctlPath || !donePath) throw new Error("log-flood preload: CURSOR_LOG_FLOOD_CTL and CURSOR_LOG_FLOOD_DONE required");

const { log } = await import("../src/logger.mjs");

const timer = setInterval(() => {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(ctlPath, "utf8"));
  } catch {
    return; // control file not written yet
  }
  if (!spec?.seq) return;
  const done = `${donePath}.${spec.seq}`;
  if (fs.existsSync(done)) return; // already flooded this seq
  const pad = "x".repeat((spec.sizeKB ?? 1) * 1024);
  const count = spec.count ?? 1000;
  for (let i = 0; i < count; i++) {
    log.warn(`flood ${spec.seq} ${i} ${pad}`);
  }
  fs.writeFileSync(done, "");
}, 50);
timer.unref?.();
