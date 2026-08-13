// Hot config tier: runtime-config.json overrides env/defaults at runtime.
// Resolution order: file -> env -> defaults (settings.mjs).
// PUT /admin/config applies hot fields live; restart-only fields persist
// but stay frozen in the running state until the next boot.
// The file lives in the data dir, written atomically with 0600 — it may
// hold client/admin keys.

import fs from "node:fs";
import path from "node:path";
import { config } from "./settings.mjs";

// Field registry: single source of truth — one entry per configurable key.
// STATIC_FIELDS are restart-only: persisted on PUT, applied to the live
// config only at first load (startup-frozen values must not change
// mid-flight). Fields marked secret are masked in admin responses.
const STATIC_FIELDS = [
  { key: "port", type: "int", min: 1, max: 65535 },
  { key: "host", type: "string" },
  { key: "accountsPath", type: "string" },
  { key: "probeIntervalMs", type: "int", min: 5000 },
  { key: "workspace", type: "string" },
  { key: "proxy", type: "string", secret: true },
];

const HOT_FIELDS = [
  { key: "maxAccountAttempts", type: "int", min: 1, max: 100 },
  { key: "clientKeys", type: "list", secret: true },
  { key: "adminKey", type: "string", secret: true },
  { key: "prefix", type: "string" },
  { key: "showToolActivity", type: "bool" },
  { key: "modelDefaults", type: "json" },
  { key: "turnIdleTimeoutMs", type: "int", min: 1000 },
  { key: "toolResultTimeoutMs", type: "int", min: 1000 },
  { key: "cooldown429BaseMs", type: "int", min: 1000, max: 300000 },
  { key: "cooldown429MaxMs", type: "int", min: 1000, max: 3600000 },
  { key: "cooldown5xxMs", type: "int", min: 1000, max: 3600000 },
  // Long-window semantics: session auth failure waits before retry;
  // second-scale values would storm every account during an outage.
  { key: "cooldownAuthMs", type: "int", min: 60000, max: 86400000 },
  { key: "logLevel", type: "string" },
  // OTA switch: restart-only, and the value is mirrored to process.env so
  // updater.otaEnabled() (which reads the env var) sees the change.
  { key: "otaEnabled", type: "bool" },
];

const FIELDS = [...STATIC_FIELDS, ...HOT_FIELDS];
const REGISTRY = new Map(FIELDS.map((f) => [f.key, f]));
const HOT_KEYS = new Set(HOT_FIELDS.map((f) => f.key));
export const RESTART_ONLY_KEYS = STATIC_FIELDS.map((f) => f.key);

// Field -> env var name (mirrors settings.mjs). Drives the `effective`
// source marking: no override + env set -> "env".
const ENV_MAP = {
  port: "CURSOR_PORT",
  host: "CURSOR_HOST",
  accountsPath: "CURSOR_ACCOUNTS",
  probeIntervalMs: "CURSOR_PROBE_INTERVAL_MS",
  workspace: "CURSOR_WORKSPACE",
  proxy: "CURSOR_PROXY",
  maxAccountAttempts: "CURSOR_MAX_ACCOUNT_ATTEMPTS",
  clientKeys: "CURSOR_CLIENT_KEYS",
  adminKey: "CURSOR_ADMIN_KEY",
  prefix: "CURSOR_PREFIX",
  showToolActivity: "CURSOR_SHOW_TOOLS",
  modelDefaults: "CURSOR_MODEL_DEFAULTS",
  turnIdleTimeoutMs: "CURSOR_TURN_IDLE_TIMEOUT_MS",
  toolResultTimeoutMs: "CURSOR_TOOL_RESULT_TIMEOUT_MS",
  cooldown429BaseMs: "CURSOR_COOLDOWN_429_BASE_MS",
  cooldown429MaxMs: "CURSOR_COOLDOWN_429_MAX_MS",
  cooldown5xxMs: "CURSOR_COOLDOWN_5XX_MS",
  cooldownAuthMs: "CURSOR_COOLDOWN_AUTH_MS",
  logLevel: "CURSOR_LOG_LEVEL",
  otaEnabled: "CURSOR_OTA_ENABLED",
};

// Whether an env var contributes a value (same semantics as settings.mjs:
// undefined and empty both count as unset).
function envIsSet(name) {
  const v = process.env[name];
  return v !== undefined && v !== "";
}

// runtime-config.json sits next to the accounts file (the data dir).
function overridePath() {
  return path.join(path.dirname(config.accountsPath), "runtime-config.json");
}

