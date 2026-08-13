// Authentication for two roles: client (calling key, /v1/*) and admin
// (control surface). Admins prove identity with a session cookie or a
// password header (Bearer, x-api-key, or Basic). The server never sends
// WWW-Authenticate, so browsers never pop the native login dialog.

import crypto from "node:crypto";
import { config } from "./settings.mjs";
import { cookie, validSession } from "./sessions.mjs";

export const SESSION_COOKIE = "cursorapi_sess";

function constantCompare(a, b) {
  const aa = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (aa.length !== bb.length) {
    crypto.timingSafeEqual(aa, aa);
    return false;
  }
  return crypto.timingSafeEqual(aa, bb);
}

function parseBasic(auth) {
  const m = /^Basic\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return (i >= 0 ? decoded.slice(i + 1) : decoded).trim();
}

function parseBearer(auth) {
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return (m ? m[1] : auth).trim();
}

export function extractKey(headers) {
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const basic = parseBasic(auth.trim());
    if (basic !== null) return basic;
    return parseBearer(auth.trim());
  }
  const alt = headers["x-api-key"];
  return typeof alt === "string" ? alt.trim() : "";
}

function keyMatches(key, candidates) {
  return Boolean(key) && candidates.some((k) => constantCompare(key, k));
}

export function isClient(headers) {
  if (!config.clientKeys.length) return true;
  return keyMatches(extractKey(headers), config.clientKeys);
}

export function isAdminSecret(key) {
  if (config.adminKey) return keyMatches(key, [config.adminKey]);
  if (!config.clientKeys.length) return true;
  return keyMatches(key, config.clientKeys);
}

export function isAdmin(headers) {
  if (validSession(cookie(headers, SESSION_COOKIE))) return true;
  return isAdminSecret(extractKey(headers));
}

export function authMode() {
  const c = config.clientKeys.length ? `${config.clientKeys.length} client key(s)` : "no auth (localhost only)";
  const a = config.adminKey ? "separate admin password" : "admin password reuses client keys";
  return `${c}, ${a}`;
}
