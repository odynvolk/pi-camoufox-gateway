import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { withFakeGateway, createFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { snapshotSettled } from "../src/settle.ts";
import { GatewayError } from "../src/errors.ts";
import { enginesFromConfig, SEARCH_CHAIN_BUDGET_IN_DEADLINES, searchWithFallback } from "../src/engines/chain.ts";
import { googleEngine } from "../src/engines/google.ts";
import { duckduckgoEngine } from "../src/engines/duckduckgo.ts";
import { classifySerp, engineOwnsUrl, parseSerp } from "../src/snapshot.ts";
import { SEARCH_SETTLE_MS, SEARCH_SETTLE_POLL_MS, serpWorthAnotherLook } from "../src/engines/settle.ts";
import { STABLE_ROUNDS } from "../src/settle.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { engineResultPrefixes } from "../scripts/measure-unregistered-pages.mjs";

const BASE = "http://gateway.test:9377";

function setup(t, options = {}) {
  const { timeoutMs = 2000, ...gatewayOptions } = options;
  const fake = withFakeGateway(t, gatewayOptions);
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs });
  return { fake, client };
}

function callsFor(fake, suffix) {
  return fake.state.calls.filter((c) => c.path.includes(suffix));
}

test("google opens the tab at the SERP url and nothing else", async (t) => {
  // The macro is gone, and this is the sequence that replaced it. Measured on the live gateway
  // (2026-10-27): `POST /tabs/open` at the search url answers in 268 ms with a Google SERP, while
  // `POST /tabs/:id/navigate` with `@google_search` spends ~31s and hands back a DuckDuckGo page —
  // upstream's organic-results check rejects `google.com/goto?url=` links by host name, so it always
  // concludes "no organic results" and substitutes DuckDuckGo. One open is both the fast path and the
  // honest one.
  const { fake, client } = setup(t);

  const outcome = await googleEngine().search("camoufox", { client, userId: "u1" });

  assert.ok(outcome.results.length > 0);
  // No engine label here: identity is credited by the chain from Engine.name, so the adapter has
  // nothing to claim. The sequence below is what proves this was the google path.

  const sequence = fake.state.calls
    .filter((c) => c.path !== "/")
    .map((c) => `${c.method} ${c.path.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, ":tab")}`);
  assert.deepEqual(sequence, ["POST /tabs/open", "GET /tabs/:tab/snapshot", "DELETE /tabs/:tab"]);

  const opened = fake.state.calls.find((c) => c.path === "/tabs/open");
  assert.equal(
    opened.body.url,
    "https://www.google.com/search?q=camoufox",
    "the engine asks for the SERP itself, query encoded",
  );
  assert.equal(callsFor(fake, "/navigate").length, 0, "no macro hop, and no second navigation to time out on");
});

test("google leaves no tab open when it finishes", async (t) => {
  const { client } = setup(t);
  await googleEngine().search("camoufox", { client, userId: "u1" });
  assert.equal(client.openTabCount(), 0);
});

test("google closes its tab even when the snapshot fails", async (t) => {
  const { client } = setup(t, { failSnapshot: true });

  const error = await googleEngine()
    .search("camoufox", { client, userId: "u1" })
    .catch((e) => e);

  assert.ok(error.code, `expected a typed error, got ${error}`);
  assert.equal(client.openTabCount(), 0);
});

test("duckduckgo navigates straight to its query url", async (t) => {
  const { fake, client } = setup(t);

  const outcome = await duckduckgoEngine().search("camoufox anti-detect", { client, userId: "u1" });

  assert.ok(outcome.results.length > 0);
  const opened = fake.state.calls.find((c) => c.path === "/tabs/open");
  assert.match(opened.body.url, /^https:\/\/duckduckgo\.com\/\?q=camoufox/u);
  assert.equal(callsFor(fake, "/navigate").length, 0, "no macro or extra navigation for ddg");
});

test("each adapter opens at a page its own credited name owns", async (t) => {
  // The one risk `serp.ts` takes on is that a single identifier now answers two questions: the `Engine.name`
  // the chain credits, and the key `engineOwnsUrl` decides host ownership by. Written as two literals they
  // could drift, and the drift is exactly the misattribution the ownership rule exists to close — an engine
  // credited for a page it does not host, chrome-filtered by that engine's own host list. So ask each
  // adapter where it actually opened, and hold that url to the name it reports.
  for (const engine of [googleEngine(), duckduckgoEngine()]) {
    const { fake, client } = setup(t);
    await engine.search("camoufox", { client, userId: "u1" });

    const opened = fake.state.calls.find((call) => call.path === "/tabs/open").body.url;
    assert.equal(
      engineOwnsUrl(engine.name, opened),
      true,
      `${engine.name} opened at ${opened}, which its own name does not own — it would refuse its own results page`,
    );
  }
});

test("an adapter reports only links from the page it was sent to", async (t) => {
  // G.6. `tests/helpers/fake_gateway.mjs` answers **any** url a test did not register with an invented
  // article, and that article's one link sits on a host no engine owns — so `src/snapshot.ts` →
  // `return hostIsEngineDomain(host, rule) && !(rule.wrappers && isWrapper(url));` calls it an organic
  // result under either engine label. Measured 2026-11-01 by deleting the navigation from
  // `src/engines/serp.ts` and opening both tabs at their own origin root instead: 347 of 378 tests stayed
  // green, and the search tool still answered `(via google)` with **1 result, `https://camoufox.com/docs`**.
  // `engineOwnsUrl` cannot see this: the host it asks about was the engine's own the whole time. So the
  // caller has to pin the page, which is the shape this repo already uses at
  // `tests/search-tool.test.mjs` → `the default fake SERP has to carry wrapper urls` — assert the
  // precondition the case leans on, not the number it produced.
  // Which page each engine is meant to be sent to, derived by running the adapter — the way
  // `scripts/measure-unregistered-pages.mjs` does it for the same reason: a results url pasted in here would
  // keep matching after the engine moved its search url, and this case would go on pinning a page no engine
  // opens any more.
  const QUERY = "camoufox";
  const prefixes = await engineResultPrefixes();
  const ours = ["https://registered-for-this-test.test/one", "https://registered-for-this-test.test/two"];
  const page = ours
    .map((url, index) => `- link "Ours ${index + 1}" [e${index + 1}]:\n  - /url: ${url}\n  - text: a link only this test put here`)
    .join("\n");

  for (const engine of [googleEngine(), duckduckgoEngine()]) {
    const prefix = prefixes.get(engine.name);
    assert.ok(prefix, `${engine.name} never asked to open at a results url, so there is no page to pin here`);
    const url = `${prefix}${QUERY}`;
    const registered = setup(t, { pageContents: new Map([[url, page]]) });

    const outcome = await engine.search(QUERY, { client: registered.client, userId: "u1" });
    const opened = registered.fake.state.calls.find((call) => call.path === "/tabs/open").body.url;

    // Premise zero, and the one that was missing: the tab was opened *at* the page this test registered its
    // links on. The two premises below only speak about what came back, so an adapter that reached that page
    // by some other route still satisfied them, and `opened` was read only to be named in a failure message.
    assert.equal(
      opened,
      url,
      `${engine.name} was sent to ${opened}, not to the ${url} this test put its page at — whatever reported those links, it did not read it here`,
    );

    // Premise one: the page this test registered is what came back. Without this the loop below would
    // pass against an engine that reported nothing at all.
    assert.ok(
      ours.every((link) => outcome.results.some((result) => result.url === link)),
      `${engine.name} did not report the two links registered at ${url} (${JSON.stringify(outcome.results.map((r) => r.url))})`,
    );
    // The guard: no reported url may come from anywhere else. One that does arrived from the fake's
    // invented article, which is a page no engine owns and which the host rule reads as organic.
    for (const result of outcome.results) {
      assert.ok(
        ours.includes(result.url),
        `${engine.name} reported ${result.url} from ${opened}, a page this test never registered — the fake's invented article, whose one link the host rule calls organic`,
      );
    }

    // Premise two: the invented page really is reportable as this engine's results. If the fake ever
    // stops inventing it, the guard above is vacuous and this line says so instead of going green.
    const bare = setup(t);
    const stray = await bare.client.openTab({ userId: "u1", url: `${new URL(url).origin}/` });
    const snapshot = await bare.client.snapshot({ userId: "u1", tabId: stray.tabId });
    await bare.client.closeTabQuietly({ userId: "u1", tabId: stray.tabId });
    assert.deepEqual(
      parseSerp(snapshot, engine.name).results.map((result) => result.url),
      ["https://camoufox.com/docs"],
      `the fake no longer invents a ${engine.name} results page at an unregistered url, so the guard above is vacuous — G.6 is closed, retire this case deliberately`,
    );
  }
});

