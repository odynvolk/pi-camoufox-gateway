/**
 * Extension core, free of pi imports so it can be driven from tests with the fake gateway.
 *
 * `camoufox-gateway.ts` is the only file that knows about pi's registration API; everything that decides what a
 * tool *does* lives here.
 */

import { DEFAULT_CONFIG, isRecord, loadConfig, type CamoufoxConfig } from "./config.ts";
import { createCache, type Cache } from "./cache.ts";
import { GatewayError } from "./errors.ts";
import { enginesFromConfig, type TriedStep } from "./engines/chain.ts";
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
  /**
   * A word about what the call is doing right now, for pi's tool UI.
   *
   * Optional because the core is driven directly from tests, and because the search path can be two
   * engines deep with nothing between them reaching the caller. Deliberately a sentence rather than a
   * fraction: nothing here can promise how far along a gateway request is.
   */
  onProgress?: (note: string) => void;
}

export interface ToolOutcome<T> {
  /** What the model sees. */
  text: string;
  /** Structured detail for rendering and state reconstruction. */
  details: T;
}

/**
 * What each tool's `details` carries: its outcome, minus the prose.
 *
 * Named rather than inlined because the registration boundary has to spell out `structuredContent`
 * field by field, and it can only do that against a type that says what is actually in there.
 */
export type SearchDetails = Omit<SearchOutcome, "text">;
export type ReadDetails = Omit<ReadOutcome, "text">;

/**
 * What `read` hands the registration boundary: prose, metadata, and the page body itself.
 *
 * The body is in neither of the other two by design — `content` is the page wrapped in a header and the
 * notes a model needs, and `details` leaves it out so a transcript does not hold a page twice. A
 * structured caller wants the bare body, so it has to travel somewhere else.
 */
export interface ReadToolResult extends ToolOutcome<ReadDetails> {
  pageText: string;
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
  /** Bypass the page cache. */
  fresh?: boolean;
}

export interface Extension {
  search(args: SearchToolArgs, context?: ToolCallContext): Promise<ToolOutcome<SearchDetails>>;
  read(args: ReadToolArgs, context?: ToolCallContext): Promise<ReadToolResult>;
  /** Idempotent: pi may call shutdown while a reload or session replacement already did. */
  shutdown(): Promise<void>;
  gatewayUrl: string;
  config: CamoufoxConfig;
  /**
   * Set when the config file could not be read, which means `config` is only the shipped defaults.
   * Error rendering needs it: a defaults-only `gatewayUrl` is a url the user never configured.
   */
  configError?: string;
}

export const SEARCH_DESCRIPTION =
  "Search the web through a Camoufox browser gateway. Returns ranked titles, urls and snippets. Set resolve:true when you need clean final urls (costs one extra page load per result).";
export const READ_DESCRIPTION =
  "Read a web page through a Camoufox browser gateway so JavaScript-rendered pages work. " +
  "Thin pages are re-snapshotted until they stop growing; pass waitFor (a CSS selector) for content that renders late. " +
  "Returns page text (bounded, use offset to continue) and optionally a JSON-Schema extraction. " +
  "Pages are cached for a few minutes; pass fresh:true when you need the page as it is now. " +
  "Internal addresses are refused unless network.allowPrivateHosts is set.";

export interface ExtensionDepsWithConfig extends ExtensionDeps {
  /** A broken config file must not be silently replaced with defaults. */
  configError?: string;
}

export function createExtension(deps: ExtensionDepsWithConfig): Extension {
  const { client, config, cache, userId } = deps;

  const search = searchTool({ client, engines: enginesFromConfig(config.engines), config, cache, userId });
  const read = readTool({ client, config, cache, userId });

  const guard = (): void => {
    if (deps.configError) {
      throw new GatewayError("config_error", deps.configError);
    }
  };

  /**
   * Fail fast when the gateway is simply down. A success is cached for the client's success window; a
   * failure for its `preflightRetryAfterMs` window, a much shorter default. So a gateway that fails
   * faster than that window costs one cheap `gateway_unreachable` per window instead of a full connect
   * timeout per tool call, and concurrent callers share one probe however long a failure takes.
   *
   * The failure window is short deliberately: holding it for the whole success window would turn one
   * transient blip into that entire window of refusals. It cannot bound a probe that itself runs to the
   * client timeout — a gateway that hangs rather than refuses is re-dialled by each sequential caller.
   * Recorded as D.4 in `docs/improvements/2026-10-18-code.md`.
   *
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
    ...(deps.configError ? { configError: deps.configError } : {}),

    async search(args, context) {
      guard();
      await liveness(context?.signal);
      const outcome: SearchOutcome = await search.search({
        ...args,
        signal: context?.signal,
        ...(context?.onProgress ? { onProgress: context.onProgress } : {}),
      });
      return { text: outcome.text, details: outcomeToDetails(outcome) };
    },

    async read(args, context) {
      guard();
      await liveness(context?.signal);
      const outcome: ReadOutcome = await read.read({
        ...args,
        signal: context?.signal,
        ...(context?.onProgress ? { onProgress: context.onProgress } : {}),
      });
      const { text: _text, ...rest } = outcome;
      return {
        text: renderRead(outcome),
        // The body is already in `content`; details keeps the metadata the model needs to continue
        // reading, not a second copy of the page. Same rule as search's `outcomeToDetails`.
        details: rest,
        pageText: outcome.text,
      };
    },

    async shutdown() {
      await client.deleteSession({ userId });
    },
  };
}

function outcomeToDetails(outcome: SearchOutcome): SearchDetails {
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
  // Name the cache before anything a cached page can mislead about: the model cannot tell a page it
  // fetched from one it did not, and `fresh` is the only lever that changes that.
  if (outcome.fromCache) {
    notes.push("[served from the page cache — the page was not re-fetched; read again with fresh:true to force a navigation]");
  }
  // A capped budget is a different situation from a short page. The header already says how much came
  // back; what the model cannot infer from it is that the ceiling — not the page, and not its own
  // `maxChars` — did the cutting, so re-asking with a bigger number returns the same text. Sent only
  // when there is more to get: a cap that cost nothing would point at an offset past the end.
  if (outcome.cappedAt !== undefined && (outcome.truncated || outcome.hasMore)) {
    const why = `maxChars capped at ${outcome.cappedAt} by read.maxCharsCeiling`;
    notes.push(`[${why} — a larger maxChars returns no more; continue with offset]`);
  }
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

export interface ErrorContext {
  /** The configured gateway url, but only once a config has actually been loaded and read. */
  gatewayUrl?: string;
}

