// In-memory admin sessions: a login page exchanges a cookie, with a
// delay penalty against brute force instead of a lockout (a lockout
// lets anyone lock you out of your own panel). Memory only, so a
// restart just means logging in again.

import crypto from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 64;

const liveSessions = new Map();
let failureStreak = 0;

function expireStale() {
  const now = Date.now();
  for (const [token, expiry] of liveSessions) {
    if (expiry <= now) liveSessions.delete(token);
  }
}

function mintToken() {
  expireStale();
  if (liveSessions.size >= MAX_ACTIVE_SESSIONS) {
    const soonest = [...liveSessions.entries()].sort((a, b) => a[1] - b[1])[0];
    if (soonest) liveSessions.delete(soonest[0]);
  }
  return crypto.randomBytes(32).toString("base64url");
}

export function createSession() {
  const token = mintToken();
  liveSessions.set(token, Date.now() + SESSION_TTL_MS);
  return { token, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
}

export function validSession(token) {
  if (!token) return false;
  const expiry = liveSessions.get(token);
  if (!expiry) return false;
  if (expiry <= Date.now()) {
    liveSessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token) {
  if (token) liveSessions.delete(token);
}

export function sessionCount() {
  expireStale();
  return liveSessions.size;
}

export function penaltyMs() {
  failureStreak += 1;
  return Math.min(Math.max(0, failureStreak - 3) * 400, 5000);
}

export function resetPenalty() {
  failureStreak = 0;
}

export function cookie(headers, name) {
  const raw = headers?.cookie;
  if (typeof raw !== "string") return "";
  for (const piece of raw.split(";")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    if (piece.slice(0, eq).trim() === name) return piece.slice(eq + 1).trim();
  }
  return "";
}
