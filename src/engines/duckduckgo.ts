/**
 * DuckDuckGo: open a tab at the query url and read the page — the same shape `google.ts` now takes.
 * It exists as the fallback for when Google answers with a consent interstitial, so it must not need any
 * of Google's machinery.
 */

import { GatewayError } from "../errors.ts";
import { settledSerpVerdict } from "./settle.ts";
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
        const verdict = await settledSerpVerdict(context, tab.tabId, "duckduckgo");
        if (verdict.kind === "error") {
          throw new GatewayError(verdict.code, verdict.message, { details: verdict.details });
        }

        // Whole page, unsliced — same reason as `google.ts`, and the reason no engine here declares a
        // page width of its own: a duckduckgo page carries whatever it carried, and saying so in a type
        // would be a second width to keep honest.
        return { results: verdict.results, ...(verdict.polled ? { polled: true } : {}) };
      } finally {
        await client.closeTabQuietly({ userId, tabId: tab.tabId });
      }
    },
  };
}
