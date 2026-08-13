// P2 test fetch stub: replaces global fetch so updater.mjs's GitHub mirror
// chain never leaves the machine during the update-check concurrency phase,
// while fetchTags keeps its real behaviour (ok + JSON tag list). Every call
// is appended to CSPK_PRESSURE_DIR/fetch-count.json — the driver asserts the
// ttlCache did its job by counting lines (one checkUpdate = one fetch).

import fs from "node:fs";
import path from "node:path";

const dir = process.env.CSPK_PRESSURE_DIR ?? path.join(process.cwd(), "pressure2");
const outFile = path.join(dir, "fetch-count.json");

globalThis.fetch = async (url) => {
  const hit = { ts: Date.now(), url: String(url).slice(0, 180) };
  fs.appendFileSync(outFile, JSON.stringify(hit) + "\n");
  return new Response(JSON.stringify([{ name: "v9.9.9" }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
