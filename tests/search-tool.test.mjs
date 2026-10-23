import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { testConfig } from "./helpers/config.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { urlPolicyFromConfig } from "../src/net-policy.ts";
import { createCache } from "../src/cache.ts";
import { searchTool } from "../src/tools/search.ts";
import { enginesFromConfig } from "../src/engines/chain.ts";

const BASE = "http://gateway.test:9377";

function setup(t, options = {}) {
  const fake = withFakeGateway(t, options);
  const config = testConfig({ gatewayUrl: BASE, timeoutMs: 2000, ...(options.config ?? {}) });
  const client = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 2000,
    urlPolicy: urlPolicyFromConfig(config),
    ...(options.client ?? {}),
  });
  const engines = enginesFromConfig(config.engines);
  const tool = searchTool({ client, engines, config, cache: createCache(), userId: "u1" });
  return { fake, client, config, engines, tool };
}

/** A google page wider than one call may return: 12 links, where the tool's ceiling is 10. */
function widePageContents() {
  const page = Array.from(
    { length: 12 },
    (_unused, i) => `- link "Wide ${i + 1}" [e${i + 1}]:\n  - /url: https://example.test/w${i + 1}\n  - text: snippet ${i + 1}`,
  ).join("\n");
  // Built per call, because the fake gateway reads the map it is handed and a shared one is one test's
  // mutation away from changing another's page.
  return new Map([["https://www.google.com/search?q=camoufox", page]]);
}

test("returns parsed results for a plain query", async (t) => {
  const { tool } = setup(t);

  const out = await tool.search({ query: "camoufox anti-detect" });

  assert.ok(out.results.length > 0);
  assert.equal(out.engine, "google");
  assert.match(out.text, /\n1\. /u, "results come back numbered for the model");
  assert.match(out.text, /https:\/\//u);
});

test("the second identical query costs the gateway nothing", async (t) => {
  const { fake, tool } = setup(t);

  const first = await tool.search({ query: "camoufox" });
  const before = fake.state.calls.length;
  const second = await tool.search({ query: "camoufox" });
  const after = fake.state.calls.length;

  assert.equal(after, before);
  assert.equal(second.fromCache, true);
  assert.deepEqual(second.results.map((r) => r.url), first.results.map((r) => r.url));
});

test("concurrent identical queries issue exactly one gateway round trip", async (t) => {
  const { fake, tool } = setup(t);

  const [a, b, c] = await Promise.all([
    tool.search({ query: "camoufox" }),
    tool.search({ query: "camoufox" }),
    tool.search({ query: "camoufox" }),
  ]);

  assert.equal(a.results.length, b.results.length);
  assert.equal(b.engine, c.engine);
  const opens = fake.state.calls.filter((c2) => c2.path === "/tabs/open").length;
  assert.equal(opens, 1, `expected one search, saw ${opens} tab opens`);
});

test("failures are never cached", async (t) => {
  const { fake, tool } = setup(t);
  fake.state.failOpen = true;

  const failure = await tool.search({ query: "will fail" }).catch((e) => e);

  assert.equal(failure.code, "gateway_error", `expected a gateway failure, got ${failure.code}`);
  const callsAfterFailure = fake.state.calls.length;

  fake.state.failOpen = false;
  const ok = await tool.search({ query: "will fail" });

  assert.ok(ok.results.length > 0, "the next call must be free to succeed");
  assert.ok(fake.state.calls.length > callsAfterFailure, "the retry must actually hit the gateway");
});

test("cache entries expire", async (t) => {
  const { fake, config, client, engines } = setup(t);
  config.cache.serpMs = 1;
  const tool = searchTool({ client, engines, config, cache: createCache(), userId: "u1" });
  await tool.search({ query: "expiring" });
  const calls = fake.state.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 10));
  await tool.search({ query: "expiring" });

  assert.ok(fake.state.calls.length > calls, "expired entry should refetch");
});

test("clamps n and says so", async (t) => {
  const { tool } = setup(t);

  const out = await tool.search({ query: "camoufox", n: 50 });

  assert.equal(out.clampedTo, 10);
  assert.match(out.text, /10 of 50|clamped/iu);
});

test("a page wider than what came back is counted, not quietly dropped", async (t) => {
  // Nobody asked for more than the tool can give, so `clampedTo` stays undefined and `shortBy` stays
  // undefined: on `main` this call printed "10 result(s)" for a page that carried 12, which is the
  // output claiming more than it returned.
  const { tool } = setup(t, { pageContents: widePageContents() });

  const out = await tool.search({ query: "camoufox" });

  assert.equal(out.results.length, 10, "one call returns the tool's ceiling, no more");
  assert.equal(out.pageCarried, 12, "the two results it threw away are named");
  assert.equal(out.clampedTo, undefined, "nothing was asked for that had to be clamped");
  assert.equal(out.shortBy, undefined, "and nothing came up short");
  assert.match(out.text, /carried 12 result\(s\), 10 returned: one call returns at most 10/u);
});

