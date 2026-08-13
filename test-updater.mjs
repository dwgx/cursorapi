// OTA: semver comparison, tag whitelist, anti-downgrade, version parsing,
// mirror candidate safety, OTA off by default, boot-guard rollback.
// No network — fetch is stubbed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const mod = await import("./src/updater.mjs");
const guard = await import("./src/guard.mjs");

// CI runners may run under systemd (INVOCATION_ID set) — restartNow() would
// exit(75) the whole test process. Pin supervisor detection off for the
// suite, and restore afterwards.
const SAVED_ENV = {};
for (const k of ["INVOCATION_ID", "PM2_USAGE", "pm_id"]) {
  SAVED_ENV[k] = process.env[k];
  delete process.env[k];
}
const SAVED_SUP = process.env.CURSOR_OTA_SUPERVISOR;
process.env.CURSOR_OTA_SUPERVISOR = "";
const {
  compareVersions,
  isValidVersionTag,
  apiCandidates,
  currentVersion,
  checkUpdate,
  performUpdate,
  otaEnabled,
} = mod;

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

// ── minimal stored (uncompressed) tar.gz writer ──────────────────
// Enough of the ustar format for the system `tar` binary to list and
// extract the test fixture, so the P0 source-package-layout regression runs
// the real verifyAndExtract + swapSrc path. No external deps.
function buildTar(files) {
  const blocks = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data ?? ""));
    const header = Buffer.alloc(512);
    header.write(f.name.slice(0, 99), 0, 99); // ASCII names only in fixtures
    header.write("0000644\0", 100, 8); // mode: regular file
    header.write("0000000\0", 108, 8); // uid
    header.write("0000000\0", 116, 8); // gid
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12); // size
    header.write("00000000000\0", 136, 12); // mtime
    header.fill(0x20, 148, 156); // checksum: spaces while summing
    header[156] = 0x30; // typeflag: '0' regular file
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header);
    if (data.length) blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
}

const buildTarGz = (files) => gzipSync(buildTar(files));

// gzip compresses repeated filler to a few bytes, so fixture padding must be
// incompressible or the archive lands under the 1024-byte minimum-archive
// gate. LCG bytes are deterministic (no randomBytes -> reproducible runs).
function incompressiblePad(n) {
  const buf = Buffer.alloc(n);
  let seed = 0x12345678;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    buf[i] = (seed >>> 24) % 256; // high bits: LCG low bits repeat with period 256
  }
  return buf;
}

