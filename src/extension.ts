/**
 * Extension core, free of pi imports so it can be driven from tests with the fake gateway.
 *
 * `camoufox-gateway.ts` is the only file that knows about pi's registration API; everything that decides what a
 * tool *does* lives here.
 */

import { DEFAULT_CONFIG, loadConfig, type CamoufoxConfig } from "./config.ts";
import { createCache, type Cache } from "./cache.ts";
import { GatewayError } from "./errors.ts";
import { enginesFromConfig } from "./engines/chain.ts";
import { createGatewayClient, type GatewayClient } from "./gateway.ts";
import { readTool, type ReadOutcome } from "./tools/read.ts";
import { searchTool, type CachedSearch, type SearchOutcome } from "./tools/search.ts";

export interface ExtensionDeps {
  config: CamoufoxConfig;
  client: GatewayClient;
  cache: Cache<CachedSearch>;
  userId: string;
}

export interface ToolCallContext {
  signal?: AbortSignal;
}

export interface ToolOutcome<T> {
  /** What the model sees. */
  text: string;
  /** Structured detail for rendering and state reconstruction. */
  details: T;
}

export interface SearchToolArgs {
  query: string;
  n?: number;
  engine?: string;
  resolve?: boolean;
}

export interface ReadToolArgs {
  url: string;
  maxChars?: number;
  offset?: number;
  /** Hold for this selector before reading, for content the settle heuristic would miss. */
  waitFor?: string;
  schema?: Record<string, unknown>;
}

export interface Extension {
  search(args: SearchToolArgs, context?: ToolCallContext): Promise<ToolOutcome<Record<string, unknown>>>;
  read(args: ReadToolArgs, context?: ToolCallContext): Promise<ToolOutcome<Record<string, unknown>>>;
  /** Idempotent: pi may call shutdown while a reload or session replacement already did. */
  shutdown(): Promise<void>;
  gatewayUrl: string;
  config: CamoufoxConfig;
}

export const SEARCH_DESCRIPTION =
  "Search the web through a Camoufox browser gateway. Returns ranked titles, urls and snippets. Set resolve:true when you need clean final urls (costs one extra page load per result).";
export const READ_DESCRIPTION =
  "Read a web page through a Camoufox browser gateway so JavaScript-rendered pages work. " +
  "Thin pages are re-snapshotted until they stop growing; pass waitFor (a CSS selector) for content that renders late. " +
  "Returns page text (bounded, use offset to continue) and optionally a JSON-Schema extraction. " +
  "Internal addresses are refused unless network.allowPrivateHosts is set.";

export interface ExtensionDepsWithConfig extends ExtensionDeps {
  /** A broken config file must not be silently replaced with defaults. */
  configError?: string;
}

export function createExtension(deps: ExtensionDepsWithConfig): Extension {
  const { client, config, cache, userId } = deps;

  const search = searchTool({ client, engines: enginesFromConfig(config.engines), config, cache, userId });
  const read = readTool({ client, config, userId });

  const guard = (): void => {
    if (deps.configError) {
      throw new GatewayError("config_error", deps.configError);
    }
  };

  /**
   * Fail fast when the gateway is simply down. `preflight` caches for 60s, so a dead gateway costs
   * one cheap `gateway_unreachable` per window instead of a full connect timeout per tool call.
   * Anything else (an old gateway without `GET /`, a slow body) is not our business: let the real
   * request answer.
   */
  async function liveness(signal?: AbortSignal): Promise<void> {
    try {
      await client.preflight(signal);
    } catch (error) {
      if (error instanceof GatewayError && error.code === "gateway_unreachable") throw error;
    }
  }

  return {
    gatewayUrl: config.gatewayUrl,
    config,

    async search(args, context) {
      guard();
      await liveness(context?.signal);
      const outcome: SearchOutcome = await search.search({ ...args, signal: context?.signal });
      return { text: outcome.text, details: outcomeToDetails(outcome) };
    },

    async read(args, context) {
      guard();
      await liveness(context?.signal);
      const outcome: ReadOutcome = await read.read({ ...args, signal: context?.signal });
      const { text: _text, ...rest } = outcome;
      return {
        text: renderRead(outcome),
        // The body is already in `content`; details keeps the metadata the model needs to continue
        // reading, not a second copy of the page. Same rule as search's `outcomeToDetails`.
        details: { ...rest },
      };
    },

    async shutdown() {
      await client.deleteSession({ userId });
    },
  };
}

