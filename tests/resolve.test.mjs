import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { resolveUrls } from "../src/resolve.ts";
import { createCache } from "../src/cache.ts";
import { resultHost } from "../src/snapshot.ts";

const BASE = "http://gateway.test:9377";

function setup(t, options = {}) {
  const fake = withFakeGateway(t, options);
  return { fake, client: createGatewayClient({ baseUrl: BASE, timeoutMs: 2000 }) };
}

/**
 * A result as `parseSerp` would emit it.
 *
 * The `host` is derived from the url, by the same reader the source uses. It used to be written by hand
 * next to an unrelated url, which is why nothing in this file could see a resolved result keeping the
 * wrapper's host: the fixture supplied the field the code under test is supposed to derive.
 */
function result(url, { resolvable = false, title = "x" } = {}) {
  return { title, url, host: resultHost(url), snippet: "", resolvable, engine: "google" };
}

test("the fixture derives host from its own url, so it cannot launder the bug it is here to catch", () => {
  // Every host assertion below is only evidence if this helper is not itself writing the field. Two urls
  // give two hosts, each one the host of its own url, shaped exactly as `resultHost` shapes it.
  assert.equal(result("https://www.Example.test./x").host, "example.test", "`www.` and the FQDN terminator peel here as they do in the source");
  assert.notEqual(result("https://a.test/").host, result("https://b.test/").host, "the helper is not a constant wearing a host");
  for (const url of ["https://www.Example.test./x", "https://www.google.com/goto?url=AAA", "https://someone-else.test/deal"]) {
    assert.equal(result(url).host, resultHost(url), "the helper asks the same reader the source asks");
  }
});

test("resolves every redirect wrapper in parallel and closes every tab", async (t) => {
  const { fake, client } = setup(t);
  const results = [
    result("https://www.google.com/goto?url=AAA", { resolvable: true, title: "one" }),
    result("https://www.google.com/goto?url=BBB", { resolvable: true, title: "two" }),
    result("https://www.google.com/goto?url=CCC", { resolvable: true, title: "three" }),
  ];

  const resolved = await resolveUrls(results, { client, userId: "u1" });

  assert.equal(resolved.length, 3);
  for (const item of resolved) {
    assert.ok(!item.url.includes("goto"), `url should be final, got ${item.url}`);
    assert.equal(item.resolved, true);
  }
  assert.equal(client.openTabCount(), 0);
  const opens = fake.state.calls.filter((c) => c.method === "POST" && c.path === "/tabs/open");
  assert.equal(opens.length, 3);
  assert.equal(fake.state.calls.filter((c) => c.method === "DELETE").length, 3);
});

test("resolves concurrently, not one after another", async (t) => {
  const { client } = setup(t, { openLatencyMs: 30 });
  const started = Date.now();

  await resolveUrls(
    [
      result("https://www.google.com/goto?url=AAA", { resolvable: true }),
      result("https://www.google.com/goto?url=BBB", { resolvable: true }),
      result("https://www.google.com/goto?url=CCC", { resolvable: true }),
    ],
    { client, userId: "u1", concurrency: 3 },
  );

  const elapsed = Date.now() - started;
  assert.ok(elapsed < 85, `three 30ms opens in series would take ~90ms, took ${elapsed}ms`);
});

test("keeps the original url and flags it when resolution fails", async (t) => {
  const { client } = setup(t, { resolveFailures: new Set(["https://www.google.com/goto?url=BBB"]) });
  const results = [
    result("https://www.google.com/goto?url=AAA", { resolvable: true }),
    result("https://www.google.com/goto?url=BBB", { resolvable: true }),
  ];

  const resolved = await resolveUrls(results, { client, userId: "u1" });

  assert.equal(resolved[0].url, "https://github.com/daijro/camoufox");
  assert.equal(resolved[1].url, "https://www.google.com/goto?url=BBB", "a failed result must not be dropped");
  assert.equal(resolved[1].resolved, false);
  assert.equal(client.openTabCount(), 0);
});

