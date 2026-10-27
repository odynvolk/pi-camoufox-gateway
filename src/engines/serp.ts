/**
 * The one SERP adapter, which both engines are made from.
 *
 * Since `google.ts` stopped navigating, the two adapters were the same twenty lines with two literals in
 * them — and one of those literals was written *twice* per engine: once as the `Engine.name` the chain
 * credits, once as the key `classifySerp` decides host ownership by. Nothing pinned the two to the same
 * string, and a drift between them is exactly the misattribution the ownership rule was written to close —
 * an engine credited for a page it does not host, chrome-filtered by that engine's own host list. Here the
 * one `name` argument answers both questions, so they cannot disagree.
 *
 * What is deliberately *not* here is the rationale. Each engine keeps its own module and its own header
 * comment, because those record what the live gateway was measured doing at a cost in probes; collapsing
 * them into a generic docstring here would throw away the evidence with the duplication.
 */

import type { EngineName } from "../config.ts";
import { GatewayError } from "../errors.ts";
import { settledSerpVerdict } from "./settle.ts";
import type { Engine, EngineContext, EngineOutcome } from "./types.ts";

/**
 * Build the engine that opens a tab at `searchUrl` + the encoded query and reads the page it lands on.
 *
 * The teardown contract lives here on purpose: an engine that threw on its way to a result is the case
 * that leaks a tab, and a `finally` written in two files is one that can be missing from either.
 */
export function serpEngine(name: EngineName, searchUrl: string): Engine {
  return {
    name,
    async search(query: string, context: EngineContext): Promise<EngineOutcome> {
      const { client, userId, signal } = context;
      const url = `${searchUrl}${encodeURIComponent(query)}`;
      const tab = await client.openTab({ userId, url, signal });
      try {
        // `name` and not a second literal: this is the same value `chain.ts` credits, so the page can only
        // ever be owned by the engine that gets the credit for it.
        const verdict = await settledSerpVerdict(context, tab.tabId, name);
        if (verdict.kind === "error") {
          throw new GatewayError(verdict.code, verdict.message, { details: verdict.details });
        }

        // The whole page, unsliced. One fact is worth keeping out of a constant: Google's page is ten wide
        // and there is no pagination to ask for, so asking for 20 buys a page of ~10 whatever `n` says — and
        // a DuckDuckGo page carries whatever it carried, which is why no engine here declares a page width
        // of its own either. `tools/search.ts` is where any further slice happens.
        return { results: verdict.results, ...(verdict.polled ? { polled: true } : {}) };
      } finally {
        await client.closeTabQuietly({ userId, tabId: tab.tabId });
      }
    },
  };
}
