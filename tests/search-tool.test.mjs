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
import { readTool } from "../src/tools/read.ts";
import { enginesFromConfig } from "../src/engines/chain.ts";
import { SEARCH_SETTLE_POLL_MS } from "../src/engines/settle.ts";

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
 * alone.
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

test("an engine we have no adapter for is refused as an unknown name", async (t) => {
  // `engine?` is free-form at the boundary, so `bing` used to arrive and be answered with "is not
  // available (enabled: google, duckduckgo)" — which reads as a capability the gateway lacks, not as a
  // name nobody recognises. Those are different facts with different remedies: one is fixed by editing
  // config, the other by fixing a typo, and a model that is told the first will go looking for a
  // setting that has to do with `bing` and does not exist.
  const { tool } = setup(t);

  const error = await tool.search({ query: "camoufox", engine: "bing" }).catch((e) => e);

  assert.equal(error.code, "unsupported");
  // Wording lifted from `config.ts`, which refuses this same name at load with `unknown engine "x"
  // (known: ...)`. Deliberately not `chain.ts`'s "no adapter for engine", which means something else:
  // the name passed config validation and still has no factory — our bug, not the caller's.
  assert.match(error.message, /unknown engine/u, `"${error.message}"`);
  assert.match(error.message, /google, duckduckgo/u, "and it names what is actually selectable");
  assert.doesNotMatch(error.message, /enabled: google, duckduckgo/u, "because 'enabled' is the wording for the other case");
});

test("an engine that exists but is switched off says so, rather than claiming it is not a thing", async (t) => {
  // The same message covered both cases, and this is the one it got wrong: `duckduckgo` is a real
  // adapter, present, and turned off in this user's config. Telling them it "is not available (enabled:
  // google)" is true only about the active chain and reads as though the engine itself is missing — the
  // one thing they could do is the one thing the message rules out.
  const { tool, engines } = setup(t, {
    config: { engines: [{ name: "google", enabled: true }, { name: "duckduckgo", enabled: false }] },
  });

  assert.deepEqual(engines.map((e) => e.name), ["google"], "the fixture really does switch it off");

  const error = await tool.search({ query: "camoufox", engine: "duckduckgo" }).catch((e) => e);

  assert.equal(error.code, "unsupported");
  assert.match(error.message, /disabled/u, `"${error.message}"`);
  assert.doesNotMatch(error.message, /unknown engine/u, "it is known — that is the whole distinction");
});

test("a non-string engine is refused by name rather than compared against the chain", async (t) => {
  // Nothing validates tool arguments, so `engine: 5` reaches the filter as-is and matches nothing. It
  // is the same unknown-name case, but the message has to print it the way it arrived or a model reads
  // `5` as a disabled engine.
  const { tool } = setup(t);

  const error = await tool.search({ query: "camoufox", engine: 5 }).catch((e) => e);

  assert.equal(error.code, "unsupported");
  assert.match(error.message, /unknown engine/u, `"${error.message}"`);
  assert.match(error.message, /\(number\)/u, "printed with its type, so the mistake is visible");
});

/**
 * The falsy `engine` values, one test each.
 *
 * Truthiness is what the filter tested, so each value below read as "nobody forced an engine": the whole
 * two-engine chain ran, and the header attributed the answer to whichever engine served it. The schema
 * description ("anything else is refused with code unsupported") and the README bullet both say these
 * are refused.
 *
 * One test per value rather than a loop, because `bing` being the only case anyone wrote down is how this
 * survived its own test file: a loop that skips a value looks identical to one that covers it.
 */

/** Refused, and refused before a page was fetched: a refusal that cost two navigations is not a refusal. */
function assertRefusedBeforeFetching(error, fake, shown, label) {
  assert.equal(error.code, "unsupported", `${label} was served results instead of being refused`);
  assert.match(error.message, /unknown engine/u, `${label} → "${error.message}"`);
  assert.match(error.message, new RegExp(shown, "u"), "printed the way it arrived, so the mistake is visible");
  assert.equal(
    fake.state.calls.filter((call) => call.path === "/tabs/open").length,
    0,
    `${label}: no tab was opened, not even to be refused`,
  );
}