test("an adapter hands back the whole page, unsliced", async (t) => {
  // The default fake SERP carries three links, so `results.length <= 10` would pass against any
  // implementation. Twelve is the input that decides whether a slice happened here or at the tool.
  const overflow = Array.from({ length: 12 }, (_, i) => `- link "R${i}" [e${i}]:
  - /url: https://example.com/r${i}
  - cite: https://example.com
`).join("");

  const { fake, client } = setup(t, {
    pageContents: new Map([["https://www.google.com/search?q=camoufox", overflow]]),
  });
  const outcome = await googleEngine().search("camoufox", { client, userId: "u1" });

  assert.equal(outcome.results.length, 12, "twelve links on the page, twelve handed back — one width, and it is not here");
  assert.equal(callsFor(fake, "/navigate").length, 0, "and the count was bought with the one open, not a navigation");
});

test("a page we cannot read as a results list is parse_error, not empty_results", async (t) => {
  // A wall or an empty page says something about the query; "the tree changed shape" says something
  // about our parser, and the model needs the difference to know whether retrying can help.
  const prose = `- heading "Google Results" [level=1]\n${"- paragraph:\n  - text: long enough to be a real page.\n".repeat(120)}`;
  assert.ok(prose.length > 2_000);

  const { client } = setup(t, { pageContents: new Map([["https://www.google.com/search?q=anything", prose]]) });
  const error = await googleEngine().search("anything", { client, userId: "u1" }).catch((e) => e);

  assert.equal(error.code, "parse_error");
  assert.ok(error.details?.excerpt, "the failure carries an excerpt so the diagnosis is possible");
});
test("falls through to duckduckgo when google hits a consent wall", async (t) => {
  const { client } = setup(t, { consentWallOn: new Set(["u1"]) });
  const google = googleEngine();
  const ddg = duckduckgoEngine();

  const outcome = await searchWithFallback("camoufox", [google, ddg], { client, userId: "u1" });

  assert.equal(outcome.engine, "duckduckgo");
  assert.deepEqual(outcome.tried.map((step) => step.engine), ["google", "duckduckgo"]);
  assert.equal(outcome.tried[0].code, "consent_wall");
});

test("reports empty_results and keeps trying the chain", async (t) => {
  const { client } = setup(t);
  const empty = {
    name: "empty",
    search: async () => ({ results: [] }),
  };
  const ddg = duckduckgoEngine();

  const outcome = await searchWithFallback("camoufox", [empty, ddg], { client, userId: "u1" });

  assert.equal(outcome.engine, "duckduckgo");
  assert.equal(outcome.tried[0].code, "empty_results");
});

test("keeps the first meaningful error when the whole chain fails", async (t) => {
  const { client } = setup(t);
    const first = { name: "first", search: async () => { throw new GatewayError("consent_wall", "google consent"); } };
  const second = {
    name: "second",
    search: async () => {
      throw new GatewayError("parse_error", "tree changed");
    },
  };

  const error = await searchWithFallback("camoufox", [first, second], { client, userId: "u1" }).catch((e) => e);

  assert.equal(error.code, "consent_wall");
  assert.deepEqual(error.details.tried.map((step) => step.engine), ["first", "second"]);
});

test("does not walk the chain when the gateway itself is down", async (t) => {
  const { client } = setup(t, { unreachable: true });
  const engines = [googleEngine(), duckduckgoEngine()];

  const error = await searchWithFallback("camoufox", engines, { client, userId: "u1" }).catch((e) => e);

  assert.equal(error.code, "gateway_unreachable");
  // The early exit is the whole point of the code list: without it every search burns a second
  // connect timeout against a gateway that is already known to be down.
  assert.equal(error.details.tried.length, 1, "the chain stopped at the first terminal code");
});

test("a link-less page inside the wall window is parse_error, empty_results is reserved for short pages", async (t) => {
  // The boundary that PARSEABLE_MIN_CHARS actually decides. detectWall runs first and declines these
  // (no host evidence, no wall phrase, both under INTERSTITIAL_MAX_CHARS), so which code the model
  // gets is decided here and nowhere else.
  const line = "- paragraph:\n  - text: page text without links.\n"; // 48 chars
  const band = `- heading "Google Results" [level=1]\n${line.repeat(50)}`; // 2,438 chars
  const short = `- heading "Google Results" [level=1]\n${line.repeat(35)}`; // 1,718 chars

  assert.ok(band.length > 2_000 && band.length <= 3_000, `band fixture is ${band.length} chars`);
  assert.ok(short.length <= 2_000, `short fixture is ${short.length} chars`);

  const { client } = setup(t, {
    pageContents: new Map([
      ["https://www.google.com/search?q=band", band],
      ["https://www.google.com/search?q=thin", short],
    ]),
  });

  const bandError = await googleEngine().search("band", { client, userId: "u1" }).catch((e) => e);
  assert.equal(bandError.code, "parse_error", "long enough to have been a real page, so blame the parser");

  const shortError = await googleEngine().search("thin", { client, userId: "u1" }).catch((e) => e);
  assert.equal(shortError.code, "empty_results", "a page this thin says something about the query, not us");
});

