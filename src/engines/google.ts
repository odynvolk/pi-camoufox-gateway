/**
 * Google by opening a tab at the results page.
 *
 * Not the gateway's `@google_search` macro, which this engine used to run instead of building the url.
 * The macro is byte-identical to the url we build here (`lib/macros.js`), so it carried no capability —
 * but `POST /tabs/:id/navigate` runs upstream's organic-results check, and that check rejects any `h3`
 * link on a `google.` host while Google now serves organics as `google.com/goto?url=…`. Measured on the
 * live gateway (2026-10-27): the macro call spends ~31s and comes back a DuckDuckGo page; opening the
 * same url answers in ~270ms with 9–10 Google results, on every query tried. A check we cannot pass is
 * not a service, it is a delay.
 *
 * The consent interstitial the macro was kept for is still handled — `detectWall` calls it, and the chain
 * hops to duckduckgo — it is just no longer avoided by a request that costs 100x what it buys.
 */

import { GatewayError } from "../errors.ts";
import { settledSerpVerdict } from "./settle.ts";
import type { Engine, EngineContext, EngineOutcome } from "./types.ts";

/**
 * No `hl`/`gl`, though both are available: probes returned 10 organics geo-detected without them, and a
 * hardcoded locale is a claim about the user's geography this repo has no way to know.
 */
const SEARCH_URL = "https://www.google.com/search?q=";

export function googleEngine(): Engine {
  return {
    name: "google",
    async search(query: string, context: EngineContext): Promise<EngineOutcome> {
      const { client, userId, signal } = context;
      const url = `${SEARCH_URL}${encodeURIComponent(query)}`;
      const tab = await client.openTab({ userId, url, signal });
      try {
        const verdict = await settledSerpVerdict(context, tab.tabId, "google");
        if (verdict.kind === "error") {
          throw new GatewayError(verdict.code, verdict.message, { details: verdict.details });
        }

        // The whole page, unsliced. One fact is worth keeping out of a constant: Google's page is ten
        // wide and there is no pagination to ask for, so asking for 20 buys a page of ~10 whatever `n`
        // says, and `tools/search.ts` is where any further slice happens.
        return { results: verdict.results, ...(verdict.polled ? { polled: true } : {}) };
      } finally {
        await client.closeTabQuietly({ userId, tabId: tab.tabId });
      }
    },
  };
}