test('engine "" is refused, not read as an empty default nobody asked about', async (t) => {
  // The realistic one: a caller forwarding an unset value as `config.engine ?? ""`, or a model emitting
  // an empty string as its default for an optional field. Truthiness turned an explicit ask into a
  // silent full-chain run — the defect `assertMaxCharsUsable` was written to prevent, in the sibling tool.
  const { fake, tool } = setup(t);

  const error = await tool.search({ query: "camoufox", engine: "" }).catch((e) => e);

  assertRefusedBeforeFetching(error, fake, '"" \\(string\\)', '""');
});

test("engine 0 is refused, not read as an unindexed default", async (t) => {
  // A caller mapping engines by position and reading the slot of an unset index sends this, and `0` is
  // the value that made the old truthiness branch look harmless: it is falsy, so it was "no engine".
  const { fake, tool } = setup(t);

  const error = await tool.search({ query: "camoufox", engine: 0 }).catch((e) => e);

  assertRefusedBeforeFetching(error, fake, '\\b0 \\(number\\)', "0");
});

test("engine false is refused, not read as an unanswered question", async (t) => {
  // `engine: ready && "google"` from a caller wiring the argument conditionally produces exactly this
  // before anything is awaited, and the answer it used to get names an engine nobody asked for.
  const { fake, tool } = setup(t);

  const error = await tool.search({ query: "camoufox", engine: false }).catch((e) => e);

  assertRefusedBeforeFetching(error, fake, "false \\(boolean\\)", "false");
});

test("engine NaN is refused, like every other number this tool refuses", async (t) => {
  // `Number("")` and `Number(undefined)` are both this value, so it arrives from the same string-parsing
  // caller that produced the read tool's uncapped page. Here the type is the mistake, so it is printed
  // as `NaN (number)` rather than compared against the chain, where it matches nothing quietly.
  const { fake, tool } = setup(t);

  const error = await tool.search({ query: "camoufox", engine: NaN }).catch((e) => e);

  assertRefusedBeforeFetching(error, fake, "NaN \\(number\\)", "NaN");
});

test("engine null is the absence it looks like, and keys the same chain an omitted one does", async (t) => {
  // The one falsy value that is not an ask. `null` is a nullish *nothing*, which is the same thing
  // `params.maxChars ?? read.defaultMaxChars` treats as "not provided" — so `??` normalises it and this
  // call takes the whole enabled chain. Asserted through the cache: a shared key is the proof that the
  // filter saw no engine, where a message would only prove we did not throw.
  const { fake, tool } = setup(t);

  const out = await tool.search({ query: "camoufox", engine: null });
  assert.equal(out.engine, "google", "the chain ran from the top, as it does with no engine named");

  const before = fake.state.calls.length;
  const plain = await tool.search({ query: "camoufox" });

  assert.equal(plain.fromCache, true, "the omitted call hits the entry the null call stored");
  assert.equal(fake.state.calls.length, before, "so the two asked for the same page, not two pages");
});

