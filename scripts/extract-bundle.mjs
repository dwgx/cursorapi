#!/usr/bin/env node
// Parse ESM webpack bundle (index.js style): extract every module map (var X={...}) and entry code.
// Usage: node extract-bundle.mjs <file> <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { findMatchingBrace, beautify } from './bundle-scan.js';

const [, , file, outDir] = process.argv;
const src = fs.readFileSync(file, 'utf8');

function extractModules(body) {
  const mods = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && (body[i] === ' ' || body[i] === '\n' || body[i] === ',')) i++;
    if (i >= body.length || body[i] === '}') break;
    if (body[i] !== '"' && body[i] !== "'") {
      // bare-identifier external module: id(e,t,n){...} — skip its body, keep going
      const m = /^[A-Za-z_$][\w$]*\(/.exec(body.slice(i, i + 64));
      if (m) {
        const close = findMatchingBrace(body, i + m[0].length - 1);
        if (close < 0) break;
        i = close + 1;
        continue;
      }
      i++;
      continue;
    }
    const q = body[i];
    let j = i + 1;
    while (j < body.length && body[j] !== q) {
      if (body[j] === '\\') j++;
      j++;
    }
    const id = body.slice(i + 1, j);
    j++;
    while (j < body.length && body[j] !== '(') j++;
    if (body[j] !== '(') break;
    const close = findMatchingBrace(body, j);
    if (close < 0) break;
    mods.push({ id, body: body.slice(j, close + 1) });
    i = close + 1;
  }
  return mods;
}

const mapRe = /(?:^|[^=>])=\s*\{/g;
let m;
const maps = [];
while ((m = mapRe.exec(src)) !== null) {
  const open = m.index + m[0].length - 1;
  let k = open + 1;
  while (k < src.length && (src[k] === ' ' || src[k] === '\n' || src[k] === '\r' || src[k] === '\t')) k++;
  if (k >= src.length || (src[k] !== '"' && src[k] !== "'")) continue;
  const q = src[k];
  let e2 = k + 1;
  while (e2 < src.length && src[e2] !== q) {
    if (src[e2] === '\\') e2++;
    e2++;
  }
  e2++;
  while (e2 < src.length && (src[e2] === ' ' || src[e2] === '\n')) e2++;
  if (src[e2] !== '(') continue;
  const close = findMatchingBrace(src, open);
  if (close < 0) break;
  const nm = /([A-Za-z_$][\w$]*)\s*$/.exec(src.slice(0, m.index + 1));
  maps.push({ name: nm ? nm[1] : `map${maps.length}`, start: m.index, end: close + 1, src: src.slice(open + 1, close) });
  mapRe.lastIndex = close + 1;
}

fs.mkdirSync(outDir, { recursive: true });
let total = 0;
let idx = '';
for (const map of maps) {
  const mods = extractModules(map.src);
  if (mods.length === 0) continue;
  const dir = path.join(outDir, map.name);
  fs.mkdirSync(dir, { recursive: true });
  mods.forEach((mod, i) => {
    const clean = mod.id.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(-110);
    const outPath = path.join(dir, `${String(i + 1).padStart(3, '0')}_${clean}.js`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, beautify(mod.body));
    idx += `${map.name}::${i + 1}\t${mod.id}\n`;
  });
  total += mods.length;
  console.log(`map ${map.name}: ${mods.length} modules`);
}
fs.writeFileSync(path.join(outDir, '_INDEX.txt'), idx);

const lastEnd = maps.length ? Math.max(...maps.map(m => m.end)) : 0;
const entry = src.slice(lastEnd);
if (entry.trim().length > 50) {
  const outPath = path.join(outDir, '_entry.js');
  fs.writeFileSync(outPath, beautify(entry));
  console.log(`entry: ${entry.length} chars -> ${outPath}`);
  console.log(`total modules: ${total}`);
}