// ── semver comparison ───────────────────────────────────
test("semver: numeric comparison across segments, v-prefix ignored", () => {
  assert.equal(compareVersions("v1.2.3", "1.2.2"), 1);
  assert.equal(compareVersions("1.2.3", "v1.2.3"), 0, "v prefix doesn't matter");
  assert.equal(compareVersions("1.2", "1.2.0"), 0, "missing segments pad with 0");
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1, "10 > 9; never lexicographic");
  assert.equal(compareVersions("0.1.0", "0.0.9"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0.1"), -1, "4 segments participate");
  assert.equal(compareVersions("", "1.0.0"), -1, "empty string counts as 0");
});

// ── tag whitelist ───────────────────────────────────────
test("tags: plain version tags pass the whitelist", () => {
  for (const ok of ["v1.2.3", "1.2.3", "v1.2", "1", "v1.2.3.4"]) {
    assert.equal(isValidVersionTag(ok), true, `${ok} must pass`);
  }
});

test("tags: pre-releases and garbage are rejected", () => {
  for (const bad of [
    "v1.2.3-beta",
    "v1.2.3-rc1",
    "release-1.2.3",
    "v1..3",
    "v",
    "",
    null,
    undefined,
    "v1.2.3.4.5",
    "1.2.3 ",
  ]) {
    assert.equal(isValidVersionTag(bad), false, `${String(bad)} must be rejected`);
  }
});

// ── anti-downgrade ──────────────────────────────────────
test("anti-downgrade: the target must be strictly newer than local", () => {
  const newer = (tag, local) => compareVersions(tag, local) > 0;
  assert.equal(newer("1.1.0", "1.2.0"), false, "downgrade must be refused");
  assert.equal(newer("1.2.0", "1.2.0"), false, "same version never updates");
  assert.equal(newer("1.3.0", "1.2.0"), true);
});

// ── version parsing: package.json + git ─────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-update-"));

test("version parsing: package.json only when there is no .git", () => {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// placeholder", "utf8");
  const local = currentVersion(dir);
  assert.equal(local.version, "0.2.0");
  assert.equal(local.git, null, "no .git -> package.json only");
  assert.equal(local.display, "0.2.0");
});

test("version parsing: missing package.json -> placeholder version", () => {
  fs.rmSync(path.join(dir, "package.json"), { force: true });
  const local = currentVersion(dir);
  assert.equal(local.version, "0.0.0");
});

// ── version check (mock fetch, no network) ──────────────
test("check: the highest valid tag wins (zip mode)", async () => {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }));
  globalThis.fetch = async (url, init) => ({
    ok: true,
    status: 200,
    json: async () => [
      { name: "v0.1.0" },
      { name: "v9.9.9" },
      { name: "v1.2.3" },
      { name: "not-a-tag" },
    ],
  });
  const check = await checkUpdate({ projectRoot: dir });
  assert.equal(check.mode, "zip", "no .git -> zip mode");
  assert.equal(check.current, "0.2.0");
  assert.equal(check.latest, "v9.9.9", "highest valid tag wins");
  assert.equal(check.hasUpdate, true);
  assert.equal(check.behind, null, "non-git mode has no behind");
});

test("check: all mirrors down -> latest null, no throw", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  const check = await checkUpdate({ projectRoot: dir });
  assert.equal(check.latest, null);
  assert.equal(check.hasUpdate, false);
});

test("check: already newest -> no update", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{ name: "v0.1.9" }, { name: "v0.1.0" }],
  });
  const check = await checkUpdate({ projectRoot: dir });
  assert.equal(check.hasUpdate, false, "remote 0.1.9 < local 0.2.0: not an update");
  assert.equal(check.latest, "v0.1.9");
});

// ── mirror candidate safety ─────────────────────────────
test("mirror candidates: with a token, direct only — never through a third-party mirror", () => {
  process.env.CURSOR_UPDATE_TOKEN = "ghp_dummy_for_test";
  const cands = apiCandidates("repos/x/y/tags");
  assert.equal(cands.length, 1, "with a token, direct only");
  assert.equal(cands[0].name, "github-direct");
  assert.ok(cands.every((c) => !c.url.includes("gh-proxy")), "with a token, never through a third-party mirror");
  delete process.env.CURSOR_UPDATE_TOKEN;
});

test("mirror candidates: without a token, mirrors first and direct last", () => {
  const cands = apiCandidates("repos/x/y/tags");
  assert.equal(cands.length, 5, "no token: 4 mirrors + direct fallback");
  assert.equal(cands.at(-1).name, "github-direct", "direct must be the final fallback");
  assert.ok(cands.slice(0, 4).every((c) => c.url.includes("gh-proxy")), "the first 4 are mirrors");
});

