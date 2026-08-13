// Hot config layer: three-tier resolution (env/default -> runtime override),
// PUT hot updates, restart-only backfill against split-brain, atomic writes
// and secret masking in the view.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tests = [];
const passed = [];
const failed = [];
function test(name, fn) {
  tests.push({ name, fn });
}
async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed.push(name);
    } catch (e) {
      failed.push({ name, error: e });
    }
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-cfghot-"));
const cfgFile = path.join(dir, "runtime-config.json");

const { config } = await import("./src/settings.mjs");
config.accountsPath = path.join(dir, "accounts.json");
const hot = await import("./src/runtime-settings.mjs");

const file = () => JSON.parse(fs.readFileSync(cfgFile, "utf8"));

// ── defaults ────────────────────────────────────────────
test("defaults: no runtime-config.json -> env / defaults", () => {
  const snap = hot.getConfig();
  assert.equal(snap.port, 8008, "default port 8008");
  assert.equal(snap.maxAccountAttempts, 3, "default account-attempt cap 3");
  assert.deepEqual(snap.clientKeys, [], "no keys configured -> empty array");
});

// ── first load: file overrides apply ────────────────────
test("first load: the file overrides apply, restart-only included", () => {
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({
      maxAccountAttempts: 7,
      port: 9001,
      clientKeys: ["sk-test-abcdef123456", "sk-test-xyz7890"],
    }),
    "utf8",
  );
  // Wind the state back to "not loaded" to simulate "file present at
  // process start" — that is when "effective after restart" happens.
  hot._resetForTests();
  const snap = hot.getConfig();
  assert.equal(snap.maxAccountAttempts, 7, "hot field overridden by runtime-config");
  assert.equal(snap.port, 9001, "restart-only fields also apply at first load");
  assert.deepEqual(snap.clientKeys, ["sk-test-abcdef123456", "sk-test-xyz7890"], "list fields parse as arrays");
  assert.equal(Object.isFrozen(snap), true, "snapshots must be frozen; callers cannot mutate");
  assert.equal(Object.isFrozen(snap.clientKeys), true, "nested structures freeze too");
});

// ── three-tier precedence (child processes) ─────────────
// Env vars are fixed at settings.mjs import time; mutating process.env in
// this process cannot test the env tier, so child processes verify it.
const cfgMod = new URL("./src/settings.mjs", import.meta.url).pathname;
const hotMod = new URL("./src/runtime-settings.mjs", import.meta.url).pathname;
const childEnv = { ...process.env, CURSOR_ACCOUNTS: path.join(dir, "accounts.json") };
const probe = (env, code) =>
  JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...childEnv, ...env },
      encoding: "utf8",
    }),
  );

test("precedence: a runtime override beats env", () => {
  // Override present (7) -> beats env (5).
  const r = probe(
    { CURSOR_MAX_ACCOUNT_ATTEMPTS: "5" },
    `const { config } = await import(${JSON.stringify(cfgMod)});
     const hot = await import(${JSON.stringify(hotMod)});
     console.log(JSON.stringify({ direct: config.maxAccountAttempts, resolved: hot.getField("maxAccountAttempts") }));`,
  );
  assert.equal(r.resolved, 7, "runtime override must beat env");
});

test("precedence: env applies when there is no override", () => {
  fs.rmSync(cfgFile, { force: true });
  const r = probe(
    { CURSOR_MAX_ACCOUNT_ATTEMPTS: "5" },
    `const hot = await import(${JSON.stringify(hotMod)});
     console.log(JSON.stringify({ resolved: hot.getField("maxAccountAttempts") }));`,
  );
  assert.equal(r.resolved, 5, "no override: env applies");
});

test("precedence: the default applies when neither is present", () => {
  const r = probe(
    {},
    `const hot = await import(${JSON.stringify(hotMod)});
     console.log(JSON.stringify({ resolved: hot.getField("maxAccountAttempts") }));`,
  );
  assert.equal(r.resolved, 3, "neither present: falls to the default");
  // Restore the override file for the PUT tests below.
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({
      maxAccountAttempts: 7,
      port: 9001,
      clientKeys: ["sk-test-abcdef123456", "sk-test-xyz7890"],
    }),
    "utf8",
  );
  hot.reloadOverrides();
});