test("both tools read a nullish argument as absence, not as a value to refuse", async (t) => {
  // The decision above, pinned as an assertion rather than a comment: search normalises `engine` with
  // `??`, which is the exact expression `wantedChars` uses. Two tools giving two different answers to
  // "is null an ask?" is the thing a caller cannot guess, so the pair is tested together.
  const { tool, client, config } = setup(t, {
    pageContents: new Map([["https://huge.test/", "h".repeat(20_000)]]),
  });
  const read = readTool({ client, config, cache: createCache(), userId: "u1" });

  const search = await tool.search({ query: "camoufox", engine: null });
  assert.equal(search.engine, "google", "search: null engine runs the chain rather than being refused");

  // 20 000 characters on the page, 12 000 is the configured default: cut to the default, which is what
  // an absent budget does. `0` and `false` are refused outright by this same tool, which is the
  // distinction — null is not in that family.
  const page = await read.read({ url: "https://huge.test/", maxChars: null });
  assert.equal(page.text.length, config.read.defaultMaxChars, "read: null maxChars spent the default");
  assert.equal(page.totalChars, 20_000);
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

// --- what a slow SERP cost ----------------------------------------------------------------------

/**
 * Two frames of the same page, engine-neutral on purpose: an engine that has drawn its own chrome and
 * an engine that has drawn its results are the two states every adapter waits between.
 */
const SERP_SKELETON = `- heading "camoufox"\n- searchbox "Search" [e1]: camoufox\n- navigation:\n  - link "Allt" [e2]\n  - link "Webb" [e3]`;
const SERP_WITH_RESULTS = `${SERP_SKELETON}\n- link "Camoufox: Introduction" [e9]:\n  - /url: https://camoufox.com\n  - text: An open source anti-detect browser.`;
/** A page as wide as one call may return — what a caller asking `n: 10` is owed, once the render finishes. */
const TEN_RESULTS_PAGE = Array.from(
  { length: 10 },
  (_unused, i) => `- link "Tall ${i + 1}" [e${i + 2}]:\n  - /url: https://example.test/t${i + 1}\n  - text: snippet ${i + 1}`,
).join("\n");

test("a search that waited for its SERP says how long it waited, and says nothing else", async (t) => {
  const { tool } = setup(t, {
    snapshotScripts: new Map([["https://www.google.com/search?q=late", [SERP_SKELETON, SERP_WITH_RESULTS]]]),
  });

  const out = await tool.search({ query: "late", n: 1 });

  assert.equal(out.results.length, 1, "the re-look is what served this, so the wait is the story");
  assert.equal(typeof out.settledInMs, "number", "the time is a fact about the call, not only about the page");

  const notes = out.text.split("\n").filter((line) => line.startsWith("("));
  assert.equal(notes.length, 1, `one conditional line, not one per surprise: ${JSON.stringify(notes)}`);
  assert.match(notes[0], /^\(waited \d+ms for the page to render\)$/u, "the number, and no advice to give");
});

test("a search that needed no re-look says nothing about waiting", async (t) => {
  // The other half of the note: a line that fires on every search is noise, and this item is about the
  // wrong statement a thin page used to produce, not about narrating normal operation.
  const { tool } = setup(t);

  const out = await tool.search({ query: "camoufox" });

  assert.equal(out.settledInMs, undefined, "nothing was polled, so nothing is reported as polled");
  assert.equal(/\bwaited\b/u.test(out.text), false, "and the model is not told about a wait that did not happen");
});

test("a search served from cache reports no wait it did not pay", async (t) => {
  // `settledInMs` is a cost, and the caching rule in this file is that a caller who rode along on
  // someone else's work does not report having done it.
  //
  // The chain waited on google and failed there, so the page that was stored is the one duckduckgo
  // answered with at a glance — which is what makes it storable at all. A page the engines had to wait
  // for is not kept, and the test below is why.
  const { fake, tool } = setup(t, {
    pageContents: new Map([["https://www.google.com/search?q=late", SERP_SKELETON]]),
  });

  const first = await tool.search({ query: "late" });
  assert.equal(first.engine, "duckduckgo", "the stored page came from the engine that answered at a glance");
  const second = await tool.search({ query: "late" });

  assert.equal(typeof first.settledInMs, "number", "the call that fetched the page paid for it");
  assert.equal(second.fromCache, true);
  assert.equal(second.settledInMs, undefined, "the call that fetched nothing claims no waiting");
  assert.equal(/\bwaited\b/u.test(second.text), false);
});

test("a SERP caught at its first result answers this call and is not kept for the next", async (t) => {
  // The engines stop at the first organic result, so a page caught between its chrome and its results is
  // a page only partly known — and nothing later can tell it from a page that finished there. Returning
  // it is honest, because `shortBy` says what came up short. Storing it under a key that deliberately
  // ignores `n` is not: one result becomes the answer for every later ask, for the whole `cache.serpMs`.
  const { fake, tool } = setup(t, {
    snapshotScripts: new Map([["https://www.google.com/search?q=slow", [SERP_SKELETON, SERP_WITH_RESULTS]]]),
  });

  const narrow = await tool.search({ query: "slow", n: 1 });
  assert.equal(narrow.results.length, 1, "stop-at-first is still what answers a search");

  // The page has arrived since. Were the partial frame still stored, none of what follows would be read.
  fake.state.snapshotScripts.set("https://www.google.com/search?q=slow", [TEN_RESULTS_PAGE]);
  const before = fake.state.calls.length;

  const wide = await tool.search({ query: "slow", n: 10 });

  assert.notEqual(wide.fromCache, true, "a page we stopped looking at mid-render was not kept");
  assert.ok(fake.state.calls.length > before, "the wider ask went back to the gateway instead of the frozen frame");
  assert.equal(wide.results.length, 10, "and came back with a page");
});

/**
 * B.8 as filed, at the far end of the chain: the refusal is not only served, it is kept.
 *
 * `shouldStore` reads `!pagePolled`, and a page that answers at its first look is never polled — so a
 * refusal the classifier never saw is stored under a key that deliberately ignores `n` and served for
 * `cache.serpMs`. The classifier case in `tests/snapshot.test.mjs` shows the wrong verdict; this shows
 * what it costs, which is the half that decides the item's rank.
 *
 * Pinned as wrong, not as right. Two assertions carry it: the absence of a wait, and the absence of
 * requests. A fix that makes a first look count as polled, or that refuses this page at the classifier,
 * turns this red by design — retire it with the item rather than tuning it.
 */
test("B.8 as filed: a refusal served from the first look is cached, and the second query costs no request", async (t) => {
  const { fake, tool } = setup(t, {
    pageContents: new Map([
      ["https://www.google.com/search?q=blocked", readFileSync(new URL("./fixtures/serp-reddit-blocked.txt", import.meta.url), "utf8")],
    ]),
  });

  const first = await tool.search({ query: "blocked" });

  assert.deepEqual(
    first.tried,
    [{ engine: "google", code: "ok", message: "served" }],
    "B.8: the chain credits the block page as an engine answering, so no second engine is tried",
  );
  assert.equal(first.results.length, 1, "B.8: the one link on a refusal is the whole answer");
  assert.match(first.results[0].url, /^https:\/\/support\.reddithelp\.com\//u, "B.8: and it is the support desk ticket form");
  assert.equal(first.settledInMs, undefined, "nothing was re-looked at, which is exactly the fact `shouldStore` reads");

  const before = fake.state.calls.length;
  const second = await tool.search({ query: "blocked" });

  assert.equal(
    second.fromCache,
    true,
    "B.8 is open, not fixed: a refusal was kept as a cached answer. Red here means the store gate or the classifier changed — retire this with the item.",
  );
  assert.equal(fake.state.calls.length, before, "B.8: the second identical query costs 0 gateway calls, so nothing downstream can notice it");
});

test("the wait a search reports is the whole chain's, not just the engine that answered", async (t) => {
  // Google renders chrome, never results, and costs two re-looks before the hop. DuckDuckGo needs one
  // and serves. A hop is paid *after* the wait that preceded it, so the note that omits the first one
  // is a number the model cannot reconcile with how long the call took.
  const { tool } = setup(t, {
    pageContents: new Map([["https://www.google.com/search?q=two-waits", SERP_SKELETON]]),
    snapshotScripts: new Map([["https://duckduckgo.com/?q=two-waits", [SERP_SKELETON, SERP_WITH_RESULTS]]]),
  });

  const out = await tool.search({ query: "two-waits" });

  assert.equal(out.engine, "duckduckgo", "the chain really did hop, or this measures nothing");
  assert.ok(
    out.settledInMs >= 3 * SEARCH_SETTLE_POLL_MS,
    `${out.settledInMs}ms is under the three re-looks this chain made — a timer that oversleeps can only raise this`,
  );
});
