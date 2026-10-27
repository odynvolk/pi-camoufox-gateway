/**
 * DuckDuckGo: open a tab at the query url and read the page — the same shape `google.ts` takes, both made
 * by `serp.ts`. It exists as the fallback for when Google answers with a consent interstitial, so it must
 * not need any of Google's machinery.
 */

import { serpEngine } from "./serp.ts";
import type { Engine } from "./types.ts";

/** `html.duckduckgo.com` is deliberately avoided: it returns a search form, not results. */
const SEARCH_URL = "https://duckduckgo.com/?q=";

export function duckduckgoEngine(): Engine {
  return serpEngine("duckduckgo", SEARCH_URL);
}
