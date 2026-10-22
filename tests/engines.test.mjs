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

const BASE = "http://gateway.test:9377";

function setup(t, options = {}) {
  const fake = withFakeGateway(t, options);
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 2000 });
  return { fake, client };
}

function callsFor(fake, suffix) {
  return fake.state.calls.filter((c) => c.path.includes(suffix));
}

test("google goes open -> navigate(macro) -> snapshot and nothing else", async (t) => {
  const { fake, client } = setup(t);

  const outcome = await googleEngine().search("camoufox", { client, userId: "u1" });

  assert.ok(outcome.results.length > 0);
  // No engine label here: identity is credited by the chain from Engine.name, so the adapter has
  // nothing to claim. The sequence below is what proves this was the google path.

  const sequence = fake.state.calls
    .filter((c) => c.path !== "/")
    .map((c) => `${c.method} ${c.path.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, ":tab")}`);
  assert.deepEqual(sequence, [
    "POST /tabs/open",
    "POST /tabs/:tab/navigate",
    "GET /tabs/:tab/snapshot",
    "DELETE /tabs/:tab",
  ]);

  const navigate = callsFor(fake, "/navigate")[0];
  assert.equal(navigate.body.macro, "@google_search");
  assert.equal(navigate.body.query, "camoufox");
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
  assert.equal(callsFor(fake, "/navigate").length, 1, "and still one navigation, whatever the count");
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
