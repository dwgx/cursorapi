// Model catalog: cached Cursor model list and `name[param,param]` resolution.
// One pool-wide cache — the list is identical across accounts (verified on
// two accounts), so per-account catalogs would only add drift.

import { Cursor } from "@cursor/sdk";
import { config } from "./settings.mjs";
import { errShape, log } from "./logger.mjs";
import * as pool from "./keys.mjs";

const CACHE_TTL = 60 * 60 * 1000;

let cached = null;
let cachedAt = 0;
let inflight = null;

// Canonical key: lowercase, dots and underscores collapse to dashes.
function canon(s) {
  return String(s).toLowerCase().replaceAll(".", "-").replaceAll("_", "-");
}

// Drop the configured name prefix when present.
function stripPrefix(name) {
  return config.prefix && name.toLowerCase().startsWith(config.prefix)
    ? name.slice(config.prefix.length)
    : name;
}

// "claude-opus-5[1m,max]" -> { base: "claude-opus-5", words: ["1m", "max"] }.
function splitModelSpec(name) {
  const m = /^(.*?)\[(.*)\]$/.exec(name);
  return {
    base: (m ? m[1] : name).trim(),
    words: m ? m[2].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : [],
  };
}

// Parameter dimension whose value list matches the word, if any.
function dimForValue(model, word) {
  return (model.parameters ?? []).find((p) => p.values.some((v) => canon(v.value) === canon(word)));
}

// Parameter dimension with this id, if any.
function dimById(model, id) {
  return (model.parameters ?? []).find((p) => p.id === id);
}

// The canonical (display) value behind a canonical key.
function valueFor(dim, word) {
  return dim.values.find((v) => canon(v.value) === canon(word)).value;
}

// One bracket word -> a {id, value} pair, or null when unknown.
function parseParamWord(word, model) {
  if (word.includes("=")) {
    const [id, value] = word.split("=", 2);
    return { id, value };
  }
  const dim = dimForValue(model, word);
  if (dim) return { id: dim.id, value: valueFor(dim, word) };
  if (dimById(model, word)) return { id: word, value: "true" }; // bare toggle -> on
  log.warn(`model ${model.id} does not know parameter ${word}; ignored`);
  return null;
}

// Billing-sensitive dimensions left unset always take the cheap variant:
// the model's own default is not necessarily cheap (measured on real bills:
// composer-2.5-fast billed 2 requests per call, opus-4.6-max ran 4.22M
// tokens for one call). thinking stays off too — tool calls and short Q&A
// do not need it.
function applyCheapDefaults(model, params) {
  const present = new Set(params.map((p) => p.id));
  for (const id of ["fast", "thinking"]) {
    const dim = present.has(id) ? null : dimById(model, id);
    const off = dim && dim.values.find((v) => canon(v.value) === "false");
    if (off) params.push({ id, value: off.value });
  }
}

// CURSOR_MODEL_DEFAULTS: per-model params appended when the client sends a
// bare name; anything the client spelled out is never overridden.
function appendConfiguredDefaults(model, publicName, params) {
  const defs = config.modelDefaults?.[model.id] ?? config.modelDefaults?.[publicName] ?? null;
  if (!defs) return;

  const present = new Set(params.map((p) => p.id));
  const add = (id, value) => {
    if (present.has(id)) return;
    const dim = dimById(model, id);
    if (!dim || !dim.values.some((v) => canon(v.value) === canon(String(value)))) return;
    params.push({ id, value: valueFor(dim, String(value)) });
  };

  if (typeof defs === "string") {
    const inner = defs.trim().replace(/^\[|\]$/g, "");
    for (const word of inner.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
      if (word.includes("=")) {
        const [id, value] = word.split("=", 2);
        add(id.trim(), value.trim());
      } else {
        const dim = dimForValue(model, word);
        if (dim) add(dim.id, word);
        else if (dimById(model, word)) add(word, "true");
      }
    }
  } else if (defs && typeof defs === "object") {
    for (const [id, value] of Object.entries(defs)) add(id, value);
  }
}

