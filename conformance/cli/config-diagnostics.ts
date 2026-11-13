import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// Every diagnostic the frozen loader (packages/control/src/config.ts) can throw,
// in source order, cut at the first interpolation.
export const CONFIG_DIAGNOSTICS = [
  "OMNI_ENCRYPTION_KEY must be set to at least ",
  'OMNI_PORT must be an integer between 1 and 65535, got "',
  "OMNI_CLUSTER_MODE=true needs OMNI_DATABASE_URL to be a postgres:// URL",
  "OMNI_CLUSTER_MODE=true needs OMNI_REDIS_URL",
  "OMNI_DATABASE_URL and OMNI_REDIS_URL are cluster-mode settings; set OMNI_CLUSTER_MODE=true or unset them",
  'OMNI_METRICS_MAX_SERIES must be a positive integer, got "',
  'OMNI_TRACE_SAMPLE must be between 0 and 1, got "',
];

/** A line carrying one of them, as plain text or inside a JSON string. */
export function isConfigDiagnostic(line: string): boolean {
  return CONFIG_DIAGNOSTICS.some(
    (prefix) => line.includes(prefix) || line.includes(JSON.stringify(prefix).slice(1, -1)),
  );
}

/**
 * Fails when the list above and the frozen source disagree. Called by every
 * histogram-gated suite and by config-gate.ts, so a diagnostic added to the
 * loader cannot go unrecognised silently.
 */
export function assertCoversFrozenLoader(): void {
  const source = readFileSync(
    new URL("../../packages/control/src/config.ts", import.meta.url),
    "utf8",
  );
  const prefixes = [...source.matchAll(/throw new Error\(\s*(["`])([\s\S]*?)(?=\$\{|\1)/g)].map(
    (m) => m[2],
  );
  assert.deepEqual(prefixes, CONFIG_DIAGNOSTICS, "frozen config diagnostics changed");
  // Any throw at all, so a diagnostic raised through another error class counts.
  assert.equal((source.match(/\bthrow\b/g) ?? []).length, CONFIG_DIAGNOSTICS.length);
}
