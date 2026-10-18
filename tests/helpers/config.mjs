/**
 * A `CamoufoxConfig` for tests, built from the real defaults.
 *
 * Hand-written config literals drift silently: a new setting added to `DEFAULT_CONFIG` is simply
 * absent, and the code under test reads `undefined` while the suite stays green. Deriving from the
 * loader's own defaults makes that impossible.
 *
 * Deriving is not enough on its own. The loader is bypassed, so `rejectUnknownKeys` never runs on the
 * overrides either, and a typo'd setting (`read.settlePolllMs`) merges in as an unknown key while the
 * real one keeps its default — the test then exercises a configuration it does not name. This helper
 * refuses unknown or mis-shaped keys for the same reason the loader does.
 */

import { DEFAULT_CONFIG } from "../../src/config.ts";

/** Valid but absent from `DEFAULT_CONFIG`, because "unset" is its only default. Mirrors `OPTIONAL_KEYS`. */
const OPTIONAL_KEYS = ["apiKey"];

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(base, patch, path) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in base) && !OPTIONAL_KEYS.includes(key)) {
      throw new Error(`unknown test config key "${path}${key}" (known: ${[...Object.keys(base), ...OPTIONAL_KEYS].sort().join(", ")})`);
    }
    if (key in base && isPlainObject(value) !== isPlainObject(base[key])) {
      throw new Error(`test config key "${path}${key}" must be ${isPlainObject(base[key]) ? "an object" : "a value"}, got ${JSON.stringify(value)}`);
    }
    if (isPlainObject(value) && isPlainObject(base[key])) assertKnownKeys(base[key], value, `${path}${key}.`);
  }
}

function merge(base, patch) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : structuredClone(value);
  }
  return out;
}

export function testConfig(overrides = {}) {
  assertKnownKeys(DEFAULT_CONFIG, overrides, "");
  return merge(DEFAULT_CONFIG, overrides);
}
