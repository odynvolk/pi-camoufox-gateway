/**
 * Google through the gateway's `@google_search` macro.
 *
 * The macro is what survives Google's consent interstitial: navigating to a hand-built
 * `google.com/search?...` url instead gets us dumped on consent.google.com. That single fact is why
 * this engine opens a seed tab first — a tab must exist before the macro can navigate it.
 */

import { GatewayError } from "../errors.ts";
import { classifySerp } from "../snapshot.ts";
import type { Engine, EngineContext, EngineOutcome } from "./types.ts";

const SEED_URL = "https://example.com/";
const MACRO = "@google_search";
/** The macro takes only a query and Google's page is ten wide; more needs pagination we don't have. */
export const GOOGLE_PAGE_SIZE = 10;

export function googleEngine(): Engine {
  return {
    name: "google",
    async search(query: string, context: EngineContext): Promise<EngineOutcome> {
      const { client, userId, signal } = context;
      const tab = await client.openTab({ userId, url: SEED_URL, signal });
      try {
        await client.navigateMacro({ userId, tabId: tab.tabId, macro: MACRO, query, signal });
        const snapshot = await client.snapshot({ userId, tabId: tab.tabId, signal });

        const verdict = classifySerp(snapshot, "google");
        if (verdict.kind === "error") {
          throw new GatewayError(verdict.code, verdict.message, { details: verdict.details });
        }
        const results = verdict.results;

        const wanted = Math.max(1, Math.min(context.maxResults, GOOGLE_PAGE_SIZE));
        return { results: results.slice(0, wanted) };
      } finally {
        await client.closeTabQuietly({ userId, tabId: tab.tabId });
      }
    },
  };
}
