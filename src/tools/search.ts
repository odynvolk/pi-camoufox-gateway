/**
 * The search side of the extension: cache → engine chain → optional url resolution → model-facing
 * text. It owns no HTTP of its own; that lives behind `GatewayClient`.
 */

import type { CamoufoxConfig } from "../config.ts";
import { GatewayError } from "../errors.ts";
import { searchWithFallback, type ChainOutcome, type TriedStep } from "../engines/chain.ts";
import type { Engine } from "../engines/types.ts";
import type { GatewayClient } from "../gateway.ts";
import { resolveUrls, type ResolvableResult } from "../resolve.ts";
import type { SearchResult } from "../snapshot.ts";
import type { Cache } from "../cache.ts";

export interface SearchToolDeps {
  client: GatewayClient;
  engines: Engine[];
  config: CamoufoxConfig;
  cache: Cache<CachedSearch>;
  userId: string;
}

export interface SearchParams {
  query: string;
  n?: number;
  engine?: string;
  resolve?: boolean;
  signal?: AbortSignal;
}

/** What goes into the cache: the facts, no rendering. */
export type CachedSearch = Omit<SearchOutcome, "text" | "clampedTo" | "fromCache">;

export interface SearchOutcome {
  query: string;
  engine: string;
  results: ResolvableResult[];
  tried: TriedStep[];
  /** Set when the caller asked for more results than an engine can actually return. */
  clampedTo?: number;
  fromCache?: boolean;
  text: string;
}

const MAX_RESULTS_HARD_LIMIT = 10;

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function engineLabel(result: SearchResult): string {
  return result.host || new URL(result.url).hostname;
}

export function formatResults(outcome: {
  query: string;
  engine: string;
  results: ResolvableResult[];
  tried: TriedStep[];
  /** What the caller asked for, kept so the output can admit when it got fewer. */
  requested?: number;
  clampedTo?: number;
  shortBy?: number;
  fromCache?: boolean;
}): string {
  const lines: string[] = [];
  const fallback = outcome.tried.length > 1 ? ` (via ${outcome.engine}; tried ${outcome.tried.map((s) => `${s.engine}:${s.code}`).join(", ")})` : "";
  const asked = outcome.requested !== undefined && outcome.requested !== outcome.results.length ? ` (${outcome.results.length} of ${outcome.requested} asked for)` : "";
  lines.push(`Search results for "${outcome.query}" — ${outcome.results.length} result(s)${asked}${fallback}:`);
  outcome.results.forEach((result, index) => {
    const suffix = result.resolved === false ? " [url unresolved]" : "";
    lines.push(`${index + 1}. ${result.title}\n   ${result.url}${suffix}\n   ${engineLabel(result)}${result.snippet ? ` — ${result.snippet}` : ""}`);
  });
  if (outcome.clampedTo !== undefined) {
    lines.push(`(clamped to ${outcome.clampedTo}: the engine returns a page of ${outcome.clampedTo}; narrow the query for a different page)`);
  }
  if (outcome.shortBy) {
    lines.push(`(the page carried ${outcome.shortBy} fewer result(s) than asked for; a narrower query usually finds more)`);
  }
  if (outcome.fromCache) lines.push("(served from cache)");
  return lines.join("\n");
}

export function searchTool(deps: SearchToolDeps) {
  const { client, engines, config, cache, userId } = deps;

  async function run(params: SearchParams): Promise<SearchOutcome> {
    const query = normalizeQuery(params.query ?? "");
    if (!query) {
      throw new GatewayError("unsupported", "query must not be empty");
    }

    const requested = params.n ?? config.search.maxResults;
    const clamped = Math.max(1, Math.min(requested, MAX_RESULTS_HARD_LIMIT));
    const resolve = params.resolve === true;

    const activeEngines = params.engine
      ? engines.filter((engine) => engine.name === params.engine)
      : engines;
    if (activeEngines.length === 0) {
      throw new GatewayError("unsupported", `engine "${params.engine}" is not available (enabled: ${engines.map((e) => e.name).join(", ")})`);
    }

    // `n` deliberately stays out of the key: the cached value is the whole engine page, sliced only
    // when the outcome is shaped, so a cheap first call can never cap a later one.
    const key = `search:${query}:${activeEngines.map((e) => e.name).join(">")}:raw`;

    let fromCache = false;
    const cached = cache.get(key);
    if (cached) fromCache = true;

    const outcome = await cache.run(key, async () => {
      let chain: ChainOutcome;
      try {
        chain = await searchWithFallback(query, activeEngines, {
          client,
          userId,
          signal: params.signal,
          maxResults: MAX_RESULTS_HARD_LIMIT,
        });
      } catch (error) {
        // Never cache a failure: the next call must be free to try the chain again.
        throw error instanceof GatewayError ? error : new GatewayError("gateway_error", String(error));
      }
      return { query, engine: chain.engine, results: chain.results, tried: chain.tried };
    }, config.cache.serpMs);

    // Resolution happens after the cache and only for what will be shown: a wrapper costs one page
    // load each, so we never resolve urls the caller did not ask to see.
    const visible = outcome.results.slice(0, clamped);
    const results = resolve
      ? await resolveUrls(visible, { client, userId, signal: params.signal, cache, ttlMs: config.cache.pageMs })
      : visible;

    // Two different surprises, and they need different words: the engine page is capped at 10,
    // but a clean page can also simply have fewer results than we asked for.
    const clampedTo = requested === clamped ? undefined : clamped;
    const shaped = {
      ...outcome,
      results,
      requested,
      ...(clampedTo ? { clampedTo } : {}),
      ...(results.length < Math.min(requested, clamped) ? { shortBy: Math.min(requested, clamped) - results.length } : {}),      ...(fromCache ? { fromCache: true } : {}),
    };
    return { ...shaped, text: formatResults(shaped) };
  }

  return { name: "camoufox_search", search: run };
}