test("every terminal code stops the chain before the next engine is tried", async (t) => {
  const { client } = setup(t);

  // `timeout` is not in this list, and the case below is why. Everything here is an outcome where the
  // next engine would meet the same wall: the gateway is down, it refused our credentials, or the address
  // guard said no before anyone dialled.
  for (const code of ["gateway_unreachable", "gateway_unauthorized", "host_blocked", "private_network"]) {
    let secondRan = false;
    const first = {
      name: "first",
      search: async () => {
        throw new GatewayError(code, `${code} from the first engine`);
      },
    };
    const second = {
      name: "second",
      search: async () => {
        secondRan = true;
        return { results: [] };
      },
    };

    const error = await searchWithFallback("camoufox", [first, second], { client, userId: "u1" }).catch((e) => e);

    assert.equal(error.code, code, `${code} must surface unchanged`);
    assert.equal(secondRan, false, `${code} must not reach the next engine`);
    assert.equal(error.details.tried.length, 1, `${code} must stop after one step`);
  }
});

test("one slow engine may not abort the whole search", async (t) => {
  // A gateway that is up and slow on one engine is the case this chain exists for; a gateway that is
  // *down* is still terminal through `gateway_unreachable`, which the case above keeps. Reported with the
  // timeout still terminal: one slow google cost 2 × 30s (a retryable timeout spends the retry budget)
  // and the call came back `tried: [{"engine":"google","code":"timeout"}]` with duckduckgo never asked.
  const { client } = setup(t);
  const slow = {
    name: "google",
    search: async () => {
      throw new GatewayError("timeout", "gateway did not respond within 30000ms", { retryable: true });
    },
  };

  const outcome = await searchWithFallback("camoufox", [slow, duckduckgoEngine()], { client, userId: "u1" });

  assert.equal(outcome.engine, "duckduckgo", "the engine that answered, not the one that was slow");
  assert.deepEqual(
    outcome.tried.map((step) => `${step.engine}:${step.code}`),
    ["google:timeout", "duckduckgo:ok"],
    "the slow engine is still recorded — a hop that hides which engine was slow is a lie by omission",
  );
});

test("an engine that throws something bare is our fault, not the gateway's", async (t) => {
  // A gateway fault arrives coded, because the client codes it at the transport boundary. A `TypeError`
  // out of an adapter is our own code tripping, and it must not reach the model as `gateway_error`.
  const { client } = setup(t);
  const broken = {
    name: "broken",
    search: async () => {
      throw new TypeError("cannot read properties of undefined");
    },
  };

  const error = await searchWithFallback("camoufox", [broken], { client, userId: "u1" }).catch((e) => e);

  assert.equal(error.code, "internal_error");
  assert.match(error.message, /cannot read properties of undefined/u, "the real fault, still named");
  assert.deepEqual(
    error.details.tried.map((step) => step.code),
    ["internal_error"],
    "the step is credited with the same code",
  );
});

test("honours enabled flags and ordering from config", async (t) => {
  const engines = enginesFromConfig([
    { name: "google", enabled: true },
    { name: "duckduckgo", enabled: false },
  ]);

  assert.deepEqual(engines.map((e) => e.name), ["google"]);
});

// --- hydration tolerance on the search path ---------------------------------------------------
//
// Every frame here is cut from a recorded fixture rather than invented, because the case this section is
// about is a page that *looks finished* and is not. Everything above the first organic block of
// `serp-google.txt` is that page's own chrome with the results missing, and `serp-no-results.txt` is a
// *finished* page that looks the same way from the outside — which is the whole reason a re-look is the
// answer and reading the first snapshot harder is not.

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const GOOGLE_SERP = fixture("serp-google.txt");
const DUCKDUCKGO_SERP = fixture("serp-duckduckgo.txt");
/** `serp-google.txt` down to its own chrome: 5 link blocks, 0 organic results. */
const GOOGLE_SKELETON = GOOGLE_SERP.split("\n").slice(0, 8).join("\n");
/** `serp-duckduckgo.txt` down to its own chrome: 9 link blocks, 0 organic results. */
const DUCKDUCKGO_SKELETON = DUCKDUCKGO_SERP.split("\n").slice(0, 66).join("\n");
/** A whole recorded page that answered cleanly with nothing organic in it. */
const GOOGLE_NO_RESULTS = fixture("serp-no-results.txt");
/** The B.6 page: 26 link blocks, every `/url` protocol-relative, so nothing parses as a result. */
const DUCKDUCKGO_BLIND_PAGE = fixture("serp-duckduckgo-html.txt");

/** A frame that parses as a SERP has to be one the engine's own parser finds nothing in. */
function assertNoOrganics(text, engine, label) {
  assert.equal(
    parseSerp({ url: "", text }, engine).results.length,
    0,
    `${label} carries an organic result, so a test built on it proves nothing`,
  );
}

test("a google tab that ends up on duckduckgo is credited to duckduckgo, not to google", async (t) => {
  // The engine is decided by where the page is, not by who asked. Measured before this rule existed: one
  // recorded DuckDuckGo page classified under "google" returned 30 results where the same page returns 22
  // as duckduckgo — 9 of the extra 10 are DuckDuckGo's own footer, because `isChrome` filters chrome by
  // the host of the engine we *asked* for. Crediting from `Engine.name` is only honest while the page is
  // that engine's, which is the fact this case pins.
  const { fake, client } = setup(t, {
    redirects: new Map([["https://www.google.com/search?q=camoufox", "https://duckduckgo.com/?q=camoufox"]]),
    pageContents: new Map([["https://duckduckgo.com/?q=camoufox", DUCKDUCKGO_SERP]]),
    // The recorded page is wider than the fake's snapshot window, so without this the count below is a
    // fact about the fake rather than about the fixture.
    snapshotLimit: 40_000,
  });

  const outcome = await searchWithFallback("camoufox", [googleEngine(), duckduckgoEngine()], { client, userId: "u1" });

  assert.deepEqual(outcome.tried.map((step) => step.engine), ["google", "duckduckgo"], "google was not skipped: it was refused, and then duckduckgo ran");
  assert.equal(outcome.tried[0].code, "empty_results", "the code the chain hops on — a refused page may not end the search");
  assert.equal(outcome.engine, "duckduckgo", "credited to the engine that served the page");
  assert.equal(outcome.results.length, 19, "the recorded page's nineteen results, and none of duckduckgo's footer");
  assert.equal(
    outcome.results.every((result) => !/\/\/([^/]*\.)?duckduckgo\.com/u.test(result.url)),
    true,
    "no duckduckgo chrome reached the model, which is what the wrong-engine filter used to let through",
  );
  // The price of the refusal, pinned rather than described: a page whose host the asked engine does not own
  // can never become its results, which is a fact about the address and not about the page still arriving,
  // so it is answered on the first look — the same reason `wallWorthWaitingOn` ends the wait on a wall. B.6's
  // blind page is the contrast: that one cannot be told from "not yet", and it does pay the stability looks.
  assert.equal(
    callsFor(fake, "/snapshot").length,
    2,
    "one look named a page google can never own, and google paid for no more at it — then one at duckduckgo's own",
  );
});

