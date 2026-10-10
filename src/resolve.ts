/**
 * Turns Google's `goto` wrappers into usable urls.
 *
 * Two facts drive this module: the wrapper cannot be decoded locally (its payload is a signed
 * protobuf, not a url), and opening it in a tab makes the gateway report the destination. That makes
 * resolution one `openTab` per url — but only for urls that need it, and only when the caller asked.
 */

import { GatewayError } from "./errors.ts";
import type { SearchResult } from "./snapshot.ts";
import type { GatewayClient } from "./gateway.ts";
import type { Cache } from "./cache.ts";

export interface ResolveContext {
  client: GatewayClient;
  userId: string;
  signal?: AbortSignal;
  /** How many tabs may be open at once while resolving. Defaults to 3. */
  concurrency?: number;
  /** Per-url deadline. Defaults to the client's own timeout. */
  timeoutMs?: number;
  /** Cache for url -> final url, so a repeat call costs no tab. */
  cache?: Cache<unknown>;
  ttlMs?: number;
}

export interface ResolvableResult extends SearchResult {
  /** true = we replaced the url; false = we tried and kept the original. */
  resolved?: boolean;
  /** Short reason when resolution did not happen. */
  resolveError?: string;
}

const DEFAULT_CONCURRENCY = 3;

function needsResolution(result: SearchResult): boolean {
  return result.resolvable === true;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}

export async function resolveUrls(
  results: SearchResult[],
  context: ResolveContext,
): Promise<ResolvableResult[]> {
  if (!results.some(needsResolution)) return results.map((result) => ({ ...result }));

  const { client, userId, signal, cache, ttlMs } = context;
  const concurrency = context.concurrency ?? DEFAULT_CONCURRENCY;

  return mapWithConcurrency(results, concurrency, async (result) => {
    if (!needsResolution(result)) return { ...result };

    const key = `url:${result.url}`;
    if (cache) {
      const known = cache.get(key) as { url: string; resolved: boolean } | undefined;
      if (known) return { ...result, url: known.url, resolved: known.resolved };
    }

    let tab;
    try {
      const opened = await withDeadline(
        (signal) => client.openTab({ userId, url: result.url, signal }),
        context.timeoutMs,
        signal,
      );
      tab = opened.tabId;
      if (opened.url && !/google\.com\/(goto|url)\?/u.test(opened.url)) {
        cache?.set(key, { url: opened.url, resolved: true }, ttlMs ?? 600_000);
        return { ...result, url: opened.url, resolved: true };
      }
      cache?.set(key, { url: result.url, resolved: false }, 30_000);
      return { ...result, resolved: false, resolveError: "stayed on the redirect wrapper" };
    } catch (error) {
      // A failed resolution is not cached: the next call should get a fresh chance.
      return { ...result, resolved: false, resolveError: error instanceof Error ? error.message : String(error) };
    } finally {
      if (tab) await client.closeTabQuietly({ userId, tabId: tab });
    }
  });
}

/**
 * Bound one url's resolution without leaving a tab behind.
 *
 * The deadline cannot just win the race: if it abandons `openTab` mid-flight, the gateway keeps the
 * page it already opened and we never learn its id. So the deadline aborts the request instead, and
 * the client reconciles what that leaves.
 */
async function withDeadline<T>(
  run: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs: number | undefined,
  outer?: AbortSignal,
): Promise<T> {
  if (!timeoutMs && !outer) return run(undefined);

  const controller = new AbortController();
  const timer = timeoutMs
    ? setTimeout(() => controller.abort(new GatewayError("timeout", `url did not resolve within ${timeoutMs}ms`)), timeoutMs)
    : undefined;
  const relay = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", relay, { once: true });

  try {
    return await run(controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener("abort", relay);
  }
}
