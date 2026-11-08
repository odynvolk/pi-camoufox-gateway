/**
 * A suite small enough for the instrument to measure, run from a scratch copy of the repo.
 *
 * `--check` can only be tested against a real reading, and a real reading means a real `node --test` child.
 * Pointed at the shipped suite that is a second 14 s run per assertion, so the check's own cases measure this
 * instead: four cases whose three headline figures are three *different* numbers, which is what a stale
 * figure has to be identifiable by — in a suite where the total, the invented count and the results-page
 * count coincided, a place that was stale in one could be read as stale in another.
 *
 * The four figures this is built to produce, and why each is here:
 * - a total of 4, so a total that moved is visible as a moved total;
 * - two cases read an invented page and one of those reads it as an engine's results page, so the second and
 *   third figures differ from each other and neither can hide behind the other;
 * - one case reads a page it registered itself and one reads nothing at all, which is what keeps both counts
 *   below the total — an instrument that charged every running case with a read would pass here and lie on
 *   the shipped suite.
 *
 * The first case takes its name from `KNOWN_CASE`, which is a label and no longer a gate: what lets a four-case
 * suite be published at all is the probe read every recorded child takes of its own accord, at an engine's own
 * results url, and reports before any figure prints. On the shipped suite the case still lives in
 * `tests/engines.test.mjs`, where it is the one that navigates to an engine and registers nothing there.
 *
 * Not run by `npm test`: the glob there is `tests/*.test.mjs` and this file's name deliberately stops short
 * of it, for the same reason `scripts/record-fixtures.py` never runs from the suite. A case of this one
 * inside the measured suite would move the very figure the instrument publishes — it would read an invented
 * page nobody asked it to. It is copied to `tests/instrument-probe.test.mjs` inside a scratch copy by
 * `tests/measure-unregistered-pages.test.mjs`, which is where the name above is run from; its imports are
 * written for that depth, so the copy needs no rewriting and cannot arrive broken in a way nothing notices.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { duckduckgoEngine } from "../src/engines/duckduckgo.ts";
import { KNOWN_CASE } from "../scripts/measure-unregistered-pages.mjs";

const BASE = "http://gateway.probe.test:9377";
/** Registered with nothing, so the fake can only answer with the article it invents. */
const UNREGISTERED_ARTICLE = "https://example.test/an-article-nobody-registered";
const CLIENT_OPTIONS = { baseUrl: BASE, timeoutMs: 1000 };

test(KNOWN_CASE, async (t) => {
  // Run through the adapter rather than at a url copied in here, so the results-page attribution the
  // instrument makes is one the shipped duckduckgo adapter still earns rather than one this file asserts.
  //
  // The claim is the throw, not the result: the invented page is a page and not a result set, so the adapter
  // finds no link blocks in a body past `PARSEABLE_MIN_CHARS` and blames its own parser. The navigation is
  // kept because the navigation is what the recorder records and what `classify` then reads.
  const fake = withFakeGateway(t);
  const client = createGatewayClient(CLIENT_OPTIONS);
  const outcome = await duckduckgoEngine()
    .search("camoufox anti-detect", { client, userId: "u1" })
    .catch((error) => error);

  assert.equal(outcome.code, "parse_error", `the invented page did not reach the adapter as an unparseable page: ${JSON.stringify(outcome)}`);
  const opened = fake.state.calls.find((call) => call.path === "/tabs/open");
  assert.match(opened.body.url, /^https:\/\/duckduckgo\.com\/\?q=/u, "and it opened the engine's own query page anyway, which is the read being counted");
});

test("reads an article page nobody registered", async (t) => {
  const fake = withFakeGateway(t);
  const client = createGatewayClient(CLIENT_OPTIONS);
  const opened = await client.openTab({ userId: "u1", url: UNREGISTERED_ARTICLE });
  const page = await client.snapshot({ userId: "u1", tabId: opened.tabId });
  await client.closeTabQuietly({ userId: "u1", tabId: opened.tabId });

  assert.ok(page.text.length > 200, "the fake invented this page, nobody registered it");
});

test("reads a page its own case registered", async (t) => {
  const registered = "https://example.test/a-page-this-case-put-there";
  const mine = `- heading "Mine" [level=1]\n${"x".repeat(400)}`;
  const fake = withFakeGateway(t, { pageContents: new Map([[registered, mine]]) });
  const client = createGatewayClient(CLIENT_OPTIONS);
  const opened = await client.openTab({ userId: "u1", url: registered });
  const page = await client.snapshot({ userId: "u1", tabId: opened.tabId });
  await client.closeTabQuietly({ userId: "u1", tabId: opened.tabId });

  assert.equal(page.text, mine, "this case's own page came back, so this is not a read of an invention");
  assert.equal(fake.state.calls.some((call) => call.path === "/tabs/open"), true, "and it really went through the fake");
});

test("opens nothing and reads nothing", async (t) => {
  // The case that keeps the published counts below the suite total. It installs a fake and asks it for
  // nothing, so a recorder that charged every running case with a read would count this one too.
  const fake = withFakeGateway(t);
  assert.deepEqual(fake.state.calls, [], "nothing was requested, so nothing can be attributed to this case");
});