test("a page the asked engine cannot own is reported as a substitution, whatever it was doing while we looked", async (t) => {
  // Rotating text is the provocation, because it is exactly the shape that keeps the settle loop alive: a
  // page that never answers stable runs to the budget, and the budget's line is "its results page was still
  // rendering, so it is not known whether it had results". That is a claim about *whether results arrived*,
  // and it cannot be made about a page this engine never served. Where the page is is decided from its
  // address on the first look and no frame afterwards contradicts it, so it is the one verdict the wait may
  // not downgrade — the model reads one message, and it must be the one about which page we got.
  const { fake, client } = setup(t, {
    redirects: new Map([["https://www.google.com/search?q=camoufox", "https://duckduckgo.com/?q=camoufox"]]),
    snapshotScripts: new Map([["https://duckduckgo.com/?q=camoufox", ROTATING_FRAMES]]),
  });

  const error = await googleEngine().search("camoufox", { client, userId: "u1" }).catch((e) => e);

  assert.equal(error.code, "empty_results", "the code the chain hops on, so a foreign page never ends the search");
  assert.equal(error.details.substituted, true, "and a reader can tell this from a query that came up empty");
  assert.match(error.message, /^google did not serve this page/u, "names the engine we asked for");
  assert.match(error.message, /duckduckgo\.com/u, "and the destination that actually served it");
  assert.doesNotMatch(
    error.message,
    /still rendering/u,
    `"${error.message}" makes the wait's claim about a page that was never this engine's to render`,
  );
  // The cost of deciding it, measured rather than hoped: rotation is what would have kept the loop alive,
  // and it does not, because the question the loop now asks is answered before the second look.
  assert.equal(callsFor(fake, "/snapshot").length, 1, "one look was enough to know this page cannot be google's");
});

test("a google page still rendering on the first look is re-looked, not reported as one with no results", async (t) => {
  assertNoOrganics(GOOGLE_SKELETON, "google", "the chrome-only frame");

  const { fake, client } = setup(t, {
    snapshotScripts: new Map([["https://www.google.com/search?q=camoufox", [GOOGLE_SKELETON, GOOGLE_SERP]]]),
  });

  const outcome = await googleEngine().search("camoufox", { client, userId: "u1" });

  assert.equal(outcome.results.length, 10, "the recorded page's ten results, once they had arrived");
  assert.equal(callsFor(fake, "/snapshot").length, 2, "one look was thin, one was the page — no more");
});

test("a first look that matches the recorded zero-result page is still re-looked", async (t) => {
  // The two cases this item turns on are indistinguishable on the first snapshot: this frame is a
  // *finished* page that answered with nothing, served here as the first frame of a page that was
  // still arriving. Only re-looking separates them, which is why the predicate asks the parser rather
  // than measuring the page.
  assertNoOrganics(GOOGLE_NO_RESULTS, "google", "the recorded no-results page");

  const { fake, client } = setup(t, {
    snapshotScripts: new Map([["https://www.google.com/search?q=camoufox", [GOOGLE_NO_RESULTS, GOOGLE_SERP]]]),
  });

  const outcome = await googleEngine().search("camoufox", { client, userId: "u1" });

  assert.equal(outcome.results.length, 10, "the re-look is what turned 'no results' into the page");
});

test("duckduckgo waits the same way google does, on the same shape of page", async (t) => {
  assertNoOrganics(DUCKDUCKGO_SKELETON, "duckduckgo", "the chrome-only frame");

  const { fake, client } = setup(t, {
    // The recorded duckduckgo page is wider than the fake's snapshot window, so without this the count
    // below would be a fact about the fake rather than about the fixture.
    snapshotLimit: 40_000,
    snapshotScripts: new Map([["https://duckduckgo.com/?q=camoufox", [DUCKDUCKGO_SKELETON, DUCKDUCKGO_SERP]]]),
  });

  const outcome = await duckduckgoEngine().search("camoufox", { client, userId: "u1" });

  assert.equal(outcome.results.length, 19, "the recorded duckduckgo page's nineteen results");
  assert.equal(callsFor(fake, "/snapshot").length, 2, "and the same single re-look google needed");
});

test("a SERP that has not arrived at all is re-looked, not reported as an empty page", async (t) => {
  // `empty_page` is what a blank snapshot is called, and a blank first snapshot is the most
  // obviously-still-rendering page there is. Read's loop already refuses to treat it as settled.
  const { fake, client } = setup(t, {
    snapshotScripts: new Map([["https://www.google.com/search?q=camoufox", ["", GOOGLE_SERP]]]),
  });

  const outcome = await googleEngine().search("camoufox", { client, userId: "u1" });

  assert.equal(outcome.results.length, 10);
  assert.equal(callsFor(fake, "/snapshot").length, 2);
});

test("a wall is hopped past without spending the search settle budget on it", async (t) => {
  // A wall is not a page still arriving; it is a page that has decided. Waiting on it is latency the
  // model pays before the hop that was always the answer.
  const { fake, client } = setup(t, { consentWallOn: new Set(["u1"]) });

  const error = await googleEngine().search("camoufox", { client, userId: "u1" }).catch((e) => e);

  assert.equal(error.code, "consent_wall");
  assert.equal(callsFor(fake, "/snapshot").length, 1, "one look named the wall, so one look was enough");
});

test("the recorded page this parser is blind to is re-looked until it stops changing, and no longer", async (t) => {
  // B.6: 26 link blocks, every one of them a protocol-relative wrapper, so the answer is deterministic
  // and a re-look cannot change it. It costs the two identical looks that prove the page is finished —
  // bounded by the loop's stability stop, not by the budget. That is the price of a predicate that
  // cannot tell "no results yet" from "no results we can read", and it is paid knowingly.
  assertNoOrganics(DUCKDUCKGO_BLIND_PAGE, "duckduckgo", "the B.6 page");

  const { fake, client } = setup(t, {
    pageContents: new Map([["https://duckduckgo.com/?q=camoufox", DUCKDUCKGO_BLIND_PAGE]]),
  });

  const error = await duckduckgoEngine().search("camoufox", { client, userId: "u1" }).catch((e) => e);

  assert.equal(error.code, "empty_results", "blind is still blind on the third look");
  // The other half of the deadline fix: a page that answered *stable* and empty is a real zero, and has
  // to keep being reported as one. Only a wait that ran out is an unknown.
  assert.equal(
    error.message,
    "duckduckgo returned no organic results for that query",
    "the page stopped changing, so saying it had nothing is a statement we can make",
  );
  assert.equal(
    callsFor(fake, "/snapshot").length,
    1 + STABLE_ROUNDS,
    "the page stopped changing, which is the stop the budget is only the backstop of",
  );
});

