/**
 * Register a page at the url an engine's own adapter opens at.
 *
 * A test that asks an engine to search and registers nothing gets whatever
 * `tests/helpers/fake_gateway.mjs` invents for that url — and the invented article carries a link on a host no
 * engine owns, which `src/snapshot.ts` reads as organic, so a search whose engine never earned a result still
 * returns one (`docs/improvements/2026-10-18-code.md` → G.6). Registering the page is what keeps a case off
 * that count, and the rule the instrument states for itself decides *how*: a results url pasted into a fixture
 * keeps matching after the adapter moves, and reports the hole closed while the engine opens somewhere else
 * now. So the url here comes from `engineResultPrefixes`, which runs the shipped adapters and takes the url
 * each one opened.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { engineResultPrefixes } from "../../scripts/measure-unregistered-pages.mjs";

/**
 * The recorded DuckDuckGo SERP, for a case that needs a page its own parser finds results in.
 *
 * Recorded rather than typed out here because the thing under test is what an adapter makes of a real results
 * page, and a page this file invented could be results-shaped for reasons the engine never has to earn.
 */
export const RECORDED_SERP = readFileSync(new URL("../fixtures/serp-duckduckgo.txt", import.meta.url), "utf8");

/** Where the shipped adapter for this engine asks to go to answer `query` — derived by running it. */
export async function engineResultsUrl(engineName, query) {
  const prefix = (await engineResultPrefixes()).get(engineName);
  assert.ok(prefix, `${engineName} never asked to open at a results url, so there is no page to register for it`);
  return `${prefix}${encodeURIComponent(query)}`;
}

/**
 * Fake options that answer that url with this page, and the url it registered.
 *
 * `snapshotLimit` is the page's own length plus one, the way the recorded-page sweeps set it: a window fixed
 * above today's biggest recording silently slices tomorrow's, and a sliced SERP answers with a different set of
 * links than the page a test thinks it registered — which is how a settle count stops being a fact about the
 * engine and becomes one about the fake.
 */
export async function enginePage(engineName, query, text) {
  const url = await engineResultsUrl(engineName, query);
  return { url, fakeOptions: { pageContents: new Map([[url, text]]), snapshotLimit: text.length + 1 } };
}
