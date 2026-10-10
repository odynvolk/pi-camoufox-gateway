/**
 * DuckDuckGo: no macro, so this engine navigates once and reads the page. It exists as the fallback
 * for when Google answers with a consent interstitial, so it must not need any of Google's machinery.
 */

import { GatewayError } from "../errors.ts";
import { detectWall, excerpt, looksUnparseable, parseSerp } from "../snapshot.ts";
import type { Engine, EngineContext, EngineOutcome } from "./types.ts";

/** `html.duckduckgo.com` is deliberately avoided: it returns a search form, not results. */
const SEARCH_URL = "https://duckduckgo.com/?q=";

export function duckduckgoEngine(): Engine {
  return {
    name: "duckduckgo",
    async search(query: string, context: EngineContext): Promise<EngineOutcome> {
      const { client, userId, signal } = context;
      const url = `${SEARCH_URL}${encodeURIComponent(query)}`;
      const tab = await client.openTab({ userId, url, signal });
      try {
        const snapshot = await client.snapshot({ userId, tabId: tab.tabId, signal });

        const wall = detectWall(snapshot);
        if (wall) {
          throw new GatewayError(wall, `duckduckgo did not serve results (got ${snapshot.url})`, {
            details: { url: snapshot.url, engine: "duckduckgo" },
          });
        }

        const { results } = parseSerp(snapshot, "duckduckgo");
        if (results.length === 0) {
          if (looksUnparseable(snapshot)) {
            throw new GatewayError("parse_error", `duckduckgo served a page we could not read as a results list`, {
              details: { url: snapshot.url, excerpt: excerpt(snapshot) },
            });
          }
          throw new GatewayError("empty_results", "duckduckgo returned no organic results for that query", {
            details: { url: snapshot.url },
          });
        }

        return {
          engine: "duckduckgo",
          results: results.slice(0, Math.min(context.maxResults, results.length)),
          requestedCount: context.maxResults,
        };
      } finally {
        await client.closeTabQuietly({ userId, tabId: tab.tabId });
      }
    },
  };
}
