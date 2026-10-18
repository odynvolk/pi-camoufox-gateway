import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { testConfig } from "./helpers/config.mjs";
import { createGatewayClient } from "../src/gateway.ts";
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
    urlPolicy: { blockedHosts: config.blockedHosts, allowPrivateHosts: config.network.allowPrivateHosts },
    ...(options.client ?? {}),
  });
  const engines = enginesFromConfig(config.engines);
  const tool = searchTool({ client, engines, config, cache: createCache(), userId: "u1" });
  return { fake, client, config, engines, tool };
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

test("reports the engine chain it tried", async (t) => {
  const { tool } = setup(t, { consentWallOn: new Set(["u1"]) });

  const out = await tool.search({ query: "camoufox" });

  assert.equal(out.engine, "duckduckgo");
  assert.deepEqual(out.tried.map((s) => s.engine), ["google", "duckduckgo"]);
  assert.match(out.text, /google:consent_wall/u);
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
