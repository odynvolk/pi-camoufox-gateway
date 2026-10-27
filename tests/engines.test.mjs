import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { GatewayError } from "../src/errors.ts";
import { enginesFromConfig, searchWithFallback } from "../src/engines/chain.ts";
import { googleEngine } from "../src/engines/google.ts";
import { duckduckgoEngine } from "../src/engines/duckduckgo.ts";
import { SEARCH_SETTLE_MS, SEARCH_SETTLE_POLL_MS } from "../src/engines/settle.ts";
import { parseSerp } from "../src/snapshot.ts";
import { STABLE_ROUNDS } from "../src/settle.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const BASE = "http://gateway.test:9377";

function setup(t, options = {}) {
  const fake = withFakeGateway(t, options);
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 2000 });
  return { fake, client };
}

function callsFor(fake, suffix) {
  return fake.state.calls.filter((c) => c.path.includes(suffix));
}

test("google opens the tab at the SERP url and nothing else", async (t) => {
  // The macro is gone, and this is the sequence that replaced it. Measured on the live gateway
  // (2026-10-27): `POST /tabs/open` at the search url answers in ~270ms with a Google SERP, while
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

  for (const code of ["gateway_unreachable", "gateway_unauthorized", "timeout", "host_blocked"]) {
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
  // The price of the refusal, pinned rather than described: a page that is not the asked engine's can
  // never become its results, and the settle loop does not know that — it re-looks until the page stops
  // changing, which is the same bounded cost B.6's blind page pays.
  assert.equal(
    callsFor(fake, "/snapshot").length,
    1 + STABLE_ROUNDS + 1,
    "three looks at a page google will never own, then one at duckduckgo's own",
  );
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
  // The code has to stay: `chain.ts` hops on `empty_results` and stops on `timeout`, and a page that
  // never stopped changing is not a reason to give up on the next engine. The *message* is the other
  // half, and it is what the model reads first — this is the one case where the branch cannot say the
  // query came up empty, only that our waiting came up short.
  assert.doesNotMatch(
    error.message,
    /no organic results|no results/u,
    `"${error.message}" states an absence the run-out of time cannot establish`,
  );
  assert.match(error.message, /still rendering/u, "what was actually observed: a page still arriving");
  assert.match(error.message, new RegExp(`${SEARCH_SETTLE_MS}ms`, "u"), "and for how long we looked");
  assert.equal(error.details?.stalledAtDeadline, true, "read reports this fact as data; so does this");
  assert.ok(
    callsFor(fake, "/snapshot").length <= 1 + Math.ceil(SEARCH_SETTLE_MS / SEARCH_SETTLE_POLL_MS),
    `${callsFor(fake, "/snapshot").length} snapshots is more re-look than one engine's budget can buy`,
  );
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