// Whatever is on disk, manual edits included; unreadable = empty.
function readDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(overridePath(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

// Atomic write: tmp("wx") + write + fsync + rename, explicit 0600. A crash
// never leaves half a JSON; pid-named tmp collisions are cleared and retried.
function writeDisk(obj) {
  const file = overridePath();
  const tmp = `${file}.tmp-${process.pid}`;
  const body = `${JSON.stringify(obj, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let fd;
  try {
    fd = fs.openSync(tmp, "wx");
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    fs.rmSync(tmp, { force: true });
    fd = fs.openSync(tmp, "wx");
  }
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // Windows has no POSIX permission bits; ignore.
    }
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed or the open failed; ignore.
    }
  }
}

// Normalize a submitted value by field type; non-compliant -> 400.
function cast(spec, raw) {
  const bad = (why) => {
    throw Object.assign(new Error(`config ${spec.key} ${why}`), { httpStatus: 400 });
  };
  // Plain scalars only (except list) — blocks {"adminKey":{...}} from
  // overwriting the admin password with "[object Object]".
  const isPlain = raw === "" || typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean";
  switch (spec.type) {
    case "int": {
      if (typeof raw === "boolean" || raw === "" || raw === null || raw === undefined) bad("must be an integer");
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isInteger(n) || !isPlain) bad(`must be an integer, got ${typeof raw === "string" ? `"${raw}"` : JSON.stringify(raw)}`);
      if (spec.min !== undefined && n < spec.min) bad(`must be >= ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) bad(`must be <= ${spec.max}`);
      return n;
    }
    case "bool": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string" && /^(true|false)$/i.test(raw.trim())) return raw.trim().toLowerCase() === "true";
      bad(`must be true/false, got ${JSON.stringify(raw)}`);
      return false; // unreachable
    }
    case "list": {
      if (Array.isArray(raw)) {
        if (raw.some((x) => typeof x !== "string" || !x.trim())) bad("must be an array of strings");
        return raw.map((x) => x.trim());
      }
      if (typeof raw === "string") {
        return raw.split(",").map((s) => s.trim()).filter(Boolean);
      }
      bad("must be a string array or comma-separated string");
      return [];
    }
    case "json": {
      // JSON object: accept the object or a parseable JSON string; empty = {} (clear).
      if (raw === "" || raw === null || raw === undefined) return {};
      let parsed = raw;
      if (typeof raw === "string") {
        try {
          parsed = JSON.parse(raw);
        } catch {
          bad(`must be valid JSON, got ${raw.slice(0, 60)}`);
        }
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        bad("must be a JSON object");
      }
      return parsed;
    }
    default:
      // string: only strings accepted, empty allowed (clear = back to default).
      if (typeof raw === "string") return raw;
      bad(`must be a string, got ${JSON.stringify(raw)}`);
      return raw; // unreachable
  }
}

let booted = false;
// In-memory overrides: key -> normalized value (restart-only included, for
// display and backfill checks).
const overrides = {};
// The value a hot field had before its first override — the env/default it
// must fall back to when {key: null} clears the override. Snapshot once, at
// first application, when config[key] still holds the boot-time value.
const preOverride = {};

// Hot-field change listeners: consumers that cache hot values (the logger's
// logLevel) must be told when one flips, so they can update in memory
// instead of re-reading the disk on every access.
const hotSubscribers = new Set();

/** Subscribe to hot-field changes; fn receives a Set of the changed keys. */
export function onHotChange(fn) {
  hotSubscribers.add(fn);
  return () => hotSubscribers.delete(fn);
}

function notifyHot(keys) {
  if (!keys.size) return;
  for (const fn of hotSubscribers) {
    try {
      fn(keys);
    } catch {
      // A listener failure must not abort the config write.
    }
  }
}

// Re-read the disk state. Restart-only fields are applied to the config
// object only on the very first load — that is when "effective after
// restart" happens; later reloads/PUTs leave their runtime values frozen.
// Hot fields notify listeners only when their value actually changed, so a
// plain getField() re-sync never fires a notification.
function syncFromDisk() {
  const disk = readDisk();
  const firstBoot = !booted;
  const hotChanged = new Set();
  for (const [key, raw] of Object.entries(disk)) {
    const spec = REGISTRY.get(key);
    if (!spec) continue; // unknown file key: skip, keep the runtime state clean
    let value;
    try {
      value = cast(spec, raw);
    } catch {
      continue; // bad value in the file: keep the old value rather than boot sick
    }
    overrides[key] = value;
    if (HOT_KEYS.has(key)) {
      if (preOverride[key] === undefined) preOverride[key] = config[key];
      if (config[key] !== value) hotChanged.add(key);
      config[key] = value;
    } else if (firstBoot) {
      config[key] = value;
    }
  }
  booted = true;
  notifyHot(hotChanged);
}

/** Force a disk re-read (tests / manual edits). Restart-only stays frozen. */
export function reloadOverrides() {
  syncFromDisk();
}

/**
 * Test-only: rewind to "not loaded" so tests can simulate a file present
 * at process start. Production must not call this.
 */
export function _resetForTests() {
  booted = false;
  for (const k of Object.keys(overrides)) delete overrides[k];
  for (const k of Object.keys(preOverride)) delete preOverride[k];
}