test("a hanging url is flagged unresolved without blocking the others", async (t) => {
  const target = "https://www.google.com/goto?url=HANG";
  const { client } = setup(t, { hangUrls: new Set([target]), hangForMs: 5000 });

  const resolved = await resolveUrls(
    [result(target, { resolvable: true }), result("https://www.google.com/goto?url=OK", { resolvable: true })],
    { client, userId: "u1", timeoutMs: 40 },
  );

  assert.equal(resolved[0].resolved, false);
  assert.match(resolved[0].url, /HANG/u);
  assert.equal(resolved[1].resolved, true);
  assert.equal(client.openTabCount(), 0);
});

test("does not open a single tab for urls that are already final", async (t) => {
  const { fake, client } = setup(t);

  const resolved = await resolveUrls(
    [result("https://camoufox.com", {}), result("https://github.com/daijro/camoufox", {})],
    { client, userId: "u1" },
  );

  assert.equal(fake.state.calls.filter((c) => c.path === "/tabs/open").length, 0);
  assert.deepEqual(resolved.map((r) => r.resolved), [undefined, undefined]);
});

test("caps in-flight tabs so the gateway is not flooded", async (t) => {
  const { client } = setup(t);
  const results = Array.from({ length: 8 }, (_, i) =>
    result(`https://www.google.com/goto?url=${i}`, { resolvable: true }),
  );

  const resolved = await resolveUrls(results, { client, userId: "u1", concurrency: 2 });

  assert.equal(resolved.length, 8);
  assert.equal(client.openTabCount(), 0);
});

test("a resolved wrapper reports the host of its destination, not the wrapper's", async (t) => {
  const wrapper = "https://www.google.com/goto?url=DEST";
  const { client } = setup(t, { redirects: new Map([[wrapper, "https://someone-else.test/deal"]]) });

  const [resolved] = await resolveUrls([result(wrapper, { resolvable: true })], { client, userId: "u1" });

  assert.equal(resolved.resolved, true);
  assert.equal(resolved.url, "https://someone-else.test/deal", "the url is the destination");
  assert.equal(resolved.host, "someone-else.test", "and the host followed it");
});

test("the cache hit reads the host off the destination it cached, and opens no tab to do it", async (t) => {
  // The cache keeps only `{ url, resolved }`, deliberately: the host is recomputed here rather than
  // carried, so a cached value can never resurrect a host some earlier code kept from the wrapper.
  const wrapper = "https://www.google.com/goto?url=CACHED";
  const { fake, client } = setup(t, { redirects: new Map([[wrapper, "https://someone-else.test/deal"]]) });
  const cache = createCache();

  await resolveUrls([result(wrapper, { resolvable: true })], { client, userId: "u1", cache });
  const opensAfterFirst = fake.state.calls.filter((c) => c.method === "POST" && c.path === "/tabs/open").length;
  const [cached] = await resolveUrls([result(wrapper, { resolvable: true })], { client, userId: "u1", cache });

  assert.equal(
    fake.state.calls.filter((c) => c.method === "POST" && c.path === "/tabs/open").length,
    opensAfterFirst,
    "a cached destination must not cost a second tab",
  );
  assert.equal(cached.resolved, true);
  assert.equal(cached.url, "https://someone-else.test/deal");
  assert.equal(cached.host, "someone-else.test", "the second call reports the host of the url it now shows");
});

test("a destination whose url merely contains the bytes google.com/goto? is resolved, not called a wrapper", async (t) => {
  // Only the shared `isWrapper` gets this right: it asks for `?url=`, while the copy that lived in
  // `resolve.ts` asked for the bytes alone and judged a legitimate destination still-wrapped.
  const wrapper = "https://www.google.com/goto?url=TRAILING";
  const destination = "https://maps.google.com/goto?query=camoufox";
  const { client } = setup(t, { redirects: new Map([[wrapper, destination]]) });

  const [resolved] = await resolveUrls([result(wrapper, { resolvable: true })], { client, userId: "u1" });

  assert.equal(resolved.resolved, true, "a destination that merely carries those bytes is not on a wrapper");
  assert.equal(resolved.resolveError, undefined);
  assert.equal(resolved.url, destination);
  assert.equal(resolved.host, "maps.google.com");
});