function outcomeToDetails(outcome: SearchOutcome): Record<string, unknown> {
  const { text: _text, ...rest } = outcome;
  return rest;
}

function renderRead(outcome: ReadOutcome): string {
  const header = `URL: ${outcome.url}${outcome.truncated ? ` (showing ${outcome.text.length} of ${outcome.totalChars} chars)` : ""}`;
  const footer = outcome.nextOffset !== null ? `\n\n[continue with offset=${outcome.nextOffset}]` : "";
  const extracted = outcome.extracted ? `\n\nExtracted: ${JSON.stringify(outcome.extracted)}` : "";
  // A page that stayed thin after every wait is a different situation from a short page: say which,
  // and name only a lever that can still move the outcome. The page is thinner than the default text
  // budget, so more `maxChars` helps only where we did the cutting, and a bigger settle budget is
  // only the answer when it ran out while the page was still growing.
  const notes: string[] = [];
  if (outcome.thinAfterWait) {
    const waited = outcome.settledInMs ? ` after waiting ${outcome.settledInMs}ms` : "";
    const knobs: string[] = [];
    if (outcome.stalledAtDeadline) knobs.push("raise read.waitForSettleMs");
    if (outcome.truncated) knobs.push("read with a larger maxChars");
    if (!outcome.waitForRequested && !outcome.waitNote) knobs.push("retry with waitFor set to a selector you expect");
    notes.push(
      knobs.length
        ? `[page was still only ${outcome.totalChars} chars${waited} — likely client-rendered; ${knobs.join(", or ")}]`
        : `[page was still only ${outcome.totalChars} chars${waited} — it stopped growing there, so it is thin rather than unfinished]`,
    );
  }
  if (outcome.waitNote) notes.push(`[${outcome.waitNote}]`);
  return `${header}\n\n${outcome.text}${extracted}${notes.length ? `\n\n${notes.join("\n")}` : ""}${footer}`;
}

/** Failure text the model can act on: the code is stated first, then the evidence. */
export function formatError(error: unknown, config: CamoufoxConfig): { text: string; details: Record<string, unknown> } {
  const gatewayError = error instanceof GatewayError ? error : new GatewayError("gateway_error", String(error));
  const lines = [`${gatewayError.code}: ${gatewayError.message}`];
  if (gatewayError.code === "gateway_unreachable") {
    lines.push(`Gateway configured as ${config.gatewayUrl}. Check the service and try \`GET ${config.gatewayUrl}/\`.`);
  }
  if (gatewayError.code === "consent_wall") {
    lines.push("Google interstitial rather than results; a narrower query or the fallback engine usually clears this.");
  }
  if (gatewayError.code === "private_network") {
    lines.push(
      'Set "network": { "allowPrivateHosts": true } in camoufox.json (or CAMOUFOX_ALLOW_PRIVATE_HOSTS=1) if this host is meant to be reachable.',
    );
  }
  // `host_blocked` and `unsupported` also fire on the destination the browser reports, by which point a
  // tab was opened and a page was fetched — only the pre-flight refusal may claim nothing went out.
  const preFlight = gatewayError.details?.stage !== "destination";
  if (gatewayError.code === "host_blocked") {
    lines.push(
      `The host is in your camoufox blockedHosts list, so its content was not returned.${preFlight ? "" : " The browser was redirected there."}`,
    );
  }
  if (gatewayError.code === "unsupported" && preFlight) {
    lines.push("Nothing was fetched from the gateway.");
  }
  return {
    text: lines.join("\n"),
    details: { code: gatewayError.code, ...(gatewayError.details ?? {}) },
  };
}

export interface ResolvedExtensionConfig {
  config: CamoufoxConfig;
  /** True when the file/config was unreadable and defaults are in use. */
  usedDefaults: boolean;
  error?: string;
}

/**
 * Load config for the extension, separating "nothing to read" from "something is wrong".
 *
 * A missing file at the *default* path already resolves to defaults inside `loadConfig`, so any
 * throw here means a real problem — a bad `CAMOUFOX_CONFIG_PATH`, malformed json, or a typo'd key.
 * Returning defaults in that case would hide a misconfigured gateway *and* drop the environment
 * layer, because env overrides are applied by `loadConfig` and never get a chance to run twice.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedExtensionConfig {
  try {
    return { config: loadConfig({ env }), usedDefaults: false };
  } catch (error) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      usedDefaults: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
