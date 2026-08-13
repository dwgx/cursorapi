#!/usr/bin/env node
// Extract webpack esm modules from @cursor/sdk chunks (__webpack_esm_modules__ style).
// Usage: node extract-chunks.mjs <dist-esm-dir> <out-dir> [chunk...]
import fs from 'node:fs';
import path from 'node:path';
import { findMatchingBrace, beautify } from './bundle-scan.js';

const [, , distDir, outDir, ...only] = process.argv;

function extractModules(src) {
  const marker = 'export const __webpack_esm_modules__=';
  const start = src.indexOf(marker);
  if (start < 0) return null;
  let i = src.indexOf('{', start + marker.length);
  if (i < 0) return null;
  const mods = [];
  i++;
  while (i < src.length) {
    while (i < src.length && (src[i] === ' ' || src[i] === '\n' || src[i] === ',')) i++;
    if (src[i] === '}') break;
    if (src[i] !== '"' && src[i] !== "'") {
      const m = /^[A-Za-z_$][\w$]*\(/.exec(src.slice(i, i + 64));
      if (m) {
        const close = findMatchingBrace(src, i + m[0].length - 1);
        if (close < 0) break;
        i = close + 1;
        continue;
      }
      i++;
      continue;
    }
    const q = src[i];
    let j = i + 1;
    while (j < src.length && src[j] !== q) {
      if (src[j] === '\\') j++;
      j++;
    }
    const id = src.slice(i + 1, j);
    j++;
    while (j < src.length && src[j] !== '(') j++;
    if (src[j] !== '(') break;
    const close = findMatchingBrace(src, j);
    if (close < 0) break;
    mods.push({ id, body: src.slice(j, close + 1) });
    i = close + 1;
  }
  return mods;
}

for (const f of fs.readdirSync(distDir).filter(f => f.endsWith('.js'))) {
  if (only.length && !only.includes(f)) continue;
  const src = fs.readFileSync(path.join(distDir, f), 'utf8');
  const mods = extractModules(src);
  if (!mods) { console.log(`${f}: no modules`); continue; }
  const dir = path.join(outDir, f.replace(/\.js$/, ''));
  fs.mkdirSync(dir, { recursive: true });
  mods.forEach((m, idx) => {
    const clean = m.id.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(-100);
    const outPath = path.join(dir, `${String(idx + 1).padStart(2, '0')}_${clean}.js`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, beautify(m.body));
  });
  console.log(`${f}: ${mods.length} modules`);
}
