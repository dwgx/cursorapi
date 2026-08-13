// OTA hot update: version gates, mirror-chain fetch, git/zip deploy, restart.
// Env: CURSOR_OTA_ENABLED (off by default), CURSOR_UPDATE_REPO, CURSOR_UPDATE_TOKEN.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { log } from "./logger.mjs";

const execFileP = promisify(execFile);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPO = "dwgx/cursorapi";
const MIRROR_HOSTS = ["gh-proxy.org", "hk.gh-proxy.org", "cdn.gh-proxy.org", "edgeone.gh-proxy.org"];
const ZIP_CAP = 64 * 1024 * 1024; // hostile mirrors must not OOM us with an oversized body
const ZIP_ENTRY_CAP = 5000; // zip-bomb DoS guard
const ZIP_EXTRACT_CAP = 512 * 1024 * 1024; // high-compression bombs filling the disk
const FETCH_TIMEOUT = 15_000;
const ZIP_TIMEOUT = 60_000;
const GIT_QUICK_TIMEOUT = 15_000;
const GIT_LONG_TIMEOUT = 120_000;
const NPM_TIMEOUT = 300_000; // npm ci on a cold cache can take minutes
const LOCK_FILE = ".ota-lock"; // exclusive-create lock held for a whole perform

// ── Env ──

// operator/name only: the value is spliced into URL paths and mirror URLs,
// so anything outside this shape (schemes, extra path segments, query
// strings) falls back to the default repo instead of corrupting the request.
// The mandated character class alone would accept "../evil" (dots are in
// it), so dot segments are rejected on top — GitHub owners/repos are never
// "." or "..", so no legitimate value is lost.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DOT_SEGMENT_RE = /(^|\/)\.{1,2}($|\/)/;

function repo() {
  const v = String(process.env.CURSOR_UPDATE_REPO ?? "").trim();
  if (!v) return DEFAULT_REPO;
  if (REPO_RE.test(v) && !DOT_SEGMENT_RE.test(v)) return v;
  if (!repoWarned) {
    repoWarned = true;
    log.warn(`CURSOR_UPDATE_REPO "${v}" is not owner/repo; falling back to ${DEFAULT_REPO}`);
  }
  return DEFAULT_REPO;
}

let repoWarned = false;

/** OTA token (private repos only): forces direct connections, see apiCandidates. */
function token() {
  return String(process.env.CURSOR_UPDATE_TOKEN ?? "").trim();
}

export function otaEnabled() {
  // Default ON: OTA is the delivery channel, checking costs nothing and
  // performing requires admin auth. Set CURSOR_OTA_ENABLED=false to turn
  // updates off entirely (panel stops pushing notifications too).
  const raw = String(process.env.CURSOR_OTA_ENABLED ?? "");
  if (raw === "") return true;
  return /^(1|true|yes|on)$/i.test(raw);
}

// ── Version ──

function readPackageVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

/** Local version: package.json + short git hash; `dir` is injectable (tests). */
export function currentVersion(dir = PROJECT_ROOT) {
  const version = readPackageVersion(dir) || "0.0.0";
  let git = null;
  if (fs.existsSync(path.join(dir, ".git"))) {
    try {
      git = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 8000,
      }).trim();
    } catch {
      // .git present but HEAD unreadable
    }
  }
  return { version, git, display: git ? `${version} (${git})` : version };
}

/**
 * Tag whitelist: `v?X.Y.Z`, 1-4 numeric segments. Invalid tags never enter
 * the candidate list — blocks both path injection (URL assembly) and command
 * injection (git ref assembly).
 */
export function isValidVersionTag(tag) {
  const s = typeof tag === "string" ? tag.replace(/^v/, "") : "";
  if (!s) return false;
  const parts = s.split(".");
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => /^\d+$/.test(p));
}

