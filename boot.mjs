// Startup entry: boot.mjs -> src/app.mjs.
// The OTA crash-loop guard runs before anything else; only then the business
// entry loads. No top-level await: esbuild CJS bundles forbid it.

import { bumpBootAttempts } from "./src/guard.mjs";
const boot = bumpBootAttempts();
if (boot?.rolledBack) {
  process.stderr.write(
    `[guard] crash loop detected (${boot.attempts} consecutive boot failures); rolled back from cursorapi.bak (bad version kept as ${boot.failed})\n`,
  );
}

async function main() {
  await import("./src/app.mjs");
}

main().catch((err) => {
  console.error(`[boot] startup failed: ${err?.stack ?? err}`);
  process.exit(1);
});
