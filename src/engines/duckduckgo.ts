/**
 * DuckDuckGo: no macro, so this engine navigates once and reads the page. It exists as the fallback
 * for when Google answers with a consent interstitial, so it must not need any of Google's machinery.
 */

import { GatewayError } from "../errors.ts";
import { classifySerp } from "../snapshot.ts";
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

        const verdict = classifySerp(snapshot, "duckduckgo");
        if (verdict.kind === "error") {
          throw new GatewayError(verdict.code, verdict.message, { details: verdict.details });
        }
        const results = verdict.results;

        return { results: results.slice(0, Math.min(context.maxResults, results.length)) };
      } finally {
        await client.closeTabQuietly({ userId, tabId: tab.tabId });
      }
    },
  };
}