test("an unresolved result keeps its url and its host together, because neither moved", async (t) => {
  const wrapper = "https://www.google.com/goto?url=STUCK";
  const { client } = setup(t, { resolveFailures: new Set([wrapper]) });
  const original = result(wrapper, { resolvable: true });

  const [resolved] = await resolveUrls([original], { client, userId: "u1" });

  assert.equal(resolved.resolved, false);
  assert.match(resolved.resolveError, /stayed on the redirect wrapper/u);
  assert.equal(resolved.url, wrapper, "the url never moved");
  assert.equal(resolved.host, original.host, "so neither did the host read off it");
  assert.equal(resolved.host, "google.com", "the wrapper's own host is the truth about the url being shown");
});

test("every resolution path closes the tab it opened, the two failure paths included", async (t) => {
  // `trackTabLeaks` reads `fake.liveTabs()` at the end of the file; asked per path here, so a leak is
  // named by the path that caused it instead of reported once about a case nobody can identify.
  const fresh = "https://www.google.com/goto?url=LEAK-FRESH";
  const bytes = "https://www.google.com/goto?url=LEAK-BYTES";
  const stuck = "https://www.google.com/goto?url=LEAK-STUCK";
  const hanging = "https://www.google.com/goto?url=LEAK-HANG";
  const { fake, client } = setup(t, {
    redirects: new Map([
      [fresh, "https://someone-else.test/deal"],
      [bytes, "https://maps.google.com/goto?query=camoufox"],
    ]),
    resolveFailures: new Set([stuck]),
    hangUrls: new Set([hanging]),
    hangForMs: 200,
  });
  const cache = createCache();

  const paths = [
    ["a fresh open", fresh, {}],
    ["the cache hit", fresh, {}],
    ["a destination carrying the wrapper's bytes", bytes, {}],
    ["a wrapper that never resolves", stuck, {}],
    ["a wrapper that outlives its deadline", hanging, { timeoutMs: 40 }],
  ];
  for (const [name, url, options] of paths) {
    await resolveUrls([result(url, { resolvable: true })], { client, userId: "u1", cache, ...options });
    assert.deepEqual(fake.liveTabs(), [], `${name} left a tab open`);
    assert.equal(client.openTabCount(), 0, `${name} left the client counting a tab`);
  }
});

test("a resolved result's host is the host of the url it shows, and a destination whose host empties is named", async (t) => {
  // The property the third line of every result depends on. On the parser side an ownerless block is
  // dropped upstream; on this side the only thing between a malformed gateway-reported destination and a
  // blank column is a guard in another module, so the property is pinned here rather than inherited.
  //
  // `https://./x` is that shape: `new URL()` accepts `.` as a host and `normalizeHost` then empties it,
  // so `resultHost` legitimately returns "" and the result comes back `resolved: true` with an empty
  // host. Nothing in `resolve.ts` guards it, so this case records it rather than pretending it is caught.
  const wrapper = "https://www.google.com/goto?url=EMPTY";
  const destination = "https://./x";
  const { client } = setup(t, { redirects: new Map([[wrapper, destination]]) });

  const [resolved] = await resolveUrls([result(wrapper, { resolvable: true })], { client, userId: "u1" });

  assert.equal(resolved.resolved, true, "the gateway reported a destination that is not a wrapper");
  assert.equal(resolved.url, destination);
  assert.equal(resolved.host, resultHost(resolved.url), "whatever the host is, it is the host of this url");
  assert.equal(resolved.host, "", "named, not laundered: an empty host here is net-policy's shape, not a kept-over wrapper host");
});