/** a > b -> 1, < -> -1, == -> 0; v prefix ignored, missing segments pad with 0. */
export function compareVersions(a, b) {
  const clean = (v) =>
    String(v ?? "")
      .replace(/^v/, "")
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const [x, y] = [clean(a), clean(b)];
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ── Remote access: mirror chain ──

/**
 * Endpoint candidates: 4 gh-proxy mirrors then direct. With a token, direct
 * only — mirrors are HTTP middlemen and must never see the credential.
 */
export function apiCandidates(apiPath) {
  const direct = { name: "github-direct", url: `https://api.github.com/${apiPath}` };
  if (token()) return [direct];
  return [
    ...MIRROR_HOSTS.map((host) => ({ name: host, url: `https://${host}/https://api.github.com/${apiPath}` })),
    direct,
  ];
}

function authHeaders() {
  const t = token();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function withTimeout(fetchImpl, url, init = {}, ms = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Tag list, semver-descending, mirror by mirror; all-failed -> []. */
export async function fetchTags(fetchImpl = fetch) {
  let lastErr = "";
  for (const c of apiCandidates(`repos/${repo()}/tags`)) {
    try {
      const resp = await withTimeout(fetchImpl, c.url, {
        headers: { Accept: "application/vnd.github.v3+json", ...authHeaders() },
      });
      if (!resp.ok) {
        lastErr = `${c.name} returned ${resp.status}`;
        continue;
      }
      const list = await resp.json();
      const tags = Array.isArray(list)
        ? list.map((t) => t?.name).filter((n) => isValidVersionTag(n))
        : [];
      if (!tags.length) {
        lastErr = `${c.name} has no valid version tags`;
        continue;
      }
      tags.sort((a, b) => compareVersions(b, a));
      return tags;
    } catch (err) {
      lastErr = `${c.name} request failed: ${err?.message ?? err}`;
    }
  }
  return [];
}

/**
 * Release asset candidates: `https://github.com/{repo}/releases/download/{tag}/{asset}`
 * through the mirror chain (mirror prefix + release path), direct last. With a
 * token, direct only — mirrors are HTTP middlemen and must never see the credential.
 * NOT for the .sha256 file: the checksum is forced github.com direct, see
 * fetchSourceChecksum.
 */
function assetCandidates(tag, asset) {
  const gh = `github.com/${repo()}/releases/download/${tag}/${asset}`;
  const direct = { name: "github-direct", url: `https://${gh}` };
  if (token()) return [direct];
  return [
    ...MIRROR_HOSTS.map((host) => ({ name: host, url: `https://${host}/https://${gh}` })),
    direct,
  ];
}

/** Source package (release asset, tar.gz) download, size-capped while streaming, mirror by mirror; all-failed throws. */
async function downloadSourceAsset(tag, fetchImpl) {
  const f = fetchImpl ?? fetch;
  const asset = `cursorapi-src-${tag}.tar.gz`;
  let lastErr = "";
  for (const c of assetCandidates(tag, asset)) {
    try {
      const resp = await withTimeout(f, c.url, { headers: authHeaders() }, ZIP_TIMEOUT);
      if (!resp.ok) {
        lastErr = `${c.name} returned ${resp.status}`;
        continue;
      }
      const len = Number(resp.headers.get("content-length") ?? 0);
      if (len > ZIP_CAP) {
        lastErr = `${c.name} response over the limit (${len} bytes)`;
        continue;
      }
      return await readBodyCapped(resp, ZIP_CAP, c.name);
    } catch (err) {
      lastErr = `${c.name} download failed: ${err?.message ?? err}`;
    }
  }
  // All mirrors failing is an upstream problem, not a client error — 502,
  // so the HTTP layer does not flatten it into a generic 500.
  throw Object.assign(new Error(`all mirrors failed to download the source package (${asset}): ${lastErr}`), {
    httpStatus: 502,
  });
}

/**
 * Fetch the release checksum file via github.com DIRECT only — never through
 * the mirror chain. The hash must come from a channel independent of the
 * package download: a hostile mirror can serve a backdoored package AND a
 * matching hash of its own; it cannot rewrite a TLS-protected github.com
 * direct response. Direct failure ABORTS the update — falling back to a
 * mirror for the hash would defeat the verification (same stance as
 * kirostudio update.rs: 直连失败宁可中止，也不退回镜像取哈希（那等于没校验）).
 */
async function fetchSourceChecksum(tag, fetchImpl) {
  const f = fetchImpl ?? fetch;
  const asset = `cursorapi-src-${tag}.tar.gz.sha256`;
  const url = `https://github.com/${repo()}/releases/download/${tag}/${asset}`;
  try {
    const resp = await withTimeout(f, url, { headers: authHeaders() }, ZIP_TIMEOUT);
    if (!resp.ok) throw new Error(`github.com returned ${resp.status}`);
    // The checksum file is a single short line; any larger body is anomalous.
    return await readBodyCapped(resp, 4096, "checksum");
  } catch (err) {
    throw Object.assign(
      new Error(
        `direct github.com fetch of the checksum failed: ${err?.message ?? err}; `
        + `aborting the update — the checksum never falls back to a mirror (that would defeat the verification)`,
      ),
      { httpStatus: 502 },
    );
  }
}

/** sha256(downloaded package) must equal the direct-fetched release checksum; mismatch -> 502. */
async function verifySourceChecksum(tag, bytes, fetchImpl) {
  const shaTxt = await fetchSourceChecksum(tag, fetchImpl);
  const expected = String(shaTxt).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw Object.assign(
      new Error(`checksum file has no valid 64-hex sha256 (got ${JSON.stringify(expected.slice(0, 16))}...); refusing to replace`),
      { httpStatus: 502 },
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw Object.assign(
      new Error(
        `sha256 mismatch: package=${actual.slice(0, 12)}..., checksum=${expected.slice(0, 12)}...; `
        + "refusing to replace (tampered package or checksum)",
      ),
      { httpStatus: 502 },
    );
  }
}

/**
 * Read a response body with a hard cap, aborting the stream the moment the
 * cap is crossed — a hostile mirror streaming an unbounded body must never
 * get the chance to buffer the whole thing (arrayBuffer would OOM us).
 * Body-less responses (test stubs) fall back to arrayBuffer + post-check.
 */
async function readBodyCapped(resp, cap, name) {
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > cap) throw new Error(`${name} response over the limit`);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.length ?? 0;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`${name} response over the limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

// ── Deployment shape ──

/** git repo -> git mode; source tree -> zip mode; otherwise none. */
export function detectMode(dir = PROJECT_ROOT) {
  if (fs.existsSync(path.join(dir, ".git"))) return "git";
  if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src", "app.mjs"))) {
    return "zip";
  }
  return "none";
}

async function resolveBranch(dir) {
  const tries = [
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
  ];
  for (const args of tries) {
    try {
      const { stdout } = await execFileP("git", args, { cwd: dir, timeout: 8000 });
      const out = stdout.trim();
      if (out && out !== "HEAD") return out.replace(/^origin\//, "");
    } catch {
      // try the next one
    }
  }
  return null;
}

async function commitHead(dir) {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: dir,
      timeout: 8000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function commitsBehind(dir, branch) {
  if (!branch) return null;
  try {
    const { stdout } = await execFileP("git", ["rev-list", "--count", `HEAD..origin/${branch}`], {
      cwd: dir,
      timeout: GIT_QUICK_TIMEOUT,
    });
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return null;
  }
}

// ── Check / perform ──

/** { mode, current, latest, behind, hasUpdate } — network-free when fetchImpl is stubbed. */
export async function checkUpdate({ fetchImpl, projectRoot = PROJECT_ROOT } = {}) {
  const local = currentVersion(projectRoot);
  const tags = await fetchTags(fetchImpl ?? fetch);
  const latest = tags[0] ?? null;
  const hasUpdate = latest ? compareVersions(latest, local.version) > 0 : false;

  let behind = null;
  if (detectMode(projectRoot) === "git") {
    const branch = await resolveBranch(projectRoot);
    if (branch) behind = await commitsBehind(projectRoot, branch);
  }

  return { mode: detectMode(projectRoot), current: local.display, latest, behind, hasUpdate, enabled: otaEnabled() };
}

/** Run the update. Off by default (403); git mode first, zip mode as fallback. */
export async function performUpdate({ fetchImpl, projectRoot = PROJECT_ROOT } = {}) {
  if (!otaEnabled()) {
    throw Object.assign(new Error("OTA disabled: set CURSOR_OTA_ENABLED=true to allow updates"), {
      httpStatus: 403,
    });
  }
  if (detectMode(projectRoot) === "none") {
    throw Object.assign(new Error("project root looks wrong (no package.json / src/app.mjs)"), { httpStatus: 409 });
  }
  const lock = acquireUpdateLock(projectRoot);
  try {
    if (detectMode(projectRoot) === "git") return await gitModeUpdate(projectRoot, fetchImpl ?? fetch);
    return await zipModeUpdate(fetchImpl ?? fetch, projectRoot);
  } finally {
    releaseUpdateLock(lock, projectRoot);
  }
}

// ── Concurrency ──

// One in-flight flag per process (guards shared .ota-tmp / cursorapi.bak)
// plus an exclusive-create lock file at the project root (guards against a
// second process running a perform on the same tree). Both are held for the
// whole perform and released in all exit paths.
let inFlight = false;

function acquireUpdateLock(projectRoot) {
  if (inFlight) {
    throw Object.assign(new Error("an OTA update is already running"), { httpStatus: 409 });
  }
  inFlight = true;
  try {
    const fd = fs.openSync(path.join(projectRoot, LOCK_FILE), "wx");
    return fd;
  } catch (err) {
    inFlight = false;
    if (err?.code === "EEXIST") {
      throw Object.assign(
        new Error("another OTA update is in progress (a stale lock file may need a manual remove)"),
        { httpStatus: 409 },
      );
    }
    throw err;
  }
}

function releaseUpdateLock(fd, projectRoot) {
  inFlight = false;
  try {
    fs.closeSync(fd);
  } catch {
    // ignore
  }
  try {
    fs.rmSync(path.join(projectRoot, LOCK_FILE), { force: true });
  } catch {
    // a stale file only blocks the next update with a clear 409
  }
}

/** git mode: fetch -> behind check -> ff-only merge -> tag gate -> deps -> hand the restart to the caller. */
async function gitModeUpdate(projectRoot, fetchImpl) {
  const before = await commitHead(projectRoot);
  if (!before) throw Object.assign(new Error("not a git repo (cannot read HEAD)"), { httpStatus: 409 });

  // --untracked-files=no: transient root files (OTA lock, markers, data/)
  // are untracked and never block an ff-only merge — only modifications to
  // tracked files matter here.
  const { stdout: statusOut } = await execFileP("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: projectRoot,
    timeout: GIT_QUICK_TIMEOUT,
  });
  if (statusOut.trim()) {
    throw Object.assign(new Error(`working tree has uncommitted changes; refusing to update:\n${statusOut.trim()}`), {
      httpStatus: 409,
    });
  }

  // --tags so the tag-gate rev-list below can resolve the API-reported tag
  // locally, even when it does not point at a fetched branch.
  await execFileP("git", ["fetch", "origin", "--tags"], { cwd: projectRoot, timeout: GIT_LONG_TIMEOUT });

  const branch = await resolveBranch(projectRoot);
  if (!branch) throw Object.assign(new Error("cannot determine the current branch; refusing to update"), { httpStatus: 409 });
  const ref = `origin/${branch}`;
  const behind = await commitsBehind(projectRoot, branch);
  if (behind === null || behind === 0) {
    return { updated: false, mode: "git", before, message: `already up to date (${branch}, no commits behind)` };
  }

  await execFileP("git", ["merge", "--ff-only", ref], { cwd: projectRoot, timeout: GIT_LONG_TIMEOUT });
  const after = await commitHead(projectRoot);

  // Tag gate: the new HEAD must descend from the latest release tag
  // (`rev-list --count <tag>..HEAD == 0`). A push that was never tagged
  // would otherwise ride OTA, and an untagged rollout that forgets to bump
  // package.json would loop upgrades forever. Merge failure unwinds via
  // reset --hard (safe here: the tree was clean and the merge was ff-only).
  const tags = await fetchTags(fetchImpl ?? fetch);
  const latestTag = tags[0];
  if (!latestTag) {
    await resetHard(projectRoot, before);
    throw Object.assign(
      new Error(`cannot verify the update against release tags (all mirrors failed); reverted to ${before}`),
      { httpStatus: 502 },
    );
  }
  let ahead = null;
  try {
    const { stdout } = await execFileP("git", ["rev-list", "--count", `${latestTag}..HEAD`], {
      cwd: projectRoot,
      timeout: GIT_QUICK_TIMEOUT,
    });
    ahead = parseInt(stdout.trim(), 10) || 0;
  } catch {
    ahead = null; // the tag does not exist locally: fail closed
  }
  if (ahead !== 0) {
    await resetHard(projectRoot, before);
    const msg =
      ahead === null
        ? `cannot verify the update against release tag ${latestTag} (not found locally); reverted to ${before}`
        : `refusing: new HEAD is not a descendant of the latest release tag ${latestTag} (${ahead} commits beyond it); reverted to ${before}`;
    throw Object.assign(new Error(msg), { httpStatus: ahead === null ? 502 : 409 });
  }

  // Dependencies come after the code: an install failure aborts the update
  // (no restart) and the merge is unwound so the tree stays on the old version.
  try {
    await installDeps(projectRoot);
  } catch (err) {
    await resetHard(projectRoot, before).catch(() => {});
    throw Object.assign(
      new Error(`dependency install failed after the update: ${err?.message ?? err}; reverted to ${before}`),
      { httpStatus: 500 },
    );
  }

  log.info(`OTA: git update done ${before} -> ${after} (${behind} commits behind), restarting`);
  return {
    updated: true,
    mode: "git",
    before,
    after,
    behind,
    restart: true,
    message: `updated ${before} -> ${after}; restarting to apply`,
  };
}

async function resetHard(dir, ref) {
  await execFileP("git", ["reset", "--hard", ref], { cwd: dir, timeout: GIT_QUICK_TIMEOUT });
}

/**
 * Install production deps after the code swap/merge. Skipped when
 * CURSOR_OTA_SKIP_INSTALL=1 (tests) or when there is no package-lock.json.
 * Throws on failure — callers must treat that as an aborted update.
 */
async function installDeps(projectRoot) {
  if (/^(1|true|yes|on)$/i.test(String(process.env.CURSOR_OTA_SKIP_INSTALL ?? ""))) return;
  if (!fs.existsSync(path.join(projectRoot, "package-lock.json"))) return;
  await execFileP("npm", ["ci", "--omit=dev"], { cwd: projectRoot, timeout: NPM_TIMEOUT });
}

/** zip mode: download -> verify -> swap src/ (old version kept as rollback point). */
async function zipModeUpdate(fetchImpl, projectRoot) {
  const local = currentVersion(projectRoot);
  const tags = await fetchTags(fetchImpl);
  const latest = tags[0];
  if (!latest) {
    throw Object.assign(new Error("cannot fetch a remote version (all mirrors failed)"), { httpStatus: 502 });
  }
  if (compareVersions(latest, local.version) <= 0) {
    return {
      updated: false,
      mode: "zip",
      before: local.display,
      message: `current ${local.display} is up to date or newer (remote ${latest}); downgrade refused`,
    };
  }

  // The package may cross third-party mirrors, so its checksum is fetched on
  // a separate, github.com-direct channel and verified BEFORE any extraction.
  const bytes = await downloadSourceAsset(latest, fetchImpl);
  if (bytes.length < 1024) {
    throw Object.assign(new Error("downloaded content too small to be a valid archive"), { httpStatus: 502 });
  }
  await verifySourceChecksum(latest, bytes, fetchImpl);

  // Stage under the project root: same filesystem as src, so renames stay
  // atomic (os.tmpdir() could be a different volume -> EXDEV).
  const tmp = path.join(projectRoot, ".ota-tmp");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const pkgDir = await verifyAndExtract(tmp, bytes, latest);
    // Copy package.json / lockfile out first — pkgDir gets renamed away below.
    // Stage the OLD ones as a rollback point: a failed dependency install
    // must restore them too, otherwise the version metadata claims the new
    // version while the code is old — hasUpdate goes permanently false and
    // zip-mode OTA dies silently (reviewer M1).
    const pkgOld = path.join(projectRoot, ".ota-pkg-old");
    fs.rmSync(pkgOld, { recursive: true, force: true });
    fs.mkdirSync(pkgOld, { recursive: true });
    for (const f of ["package.json", "package-lock.json"]) {
      const cur = path.join(projectRoot, f);
      if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(pkgOld, f));
      const from = path.join(pkgDir, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, cur);
    }
    try {
      swapSrc(projectRoot, pkgDir);
    } catch (err) {
      // swap failed mid-way: restore both src and package metadata
      reverseSwapSrc(projectRoot);
      restorePkgOld(projectRoot, pkgOld);
      throw Object.assign(
        new Error(`replacing src/ failed: ${err?.message ?? err}; the previous version was restored`),
        { httpStatus: 500 },
      );
    }
    // Dependencies after the code: a failed install aborts the update (no
    // restart) and the swap is reversed, so the running tree stays old.
    try {
      await installDeps(projectRoot);
    } catch (err) {
      reverseSwapSrc(projectRoot);
      restorePkgOld(projectRoot, pkgOld);
      throw Object.assign(
        new Error(`dependency install failed after the update: ${err?.message ?? err}; the previous version was restored`),
        { httpStatus: 500 },
      );
    }
    fs.rmSync(pkgOld, { recursive: true, force: true });
    log.warn(`OTA: zip package replaced src/ with ${latest} (backup in cursorapi.bak), restarting`);
    return {
      updated: true,
      mode: "zip",
      before: local.display,
      after: latest,
      restart: true,
      message: `replaced with ${latest} (zip package); restarting to apply`,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Restore the staged old package metadata after a failed zip update. */
function restorePkgOld(projectRoot, pkgOld) {
  for (const f of ["package.json", "package-lock.json"]) {
    const from = path.join(pkgOld, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(projectRoot, f));
  }
  fs.rmSync(pkgOld, { recursive: true, force: true });
}

/** Undo a swapSrc: drop the freshly installed tree, put the rollback point back. */
function reverseSwapSrc(projectRoot) {
  const src = path.join(projectRoot, "src");
  const bak = path.join(projectRoot, "cursorapi.bak");
  if (!fs.existsSync(bak)) return; // nothing to restore
  try {
    fs.rmSync(src, { recursive: true, force: true });
    fs.renameSync(bak, src);
  } catch (err) {
    log.error(`OTA: reverse swap failed (${err?.message ?? err}); the old version is preserved in cursorapi.bak`);
  }
}

/**
 * Extract the tar.gz into tmp and verify the payload: entry scan (traversal /
 * absolute paths / entry-count cap), required files, version must equal the
 * requested tag (anti-poisoning — the download crossed third-party mirrors),
 * symlink scan after extraction, and a total extracted-size cap. Returns the
 * package root inside tmp.
 *
 * Requires the system `tar` binary (GNU tar or bsdtar; bundled on macOS,
 * Linux and Windows 10+ — no external install). Detected here and surfaced
 * as a clear error instead of a cryptic ENOENT.
 */
async function verifyAndExtract(tmp, bytes, expectedTag) {
  try {
    try {
      await execFileP("tar", ["--version"], { timeout: 5000 });
    } catch {
      throw new Error(
        "OTA zip mode requires the system `tar` binary, which is missing on this host. "
        + "Use git mode (run from a git clone) or install tar.",
      );
    }
    fs.writeFileSync(path.join(tmp, "bundle.tar.gz"), bytes);

    // Entry pre-read: refuse traversal / absolute paths before anything
    // touches the disk (both GNU tar and bsdtar list verbatim entry names).
    const { stdout: listing } = await execFileP("tar", ["-tzf", "bundle.tar.gz"], { cwd: tmp, timeout: ZIP_TIMEOUT });
    const entries = listing.split("\n").filter(Boolean);
    if (entries.length > ZIP_ENTRY_CAP) throw new Error("archive has too many entries; refusing to extract");
    for (const e of entries) {
      if (e.includes("..") || e.startsWith("/")) {
        throw new Error(`archive contains a suspicious path entry: ${e}`);
      }
    }

    await execFileP("tar", ["-xzf", "bundle.tar.gz"], { cwd: tmp, timeout: ZIP_TIMEOUT });

    // Symlink rejection: a malicious archive can plant src/app.mjs as a
    // symlink to an attacker-chosen absolute path — existsSync follows it,
    // and swapSrc would then serve that file as our entry point. Post-extract
    // lstat scan (the pre-read lists names only, not link flags).
    const pkgDir = findPkgDir(tmp);
    if (!pkgDir) throw new Error("archive has no package.json; not a cursorapi source package");
    rejectSymlinks(pkgDir);
    if (!fs.existsSync(path.join(pkgDir, "src", "app.mjs"))) {
      throw new Error("archive has no src/app.mjs; refusing to replace");
    }

    const pkgVersion = readPackageVersion(pkgDir);
    const stripV = (v) => String(v ?? "").replace(/^v/, "");
    if (stripV(pkgVersion) !== stripV(expectedTag)) {
      throw new Error(`archive version=${pkgVersion || "(unreadable)"} does not match requested tag=${expectedTag}; refusing to replace`);
    }

    const size = dirSize(pkgDir);
    if (size > ZIP_EXTRACT_CAP) throw new Error(`extracted content is ${size} bytes; over the limit, refusing to replace`);
    return pkgDir;
  } catch (err) {
    // An unreadable / malicious / poisoned archive is an upstream problem
    // (the download crossed the mirror chain), not a client error — 502, so
    // the HTTP layer does not flatten it into a generic 500.
    if (err?.httpStatus == null) Object.assign(err, { httpStatus: 502 });
    throw err;
  }
}

/** Walk the extracted tree and abort on any symlink or non-regular/non-dir entry. */
function rejectSymlinks(root) {
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`archive contains a symlink entry: ${name}; refusing to replace`);
      if (st.isDirectory()) walk(p);
      else if (!st.isFile()) throw new Error(`archive contains a special file entry: ${name}; refusing to replace`);
    }
  };
  walk(root);
}

/**
 * Atomic swap: src -> cursorapi.bak, then the new tree into place.
 *
 * GitHub source packages carry a wrapper dir (pkgDir = <repo>-<tag>/, with the
 * real tree in pkgDir/src) — only pkgDir/src is swapped, never the wrapper, or
 * the boot entry would land at src/src/app.mjs and crash-loop into rollback.
 *
 * Ordering keeps a usable src/ on disk at every step: the previous rollback
 * point is first moved aside (staged), then src becomes the new rollback
 * point, then the new tree is renamed in. A failed second rename is reversed
 * (bak -> src) so src never vanishes. The old rollback point is deleted last.
 */
function swapSrc(projectRoot, pkgDir) {
  const src = path.join(projectRoot, "src");
  const bak = path.join(projectRoot, "cursorapi.bak");
  const oldBak = path.join(projectRoot, "cursorapi.bak.old");
  const newSrc = fs.existsSync(path.join(pkgDir, "src")) ? path.join(pkgDir, "src") : pkgDir;
  if (!fs.existsSync(src)) throw new Error(`no src/ to replace; aborting the swap (${src})`);
  fs.rmSync(oldBak, { recursive: true, force: true }); // stale artifact of an interrupted swap
  if (fs.existsSync(bak)) fs.renameSync(bak, oldBak); // stage the previous rollback point
  fs.renameSync(src, bak); // the old src becomes the new rollback point
  try {
    fs.renameSync(newSrc, src);
  } catch (err) {
    try {
      fs.renameSync(bak, src); // reverse: put the old version back
    } catch {
      // bak still holds the old version; the boot guard can roll it back
    }
    fs.rmSync(oldBak, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(oldBak, { recursive: true, force: true }); // previous rollback point goes only now
}

/** Total bytes under a directory (recursive, symlinks not followed). */
function dirSize(dir) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) total += dirSize(p);
      else if (st.isFile()) total += st.size;
    }
  } catch {
    // unreadable dirs count as 0; the existence checks are the backstop
  }
  return total;
}

/** First level-1 directory carrying a package.json. */
function findPkgDir(root) {
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    try {
      if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "package.json"))) return p;
    } catch {
      // skip unreadable entries
    }
  }
  return null;
}

// ── Restart ──

let restartHandler = null;

/** app.mjs hooks in graceful shutdown (server.close + drain + flush accounting). */
export function setRestartHandler(fn) {
  restartHandler = fn;
}

/** Supervisor present (systemd / PM2 / docker / explicit env)? */
/** Whether a supervisor is present, i.e. a restart can actually happen. */
export function canRestart() {
  return detectSupervisor();
}

function detectSupervisor() {
  return Boolean(
    process.env.INVOCATION_ID || // systemd
      process.env.PM2_USAGE ||
      process.env.pm_id || // PM2
      process.env.CURSOR_OTA_SUPERVISOR || // explicit declaration
      fs.existsSync("/.dockerenv"), // docker
  );
}

/**
 * Restart: graceful drain (10s cap) -> exit(75) when a supervisor will pull
 * the new code up (EX_TEMPFAIL). Without a supervisor, spawning a detached
 * child silently is refused instead: an orphan process can grab the port or
 * run a half-updated tree nobody supervises. Returns an explicit result.
 */
export async function restartNow() {
  // Supervisor check FIRST: without one, refuse outright — draining the
  // server (server.close) makes the process exit naturally once the last
  // handle is gone, i.e. "restart" would silently kill the service with
  // nothing to pull it back up.
  if (!detectSupervisor()) {
    return {
      restarted: false,
      reason:
        "no supervisor detected (systemd / PM2 / docker / CURSOR_OTA_SUPERVISOR); "
        + "restart refused — launch the service under a supervisor to enable restarts",
    };
  }
  if (restartHandler) {
    try {
      await restartHandler();
    } catch (err) {
      log.warn(`graceful shutdown failed, exiting anyway: ${err?.message ?? err}`);
    }
  }
  log.info("supervisor detected, exit(75) for it to pull up the new version");
  process.exit(75);
}