test("a page that never stops changing costs the search budget and nothing more", async (t) => {
  // The one shape that does run to the deadline: a page that keeps changing and never becomes a SERP.
  // Bounded per engine, because the chain pays it once per engine before it gives up.
  const frames = Array.from(
    { length: 20 },
    (_unused, index) => `- heading "loading ${index}" [level=1]\n- link "chrome ${index}" [e1]:\n  - /url: /?q=${index}`,
  );
  const { fake, client } = setup(t, {
    snapshotScripts: new Map([["https://www.google.com/search?q=camoufox", frames]]),
  });

  const error = await googleEngine().search("camoufox", { client, userId: "u1" }).catch((e) => e);

  assert.equal(error.code, "empty_results");
  // The code has to stay whatever the last page looked like: `empty_results` is what the chain hops on,
  // and borrowing the transport's `timeout` here would report a request that missed its deadline when what
  // actually happened was a page that never finished arriving — and a page that never stopped changing is
  // no reason to give up on the next engine either. The *message* is the other
  // half, and it is what the model reads first — this is the one case where the branch cannot say the
  // query came up empty, only that our waiting came up short.
  assert.doesNotMatch(
    error.message,
    /no organic results|no results/u,
    `"${error.message}" states an absence the run-out of time cannot establish`,
  );
  assert.match(error.message, /still rendering/u, "what was actually observed: a page still arriving");
  assert.match(error.message, new RegExp(`${SEARCH_SETTLE_MS}ms`, "u"), "and for how long we looked");
  const looked = callsFor(fake, "/snapshot").length;
  // The counterpart of that flag where it is live: a stall is only honest about a frame another look could
  // still have answered. The fake serves one scripted frame per look, so the nth look is the nth frame.
  const openedAt = fake.state.calls.find((call) => call.path === "/tabs/open").body.url;
  assert.equal(
    serpWorthAnotherLook({ url: openedAt, text: frames[Math.min(looked - 1, frames.length - 1)] }, "google"),
    true,
    "the wait ran out on a frame another look could not have changed, so the stall it reports is one it never earned",
  );
  assert.equal(error.details?.stalledAtDeadline, true, "read reports this fact as data; so does this");
  assert.ok(
    looked <= 1 + Math.ceil(SEARCH_SETTLE_MS / SEARCH_SETTLE_POLL_MS),
    `${looked} snapshots is more re-look than one engine's budget can buy`,
  );
});

test("the identical pair that spent the budget is a stop, not a page still rendering", async (t) => {
  // The measured live case (`scripts/measure-stalled-at-deadline.mjs`, the 449ms row): one `/snapshot`
  // costing more than the whole settle budget means the loop can never reach the *second* comparison the
  // stability stop asks for, so it leaves with the flag that started at `true` — and `undecidedVerdict`
  // said "was still rendering" about a page that had already answered identically twice. The pair in hand
  // is the evidence; the missing third look is the thing this call could not buy.
  assertNoOrganics(GOOGLE_NO_RESULTS, "google", "the recorded zero-result page");

  // Both numbers come from the one at risk: the hang must outlast the settle budget, and the client's own
  // per-request deadline must not fire before the hang ends. Inheriting `setup()`'s 2000ms left 499ms of
  // slack there, so a raised `SEARCH_SETTLE_MS` would fail this case as a transport `timeout`.
  const requestDeadlineMs = SEARCH_SETTLE_MS + 500;
  const { fake, client } = setup(t, {
    timeoutMs: requestDeadlineMs,
    pageContents: new Map([["https://www.google.com/search?q=camoufox", GOOGLE_NO_RESULTS]]),
    snapshotHangsForMs: SEARCH_SETTLE_MS + 1,
  });

  const error = await googleEngine().search("camoufox", { client, userId: "u1" }).catch((e) => e);

  assert.equal(error.code, "empty_results");
  assert.equal(
    error.message,
    "google returned no organic results for that query",
    "a page that answered stable and empty is a zero we may name, not an unknown",
  );
  assert.equal(error.details?.stalledAtDeadline, undefined, "a bigger budget could not have bought the third look, so it is not offered");
  assert.equal(
    callsFor(fake, "/snapshot").length,
    2,
    "one look, then the identical re-look that both proved the page had stopped and spent the budget",
  );
});

test("a stable page on a gateway that answers in milliseconds still pays for the third look", async (t) => {
  // The other half of that stop: it fires only when the budget cannot admit another look, so nothing here
  // gets cheaper on a fast gateway, and one repeat is still not mistaken for a finished page.
  const { fake, client } = setup(t, {
    pageContents: new Map([["https://www.google.com/search?q=camoufox", GOOGLE_NO_RESULTS]]),
  });

  const error = await googleEngine().search("camoufox", { client, userId: "u1" }).catch((e) => e);

  assert.equal(error.message, "google returned no organic results for that query");
  assert.equal(error.details?.stalledAtDeadline, undefined);
  assert.equal(
    callsFor(fake, "/snapshot").length,
    1 + STABLE_ROUNDS,
    "the budget could still afford the confirmation, so it bought it",
  );
});

