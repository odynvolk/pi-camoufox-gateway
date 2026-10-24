/**
 * Google through the gateway's `@google_search` macro.
 *
 * The macro is what survives Google's consent interstitial: navigating to a hand-built
 * `google.com/search?...` url instead gets us dumped on consent.google.com. That single fact is why
 * this engine opens a seed tab first — a tab must exist before the macro can navigate it.
 */

import { GatewayError } from "../errors.ts";
import { settledSerpVerdict } from "./settle.ts";
import type { Engine, EngineContext, EngineOutcome } from "./types.ts";

const SEED_URL = "https://example.com/";
const MACRO = "@google_search";

export function googleEngine(): Engine {
  return {
    name: "google",
    async search(query: string, context: EngineContext): Promise<EngineOutcome> {
      const { client, userId, signal } = context;
      const tab = await client.openTab({ userId, url: SEED_URL, signal });
      try {
        await client.navigateMacro({ userId, tabId: tab.tabId, macro: MACRO, query, signal });
        const verdict = await settledSerpVerdict(context, tab.tabId, "google");
        if (verdict.kind === "error") {
          throw new GatewayError(verdict.code, verdict.message, { details: verdict.details });
        }

        // The whole page, unsliced. One fact is worth keeping out of a constant: the macro takes only a
        // query, and Google's page is ten wide — more needs pagination we do not have. So asking for 20
        // buys a page of ~10 whatever `n` says, and `tools/search.ts` is where any further slice happens.
        return { results: verdict.results };
      } finally {
        await client.closeTabQuietly({ userId, tabId: tab.tabId });
      }
    },
  };
}