// ── CURSOR_UPDATE_REPO validation ────────────────────────
test("repo: a valid owner/repo is used verbatim; anything else falls back to the default", async () => {
  let seenUrl = "";
  const stub = async (url) => {
    seenUrl = String(url);
    return { ok: true, status: 200, json: async () => [{ name: "v9.9.9" }] };
  };
  process.env.CURSOR_UPDATE_REPO = "someuser/some-repo";
  await checkUpdate({ fetchImpl: stub, projectRoot: dir });
  assert.ok(seenUrl.includes("someuser/some-repo"), "a valid owner/repo is spliced in as-is");
  for (const bad of [
    "https://github.com/a/b",
    "a",
    "a/b/c",
    "a/b?x=1",
    "../evil",
    "a//b",
    "a\\b",
    "a/b\nc",
  ]) {
    process.env.CURSOR_UPDATE_REPO = bad;
    await checkUpdate({ fetchImpl: stub, projectRoot: dir });
    assert.ok(
      seenUrl.includes("dwgx/cursorapi"),
      `${JSON.stringify(bad)} must fall back to the default repo`,
    );
  }
  delete process.env.CURSOR_UPDATE_REPO;
});

// ── OTA default ─────────────────────────────────────────
test("OTA: on by default — unset performs, explicit 0 refuses with 403", async () => {
  process.env.CURSOR_OTA_ENABLED = "";
  assert.equal(otaEnabled(), true, "unset must default to ON");
  const ok = await performUpdate({ projectRoot: dir }).then((r) => r, (e) => e);
  assert.ok(!(ok && ok.httpStatus === 403), "unset OTA_ENABLED must not refuse");
  process.env.CURSOR_OTA_ENABLED = "0";
  const denied = await performUpdate({ projectRoot: dir }).then(() => null, (e) => e);
  assert.ok(denied, "explicit 0 must refuse");
  assert.equal(denied.httpStatus, 403, "refusal carries 403");
  assert.equal(otaEnabled(), false);
});

test("OTA: toggling — explicit 0 is off too", async () => {
  process.env.CURSOR_OTA_ENABLED = "1";
  assert.equal(otaEnabled(), true);
  process.env.CURSOR_OTA_ENABLED = "0";
  const denied = await performUpdate({ projectRoot: dir }).then(() => null, (e) => e);
  assert.equal(denied.httpStatus, 403, "explicit 0 is off too");
  process.env.CURSOR_OTA_ENABLED = "";
});

// ── boot guard: rollback only on real crash loops ───────
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-guard-"));
const mk = (name, content) => {
  const p = path.join(root, name);
  if (content !== undefined) fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
};

test("boot guard: no bak -> no rollback, however often it crashes", () => {
  fs.writeFileSync(mk("cursorapi.boot_attempts"), "0", "utf8");
  assert.equal(guard.bumpBootAttempts(root).rolledBack, false, "no bak -> no rollback");
  assert.equal(guard.bumpBootAttempts(root).rolledBack, false, "three crashes, no bak, still no rollback");
  assert.equal(guard.bumpBootAttempts(root).rolledBack, false, "four crashes, no bak, still no rollback");
  assert.equal(fs.readdirSync(root).filter((f) => f.startsWith("cursorapi.failed.")).length, 0, "no evidence files");
});

test("boot guard: bak below the threshold -> no mis-rollback on a normal restart", () => {
  fs.writeFileSync(mk("cursorapi.boot_attempts"), "1", "utf8");
  fs.mkdirSync(mk("cursorapi.bak"), { recursive: true });
  const b = guard.bumpBootAttempts(root);
  assert.equal(b.rolledBack, false, "bak present but count 2 < 3: a normal restart must not roll back");
  assert.ok(fs.existsSync(path.join(root, "cursorapi.bak")), "below the threshold the rollback point stays untouched");
  assert.equal(fs.readdirSync(root).filter((f) => f.startsWith("cursorapi.failed.")).length, 0, "no evidence files");
});