test("the loop's exit and its stop consume one reading of the deadline, so it cannot leave holding an identical pair and call it a stall", async (t) => {
  // Whether the budget is spent decides two things: whether the identical-pair stop fires, and whether the
  // loop runs again. Read twice, they can be handed different sides of the deadline — the stop got
  // `deadline - 1` and did not fire, the loop top got `deadline` and exited, and the wait ended past a flag
  // that started at `true` with a byte-identical pair in hand. That is the exact output this branch exists
  // to eliminate, arriving on roughly one stable slow-gateway wait in 10^4, so the clock is pinned to that
  // tick rather than raced for. The clock is what is under test, so the page comes from a stub: a real
  // client's own timing reads would land in the script below.
  const frames = [];
  const client = {
    snapshot: async () => {
      // The request is what spends the budget, which is the only honest way to advance a clock that is
      // measuring one: everything before the first poll is still `startedAt`.
      if (frames.length > 0) polls += 1;
      const looked = {
        url: "https://www.google.com/search?q=camoufox",
        text: GOOGLE_SKELETON,
        refsCount: 0,
        truncated: false,
        totalChars: GOOGLE_SKELETON.length,
        hasMore: false,
        nextOffset: GOOGLE_SKELETON.length,
      };
      frames.push(looked);
      return looked;
    },
  };

  const startedAt = 1_000_000;
  const deadline = startedAt + SEARCH_SETTLE_MS;
  let polls = 0;
  let straddled = false;
  const realNow = Date.now;
  Date.now = () => {
    if (polls === 0) return startedAt;
    // The tick in question: one read short of spent, and every read after it at spent.
    if (!straddled) {
      straddled = true;
      return deadline - 1;
    }
    return deadline;
  };
  t.after(() => {
    Date.now = realNow;
  });

  const settled = await snapshotSettled(client, "u1", "tab-1", {
    budgetMs: SEARCH_SETTLE_MS,
    pollMs: 1,
    worthLookingAgain: (looked) => serpWorthAnotherLook(looked, "google"),
    cancelledMessage: "the settle probe was cancelled",
  });

  // The premises, so the assertion below is about the loop and not about a wait that never got there.
  assert.ok(frames.length >= 2, "no pair was ever in hand, so this case proved nothing");
  assert.ok(
    frames.every((looked) => looked.text === frames[0].text && looked.totalChars === frames[0].totalChars),
    "the loop was served one page answering twice, which is the pair the stop is about",
  );
  assert.equal(
    serpWorthAnotherLook(settled.snapshot, "google"),
    true,
    "the predicate still wanted a look at the last frame, so only the budget could have ended the wait",
  );
  assert.equal(
    settled.stalledAtDeadline,
    false,
    "a page the loop had itself seen byte-identical is not one that was still changing when the budget ran out",
  );
  assert.ok(
    frames.length <= 1 + STABLE_ROUNDS,
    `${frames.length} snapshots: the loop kept looking after the budget was spent`,
  );
});

/**
 * Every recording, so this section's coupling check picks up a page the moment one is added — a hand-named
 * list is a count, and a count is the thing that goes stale quietly.
 */
const RECORDED_PAGES = readdirSync(new URL("./fixtures/", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
  .map((entry) => entry.name)
  .sort();

/**
 * The destinations a snapshot can be reported at: both engines' own hosts, a look-alike, a stranger's, and
 * the two silences — no destination, and one a tab has not taken yet.
 */
const REPORTED_URLS = [
  "https://www.google.com/search?q=camoufox",
  "https://duckduckgo.com/?q=camoufox",
  "https://www.google.com.evil.test/search?q=camoufox",
  "https://example.test/",
  "about:blank",
  "",
];

test("the settle loop never keeps looking at a page the classifier says this engine cannot own", () => {
  // The two ask one question — `classifySerp` to refuse the page, `serpWorthAnotherLook` to stop waiting on
  // it — and they must keep answering it identically. Their agreement is what makes `undecidedVerdict`'s
  // substituted branch dead: a frame the loop is still willing to re-look at is never a frame the classifier
  // called a substitution. Narrow the predicate on one side alone — "stop only on walls" is the plausible
  // revision — and the loop runs its budget out on a page that was never ours and reports it as still
  // rendering. So assert the rule, not the branch, across every recording: the shapes where the two could
  // drift apart (a wall, a blank page, a page this parser is blind to) are exactly what a single case misses.
  for (const name of RECORDED_PAGES) {
    const text = fixture(name);
    for (const engine of ["google", "duckduckgo"]) {
      for (const url of REPORTED_URLS) {
        const snapshot = { url, text };
        const verdict = classifySerp(snapshot, engine);
        const substituted = verdict.kind === "error" && verdict.details.substituted === true;
        assert.equal(
          substituted && serpWorthAnotherLook(snapshot, engine),
          false,
          `${name} read as ${engine} at ${url || "(no destination)"}: refused as a substitution, and re-looked at anyway`,
        );
      }
    }
  }

  // Named explicitly because it is the recording the ownership rule was written for: a DuckDuckGo page
  // asked for as google, at the url it was taken at.
  const substituted = { url: "https://duckduckgo.com/?q=expressen&ia=web", text: fixture("serp-google-answered-by-duckduckgo.txt") };
  assert.equal(classifySerp(substituted, "google").details.substituted, true, "the classifier refuses it — the premise below is nothing without this");
  assert.equal(serpWorthAnotherLook(substituted, "google"), false, "and the loop does not spend a look on it");
});

/** Where each engine's own results page is, which is what makes a recorded page an honest frame. */
const ENGINE_URLS = [
  ["google", "https://www.google.com/search?q=camoufox"],
  ["duckduckgo", "https://duckduckgo.com/?q=camoufox"],
];

/** One look costs more than the whole budget, which is the shape the third stop clause exists for. */
const OVERSPENT_BUDGET_MS = 10;
const OVERSPENT_SNAPSHOT_MS = 20;

test("a budget that cannot afford the third look never reports a stall on a page that stopped changing", async (t) => {
  // The same rule as above, on the frame the budget runs out on. `undecidedVerdict`'s premise — a page that
  // had answered stable and empty already stopped it — is true because of that clause, not independently of
  // it, so it is asserted over every recording rather than trusted: at a latency where the third look is
  // unaffordable, no recording may be called a stall, and a stall is never reported for a frame the loop
  // itself no longer wanted to look at again.
  //
  // Driven through the shared machine with the engine's own predicate rather than through an engine, so the
  // budget can be smaller than one snapshot here; the message that budget produces is the engine cases'
  // business, and `"the identical pair that spent the budget is a stop…"` below owns it.
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });

  for (const [name, url] of ENGINE_URLS) {
    for (const page of RECORDED_PAGES) {
      // One read of the recording, so the window asked for and the oracle below are measured on the same
      // text.
      const text = fixture(page);
      const fake = createFakeGateway({
        pageContents: new Map([[url, text]]),
        // Derived, not out-guessed: `RECORDED_PAGES` is whatever the directory holds, and a window fixed
        // above today's biggest recording silently slices tomorrow's.
        snapshotLimit: text.length + 1,
        snapshotHangsForMs: OVERSPENT_SNAPSHOT_MS,
      });
      globalThis.fetch = fake.fetch;
      const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 2000 });

      const tab = await client.openTab({ userId: "u1", url });
      const settled = await snapshotSettled(client, "u1", tab.tabId, {
        budgetMs: OVERSPENT_BUDGET_MS,
        pollMs: 5,
        worthLookingAgain: (looked) => serpWorthAnotherLook(looked, name),
        cancelledMessage: "the settle probe was cancelled",
      });
      await client.closeTabQuietly({ userId: "u1", tabId: tab.tabId });
      globalThis.fetch = real;

      const label = `${page} read as ${name}`;
      const wanted = serpWorthAnotherLook({ url, text }, name);
      const snapshots = fake.state.calls.filter((call) => call.path.includes("/snapshot")).length;
      assert.equal(
        settled.snapshot.truncated,
        false,
        `${label}: the fake sliced this recording, so every count below is about the fake`,
      );
      assert.equal(
        snapshots,
        wanted ? 2 : 1,
        `${label}: wanted another look was ${wanted}, so it cost ${snapshots} snapshots`,
      );
      assert.equal(settled.stalledAtDeadline, false, `${label}: a page that answered identical once is not a stall`);
      // Documentation of the rule rather than a check of it: the line above already pins the flag `false`
      // for every recording, so this can only fire if that pin goes away. The version that can fail is in
      // the growing-page case above, the one place the flag is ever `true`.
      assert.equal(
        settled.stalledAtDeadline && !serpWorthAnotherLook(settled.snapshot, name),
        false,
        `${label}: a stall was reported on a frame the loop had stopped wanting`,
      );
      assert.deepEqual(fake.liveTabs(), [], `${label}: the tab outlived the wait`);
    }
  }
});

