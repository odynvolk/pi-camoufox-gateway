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
/**
 * The macro takes only a query and Google's page is ten wide; more needs pagination we don't have.
 *
 * The tool-level ceiling is a separate number — `MAX_SEARCH_RESULTS` in `config.ts`, which the config
 * bound, the clamp and the parameter description all read. Nothing links the two: this is one adapter's
 * page, that is the tool's, and duckduckgo pins no width at all (G.1 in
 * `docs/improvements/2026-10-18-code.md`).
 */
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