test("a page wider than `n` names the ask as the reason, not the ceiling", async (t) => {
  // Same page, different request. The one disclosure has to say which limit fired, because the two
  // levers pull differently: `n` is this call's, and no larger `n` moves the other.
  const { tool } = setup(t, { pageContents: widePageContents() });

  const out = await tool.search({ query: "camoufox", n: 4 });

  assert.equal(out.results.length, 4);
  assert.match(out.text, /carried 12 result\(s\), 4 returned: 4 asked for/u);
});

test("both width lines print, and each blames the limit that actually fired", async (t) => {
  // A wide page and an ask past the ceiling fire the two disclosures in one response. The commit that
  // added `pageCarried` left `clampedTo` claiming the *engine* capped the call one line above the line
  // naming this tool's own ceiling — one fact, two causes, and false outright for an engine whose page
  // "carries whatever it carried".
  const { tool } = setup(t, { pageContents: widePageContents() });

  const out = await tool.search({ query: "camoufox", n: 50 });

  assert.equal(out.clampedTo, 10, "the ask was clamped");
  assert.equal(out.pageCarried, 12, "and the page was wider than what returned");

  const notes = out.text.split("\n").filter((line) => line.startsWith("("));
  assert.equal(notes.length, 2, `expected the two width lines, got ${JSON.stringify(notes)}`);
  const [clamped, carried] = notes;

  assert.match(clamped, /50/u, "the line about the ask names the ask");
  assert.match(carried, /carried 12/u, "the line about the page names the page");
  assert.equal(/\bengine\b|\bpage of\b/iu.test(clamped), false, `"${clamped}" blames an engine for a cap this tool set`);
});

test("a cheap first call does not cap what a later call can ask for", async (t) => {
  // Regression: the cache key used to omit `n` and the cached value was already sliced, so asking
  // for 10 after asking for 2 within the TTL window returned 2 and labelled them "from cache".
  const page = `- heading "camoufox daijro - Sök på Google"\n${Array.from(
    { length: 10 },
    (_unused, i) =>
      `- link "Result ${i + 1}" [e${i + 2}]:\n  - /url: https://example.test/result-${i + 1}\n  - text: snippet ${i + 1}`,
  ).join("\n")}`;
  const { tool } = setup(t, { pageContents: new Map([["https://www.google.com/search?q=camoufox", page]]) });

  const few = await tool.search({ query: "camoufox", n: 2 });
  assert.equal(few.results.length, 2);

  const many = await tool.search({ query: "camoufox", n: 10 });
  assert.equal(many.results.length, 10);
  assert.equal(many.fromCache, true);
  assert.equal(many.clampedTo, undefined);
});

test("n below one is disclosed, not silently turned into a single result", async (t) => {
  const { tool } = setup(t);

  const out = await tool.search({ query: "camoufox", n: 0 });

  assert.equal(out.results.length, 1);
  assert.equal(out.clampedTo, 1);
});

test("a fractional n is refused, not floored into silence", async (t) => {
  const { tool } = setup(t);

  // 2.5 used to reach `slice`, which floors it: 2 rows came back, `clampedTo` stayed undefined (2.5 is
  // its own minimum against the page bound), and on a page of 2 the output said "0.5 fewer result(s)".
  await assert.rejects(
    () => tool.search({ query: "camoufox", n: 2.5 }),
    /"n" must be a whole number.*2\.5/us,
    "names the parameter and the value it rejected",
  );
});

test("a string n is refused as the string it is, not as the number it was mistaken for", async (t) => {
  // The bare interpolation printed `"2"` as `2`, so the one thing a caller needed to see — that it sent
  // a string — was missing from the message that exists to say it.
  const { tool } = setup(t);

  await assert.rejects(
    () => tool.search({ query: "camoufox", n: "2" }),
    /got "2" \(string\)/us,
    "quoted, typed, and therefore readable as the mistake it was",
  );
});

test("a fractional search.maxResults is refused at the tool, not only by the validator", async (t) => {
  // `testConfig` merges without running `assertCoherent`, so this is the path a hand-built config takes
  // — and the one the validator's integer rule cannot cover.
  const { tool } = setup(t, { config: { search: { maxResults: 2.5 } } });

  await assert.rejects(
    () => tool.search({ query: "camoufox" }),
    /"search\.maxResults" must be a whole number/u,
    "the message names the key that is wrong, not a parameter nobody passed",
  );
});

test("resolve fills in final urls and reports ones that stayed wrapped", async (t) => {
  const { client, config, engines } = setup(t);
  const tool = searchTool({ client, engines, config, cache: createCache(), userId: "u1" });

  const out = await tool.search({ query: "camoufox daijro", resolve: true });

  assert.ok(out.results.length > 0);
  for (const result of out.results) {
    assert.equal(result.resolved, true, `expected resolution, got ${result.url}`);
    assert.ok(!result.url.includes("goto"), `still wrapped: ${result.url}`);
  }
  assert.equal(client.openTabCount(), 0, "resolver tabs are closed");
});

test("resolution is narrated, and only when something is being resolved", async (t) => {
  // The engine notes stop once a page is parsed, but resolution is the part the description warns the
  // model about — one navigation per wrapper url — and it came after the last note in silence.
  const direct = Array.from(
    { length: 3 },
    (_unused, i) => `- link "Direct ${i + 1}" [e${i + 1}]:\n  - /url: https://example.test/d${i + 1}\n  - text: snippet ${i + 1}`,
  ).join("\n");
  const { tool } = setup(t, { pageContents: new Map([["https://www.google.com/search?q=direct", direct]]) });

  const resolving = [];
  const out = await tool.search({ query: "camoufox", resolve: true, onProgress: (note) => resolving.push(note) });
  const wrapped = out.results.filter((r) => r.resolvable).length;
  assert.ok(wrapped > 0, "the default fake SERP has to carry wrapper urls, or this proves nothing");
  assert.ok(resolving.includes(`resolving ${wrapped} urls`), `no count note in ${JSON.stringify(resolving)}`);

  const plain = [];
  await tool.search({ query: "camoufox daijro", onProgress: (note) => plain.push(note) });
  assert.equal(plain.some((note) => /resolving/u.test(note)), false, "nothing was navigated, so nothing was claimed");

  const unwrapped = [];
  const directOut = await tool.search({ query: "direct", resolve: true, onProgress: (note) => unwrapped.push(note) });
  assert.equal(directOut.results.some((r) => r.resolvable), false, "this page has no wrapper, so resolve has nothing to do");
  assert.equal(unwrapped.some((note) => /resolving/u.test(note)), false, "a count of nothing would be a promise of work not coming");
});