test("the search settle budget is its own, and smaller than the one a read may spend", () => {
  // Search runs a chain, so this budget is paid once per engine before a hop. Inheriting read's would
  // put a document's patience on the critical path of every search.
  assert.ok(
    SEARCH_SETTLE_MS < DEFAULT_CONFIG.read.waitForSettleMs,
    `${SEARCH_SETTLE_MS}ms per engine is not under read's ${DEFAULT_CONFIG.read.waitForSettleMs}ms`,
  );
  assert.ok(
    SEARCH_SETTLE_POLL_MS < SEARCH_SETTLE_MS,
    "a poll interval at or above the budget means one look and a sleep through the rest of it",
  );
});

test("an abort that lands during a search's settle sleep ends it and closes the gateway's tab", async (t) => {
  // The window the re-look machine opened on the search path: up to `SEARCH_SETTLE_MS` per engine spent
  // asleep with a tab open. Two ways this used to be wrong and still looked fine — a timer left running
  // after the caller gave up, and a teardown close that inherited the signal that had just aborted, which
  // is dropped before it is sent and leaves the tab open on the gateway. Only the second one is visible
  // from the server side, which is why the assertion below is `liveTabs()` and not our own bookkeeping.
  const { fake, client } = setup(t, {
    snapshotScripts: new Map([["https://www.google.com/search?q=camoufox", ['- heading "Loading…" [level=1]']]]),
  });
  const controller = new AbortController();
  const running = googleEngine()
    .search("camoufox", { client, userId: "u1", signal: controller.signal })
    .catch((e) => e);
  const startedAt = Date.now();

  const abortTimer = setTimeout(() => controller.abort(), 10);
  const error = await running;
  clearTimeout(abortTimer);

  assert.equal(error.code, "aborted");
  assert.match(error.message, /cancelled while waiting for the results page to render/u, "the sleep is where it stopped");
  assert.ok(
    Date.now() - startedAt < SEARCH_SETTLE_POLL_MS,
    "the poll sleep outlived the abort, so its timer was never cleared",
  );
  assert.deepEqual(fake.liveTabs(), []);
  assert.equal(client.openTabCount(), 0);
});

test("a SERP that answers on the first look costs exactly the requests it always cost", async (t) => {
  const google = setup(t);
  await googleEngine().search("camoufox", { client: google.client, userId: "u1" });
  // Open at the SERP, one look, close. Anything else is a re-look nobody asked for — and the request
  // this dropped, the macro hop, is the one that measured 31s against the real gateway.
  assert.equal(google.fake.state.calls.filter((call) => call.path !== "/").length, 3);

  const duckduckgo = setup(t);
  await duckduckgoEngine().search("camoufox", { client: duckduckgo.client, userId: "u1" });
  assert.equal(duckduckgo.fake.state.calls.filter((call) => call.path !== "/").length, 3);
});

// --- the chain's own wall-clock budget -------------------------------------------------------------
//
// Taking `timeout` out of `TERMINAL_CODES` was the fix, and it moved a cost: the terminal list used to own
// "when does the search stop" implicitly, and the deadline now lives only per request, so nothing owned the
// total. These cases own it. The per-request deadline is lowered from the shipped 30s so they run in
// milliseconds rather than minutes — which is only possible because the chain budget is *derived* from it,
// the one number `gateway.ts` already enforces.

const REQUEST_DEADLINE_MS = 300;
/** Exported rather than repeated here, so the budget these cases are sized against is the one that ships. */
const CHAIN_BUDGET_MS = SEARCH_CHAIN_BUDGET_IN_DEADLINES * REQUEST_DEADLINE_MS;
/** Long enough that only our deadline can end a hung request. */
const HANG_MS = 20 * REQUEST_DEADLINE_MS;

function hangSetup(t, options) {
  const fake = withFakeGateway(t, options);
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: REQUEST_DEADLINE_MS });
  return { fake, client };
}

/** A page that keeps changing, so the settle loop keeps looking and stays inside whatever budget is left. */
const ROTATING_FRAMES = Array.from(
  { length: 12 },
  (_unused, index) => `- heading "loading ${index}" [level=1]\n- link "chrome ${index}" [e${index}]:\n  - /url: /?q=${index}`,
);

test("an engine that hangs to its deadline still leaves the next one its whole deadline", async (t) => {
  // The bound is on the chain, not on the call: the first engine must still get a full request deadline,
  // and spending it must not be the reason the second engine never gets asked.
  const { fake, client } = hangSetup(t, {
    hangUrls: new Set(["https://www.google.com/search?q=camoufox"]),
    hangForMs: HANG_MS,
  });

  const startedAt = Date.now();
  const outcome = await searchWithFallback("camoufox", [googleEngine(), duckduckgoEngine()], { client, userId: "u1" });
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome.engine, "duckduckgo", "one engine burning its deadline is not a reason to skip the other");
  assert.deepEqual(
    outcome.tried.map((step) => `${step.engine}:${step.code}`),
    ["google:timeout", "duckduckgo:ok"],
  );
  assert.ok(
    elapsed < CHAIN_BUDGET_MS + REQUEST_DEADLINE_MS,
    `${elapsed}ms spent the whole chain budget on the first engine, so the hop got none of it`,
  );
  // The hung open is the ambiguous case: the gateway had created the tab before we stopped listening.
  assert.deepEqual(fake.liveTabs(), [], "a hung open is still swept, budget or no budget");
  assert.equal(client.openTabCount(), 0);
});

