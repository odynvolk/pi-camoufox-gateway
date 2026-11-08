/**
 * A three-case suite for the two readings the instrument can only be tested against on demand.
 *
 * `tests/measure-unregistered-pages.test.mjs` copies this into a scratch repo and runs the instrument over
 * it, for the two figures no shipped suite can produce when asked: a run where a case reads an engine's
 * results page and *nobody registered it* (the hole G.6 counts), and the same run with that page registered,
 * where the honest reading is zero. Neither is reachable in the shipped suite on demand — one of them is
 * exactly what G.6 closes.
 *
 * `CAMOUFOX_MEASURE_RIG_REGISTER=1` picks the second shape, and the case's own assertions are the same in
 * both: which page answers is the rig's business, and a case that asserted differently per shape would be
 * asserting which shape it was told to run rather than what the instrument read.
 *
 * The results url is derived through `engineResultPrefixes`, never pasted — the rule
 * `scripts/measure-unregistered-pages.mjs` states for itself: a prefix pasted here would keep matching after
 * the engine moved, and would report the hole as closed while the adapter opens somewhere else now.
 *
 * What this suite pins about a published **zero** is the F1 half of the instrument: the recorder probes itself
 * at an engine's own results url, and were that probe read recorded as a case, `classify` — which matches on
 * the url alone — would credit this very run with a results read and the count could never be 0. The registered
 * case below is the only thing that could tell those two runs apart, so it is the case F1 would have survived.
 *
 * Not run by `npm test`, for the same two reasons as `tests/instrument-probe.mjs`: the glob there is
 * `tests/*.test.mjs`, and a case of this one inside the measured suite would move the figures the instrument
 * publishes. Copied to `tests/instrument-rig.test.mjs` by the rig, whose imports are written for that depth.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { engineResultPrefixes, KNOWN_CASE } from "../scripts/measure-unregistered-pages.mjs";

const BASE = "http://gateway.rig.test:9377";
/** A query nothing else asks for, so no other fixture can be the page this case registers. */
const QUERY = "rig-camoufox";
/** The page this case registers when the rig asks it to: results-shaped, and nobody's invention. */
const RECORDED_RESULTS_PAGE = [
  '- heading "camoufox - DuckDuckGo" [level=1]',
  '- link "Camoufox: Introduction" [e1]:',
  "  - /url: https://camoufox.com/introduction",
  "  - text: An open source anti-detect browser built for AI agents.",
  "  - text: Paragraph 1 of the page this case registered, long enough to read as a rendered document.",
  "  - text: Paragraph 2 of the page this case registered, long enough to read as a rendered document.",
].join("\n");
/** A url nothing registers, so the fake can only invent an answer for it. */
const ARTICLE_URL = "https://example.test/an-article-nobody-registered";

const register = process.env.CAMOUFOX_MEASURE_RIG_REGISTER === "1";
const resultsUrl = `${(await engineResultPrefixes()).get("duckduckgo")}${QUERY}`;

// Where the case below actually went, for whoever runs this file by hand: the rig's own cases assert on the
// instrument's figures, not on this line, so nothing reads it back — a line that claims a reader it does not
// have is how a stale affordance survives. The url is derived through `engineResultPrefixes` for the reason
// above, and a reader reconstructing it would be a second copy of the rule this file exists to avoid pasting.
console.error(`RIG-RESULTS\t${resultsUrl}\t${register ? "registered" : "invented"}`);

test(KNOWN_CASE, async (t) => {
  const fake = withFakeGateway(t, register ? { pageContents: new Map([[resultsUrl, RECORDED_RESULTS_PAGE]]) } : {});
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 1000 });
  const opened = await client.openTab({ userId: "u1", url: resultsUrl });
  const page = await client.snapshot({ userId: "u1", tabId: opened.tabId });
  await client.closeTabQuietly({ userId: "u1", tabId: opened.tabId });

  const open = fake.state.calls.find((call) => call.path === "/tabs/open");
  assert.equal(open.body.url, resultsUrl, "the case opened an engine's own results url, however the adapter spells it");
  assert.ok(page.text.length > 200, "and it read a page — registered or invented, which is the rig's choice, not this case's");
});

test("reads an article page nobody registered", async (t) => {
  // The case that keeps `read the fake's invented page` above zero in a run whose results-page count is zero:
  // the two figures have different denominators, and a run where both are 0 could not tell a closed hole from
  // a recorder that stopped recording.
  const fake = withFakeGateway(t);
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 1000 });
  const opened = await client.openTab({ userId: "u1", url: ARTICLE_URL });
  const page = await client.snapshot({ userId: "u1", tabId: opened.tabId });
  await client.closeTabQuietly({ userId: "u1", tabId: opened.tabId });

  assert.ok(page.text.length > 200, "the fake invented this page, nobody registered it");
});

test("opens nothing and reads nothing", async (t) => {
  const fake = withFakeGateway(t);
  assert.deepEqual(fake.state.calls, [], "nothing was requested, so nothing can be attributed to this case");
});