test("reports the engine chain it tried", async (t) => {
  const { tool } = setup(t, { consentWallOn: new Set(["u1"]) });

  const out = await tool.search({ query: "camoufox" });

  assert.equal(out.engine, "duckduckgo");
  assert.deepEqual(out.tried.map((s) => s.engine), ["google", "duckduckgo"]);
  assert.match(out.text, /google:consent_wall/u);
  assert.match(out.text.split("\n")[0], /via duckduckgo/u, "and the answer is attributed to the engine that served it, not the one that walled");
});

/**
 * A model cannot calibrate trust in a result set it cannot attribute. "Google served this" and
 * "DuckDuckGo served this after Google walled" are different claims, and only the second one used to
 * be stated: the header named an engine only once the chain had walked, so the common case — first
 * engine, no wall — said nothing in the text a model reads, and left the engine in `details.engine`
 * alone. `src/extension.ts` has a comment claiming the success path "has named its chain all along";
 * that is the sentence that let this stay open, and it was true only of a success that fell back.
 *
 * Asserted against the first line on purpose. Every result line already prints the result's own host,
 * so a link to `google.com` in the body would satisfy a loose match without this being about it.
 */
test("a first-try success still names the engine that answered", async (t) => {
  const { tool } = setup(t);

  const out = await tool.search({ query: "camoufox" });

  assert.equal(out.engine, "google");
  assert.equal(out.tried.length, 1, "nothing fell back — this is the case that used to be silent");

  const header = out.text.split("\n")[0];
  assert.match(header, /\(via google\)/u, "attributed even when there was no chain to report");
  assert.doesNotMatch(header, /tried/u, "and with no fallback, there is no fallback to enumerate");
});

test("an empty query is rejected before touching the gateway", async (t) => {
  const { fake, tool } = setup(t);

  const error = await tool.search({ query: "   " }).catch((e) => e);

  assert.equal(error.code, "unsupported");
  assert.equal(fake.state.calls.filter((c) => c.path !== "/").length, 0);
});

test("normalises the query for cache purposes", async (t) => {
  const { fake, tool } = setup(t);

  await tool.search({ query: "  Camoufox   Anti-Detect  " });
  const calls = fake.state.calls.length;
  await tool.search({ query: "camoufox anti-detect" });

  assert.equal(fake.state.calls.length, calls);
});