test("a gateway that hangs on both engines comes back inside the chain budget, not four deadlines", async (t) => {
  // The shape that costs two deadlines per engine, and so four across the chain: an open that lands just
  // inside its deadline, and a snapshot that never answers. Measured against the shipped 30s default this
  // is the ~122s a gateway that is *up* and answering nothing used to be able to cost, once `timeout`
  // stopped ending the walk — the probe is `preflight`'s own 2s and lives outside the chain.
  let thirdRan = false;
  const third = {
    name: "third",
    search: async () => {
      thirdRan = true;
      return { results: [] };
    },
  };
  const { fake, client } = hangSetup(t, {
    openLatencyMs: REQUEST_DEADLINE_MS - 20,
    snapshotHangsForMs: HANG_MS,
  });

  const startedAt = Date.now();
  const error = await searchWithFallback("camoufox", [googleEngine(), duckduckgoEngine(), third], {
    client,
    userId: "u1",
  }).catch((e) => e);
  const elapsed = Date.now() - startedAt;

  assert.equal(error.code, "timeout", "a deadline of ours ran out, which is what the code is for");
  assert.match(error.message, /budget/u, "and the message says *which* deadline, not a per-request timeout");
  assert.deepEqual(
    error.details.tried.map((step) => `${step.engine}:${step.code}`),
    ["google:timeout", "duckduckgo:timeout"],
    "what each attempt said is still recorded; the budget is why the walk ended",
  );
  assert.equal(thirdRan, false, "the walk stops when the budget is gone, not when the engine list does");
  assert.ok(
    elapsed < 3 * REQUEST_DEADLINE_MS,
    `${elapsed}ms is more chain than its ${CHAIN_BUDGET_MS}ms budget — four deadlines would be ${4 * REQUEST_DEADLINE_MS}ms`,
  );
  assert.ok(
    callsFor(fake, "/snapshot").length <= 2,
    `${callsFor(fake, "/snapshot").length} snapshots asked a gateway that had already run out of our patience`,
  );
});

test("both engines spending their whole settle still lands inside the chain's one wall-clock budget", async (t) => {
  // The per-engine settle is the largest single thing the walk can spend, and the walk owns exactly one
  // wall-clock budget for all of it — `SEARCH_CHAIN_BUDGET_IN_DEADLINES` request deadlines. Both numbers
  // are derived from the one in force here, so the arithmetic is the one at risk rather than a margin
  // picked to pass: the budget is barely twice what two engines' settle wants, an engine whose settle the
  // walk truncated shows up as elapsed time under the floor, and a settle the walk failed to bound shows
  // up over the ceiling.
  const deadlineMs = SEARCH_SETTLE_MS + 500;
  const budgetMs = SEARCH_CHAIN_BUDGET_IN_DEADLINES * deadlineMs;
  const { fake, client } = setup(t, {
    timeoutMs: deadlineMs,
    snapshotScripts: new Map([
      ["https://www.google.com/search?q=camoufox", ROTATING_FRAMES],
      ["https://duckduckgo.com/?q=camoufox", ROTATING_FRAMES],
    ]),
  });

  const startedAt = Date.now();
  const error = await searchWithFallback("camoufox", [googleEngine(), duckduckgoEngine()], {
    client,
    userId: "u1",
  }).catch((e) => e);
  const elapsed = Date.now() - startedAt;

  assert.equal(error.code, "empty_results", "two pages with nothing in them is the hop, not the budget running out");
  assert.deepEqual(
    error.details.tried.map((step) => `${step.engine}:${step.code}`),
    ["google:empty_results", "duckduckgo:empty_results"],
    "and both engines were actually asked, on a page that kept them looking",
  );
  assert.ok(
    elapsed >= 2 * SEARCH_SETTLE_MS,
    `${elapsed}ms for two engines whose settle is ${SEARCH_SETTLE_MS}ms each: the walk cut a wait short`,
  );
  assert.ok(elapsed < budgetMs, `${elapsed}ms is more than the chain's single ${budgetMs}ms budget`);
  assert.deepEqual(fake.liveTabs(), [], "and neither engine left its tab behind for the next one to find");
});

test("a search that runs out of its budget is not reported as a search someone cancelled", async (t) => {
  // Two ways a search stops early, and they are different instructions to the model: one is "you gave up",
  // the other is "we did". The chain aborts on a signal the engines cannot tell apart from the caller's, so
  // the distinction has to ride on the abort *reason* — which is what each of these two messages is read to
  // prove, side by side.
  const cancelled = hangSetup(t, {
    snapshotScripts: new Map([["https://www.google.com/search?q=camoufox", ROTATING_FRAMES]]),
  });
  const controller = new AbortController();
  const cancelling = searchWithFallback("camoufox", [googleEngine()], {
    client: cancelled.client,
    userId: "u1",
    signal: controller.signal,
  }).catch((e) => e);
  const cancelTimer = setTimeout(() => controller.abort(), 20);
  const cancelError = await cancelling;
  clearTimeout(cancelTimer);

  const stalled = hangSetup(t, {
    openLatencyMs: REQUEST_DEADLINE_MS - 20,
    snapshotScripts: new Map([["https://www.google.com/search?q=camoufox", ROTATING_FRAMES]]),
  });
  const startedAt = Date.now();
  const budgetError = await searchWithFallback("camoufox", [googleEngine()], {
    client: stalled.client,
    userId: "u1",
  }).catch((e) => e);

  assert.equal(cancelError.code, "aborted", "a caller that gave up is the caller's own decision");
  assert.match(cancelError.message, /cancelled/u, `got "${cancelError.message}"`);
  assert.equal(budgetError.code, "timeout", "a budget that ran out is a deadline, and says so with the deadline's code");
  assert.match(budgetError.message, /budget/u, `got "${budgetError.message}"`);
  assert.doesNotMatch(budgetError.message, /cancel/iu, "nothing was cancelled: the search spent its own budget");
  assert.notEqual(budgetError.message, cancelError.message, "the model reads one line, and it cannot read two meanings");
  assert.ok(
    Date.now() - startedAt < CHAIN_BUDGET_MS + REQUEST_DEADLINE_MS,
    "the budget cut it short, which is the whole mechanism this case is about",
  );
  // Teardown must not inherit the deadline that fired: the DELETE would be dropped before it was sent and
  // the tab would stay open on the gateway forever. `closeTabQuietly` takes no signal for exactly this.
  assert.deepEqual(stalled.fake.liveTabs(), [], "the tab outlived our budget, which is not the gateway's fault");
  assert.equal(stalled.client.openTabCount(), 0);
});

test("a search handed an already-aborted signal never reaches the gateway", async (t) => {
  // The chain's derived signal has to inherit a cancel that landed *before* the walk started: listening is
  // not enough, because an already-aborted signal never fires its event again, and the search would then
  // open a tab and read a page for a caller who has already left.
  const { fake, client } = setup(t);
  const controller = new AbortController();
  controller.abort();

  const error = await searchWithFallback("camoufox", [googleEngine(), duckduckgoEngine()], {
    client,
    userId: "u1",
    signal: controller.signal,
  }).catch((e) => e);

  assert.equal(error.code, "aborted");
  // The sweep is allowed to speak (`openTab` cannot tell a cancel that landed before the request from one
  // that landed after it, so it reconciles either way); nothing that *asks for a page* may.
  assert.equal(callsFor(fake, "/tabs/open").length, 0, "not one tab opened for a call nobody is waiting for");
  assert.equal(callsFor(fake, "/snapshot").length, 0);
  assert.equal(client.openTabCount(), 0);
});