// ── PUT hot update ──────────────────────────────────────
test("PUT hot fields: apply immediately, write back to config and disk", () => {
  const r1 = hot.setConfig({ maxAccountAttempts: 9, showToolActivity: false, logLevel: "debug" });
  assert.deepEqual(r1.applied.sort(), ["logLevel", "maxAccountAttempts", "showToolActivity"]);
  assert.deepEqual(r1.restartFields, [], "no restart-only fields -> none reported");
  assert.equal(hot.getConfig().maxAccountAttempts, 9);
  assert.equal(hot.getConfig().showToolActivity, false);
  assert.equal(config.maxAccountAttempts, 9, "hot fields must write back into the config object — existing readers pick them up at once");
  assert.equal(config.showToolActivity, false);
  assert.equal(file().maxAccountAttempts, 9, "the file must hold it too, so a restart doesn't lose it");
  assert.equal(file().port, 9001, "existing file keys must not be lost (partial update only touches submitted ones)");
});

test("PUT restart-only: runtime keeps the old value, the file persists the new (no split-brain)", () => {
  const r2 = hot.setConfig({ port: 9999, host: "0.0.0.0" });
  assert.deepEqual(r2.restartFields.sort(), ["host", "port"]);
  assert.equal(hot.getConfig().port, 9001, "runtime value keeps the old one (split-brain prevention)");
  assert.equal(config.port, 9001, "the config object must not be polluted by restart-only fields");
  assert.equal(hot.getConfig().host, "127.0.0.1", "host keeps its runtime value too");
  assert.equal(file().port, 9999, "the file persists the new value; effective after restart");
});

test("reload: restart-only values never pour back into runtime state", () => {
  hot.reloadOverrides();
  assert.equal(hot.getConfig().port, 9001, "reload must not override restart-only runtime values");
});

// ── GET view masking ────────────────────────────────────
test("GET view: secrets masked, restart-only listed, overrides shown", () => {
  config.adminKey = "skadm-topsecretvalue";
  const view = hot.getConfigView();
  assert.deepEqual(view.config.clientKeys, ["sk-t…3456", "sk-t…7890"], "client keys get masks only");
  assert.ok(view.config.clientKeys.every((m) => m.includes("…")), "masks carry the ellipsis");
  assert.equal(view.config.adminKey, "skad…alue", "admin password gets a mask only");
  assert.ok(!JSON.stringify(view).includes("topsecretvalue"), "no secret original anywhere in the response");
  assert.ok(!JSON.stringify(view).includes("sk-test-abcdef123456"), "no client-key original anywhere");
  assert.deepEqual(view.restartOnly.sort(), ["accountsPath", "host", "port", "probeIntervalMs", "proxy", "workspace"]);
  assert.equal(view.overrides.port, 9999, "overrides show the persisted new value (prompt: effective after restart)");
  assert.equal(view.overrides.maxAccountAttempts, 9);
  assert.equal(view.overrides.clientKeys[0], "sk-t…3456", "secrets in overrides get masked too");
  config.adminKey = "";
});

test("GET view: the proxy URL is masked — credentials never leave the server", () => {
  config.proxy = "http://user:secret@127.0.0.1:10808";
  try {
    const view = hot.getConfigView();
    assert.notEqual(view.config.proxy, "http://user:secret@127.0.0.1:10808", "the raw proxy must never appear");
    assert.ok(!JSON.stringify(view).includes("user:secret"), "no proxy credentials anywhere in the response");
    assert.ok(!JSON.stringify(view).includes("127.0.0.1:10808"), "the endpoint suffix is hidden too");
    assert.ok(String(view.config.proxy).includes("…"), "a masked value is shown instead");
  } finally {
    config.proxy = "";
  }
});

// ── atomic write ────────────────────────────────────────
test("atomic write: 0600 permission, no tmp leftovers", () => {
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o600, "runtime-config permission must be 600");
  }
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes(".tmp-")), "no half-written tmp files may remain");
});

