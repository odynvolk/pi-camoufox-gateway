/**
 * The G.6 instrument, tested as code.
 *
 * `scripts/measure-unregistered-pages.mjs` is what the two counts in
 * `docs/improvements/2026-10-18-code.md` → G.6 rest on, and a count nobody outside this repo can re-measure
 * is a claim rather than a measurement — the defect the recorded fixtures exist to close. So its parts are
 * asserted here, including the two readings the counts depend on: that a page the fake invents is recognised
 * as invented, and that a page the fake *ships* (its google SERP, its consent page) is not. The script's
 * entry point is guarded, so importing it here cannot spawn a suite from inside one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import {
  caseNames,
  classify,
  engineResultPrefixes,
  inventedPageText,
  KNOWN_CASE,
  pageAtIsInvented,
  pageWasInvented,
  parseReport,
  assertSawTheKnownCase,
  suiteTotal,
} from "../scripts/measure-unregistered-pages.mjs";

const BASE = "http://gateway.test:9377";
const UNREGISTERED = "https://duckduckgo.com/?q=camoufox";
const SHIPPED = ["https://www.google.com/search?q=camoufox", "https://consent.google.com/ml?continue=x"];

test("an invented page is recognised, and the pages the fake ships are not", async () => {
  // The count G.6 publishes is "how many cases read a page nobody registered". Three wrong answers were
  // measured on the way here: comparing against "what a fresh fake answers" also counted the google SERP and
  // the consent page the fake ships on purpose (35), comparing against the un-substituted article lost every
  // whole-page read (40), and caching the verdict per url gave one case's answer to another that had
  // registered that url (17). Each assertion below is one of those three.
  assert.equal(await pageWasInvented(UNREGISTERED, await inventedPageText(UNREGISTERED)), true);

  for (const url of SHIPPED) {
    assert.equal(await pageWasInvented(url, await inventedPageText(url)), false, `${url} is the fake's own page`);
    assert.equal(await pageAtIsInvented(url), false, `${url} is served without anyone registering it`);
  }
  assert.equal(await pageAtIsInvented(UNREGISTERED), true);

  // A slice of the invention is still the invention — `/snapshot` paginates and `read` re-looks at an offset.
  const whole = await inventedPageText(UNREGISTERED);
  assert.equal(await pageWasInvented(UNREGISTERED, whole.slice(whole.indexOf("- link"))), true);

  // And these are not the invention, however long they are.
  assert.equal(await pageWasInvented(UNREGISTERED, ""), false);
  assert.equal(await pageWasInvented(UNREGISTERED, "x".repeat(500)), false);
  assert.equal(await pageWasInvented("", whole), false);
});

test("a page a case registered is not counted as one the fake invented", async (t) => {
  // The same url is the fake's invention in one case and this case's own page here. An instrument that
  // decides per url gets this wrong, and gets it wrong in the direction that hides the hole.
  const registered = "https://duckduckgo.com/?q=camoufox";
  const mine = `- heading "Mine" [level=1]\n${"x".repeat(400)}`;
  const fake = withFakeGateway(t, { pageContents: new Map([[registered, mine]]) });
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 1000 });
  const tab = await client.openTab({ userId: "u1", url: registered });
  const page = await client.snapshot({ userId: "u1", tabId: tab.tabId });
  await client.closeTabQuietly({ userId: "u1", tabId: tab.tabId });

  assert.equal(page.text.includes("Mine"), true, "this case's own page is the one that came back");
  assert.equal(await pageWasInvented(registered, page.text), false);
  assert.equal(await pageWasInvented(registered, await inventedPageText(registered)), true, "the url alone decides nothing");
  assert.equal(fake.state.calls.some((call) => call.path === "/tabs/open"), true, "and it really went through the fake");
});

test("the run is read back case by case, reporter noise and all", () => {
  const cases = parseReport([
    "✔ some test (1.0ms)",
    `INVENTED-PAGE\ttests/engines.test.mjs\tsearches\t${UNREGISTERED} https://duckduckgo.com/?q=late`,
    "ℹ tests 3",
    `INVENTED-PAGE\ttests/engines.test.mjs\tsearches\t${UNREGISTERED}`,
    `INVENTED-PAGE\ttests/search-tool.test.mjs\tsearches\t${UNREGISTERED}`,
  ].join("\n"));

  assert.equal(cases.length, 3, "one line per fake, so a case installing two appears twice");
  assert.deepEqual(cases[0].urls, [UNREGISTERED, "https://duckduckgo.com/?q=late"]);
  assert.equal(caseNames(cases).length, 2, "but the count is cases, not fakes — same name, two files, two cases");
  assert.equal(suiteTotal("…\nℹ tests 0\nℹ tests 384\n"), 384, "the suite's total, not a stray summary of zero");
  assert.equal(suiteTotal("nothing at all"), 0, "and no summary at all is 0, which the caller refuses to publish");
});

test("a page is attributed to the engine whose results url it is, and to no other", async () => {
  const prefixes = await engineResultPrefixes();
  assert.deepEqual(
    [...prefixes.entries()].map(([engine, prefix]) => `${engine} ${prefix}`),
    ["google https://www.google.com/search?q=", "duckduckgo https://duckduckgo.com/?q="],
    "derived by running the shipped adapters, so an engine moving its url moves this assertion with it",
  );

  const { asResults } = classify(
    [
      { file: "a", name: "reads a document", urls: ["https://example.test/article"] },
      { file: "a", name: "searches", urls: [UNREGISTERED] },
      { file: "a", name: "searches", urls: [UNREGISTERED] },
    ],
    prefixes,
  );
  assert.deepEqual(asResults, [{ file: "a", name: "searches", engine: "duckduckgo", url: UNREGISTERED }]);
});

test("a run that missed the case it must see is refused, not published as zero", async () => {
  // Zero and "closed" look identical in the output and only one of them is a finding. The case named here
  // opens the engine's own query page through the fake, registers nothing, and asserts `results.length > 0`,
  // so any recorder that works sees it — that is the reading this guard rests on, and the reason a silent 0
  // cannot be reported as good news.
  const prefixes = await engineResultPrefixes();
  const seen = [{ file: "tests/engines.test.mjs", name: KNOWN_CASE, urls: ["https://duckduckgo.com/?q=camoufox%20anti-detect"] }];
  assert.doesNotThrow(() => assertSawTheKnownCase(seen, classify(seen, prefixes).asResults));

  assert.throws(() => assertSawTheKnownCase([], []), /the recorder saw nothing/u);
  const elsewhere = [{ file: "x", name: KNOWN_CASE, urls: ["https://example.test/not-a-serp"] }];
  assert.throws(
    () => assertSawTheKnownCase(elsewhere, classify(elsewhere, prefixes).asResults),
    /matched no engine's results url/u,
  );
});
