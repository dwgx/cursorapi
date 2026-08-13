// OTA boot guard (Node port of kirostudio health_marker.rs): counts
// startup attempts, clears on a successful listen, writes a health
// marker after 30s of stable running, and rolls back from
// cursorapi.bak after 3 consecutive crash-loop starts. Node builtins
// only, so it runs even when the service itself is broken.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BOOT_COUNTER = "cursorapi.boot_attempts";
const HEALTH_MARKER = "cursorapi.health";
const ROLLBACK_DIR = "cursorapi.bak";
const FAILED_PREFIX = "cursorapi.failed.";
const CRASH_LIMIT = 3;

function counterFile(dir) {
  return path.join(dir, BOOT_COUNTER);
}

function readCounter(file) {
  try {
    return parseInt(fs.readFileSync(file, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function writeCounter(file, n) {
  try {
    fs.writeFileSync(file, String(n), "utf8");
  } catch {
    // never block startup on a marker write
  }
}

function rollbackFromBak(dir, n) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = path.join(dir, `${FAILED_PREFIX}${ts}`);
  const src = path.join(dir, "src");
  const bak = path.join(dir, ROLLBACK_DIR);
  try {
    fs.renameSync(src, evidence);
  } catch {
    // src may already be gone mid zip-replacement
  }
  try {
    try {
      fs.renameSync(bak, src);
    } catch (err) {
      if (err?.code !== "EXDEV") throw err;
      fs.cpSync(bak, src, { recursive: true });
      fs.rmSync(bak, { recursive: true, force: true });
    }
    try {
      fs.rmSync(counterFile(dir), { force: true });
    } catch {
      // ignore
    }
    return { attempts: n, rolledBack: true, failed: path.basename(evidence) };
  } catch (err) {
    try {
      fs.renameSync(evidence, src);
    } catch {
      // ignore
    }
    process.stderr.write(`[guard] rollback failed: ${err?.message}\n`);
  }
  return { attempts: n, rolledBack: false };
}

export function bumpBootAttempts(dir = ROOT) {
  // A lock file left by a crashed OTA update is stale by definition — the
  // holder is dead or it would be this very process. Clearing it here keeps
  // one crash from bricking OTA with a permanent 409.
  try {
    fs.rmSync(path.join(dir, ".ota-lock"), { force: true });
  } catch {
    // never block startup on lock cleanup
  }
  const file = counterFile(dir);
  const n = readCounter(file) + 1;
  writeCounter(file, n);
  if (fs.existsSync(path.join(dir, ROLLBACK_DIR)) && n >= CRASH_LIMIT) {
    return rollbackFromBak(dir, n);
  }
  return { attempts: n, rolledBack: false };
}

export function clearBootAttempts(dir = ROOT) {
  try {
    fs.rmSync(counterFile(dir), { force: true });
  } catch {
    // ignore
  }
}

export function confirmHealth(dir = ROOT) {
  let version = "0.0.0";
  try {
    version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? version;
  } catch {
    // unreadable version: use the placeholder
  }
  try {
    fs.writeFileSync(
      path.join(dir, HEALTH_MARKER),
      `version=${version}\nconfirmed_at=${Math.floor(Date.now() / 1000)}\n`,
      "utf8",
    );
  } catch {
    // a failed health write must not affect operation
  }
  try {
    fs.rmSync(path.join(dir, ROLLBACK_DIR), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function readStatus(dir = ROOT) {
  let health = null;
  try {
    health = fs.readFileSync(path.join(dir, HEALTH_MARKER), "utf8");
  } catch {
    // none = not confirmed
  }
  let evidence = false;
  try {
    evidence = fs.readdirSync(dir).some((f) => f.startsWith(FAILED_PREFIX));
  } catch {
    // ignore
  }
  return {
    healthConfirmed: Boolean(health),
    healthDetail: health?.trim() || null,
    rollbackPointPresent: fs.existsSync(path.join(dir, ROLLBACK_DIR)),
    rolledBackBinaryPresent: evidence,
  };
}

// NOTE: no module-load side effect here anymore.
//
// boot.mjs (the single official entry — package.json start, Docker CMD,
// pkg binary, OTA restart) explicitly calls bumpBootAttempts() itself.
// Having both the side effect AND the explicit call double-counted the
// counter (2 per boot), which collapsed the rollback threshold from 3
// crashes to 1. Running `node src/app.mjs` directly (tests) deliberately
// skips the guard — it is not an entry point.
