/**
 * Configuration for the camoufox gateway extension.
 *
 * Resolution order (last wins): built-in defaults, then the JSON config file, then environment
 * variables. The config file lives at `$CAMOUFOX_CONFIG_PATH` or, by default,
 * `<pi agent dir>/camoufox.json` so it follows the same convention as pi-web-search's
 * `web-search.json`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The engines we have adapters for. One source for the union type, config validation, and the
 * model-facing hint in the tool schema, so a new engine cannot be half-registered.
 */
export const ENGINE_NAMES = ["google", "duckduckgo"] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

export interface EngineConfig {
  name: EngineName;
  enabled: boolean;
}

export interface CamoufoxConfig {
  /** Base URL of the camofox-browser gateway. */
  gatewayUrl: string;
  /** Optional bearer token for gateways that enforce `BearerAuth`. */
  apiKey?: string;
  /** Ordered engine chain; the first enabled engine is tried first. */
  engines: EngineConfig[];
  cache: { serpMs: number; pageMs: number };
  read: { defaultMaxChars: number };
  search: { maxResults: number };
  /** Hosts `camoufox_read` must never navigate to. Empty means no host policy. */
  blockedHosts: string[];
  timeoutMs: number;
}

export const DEFAULT_CONFIG: CamoufoxConfig = {
  gatewayUrl: "http://localhost:9377",
  engines: [
    { name: "google", enabled: true },
    { name: "duckduckgo", enabled: true },
  ],
  cache: { serpMs: 30 * 60 * 1000, pageMs: 10 * 60 * 1000 },
  read: { defaultMaxChars: 12_000 },
  search: { maxResults: 10 },
  blockedHosts: [],
  timeoutMs: 30_000,
};

const KNOWN_ENGINES = new Set<string>(ENGINE_NAMES);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  /** Where to look for the config file. Missing file at this path means "use defaults". */
  configPath?: string;
  /** Environment override, defaults to `process.env`. Pass `{}` in tests. */
  env?: NodeJS.ProcessEnv;
  /** Home directory, overridable for tests. */
  homeDir?: string;
}

function defaultConfigPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const agentDir = env.PI_CODING_AGENT_DIR || join(homeDir, ".pi", "agent");
  return join(agentDir, "camoufox.json");
}

function fail(message: string): never {
  throw new ConfigError(message);
}

function assertString(value: unknown, key: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path}: "${key}" must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function assertFiniteNumber(value: unknown, key: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${path}: "${key}" must be a positive number (got ${JSON.stringify(value)})`);
  }
  return value;
}

function parseGatewayUrl(raw: unknown, path: string): string {
  const url = assertString(raw, "gatewayUrl", path);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${path}: "gatewayUrl" must be an absolute URL with an http:// or https:// scheme (got "${url}")`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(`${path}: "gatewayUrl" must use http:// or https:// (got "${parsed.protocol.replace(":", "")}")`);
  }
  return url.replace(/\/+$/, "");
}

/**
 * Keys that are valid but absent from `DEFAULT_CONFIG` because "unset" is their only default. The
 * validator derives known keys from that object, so these have to be declared next to the type —
 * `mergeOntoDefaults` already has a branch for `apiKey`, and without this a config file that sets it
 * would be rejected before that branch can run.
 */
const OPTIONAL_KEYS: (keyof CamoufoxConfig)[] = ["apiKey"];

/** Valid keys per section, derived from the defaults so a new setting validates itself. */
const SECTION_FIELDS = new Map<string, Set<string>>(
  Object.entries(DEFAULT_CONFIG).map(([key, value]) => [
    key,
    typeof value === "object" && value !== null && !Array.isArray(value) ? new Set(Object.keys(value as Record<string, unknown>)) : new Set<string>(),
  ]),
);

const KNOWN_TOP_LEVEL = new Set<string>([...SECTION_FIELDS.keys(), ...OPTIONAL_KEYS]);

/**
 * Unknown keys are a hard error: a typo'd setting would otherwise look like it took effect. That
 * applies inside `cache`/`read`/`search` exactly as it does at the top level, so a misspelled
 * `cache.serpM` has to fail for the same reason `timeoutM` does.
 */
function rejectUnknownKeys(raw: Record<string, unknown>, path: string): void {
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      fail(`${path}: unknown config key "${key}" (known: ${[...KNOWN_TOP_LEVEL].sort().join(", ")})`);
    }
    const fields = SECTION_FIELDS.get(key);
    if (!fields || fields.size === 0) continue;
    // A section that is not an object is the section parser's problem to explain, not ours.
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    for (const inner of Object.keys(value as Record<string, unknown>)) {
      if (!fields.has(inner)) {
        fail(`${path}: unknown config key "${key}.${inner}" (known: ${[...fields].sort().join(", ")})`);
      }
    }
  }
}

