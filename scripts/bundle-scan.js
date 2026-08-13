#!/usr/bin/env node
// Shared scanning helpers for webpack bundle parsing (regex-literal aware).
export function scanString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j;
  }
  return src.length;
}

function isRegExpStart(src, i) {
  let j = i - 1;
  while (j >= 0 && (src[j] === ' ' || src[j] === '\n' || src[j] === '\r' || src[j] === '\t')) j--;
  if (j < 0) return true;
  const c = src[j];
  if ('(,=:[!&|?{};+-*%^~<>'.includes(c)) return true;
  const w = /[A-Za-z0-9_$]/.test(c);
  if (!w) return true; // e.g. after `)` it's usually division, but risky; treat non-word as regex-ish
  // check keyword before
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
  const kw = src.slice(k + 1, j + 1);
  return ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'do', 'else', 'yield', 'await', 'case', 'delete', 'void', 'throw'].includes(kw);
}

export function scanRegExp(src, i) {
  // src[i] === '/'
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j;
    else if (c === '\n') return j; // unterminated
  }
  return src.length;
}

export function scanLineComment(src, i) {
  let j = i + 2;
  while (j < src.length && src[j] !== '\n') j++;
  return j;
}

export function scanBlockComment(src, i) {
  let j = i + 2;
  while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
  return j + 1;
}

// Advance i past any string/regex/comment starting at i; return new i (or i if not special).
export function skipToken(src, i) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') return scanString(src, i);
  if (c === '/' && src[i + 1] === '/') return scanLineComment(src, i);
  if (c === '/' && src[i + 1] === '*') return scanBlockComment(src, i);
  if (c === '/' && isRegExpStart(src, i)) return scanRegExp(src, i);
  return i;
}

export function findMatchingBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`' || c === '/') {
      const ni = skipToken(src, i);
      if (ni !== i) { i = ni; continue; }
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

export function beautify(code) {
  let out = '';
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const n = code[i + 1];
    if (c === '"' || c === "'" || c === '`' || c === '/') {
      const ni = skipToken(code, i);
      if (ni !== i) {
        out += code.slice(i, ni + 1);
        i = ni;
        continue;
      }
    }
    if (c === ';') { out += ';\n'; continue; }
    if (c === '{') { out += '{\n'; continue; }
    if (c === '}') { out = out.replace(/\n\s*$/, ''); out += '\n}\n'; continue; }
    if (c === ',' && n !== ' ') { out += ', '; continue; }
    out += c;
  }
  return out;
}