/**
 * The chain's per-engine record, as the model should see it.
 *
 * Read defensively rather than trusted: `details` is a `Record<string, unknown>` that travels through
 * pi, and a `tried` that arrived malformed is not a reason to print `undefined=` next to a fault.
 */
function triedChain(details: Record<string, unknown> | undefined): string[] {
  const steps = details?.tried;
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((step): step is TriedStep => isRecord(step) && typeof step.engine === "string" && typeof step.code === "string")
    .map((step) => `${step.engine}=${step.code}`);
}

/**
 * Failure text the model can act on: the code first, then whatever the reader can do with.
 *
 * `context` carries only what was verified. A config that failed to load resolves to the shipped
 * defaults, and quoting those is how a broken file used to send a user to debug a gateway at an
 * address they never set.
 */
export function formatError(error: unknown, context: ErrorContext): { text: string; details: Record<string, unknown> } {
  // Anything from the transport arrives already coded: `requestJson` wraps even a bare throw at that
  // boundary. So an error reaching here unclassified came from our own code, and calling it
  // `gateway_error` would send the reader to debug a service that reported nothing.
  const gatewayError = error instanceof GatewayError ? error : new GatewayError("internal_error", String(error));
  const lines = [`${gatewayError.code}: ${gatewayError.message}`];
  if (gatewayError.code === "internal_error") {
    // Worded as what this branch actually knows: nothing arrived with a gateway code. Whether a request
    // went out and came back clean is not something the type can establish from here.
    lines.push("No gateway code was reported, so this is the extension's own plumbing, not a gateway fault.");
  }
  if (gatewayError.code === "config_error") {
    lines.push("Nothing was sent to the gateway: fix the config file and try again.");
  }
  if (gatewayError.code === "gateway_unreachable") {
    lines.push(
      context.gatewayUrl
        ? `Gateway configured as ${context.gatewayUrl}. Check the service and try \`GET ${context.gatewayUrl}/\`.`
        : "No gateway url is known for this client.",
    );
  }
  // Read here rather than where the chain is printed: the advice below has to know whether the fallback
  // engine is a lever left or one that already moved.
  const chain = triedChain(gatewayError.details);
  if (gatewayError.code === "consent_wall") {
    // Recommending a fallback the next line reports as already run sends the reader to a lever that is
    // not there — the same mistake the chain line exists to stop.
    lines.push(
      chain.length > 1
        ? "Google interstitial rather than results; a narrower query usually clears this."
        : "Google interstitial rather than results; a narrower query or the fallback engine usually clears this.",
    );
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
  if (gatewayError.code === "destination_unreported") {
    lines.push(
      'This gateway will not say where a tab ended up, so every page would be returned unchecked. Upgrade it, or accept the risk with "network": { "allowPrivateHosts": true } and an empty blockedHosts.',
    );
  }
  if (gatewayError.code === "parse_error") {
    // The one code whose advice has to say whose fault it is likely to be. `empty_results` means the
    // engine answered and found nothing, which a narrower query can move; this means we could not read
    // the answer, which it cannot.
    lines.push("Nothing on the page had the shape of a link, so this is likelier our parser than your query — repeating it is unlikely to change the answer.");
  }
  // A chain that walked past a non-terminal code re-throws the *first* error, because that is the one
  // that says something about the query. So the second engine's different failure was invisible: a
  // `consent_wall` from google was the last word the model got even after duckduckgo went blind with
  // `parse_error`. The success path has named its chain all along (`formatResults`); this is the same
  // fact on the path that did not succeed, and the only place the fallback's outcome is stated at all.
  if (chain.length > 1) {
    lines.push(`Engines tried: ${chain.join(", ")}.`);
  }
  return {
    text: lines.join("\n"),
    // `code` last, because it is the thing the model acts on: details come from wherever the error
    // carries them, and one of them must not be able to relabel the fault after the fact.
    details: { ...(gatewayError.details ?? {}), code: gatewayError.code },
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
