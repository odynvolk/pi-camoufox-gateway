/**
 * A `CamoufoxConfig` for tests, built from the real defaults.
 *
 * Hand-written config literals drift silently: a new setting added to `DEFAULT_CONFIG` is simply
 * absent, and the code under test reads `undefined` while the suite stays green. Deriving from the
 * loader's own defaults makes that impossible.
 */

import { DEFAULT_CONFIG } from "../../src/config.ts";

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(base, patch) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : structuredClone(value);
  }
  return out;
}

export function testConfig(overrides = {}) {
  return merge(DEFAULT_CONFIG, overrides);
}