test("boot guard: at the threshold -> rollback with evidence, bak deleted, counter cleared", () => {
  fs.mkdirSync(mk("src"), { recursive: true });
  fs.writeFileSync(mk("src/app.mjs"), "// bad version", "utf8");
  fs.writeFileSync(mk("cursorapi.bak/old.txt"), "old", "utf8");
  fs.writeFileSync(mk("cursorapi.boot_attempts"), "2", "utf8");
  const b = guard.bumpBootAttempts(root);
  assert.equal(b.rolledBack, true, "count 3 hits the threshold: must roll back");
  assert.ok(b.failed?.startsWith("cursorapi.failed."), "the bad version must be kept as evidence");
  const failedDir = path.join(root, b.failed);
  assert.ok(fs.existsSync(path.join(failedDir, "app.mjs")), "the bad src is kept whole as evidence (for later forensics)");
  assert.ok(!fs.existsSync(mk("src/app.mjs")), "the bad version is out of src");
  assert.equal(fs.readFileSync(mk("src/old.txt"), "utf8"), "old", "rollback content comes from bak");
  assert.ok(!fs.existsSync(mk("cursorapi.bak")), "the rollback point is deleted, preventing ping-pong");
});

test("boot guard: after the rollback the counter is cleared and the old version starts normally", () => {
  const b = guard.bumpBootAttempts(root);
  assert.equal(b.rolledBack, false);
});

test("health: confirmHealth records the version and deletes bak", () => {
  guard.confirmHealth(root);
  const health = fs.readFileSync(mk("cursorapi.health"), "utf8");
  assert.match(health, /^version=/);
  assert.ok(!fs.existsSync(mk("cursorapi.bak")), "the rollback point is deleted after health confirmation");
});

test("health: readStatus reflects the confirmed state", () => {
  const st = guard.readStatus(root);
  assert.equal(st.healthConfirmed, true);
  assert.equal(st.rollbackPointPresent, false);
  assert.equal(st.rolledBackBinaryPresent, true, "evidence files make rolledBack visible");
});

test("boot guard: a successful listen clears the counter", () => {
  guard.clearBootAttempts(root);
  assert.ok(!fs.existsSync(mk("cursorapi.boot_attempts")), "a successful listen clears the counter");
});

test("boot guard: a stale OTA lock file is cleared on boot", () => {
  fs.writeFileSync(mk(".ota-lock"), "stale", "utf8");
  const b = guard.bumpBootAttempts(root);
  assert.equal(b.rolledBack, false);
  assert.ok(!fs.existsSync(mk(".ota-lock")), "a stale lock from a crashed update must not brick OTA forever");
});

// ── zip: release source package (tar.gz) flow (P0) ────────────
// Stub router for the release-asset flow: tags via the API mirror chain,
// the tar.gz via the release-asset mirror chain, the .sha256 via github.com
// direct. `checksum` overrides the served hash (defaults to the real sha256
// of the package).
function assetFlowStub({ pkg, checksum, shaImpl }) {
  return async (url) => {
    const u = String(url);
    if (u.includes(".sha256")) {
      if (shaImpl) return shaImpl(u);
      const sha = checksum ?? createHash("sha256").update(pkg).digest("hex");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from(`${sha}  cursorapi-src-v1.2.3.tar.gz\n`),
      };
    }
    if (u.includes("releases/download/")) {
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => pkg };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ name: "v1.2.3" }] };
  };
}