async function loadCatalog() {
  const account = pool.select();
  if (!account) throw new Error("no usable account in the pool; cannot fetch the model catalog");

  try {
    const list = await Cursor.models.list({ apiKey: account.key });
    const byCanon = new Map();
    for (const m of list) {
      byCanon.set(canon(m.id), m);
      for (const alias of m.aliases ?? []) {
        // Aliases collide (many models are called "opus"): first one wins,
        // and the list is newest-first.
        if (!byCanon.has(canon(alias))) byCanon.set(canon(alias), m);
      }
    }
    return { list, byCanon };
  } finally {
    // Catalog queries are not inference requests: the reservation ends here,
    // otherwise one failed fetch would strand the account in-flight forever.
    pool.release(account);
  }
}

export async function getCatalog({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < CACHE_TTL) return cached;
  if (inflight) return inflight;
  inflight = loadCatalog()
    .then((c) => {
      cached = c;
      cachedAt = Date.now();
      log.info(`model catalog refreshed, ${c.list.length} models`);
      return c;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Resolve `claude-opus-5[1m,max]` into the SDK's ModelSelection.
 *
 * Bare words resolve against the model's own declared parameter values, so
 * `1m` / `max` / `thinking` all work without knowing which dimension they
 * belong to.
 */
export async function resolveModel(publicName) {
  const { byCanon } = await getCatalog();

  const stripped = stripPrefix(publicName);
  const { base, words } = splitModelSpec(stripped);
  const model = byCanon.get(canon(base));
  if (!model) {
    const err = new Error(`unknown model ${publicName}`);
    err.statusCode = 400;
    throw err;
  }

  const params = words.map((w) => parseParamWord(w, model)).filter(Boolean);
  applyCheapDefaults(model, params);
  appendConfiguredDefaults(model, stripped, params);

  return params.length ? { id: model.id, params } : { id: model.id };
}

/** For `GET /admin/models`: the full catalog the admin panel wants. */
export async function listAdminModels() {
  const { list } = await getCatalog();
  return list.map((m) => ({
    id: config.prefix + m.id,
    // Unprefixed id keeps the frontend's vendor grouping (claude-/gpt-) intact.
    rawId: m.id,
    displayName: m.displayName ?? m.id,
    description: m.description ?? null,
    aliases: m.aliases ?? [],
    parameters: m.parameters ?? [],
    variants: m.variants ?? [],
  }));
}

/** For `GET /v1/models` (OpenAI shape). */
export async function listModels() {
  const { list } = await getCatalog();
  return list.map((m) => ({
    id: config.prefix + m.id,
    object: "model",
    created: 0,
    owned_by: "cursorapi",
    display_name: m.displayName,
    // Parameter dimensions, so clients know what `[1m,max]` accepts.
    parameters: (m.parameters ?? []).map((p) => ({
      id: p.id,
      values: p.values.map((v) => v.value),
    })),
  }));
}

/**
 * Anthropic-shaped catalog for Anthropic-side clients (Claude Code etc.).
 * Shares the same cache, so it always mirrors Cursor's list.
 */
export async function listModelsAnthropic() {
  const { list } = await getCatalog();
  return list.map((m) => ({
    type: "model",
    id: config.prefix + m.id,
    display_name: m.displayName ?? m.id,
    created_at: "2026-01-01T00:00:00Z",
    // Non-standard: Cursor's parameter dimensions for capability discovery.
    parameters: (m.parameters ?? []).map((p) => ({
      id: p.id,
      display_name: p.displayName ?? p.id,
      values: (p.values ?? []).map((v) => v.value),
    })),
  }));
}

/**
 * Readable account of a catalog fetch failure (usually: every account is
 * dead). Admin/log callers get the full detail; `brief` (client-facing
 * responses) drops the upstream error text, which may carry internal ids.
 */
export function describeCatalogError(err, brief = false) {
  return brief
    ? "the model catalog is temporarily unavailable"
    : `failed to fetch the model catalog: ${errShape(err).message}`;
}
