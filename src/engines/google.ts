/**
 * Google by opening a tab at the results page.
 *
 * Not the gateway's `@google_search` macro, which this engine used to run instead of building the url.
 * The macro is byte-identical to the url we build here (`lib/macros.js`), so it carried no capability —
 * but `POST /tabs/:id/navigate` runs upstream's organic-results check, and that check rejects any `h3`
 * link on a `google.` host while Google now serves organics as `google.com/goto?url=…`. Measured on the
 * live gateway (2026-10-27): the macro call spends ~31s and comes back a DuckDuckGo page; opening the
 * same url answers in 268 ms with 9–10 Google results, on every query tried. A check we cannot pass is
 * not a service, it is a delay.
 *
 * The consent interstitial the macro was kept for is still handled — `detectWall` calls it, and the chain
 * hops to duckduckgo — it is just no longer avoided by a request that costs 100x what it buys.
 */

import { serpEngine } from "./serp.ts";
import type { Engine } from "./types.ts";

/**
 * No `hl`/`gl`, though both are available: probes returned 10 organics geo-detected without them, and a
 * hardcoded locale is a claim about the user's geography this repo has no way to know.
 */
const SEARCH_URL = "https://www.google.com/search?q=";

export function googleEngine(): Engine {
  return serpEngine("google", SEARCH_URL);
}