test("zip: a release source package (tar.gz) lands at src/app.mjs (no src/src nesting)", async () => {
  process.env.CURSOR_OTA_ENABLED = "1";
  process.env.CURSOR_OTA_SKIP_INSTALL = "1";
  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-ota-"));
  try {
    fs.writeFileSync(path.join(zipDir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    fs.mkdirSync(path.join(zipDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(zipDir, "src", "app.mjs"), "// old version", "utf8");

    // Real source package shape (git archive): cursorapi-<tag>/ package root
    // wrapping src/. README pads the payload past the 1024-byte
    // minimum-archive check.
    const pkg = buildTarGz([
      { name: "cursorapi-v1.2.3/package.json", data: JSON.stringify({ version: "1.2.3" }) },
      { name: "cursorapi-v1.2.3/README.md", data: incompressiblePad(2048) },
      { name: "cursorapi-v1.2.3/src/app.mjs", data: "// new version" },
    ]);
    const fetchStub = assetFlowStub({ pkg });

    const r = await performUpdate({ fetchImpl: fetchStub, projectRoot: zipDir });
    assert.equal(r.updated, true);
    assert.equal(r.after, "v1.2.3");
    assert.equal(fs.readFileSync(path.join(zipDir, "src", "app.mjs"), "utf8"), "// new version");
    assert.ok(!fs.existsSync(path.join(zipDir, "src", "src")), "no src/src nesting (P0 regression)");
    assert.equal(
      fs.readFileSync(path.join(zipDir, "cursorapi.bak", "app.mjs"), "utf8"),
      "// old version",
      "the old src is the rollback point",
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(zipDir, "package.json"), "utf8")).version, "1.2.3");
    assert.ok(!fs.existsSync(path.join(zipDir, ".ota-tmp")), "staging is cleaned up");
    assert.ok(!fs.existsSync(path.join(zipDir, ".ota-lock")), "the lock is released after the update");
  } finally {
    fs.rmSync(zipDir, { recursive: true, force: true });
  }
});

test("zip: a tampered checksum is refused with 502 and leaves no residue", async () => {
  process.env.CURSOR_OTA_ENABLED = "1";
  process.env.CURSOR_OTA_SKIP_INSTALL = "1";
  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-ota-"));
  try {
    fs.writeFileSync(path.join(zipDir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    fs.mkdirSync(path.join(zipDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(zipDir, "src", "app.mjs"), "// old", "utf8");
    // Forged checksum: the package is valid and its sha256 is honest, but
    // the direct channel serves a different hash — the anti-poisoning red
    // line must refuse even when the archive itself is fine.
    const pkg = buildTarGz([
      { name: "cursorapi-v1.2.3/package.json", data: JSON.stringify({ version: "1.2.3" }) },
      { name: "cursorapi-v1.2.3/README.md", data: incompressiblePad(2048) },
      { name: "cursorapi-v1.2.3/src/app.mjs", data: "// backdoored" },
    ]);
    const fetchStub = assetFlowStub({ pkg, checksum: "0".repeat(64) });
    const err = await performUpdate({ fetchImpl: fetchStub, projectRoot: zipDir }).then(() => null, (e) => e);
    assert.ok(err, "a checksum mismatch must fail the update");
    assert.match(String(err.message), /sha256 mismatch/, "the mismatch is distinguishable from other failures");
    assert.equal(err.httpStatus, 502, "a poisoned package is upstream trouble, not a client error");
    assert.equal(fs.readFileSync(path.join(zipDir, "src", "app.mjs"), "utf8"), "// old", "nothing was swapped");
    assert.ok(!fs.existsSync(path.join(zipDir, "cursorapi.bak")), "no rollback point was created");
    assert.ok(!fs.existsSync(path.join(zipDir, ".ota-tmp")), "no staging residue");
    assert.ok(!fs.existsSync(path.join(zipDir, ".ota-lock")), "the lock is released on failure");
  } finally {
    fs.rmSync(zipDir, { recursive: true, force: true });
  }
});

test("zip: a direct checksum fetch failure aborts — the hash never falls back to a mirror", async () => {
  process.env.CURSOR_OTA_ENABLED = "1";
  process.env.CURSOR_OTA_SKIP_INSTALL = "1";
  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-ota-"));
  try {
    fs.writeFileSync(path.join(zipDir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    fs.mkdirSync(path.join(zipDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(zipDir, "src", "app.mjs"), "// old", "utf8");
    const pkg = buildTarGz([
      { name: "cursorapi-v1.2.3/package.json", data: JSON.stringify({ version: "1.2.3" }) },
      { name: "cursorapi-v1.2.3/README.md", data: incompressiblePad(2048) },
      { name: "cursorapi-v1.2.3/src/app.mjs", data: "// new version" },
    ]);
    const shaUrls = [];
    const fetchStub = async (url) => {
      const u = String(url);
      if (u.includes(".sha256")) {
        shaUrls.push(u);
        return { ok: false, status: 503 }; // github.com direct is down
      }
      if (u.includes("releases/download/")) {
        return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => pkg };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ name: "v1.2.3" }] };
    };
    const err = await performUpdate({ fetchImpl: fetchStub, projectRoot: zipDir }).then(() => null, (e) => e);
    assert.ok(err, "a direct checksum failure must abort the update");
    assert.equal(err.httpStatus, 502);
    assert.match(
      String(err.message),
      /direct github\.com fetch of the checksum failed/,
      "the direct-channel failure is distinguishable",
    );
    assert.ok(shaUrls.length > 0, "the checksum was attempted");
    assert.ok(
      shaUrls.every((u) => u.startsWith("https://github.com/") && !u.includes("gh-proxy")),
      "the checksum is only ever fetched direct — never via a mirror (dual-channel invariant)",
    );
    assert.equal(fs.readFileSync(path.join(zipDir, "src", "app.mjs"), "utf8"), "// old", "nothing was swapped");
    assert.ok(!fs.existsSync(path.join(zipDir, ".ota-tmp")), "no staging residue");
    assert.ok(!fs.existsSync(path.join(zipDir, ".ota-lock")), "the lock is released on failure");
  } finally {
    fs.rmSync(zipDir, { recursive: true, force: true });
  }
});

test("zip: an oversized streamed body is aborted while downloading", async () => {
  process.env.CURSOR_OTA_ENABLED = "1";
  process.env.CURSOR_OTA_SKIP_INSTALL = "1";
  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-ota-"));
  try {
    fs.writeFileSync(path.join(zipDir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    fs.mkdirSync(path.join(zipDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(zipDir, "src", "app.mjs"), "// old", "utf8");
    let assetCalls = 0;
    const fetchStub = async (url) => {
      if (String(url).includes("releases/download/")) {
        assetCalls++;
        if (assetCalls === 1) {
          // 65 MB streamed — the 64 MB cap must abort it mid-download
          // (never fully buffered, never extracted).
          const chunk = new Uint8Array(1024 * 1024);
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: new ReadableStream({
              start(controller) {
                for (let i = 0; i < 65; i++) controller.enqueue(chunk);
                controller.close();
              },
            }),
          };
        }
        return { ok: false, status: 404 };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ name: "v1.2.3" }] };
    };
    const err = await performUpdate({ fetchImpl: fetchStub, projectRoot: zipDir }).then(() => null, (e) => e);
    assert.ok(err, "an oversized download must fail the update");
    assert.match(String(err.message), /all mirrors failed to download/, "the download failure surfaces");
    assert.equal(err.httpStatus, 502, "a mirror download failure is upstream trouble, not a client error (pressure-ota)");
    assert.ok(!fs.existsSync(path.join(zipDir, ".ota-lock")), "the lock is released on failure");
  } finally {
    fs.rmSync(zipDir, { recursive: true, force: true });
  }
});

// ── concurrency (P0) ─────────────────────────────────────────
test("zip: an archive that fails verification carries 502", async () => {
  process.env.CURSOR_OTA_ENABLED = "1";
  process.env.CURSOR_OTA_SKIP_INSTALL = "1";
  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-ota-"));
  try {
    fs.writeFileSync(path.join(zipDir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    fs.mkdirSync(path.join(zipDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(zipDir, "src", "app.mjs"), "// old", "utf8");
    // A traversal-path entry is rejected by the entry scan — the archive
    // itself is the failure, and it must read as upstream trouble (502),
    // not a generic server error. The README pads past the 1024-byte
    // minimum-archive gate so the scan is actually reached.
    const pkg = buildTarGz([
      { name: "../evil.txt", data: "boom" },
      { name: "README.md", data: incompressiblePad(2048) },
    ]);
    const fetchStub = assetFlowStub({ pkg });
    const err = await performUpdate({ fetchImpl: fetchStub, projectRoot: zipDir }).then(() => null, (e) => e);
    assert.ok(err, "a poisoned archive must fail the update");
    assert.match(String(err.message), /suspicious path|package\.json/, "the verification failure surfaces");
    assert.equal(err.httpStatus, 502, "verification failures are upstream problems (pressure-ota A-2)");
    assert.ok(!fs.existsSync(path.join(zipDir, ".ota-lock")), "the lock is released on failure");
  } finally {
    fs.rmSync(zipDir, { recursive: true, force: true });
  }
});

test("concurrency: a second perform is refused with 409 while one is in flight", async () => {
  process.env.CURSOR_OTA_ENABLED = "1";
  process.env.CURSOR_OTA_SKIP_INSTALL = "1";
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-ota-"));
  try {
    fs.writeFileSync(path.join(lockDir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    fs.mkdirSync(path.join(lockDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(lockDir, "src", "app.mjs"), "// old", "utf8");
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    let calls = 0;
    const hangingFetch = async () => {
      calls++;
      if (calls === 1) await gate; // hold the first perform inside fetchTags
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [{ name: "v1.2.3" }],
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    const first = performUpdate({ fetchImpl: hangingFetch, projectRoot: lockDir });
    const second = await performUpdate({ fetchImpl: hangingFetch, projectRoot: lockDir }).then(() => null, (e) => e);
    assert.equal(second?.httpStatus, 409, "the second perform must be refused while the first holds the lock");
    releaseGate();
    await first.then(() => null, () => null); // the first one then fails on the empty body; that is fine
    assert.ok(!fs.existsSync(path.join(lockDir, ".ota-lock")), "the lock file is gone after the perform settles");
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test("concurrency: a stale lock file refuses with 409", async () => {
  process.env.CURSOR_OTA_ENABLED = "1";
  process.env.CURSOR_OTA_SKIP_INSTALL = "1";
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-ota-"));
  try {
    fs.writeFileSync(path.join(lockDir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    fs.mkdirSync(path.join(lockDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(lockDir, "src", "app.mjs"), "// old", "utf8");
    fs.writeFileSync(path.join(lockDir, ".ota-lock"), "", "utf8");
    const err = await performUpdate({ projectRoot: lockDir }).then(() => null, (e) => e);
    assert.equal(err?.httpStatus, 409, "a held lock file must refuse the update");
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

// ── git: tag gate (P1) ───────────────────────────────────────
function makeGitFixture() {
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursorapi-git-"));
  const bare = path.join(gitRoot, "bare.git");
  const local = path.join(gitRoot, "local");
  const runIn = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  runIn(gitRoot, ["init", "-b", "main", "--bare", bare]);
  runIn(gitRoot, ["clone", "-q", bare, local]);
  const ci = ["-c", "user.name=t", "-c", "user.email=t@t"];
  fs.writeFileSync(path.join(local, "package.json"), JSON.stringify({ version: "0.1.0" }));
  runIn(local, [...ci, "add", "package.json"]);
  runIn(local, [...ci, "commit", "-q", "-m", "initial"]);
  runIn(local, ["push", "-q", "origin", "main"]);
  runIn(local, ["tag", "v0.2.0"]);
  runIn(local, ["push", "-q", "origin", "v0.2.0"]);
  // a second clone pushes new commits to the remote, leaving `local` (the
  // deployment clone) behind by exactly one commit
  const work = path.join(gitRoot, "work");
  runIn(gitRoot, ["clone", "-q", bare, work]);
  const push = (files, tag) => {
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(work, name), data, "utf8");
    runIn(work, [...ci, "add", "-A"]);
    runIn(work, [...ci, "commit", "-q", "-m", "new"]);
    runIn(work, ["push", "-q", "origin", "main"]);
    if (tag) {
      runIn(work, ["tag", tag]);
      runIn(work, ["push", "-q", "origin", tag]);
    }
  };
  return { gitRoot, local, run: (args) => runIn(local, args), push };
}

test("git: an untagged push is refused and the merge reverted (tag gate)", async () => {
  process.env.CURSOR_OTA_ENABLED = "1";
  process.env.CURSOR_OTA_SKIP_INSTALL = "1";
  const { gitRoot, local, run, push } = makeGitFixture();
  try {
    push({ "untagged.txt": "x" });
    const before = run(["rev-parse", "HEAD"]).trim();
    const fetchStub = async () => ({ ok: true, status: 200, json: async () => [{ name: "v0.2.0" }] });
    const err = await performUpdate({ fetchImpl: fetchStub, projectRoot: local }).then(() => null, (e) => e);
    assert.ok(err, "an untagged update must be refused");
    assert.equal(err.httpStatus, 409);
    assert.equal(run(["rev-parse", "HEAD"]).trim(), before, "the merge must be reverted");
    assert.ok(!fs.existsSync(path.join(local, ".ota-lock")), "the lock is released on failure");
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
});

test("git: a tagged push passes the gate and updates", async () => {
  process.env.CURSOR_OTA_ENABLED = "1";
  process.env.CURSOR_OTA_SKIP_INSTALL = "1";
  const { gitRoot, local, run, push } = makeGitFixture();
  try {
    push({ "tagged.txt": "y" }, "v0.3.0");
    const fetchStub = async () => ({ ok: true, status: 200, json: async () => [{ name: "v0.3.0" }] });
    const r = await performUpdate({ fetchImpl: fetchStub, projectRoot: local });
    assert.equal(r.updated, true);
    assert.equal(r.mode, "git");
    assert.equal(r.after, run(["rev-parse", "--short=12", "HEAD"]).trim());
    assert.ok(!fs.existsSync(path.join(local, ".ota-lock")), "the lock is released after the update");
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
});

// ── restart (P2) ─────────────────────────────────────────────
test("restart: without a supervisor, restartNow refuses explicitly instead of spawning", async () => {
  const prev = process.env.CURSOR_OTA_SUPERVISOR;
  delete process.env.CURSOR_OTA_SUPERVISOR;
  try {
    const r = await mod.restartNow();
    assert.equal(r.restarted, false);
    assert.match(String(r.reason), /supervisor/i);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_OTA_SUPERVISOR;
    else process.env.CURSOR_OTA_SUPERVISOR = prev;
  }
});

// ── release chain (P0): zip mode depends on the source-package asset ──
test("release: release.yml carries a source-package job (git archive + sha256 upload)", () => {
  const yml = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(yml, /source-package:/, "the source-package job exists");
  assert.match(yml, /git archive/, "it archives the source");
  assert.match(
    yml,
    /cursorapi-src-\${{ github\.ref_name }}\.tar\.gz/,
    "asset name matches what updater.mjs downloads (cursorapi-src-<tag>.tar.gz)",
  );
  assert.match(yml, /\.sha256/, "it publishes the checksum file next to the package");
  assert.match(yml, /gh release upload/, "it uploads both to the release");
  assert.match(
    yml,
    /release:\n[^\n]*needs: \[[^\]]*source-package/,
    "release finalize waits for the source package (asset must be up before publish)",
  );
});

await run();

// restore supervisor env
for (const k of ["INVOCATION_ID", "PM2_USAGE", "pm_id"]) {
  if (SAVED_ENV[k] !== undefined) process.env[k] = SAVED_ENV[k];
  else delete process.env[k];
}
if (SAVED_SUP !== undefined) process.env.CURSOR_OTA_SUPERVISOR = SAVED_SUP;
else delete process.env.CURSOR_OTA_SUPERVISOR;
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });

if (failed.length) {
  for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
  process.exit(1);
}
console.log(`OTA: all passed (${passed.length} tests)`);