/** Frozen snapshot of the currently effective config. Per request, not cached. */
export function getConfig() {
  syncFromDisk();
  return freezeDeep(structuredClone(config));
}

/** Effective value of one field. */
export function getField(key) {
  syncFromDisk();
  return config[key];
}

// Secrets may only appear masked in admin responses; arrays mask item-wise.
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  const s = String(v ?? "");
  if (!s) return "";
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * GET /admin/config view: effective (running) values, masked; keys that
 * need a restart; on-disk overrides (restart-only show their pending new
 * value here, so the UI can say "effective after restart"); and a per-field
 * source marking — runtime = has an override (file/in-memory), env = no
 * override but the env var is set, default = neither. `effective` values
 * mirror the `config` view (secrets masked), so the UI can render a source
 * badge next to the exact value it already displays.
 */
export function getConfigView() {
  syncFromDisk();
  const effective = {};
  for (const f of FIELDS) {
    effective[f.key] = f.secret ? redact(config[f.key]) : config[f.key];
  }
  const overridesView = {};
  for (const f of FIELDS) {
    if (!(f.key in overrides)) continue;
    overridesView[f.key] = f.secret ? redact(overrides[f.key]) : overrides[f.key];
  }
  const effectiveList = FIELDS.map((f) => {
    let source = "default";
    const envName = ENV_MAP[f.key];
    if (f.key in overrides) source = "runtime";
    else if (envName && envIsSet(envName)) source = "env";
    return {
      key: f.key,
      source,
      value: effective[f.key],
    };
  });
  return {
    config: effective,
    effective: effectiveList,
    restartOnly: RESTART_ONLY_KEYS,
    overrides: overridesView,
  };
}

/**
 * PUT /admin/config: partial update. Re-read the disk, apply only the
 * submitted keys (file siblings survive), validate everything before the
 * write, then atomic write. Hot fields apply live; restart-only fields are
 * persisted and reported as pending restart. A submitted `null` CLEARS the
 * field's override (key removed from file and memory; hot fields fall back
 * to their env/default value now, restart-only after the next boot) — note
 * the distinction from `""`, which is a real empty-string value.
 */
export function setConfig(patch) {
  // Mirror the OTA switch to process.env: updater.otaEnabled() reads the env
  // var, so a runtime change must land there too (works even before restart).
  if (patch && typeof patch === "object" && "otaEnabled" in patch) {
    process.env.CURSOR_OTA_ENABLED = patch.otaEnabled === false ? "0" : patch.otaEnabled === true ? "1" : "";
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw Object.assign(new Error("request body must be a JSON object"), { httpStatus: 400 });
  }

  // Validate/normalize all keys first; one bad item aborts the whole write.
  const coerced = {};
  const cleared = [];
  for (const [key, raw] of Object.entries(patch)) {
    const spec = REGISTRY.get(key);
    if (!spec) {
      throw Object.assign(
        new Error(`unknown config key ${key} (configurable: ${FIELDS.map((f) => f.key).join(", ")})`),
        { httpStatus: 400 },
      );
    }
    if (raw === null) cleared.push(key);
    else coerced[key] = cast(spec, raw);
  }

  const merged = { ...readDisk() };
  for (const key of cleared) delete merged[key];
  Object.assign(merged, coerced);
  // Cross-validation: the 429 escalation step must fit under the cap.
  if (
    Number.isFinite(merged.cooldown429BaseMs) &&
    Number.isFinite(merged.cooldown429MaxMs) &&
    merged.cooldown429BaseMs > merged.cooldown429MaxMs
  ) {
    throw Object.assign(
      new Error("cooldown429BaseMs must be <= cooldown429MaxMs (escalation step must fit under the cap)"),
      { httpStatus: 400 },
    );
  }
  writeDisk(merged);

  const applied = [];
  const restartFields = [];
  for (const key of cleared) {
    const hadOverride = key in overrides;
    delete overrides[key];
    if (HOT_KEYS.has(key)) {
      // Revert to the pre-override env/default value (snapshot taken when
      // the override was first applied); skip when nothing changed.
      const prev = config[key];
      if (preOverride[key] !== undefined) {
        config[key] = preOverride[key];
        delete preOverride[key];
      }
      if (hadOverride && config[key] !== prev) applied.push(key);
    } else if (hadOverride) {
      restartFields.push(key); // cleared in the file; effective after boot
    }
  }
  for (const [key, value] of Object.entries(coerced)) {
    const spec = REGISTRY.get(key);
    overrides[key] = value;
    if (HOT_KEYS.has(key)) {
      if (preOverride[key] === undefined) preOverride[key] = config[key];
      config[key] = value; // hot: effective now
      applied.push(key);
    } else {
      restartFields.push(key); // persisted; runtime value stays old until boot
    }
  }
  notifyHot(new Set(applied));

  return { ok: true, applied, restartFields, ...getConfigView() };
}

function freezeDeep(obj) {
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) freezeDeep(v);
    Object.freeze(obj);
  }
  return obj;
}