function parseEngines(raw: unknown, path: string): EngineConfig[] {
  if (raw === undefined) return structuredClone(DEFAULT_CONFIG.engines);
  if (!Array.isArray(raw)) fail(`${path}: "engines" must be an array of { name, enabled? }`);
  const engines: EngineConfig[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (!KNOWN_ENGINES.has(entry)) fail(`${path}: unknown engine "${entry}" (known: ${ENGINE_NAMES.join(", ")})`);
      engines.push({ name: entry as EngineName, enabled: true });
      continue;
    }
    if (entry === null || typeof entry !== "object") {
      fail(`${path}: engine entries must be strings or { name, enabled? }`);
    }
    const record = entry as Record<string, unknown>;
    const name = assertString(record.name, "name", `${path}.engines[]`);
    if (!KNOWN_ENGINES.has(name)) fail(`${path}: unknown engine "${name}" (known: ${ENGINE_NAMES.join(", ")})`);
    const enabled = record.enabled === undefined ? true : Boolean(record.enabled);
    engines.push({ name: name as EngineName, enabled });
  }
  if (engines.filter((engine) => engine.enabled).length === 0) {
    fail(`${path}: "engines" must keep at least one engine enabled`);
  }
  return engines;
}

function parseBlockedHosts(raw: unknown, path: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((host) => typeof host !== "string" || host.length === 0)) {
    fail(`${path}: "blockedHosts" must be an array of host strings`);
  }
  return (raw as string[]).map((host) => host.toLowerCase());
}

function readConfigFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(`${path}: config file not found (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`${path}: invalid JSON (${(error as Error).message})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${path}: config must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Merge a partial file config over defaults, keeping defaults for anything absent. */
function mergeOntoDefaults(file: Record<string, unknown>, path: string): CamoufoxConfig {
  rejectUnknownKeys(file, path);
  const merged = structuredClone(DEFAULT_CONFIG);

  if (file.gatewayUrl !== undefined) merged.gatewayUrl = parseGatewayUrl(file.gatewayUrl, path);
  if (file.apiKey !== undefined) merged.apiKey = assertString(file.apiKey, "apiKey", path);
  if (file.timeoutMs !== undefined) merged.timeoutMs = assertFiniteNumber(file.timeoutMs, "timeoutMs", path);
  merged.engines = parseEngines(file.engines, path);

  if (file.cache !== undefined) {
    if (file.cache === null || typeof file.cache !== "object") fail(`${path}: "cache" must be an object`);
    const cache = file.cache as Record<string, unknown>;
    if (cache.serpMs !== undefined) merged.cache.serpMs = assertFiniteNumber(cache.serpMs, "cache.serpMs", path);
    if (cache.pageMs !== undefined) merged.cache.pageMs = assertFiniteNumber(cache.pageMs, "cache.pageMs", path);
  }

  if (file.read !== undefined) {
    if (file.read === null || typeof file.read !== "object") fail(`${path}: "read" must be an object`);
    const read = file.read as Record<string, unknown>;
    if (read.defaultMaxChars !== undefined) {
      merged.read.defaultMaxChars = assertFiniteNumber(read.defaultMaxChars, "read.defaultMaxChars", path);
    }
  }

  if (file.search !== undefined) {
    if (file.search === null || typeof file.search !== "object") fail(`${path}: "search" must be an object`);
    const search = file.search as Record<string, unknown>;
    if (search.maxResults !== undefined) {
      merged.search.maxResults = assertFiniteNumber(search.maxResults, "search.maxResults", path);
    }
  }

  if (file.blockedHosts !== undefined) merged.blockedHosts = parseBlockedHosts(file.blockedHosts, path);

  return merged;
}

export function loadConfig(options: LoadConfigOptions = {}): CamoufoxConfig {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();

  let config: CamoufoxConfig;
  const explicitPath = env.CAMOUFOX_CONFIG_PATH;
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      fail(`CAMOUFOX_CONFIG_PATH points at "${explicitPath}" which was not found`);
    }
    config = mergeOntoDefaults(readConfigFile(explicitPath), explicitPath);
  } else {
    const path = options.configPath ?? defaultConfigPath(env, home);
    config = existsSync(path) ? mergeOntoDefaults(readConfigFile(path), path) : structuredClone(DEFAULT_CONFIG);
  }

  if (env.CAMOUFOX_GATEWAY_URL) config.gatewayUrl = parseGatewayUrl(env.CAMOUFOX_GATEWAY_URL, "$CAMOUFOX_GATEWAY_URL");
  if (env.CAMOUFOX_API_KEY) config.apiKey = assertString(env.CAMOUFOX_API_KEY, "apiKey", "$CAMOUFOX_API_KEY");

  return config;
}
