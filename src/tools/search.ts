/**
 * The search side of the extension: cache → engine chain → optional url resolution → model-facing
 * text. It owns no HTTP of its own; that lives behind `GatewayClient`.
 */

import { MAX_SEARCH_RESULTS, type CamoufoxConfig } from "../config.ts";
import { GatewayError } from "../errors.ts";
import { searchWithFallback, type TriedStep } from "../engines/chain.ts";
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
  /** What the chain is doing right now, for the tool UI. */
  onProgress?: (note: string) => void;
}

/** What goes into the cache: the facts, no rendering. */
export type CachedSearch = Omit<SearchOutcome, "text" | "clampedTo" | "shortBy" | "pageCarried" | "fromCache">;

export interface SearchOutcome {
  query: string;
  engine: string;
  results: ResolvableResult[];
  tried: TriedStep[];
  /**
   * What the caller asked for, kept so the output can admit when it got fewer.
   *
   * In `details` but deliberately not in `SearchOutputSchema`: it echoes the caller's own input rather
   * than reporting a fact about the result.
   */
  requested?: number;
  /** Set when the caller asked for more results than this tool can return. */
  clampedTo?: number;
  /** Set when the engine page was narrower than we asked for. */
  shortBy?: number;
  /**
   * How many the engine page actually carried, when that was more than this call returned.
   *
   * Without it a call that asked for 10 off a 12-wide page reports "10 result(s)" and reads as the
   * whole page. Nothing in this file may claim more than it returned.
   */
  pageCarried?: number;
  fromCache?: boolean;
  text: string;
}

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
  pageCarried?: number;
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
    // Only the two bounds in `run` set this field, so the line may name no engine — what a page happened
    // to carry is `pageCarried`'s fact, printed below.
    const asked = outcome.requested === undefined ? "" : `${outcome.requested} asked for, `;
    const why = outcome.clampedTo === MAX_SEARCH_RESULTS ? "more than one call may return" : "fewer than one call returns";
    lines.push(`(clamped to ${outcome.clampedTo}: ${asked}${why})`);
  }
  if (outcome.shortBy) {
    lines.push(`(the page carried ${outcome.shortBy} fewer result(s) than asked for; a narrower query usually finds more)`);
  }
  // The other side of the same honesty: a page wider than what came back. Advice stays with the two
  // lines above, so this one only states the count this call threw away and which limit did it — and
  // which limit is a question the reader can act on, because only one of the two answers moves.
  if (outcome.pageCarried !== undefined) {
    // `requested` cannot be the test. A caller who asked for exactly the ceiling is in the same place as
    // one who asked for more: a larger `n` moves neither, so blaming their ask would send them to a lever
    // that does not exist. What returned equal to the ceiling is the discriminator, and it holds because
    // the returned count is the minimum of the two.
    const ceilingBound = outcome.results.length === MAX_SEARCH_RESULTS;
    const why = ceilingBound
      ? `one call returns at most ${MAX_SEARCH_RESULTS}`
      : `${outcome.requested ?? outcome.results.length} asked for`;
    lines.push(`(the ${outcome.engine} page carried ${outcome.pageCarried} result(s), ${outcome.results.length} returned: ${why})`);
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
    // A fractional result count is not expressible. `slice` floors it, so `n: 2.5` showed 2 rows while
    // disclosing nothing, and on a page of 2 it claimed "0.5 fewer result(s)". Same reason `config.ts`
    // refuses a fractional `search.maxResults` — and checked on the effective value, because a hand-built
    // config reaches here without passing through the validator.
    if (!Number.isInteger(requested)) {
      throw new GatewayError(
        "unsupported",
        params.n === undefined
          ? `"search.maxResults" must be a whole number of results, got ${requested}`
          : `"n" must be a whole number of results, got ${requested}`,
      );
    }
    const clamped = Math.max(1, Math.min(requested, MAX_SEARCH_RESULTS));
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

    // A failure is never cached — `run` stores only on a resolved value — so the next call is free to
    // try the chain again, and the error keeps the single code it was given where it was caught.
    const outcome = await cache.run(key, async () => {
      const chain = await searchWithFallback(query, activeEngines, {
        client,
        userId,
        signal: params.signal,
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
      });
      return { query, engine: chain.engine, results: chain.results, tried: chain.tried };
    }, config.cache.serpMs);

    // Resolution happens after the cache and only for what will be shown: a wrapper costs one page
    // load each, so we never resolve urls the caller did not ask to see.
    const visible = outcome.results.slice(0, clamped);
    // One navigation per wrapper url, three at a time, after the last engine note — so without this the
    // call says nothing while it is still navigating. The count names the wrappers, an upper bound on the
    // tabs opened: a wrapper already in the url cache costs no navigation.
    if (resolve) {
      const wrapping = visible.filter((result) => result.resolvable).length;
      if (wrapping > 0) params.onProgress?.(`resolving ${wrapping} url${wrapping === 1 ? "" : "s"}`);
    }
    const results = resolve
      ? await resolveUrls(visible, { client, userId, signal: params.signal, cache, ttlMs: config.cache.pageMs })
      : visible;

    // Two different surprises, and they need different words: the tool's own ceiling is a number, but a
    // clean page can also simply have fewer results than we asked for — or more, which is the case that
    // used to go unmentioned.
    const clampedTo = requested === clamped ? undefined : clamped;
    const pageCarried = outcome.results.length > visible.length ? outcome.results.length : undefined;
    const shaped = {
      ...outcome,
      results,
      requested,
      ...(clampedTo ? { clampedTo } : {}),
      ...(results.length < Math.min(requested, clamped) ? { shortBy: Math.min(requested, clamped) - results.length } : {}),
      ...(pageCarried === undefined ? {} : { pageCarried }),
      ...(fromCache ? { fromCache: true } : {}),
    };
    return { ...shaped, text: formatResults(shaped) };
  }

  return { name: "camoufox_search", search: run };
}