// ── invalid input ───────────────────────────────────────
test("invalid input: always rejected with 400, disk untouched", () => {
  const before = JSON.stringify(file());
  for (const bad of [
    { maxAccountAttempts: "abc" },
    { maxAccountAttempts: 1.5 },
    { showToolActivity: "yes" },
    { clientKeys: [1, 2] },
    { nonexistent_key: 1 },
    [],
  ]) {
    let threw = null;
    try {
      hot.setConfig(bad);
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, `must reject: ${JSON.stringify(bad)}`);
    assert.equal(threw.httpStatus, 400, `rejection must carry 400: ${JSON.stringify(bad)}`);
  }
  assert.equal(JSON.stringify(file()), before, "failed PUTs must not touch the file");
});

// ── P0 tiered-cooldown params ───────────────────────────
test("cooldown params: out-of-range and cross-invalid values are rejected with 400", () => {
  const before = JSON.stringify(file());
  for (const bad of [
    { cooldown429BaseMs: 0 },                       // below min
    { cooldown429BaseMs: 999999999 },               // above max
    { cooldown429BaseMs: 300000, cooldown429MaxMs: 1000 }, // step larger than cap
    { cooldownAuthMs: 1000 },                       // long-window semantics forbid seconds
  ]) {
    let threw = null;
    try {
      hot.setConfig(bad);
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, `must reject: ${JSON.stringify(bad)}`);
    assert.equal(threw.httpStatus, 400, `rejection must carry 400: ${JSON.stringify(bad)}`);
  }
  assert.equal(JSON.stringify(file()), before, "rejected PUTs must not touch the file");
});

test("cooldown params: a valid value applies immediately and persists", () => {
  const rc = hot.setConfig({ cooldown429BaseMs: 8000 });
  assert.deepEqual(rc.applied, ["cooldown429BaseMs"], "hot fields take effect immediately");
  assert.equal(hot.getConfig().cooldown429BaseMs, 8000);
  assert.equal(config.cooldown429BaseMs, 8000, "must write back into the config object — the pool reads it at call time");
  assert.equal(file().cooldown429BaseMs, 8000, "the file must hold it too, so a restart doesn't lose it");
});

// ── source marking (the `effective` array) ─────────────
test("GET view: effective marks runtime for overridden fields, default otherwise", () => {
  const view = hot.getConfigView();
  const byKey = Object.fromEntries(view.effective.map((e) => [e.key, e]));
  assert.equal(view.effective.length, 20, "one entry per configurable field");
  assert.equal(byKey.maxAccountAttempts.source, "runtime", "an overridden hot field -> runtime");
  assert.equal(byKey.maxAccountAttempts.value, 9, "the value mirrors the config view");
  assert.equal(byKey.port.source, "runtime", "a pending restart-only override is runtime-managed too");
  assert.equal(byKey.port.value, 9001, "restart-only keeps the frozen running value (the pending one sits in overrides)");
  assert.equal(byKey.cooldown429MaxMs.source, "default", "no override and no env -> default");
  assert.equal(byKey.clientKeys.source, "runtime");
  assert.ok(String(byKey.clientKeys.value[0]).includes("…"), "secret values in effective are masked too");
  assert.ok(!JSON.stringify(view.effective).includes("sk-test-abcdef123456"), "no secret original in effective");
  assert.deepEqual(
    view.effective.map((e) => e.key),
    [...new Set(view.effective.map((e) => e.key))],
    "keys are unique",
  );
});

test("GET view: effective marks env when only the env var is set (child process)", () => {
  const backup = fs.readFileSync(cfgFile, "utf8");
  fs.rmSync(cfgFile, { force: true });
  try {
    const r = probe(
      { CURSOR_MAX_ACCOUNT_ATTEMPTS: "5" },
      `const hot = await import(${JSON.stringify(hotMod)});
       const v = hot.getConfigView();
       const e = v.effective.find((x) => x.key === "maxAccountAttempts");
       console.log(JSON.stringify({ source: e.source, value: e.value }));`,
    );
    assert.equal(r.source, "env", "no override + env set -> env");
    assert.equal(r.value, 5);
  } finally {
    fs.writeFileSync(cfgFile, backup, "utf8");
    hot.reloadOverrides();
  }
});

