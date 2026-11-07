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
  assert.equal(resolved.resolvable, false, "and it stopped being a wrapper the moment the destination arrived");
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
  assert.equal(cached.resolvable, false, "and the cached answer is not still flagged as needing a navigation");
});

test("a cached refusal keeps a wrapper flagged as one, because nothing ever revealed where it goes", async (t) => {
  // The other half of the `resolvable` decision, and the half a fix that only ever clears the flag forgets:
  // a cached `resolved: false` must leave it set, or a url that failed to resolve once comes back claiming
  // to be final while still showing the wrapper.
  const wrapper = "https://www.google.com/goto?url=STUCK_CACHED";
  const { fake, client } = setup(t, { resolveFailures: new Set([wrapper]) });
  const cache = createCache();

  await resolveUrls([result(wrapper, { resolvable: true })], { client, userId: "u1", cache });
  const opensAfterFirst = fake.state.calls.filter((c) => c.method === "POST" && c.path === "/tabs/open").length;
  const [cached] = await resolveUrls([result(wrapper, { resolvable: true })], { client, userId: "u1", cache });

  assert.equal(
    fake.state.calls.filter((c) => c.method === "POST" && c.path === "/tabs/open").length,
    opensAfterFirst,
    "a cached refusal must not cost a second tab",
  );
  assert.equal(cached.resolved, false);
  assert.equal(cached.url, wrapper, "the refusal is cached, not the destination");
  assert.equal(cached.resolvable, true, "a refusal is not a destination");
  assert.equal(cached.host, "google.com", "and the host is still read off the url being shown");
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
  assert.equal(resolved.resolvable, true, "and it is still a wrapper — nothing revealed where it goes");
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

test("a destination whose host empties is refused by the client, and the result keeps the wrapper it came from", async (t) => {
  // The property the third line of every result depends on, end to end. `https://./x` is the shape:
  // `new URL()` accepts `.` as a hostname, so the parse never fails and `normalizeHost` then empties the
  // single dot label — `resultHost` legitimately returns "". It used to come back `resolved: true` with
  // that empty host, cached for ten minutes as a destination (`docs/improvements/2026-10-18-code.md` →
  // C.6, pinned here until 2026-11-03 and guarded since). The refusal happens in the destination half of
  // the url guard, so `resolve` sees a thrown error and takes its existing unresolved path.
  const wrapper = "https://www.google.com/goto?url=EMPTY";
  const destination = "https://./x";
  const { fake, client } = setup(t, { redirects: new Map([[wrapper, destination]]) });
  const cache = createCache();

  const [resolved] = await resolveUrls([result(wrapper, { resolvable: true })], { client, userId: "u1", cache });

  assert.equal(resolved.resolved, false, "a destination with no host is never published as a destination");
  assert.equal(resolved.url, wrapper, "the url we were given is the url still being shown");
  assert.equal(resolved.host, "google.com", "and the host is read off that url, so the column is never blank");
  assert.equal(resolved.resolvable, true, "nothing revealed where the wrapper goes, so it is still one");
  assert.match(resolved.resolveError ?? "", /no host to open in a browser tab/u, "the model is told what was wrong with the destination");
  assert.deepEqual(fake.liveTabs(), [], "the refused tab was closed, as every refused destination is");

  const [cached] = await resolveUrls([result(wrapper, { resolvable: true })], { client, userId: "u1", cache });
  assert.equal(cached.resolved, false, "a refusal is not turned into a destination by the cache");
  assert.equal(cached.host, "google.com");
});

test("a client that reports a destination with no host is answered with a refusal, not a blank attribution column", async () => {
  // The local invariant, on its own: `src/gateway.ts` → `assertTabUrlAllowed(result.url, this.urlPolicy, "destination")`
  // is the first line of defence here, and the case above covers that line. This one asks what
  // `resolveUrls` itself promises, with a client that never refused anything — an older client, a stub, a
  // future path that skips the check. It must never publish `resolved: true` over a host of `""`: the
  // third line of every result is `result.host`, and `src/tools/search.ts` → `return result.host;` has no
  // fallback because nothing may need one.
  const wrapper = "https://www.google.com/goto?url=EMPTY-BYPASS";
  const client = reportingClient("https://./x");
  const cache = createCache();
  const original = result(wrapper, { resolvable: true });

  const [resolved] = await resolveUrls([original], { client, userId: "u1", cache });

  assert.equal(resolved.resolved, false, "a destination with no host is not a destination we can hand back");
  assert.equal(resolved.url, wrapper, "the url never moved, so nothing was resolved");
  assert.notEqual(resolved.host, "", "the one shape the printer cannot survive is the one this line must refuse to publish");
  assert.equal(resolved.host, resultHost(wrapper), "the host that was there is the host that stays");
  assert.equal(resolved.resolvable, true, "and it is still flagged as a wrapper, because nothing revealed where it goes");
  assert.match(resolved.resolveError ?? "", /no host/u, "the refusal says what was wrong with the destination it was given");
  assert.deepEqual(client.closed, ["t1"], "the tab that reported it was still a tab, and still had to be closed");

  const [cached] = await resolveUrls([result(wrapper, { resolvable: true })], { client, userId: "u1", cache });
  assert.equal(cached.resolved, false, "the refusal is what the cache holds, not the ownerless destination");
  assert.equal(cached.url, wrapper, "and it is cached against the url we still show");
});

/**
 * A client that reports whatever it is told to, and guards nothing.
 *
 * `src/gateway.ts` is where the destination check lives, so a case that has to reach `resolveUrls` with a
 * destination the real client would have refused cannot go through the real client. Deliberately not the
 * fake gateway: the fake is honest, and this case needs a gateway that lies.
 */
function reportingClient(destination) {
  const opened = [];
  const closed = [];
  return {
    opened,
    closed,
    openTabCount: () => opened.length - closed.length,
    async openTab({ url }) {
      opened.push(url);
      return { tabId: "t1", url: destination };
    },
    async closeTabQuietly({ tabId }) {
      closed.push(tabId);
    },
  };
}