// ── {key: null} clears an override ─────────────────────
test("PUT {key: null}: clears a hot override and falls back to the env/default value", () => {
  const r = hot.setConfig({ maxAccountAttempts: null });
  assert.deepEqual(r.applied, ["maxAccountAttempts"], "clearing a hot override takes effect now");
  assert.equal(hot.getConfig().maxAccountAttempts, 3, "falls back to the default (no env in this process)");
  assert.equal(config.maxAccountAttempts, 3, "the config object reverts too — readers see the fallback at once");
  assert.ok(!("maxAccountAttempts" in file()), "the key leaves the file");
  const view = hot.getConfigView();
  assert.ok(!("maxAccountAttempts" in view.overrides), "no longer listed as an override");
  assert.equal(view.effective.find((e) => e.key === "maxAccountAttempts").source, "default");
});

test("PUT {key: null}: a cleared restart-only field is pending, the frozen runtime value stays", () => {
  const r = hot.setConfig({ port: null });
  assert.deepEqual(r.restartFields, ["port"], "the clear is persisted; effective after restart");
  assert.equal(hot.getConfig().port, 9001, "the frozen running value does not move");
  assert.equal(config.port, 9001);
  assert.ok(!("port" in file()), "the key leaves the file");
  const view = hot.getConfigView();
  assert.ok(!("port" in view.overrides), "no longer listed as an override");
  assert.equal(view.effective.find((e) => e.key === "port").source, "default");
});

test("PUT {key: null}: clearing a non-existent override is a no-op", () => {
  const r = hot.setConfig({ prefix: null });
  assert.deepEqual(r.applied, [], "nothing took effect");
  assert.deepEqual(r.restartFields, [], "nothing pending");
  assert.equal(hot.getConfig().prefix, "");
});

test("PUT: an empty string is a real value, never a clear", () => {
  const r = hot.setConfig({ prefix: "" });
  assert.deepEqual(r.applied, ["prefix"], "empty string is a hot value");
  assert.ok("prefix" in file(), "the file holds it");
  assert.equal(hot.getConfigView().effective.find((e) => e.key === "prefix").source, "runtime");
  hot.setConfig({ prefix: null }); // clean up
});

test("PUT {key: null}: re-applying after a clear re-snapshots the fallback", () => {
  hot.setConfig({ maxAccountAttempts: 6 });
  assert.equal(hot.getConfig().maxAccountAttempts, 6);
  const r = hot.setConfig({ maxAccountAttempts: null });
  assert.deepEqual(r.applied, ["maxAccountAttempts"], "a second clear works after a re-apply");
  assert.equal(hot.getConfig().maxAccountAttempts, 3, "clears back to the default again");
  assert.ok(!("maxAccountAttempts" in file()));
});

test("PUT {key: null}: with the env var set, the clear falls back to the env value (child process)", () => {
  const backup = fs.readFileSync(cfgFile, "utf8");
  fs.rmSync(cfgFile, { force: true });
  try {
    const r = probe(
      { CURSOR_MAX_ACCOUNT_ATTEMPTS: "5" },
      `const { config } = await import(${JSON.stringify(cfgMod)});
       const hot = await import(${JSON.stringify(hotMod)});
       hot.setConfig({ maxAccountAttempts: 7 });
       hot.setConfig({ maxAccountAttempts: null });
       console.log(JSON.stringify({ resolved: hot.getField("maxAccountAttempts") }));`,
    );
    assert.equal(r.resolved, 5, "clearing an override must land on the env value, not the default");
  } finally {
    fs.writeFileSync(cfgFile, backup, "utf8");
    hot.reloadOverrides();
  }
});

await run();
fs.rmSync(dir, { recursive: true, force: true });

if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`hot config layer: all passed (${passed.length} tests)`);
