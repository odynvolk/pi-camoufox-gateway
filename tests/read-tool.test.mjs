import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { testConfig } from "./helpers/config.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { createCache } from "../src/cache.ts";
import { readTool, STABLE_ROUNDS } from "../src/tools/read.ts";
import { assertHostAllowed, urlPolicyFromConfig } from "../src/net-policy.ts";

const BASE = "http://gateway.test:9377";

function setup(t, options = {}) {
  const fake = withFakeGateway(t, options);
  const config = testConfig({
    gatewayUrl: BASE,
    blockedHosts: options.blockedHosts ?? [],
    timeoutMs: 2000,
    ...(options.config ?? {}),
  });
  // Wired the way the extension wires it, so the client's own policy is exercised too.
  const client = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 2000,
    urlPolicy: urlPolicyFromConfig(config),
    ...(options.client ?? {}),
  });
  // A cache per test, the way each pi session gets its own: page caching must not leak between
  // cases, and the caching cases below need the handle to assert against.
  const cache = createCache();
  return { fake, client, config, cache, tool: readTool({ client, config, cache, userId: "u1" }) };
}

test("returns page text and the url we actually ended up on", async (t) => {
  const finalUrl = "https://final.test/report";
  const { tool } = setup(t, { redirects: new Map([["https://news.test/r/1", finalUrl]]) });

  const out = await tool.read({ url: "https://news.test/r/1" });

  assert.equal(out.url, finalUrl, "redirects must be reported, not the url we asked for");
  assert.match(out.text, /Page: https:\/\/final\.test\/report/u);
  assert.equal(out.truncated, false);
});

test("reports the destination when reading a google redirect wrapper", async (t) => {
  const { tool } = setup(t);

  const out = await tool.read({ url: "https://www.google.com/goto?url=CAESXQHrOzAV" });

  assert.equal(out.url, "https://github.com/daijro/camoufox");
});

test("the default read of a large page stays inside 12,000 chars and says how to continue", async (t) => {
  const { tool } = setup(t, { pageContents: new Map([["https://big.test/", "x".repeat(50_000)]]) });

  const out = await tool.read({ url: "https://big.test/" });

  assert.ok(out.text.length <= 12_000, `got ${out.text.length} chars`);
  assert.equal(out.truncated, true);
  assert.equal(out.totalChars, 50_000);
  assert.equal(out.nextOffset, 12_000);
});

test("maxChars overrides the default budget", async (t) => {
  const { tool } = setup(t, { pageContents: new Map([["https://big.test/", "y".repeat(50_000)]]) });

  const out = await tool.read({ url: "https://big.test/", maxChars: 100 });

  assert.equal(out.text.length, 100);
  assert.equal(out.nextOffset, 100);
});

test("offset continues where the last read stopped", async (t) => {
  const { fake, tool } = setup(t, {
    pageContents: new Map([["https://big.test/", "z".repeat(30_000)]]),
  });

  const first = await tool.read({ url: "https://big.test/", maxChars: 10_000 });
  const second = await tool.read({ url: "https://big.test/", maxChars: 10_000, offset: first.nextOffset });

  const snapCall = fake.state.calls.filter((c) => c.path.includes("/snapshot")).at(-1);
  assert.match(snapCall.path, /offset=10000/u, "the offset goes to the gateway, not our own slicing");
  assert.equal(second.truncated, true);
});

test("the schema path snapshots first, then extracts", async (t) => {
  const { fake, tool } = setup(t);

  const out = await tool.read({
    url: "https://example.test/article",
    schema: { type: "object", properties: { title: { type: "string", "x-ref": "e1" } } },
  });

  assert.deepEqual(out.extracted, { title: "value-for-title" });
  const order = fake.state.calls
    .filter((c) => c.path.includes("/snapshot") || c.path.includes("/extract"))
    .map((c) => c.path.split("/").pop().split("?")[0]);
  assert.deepEqual(order, ["snapshot", "extract"], "extract needs refs from the snapshot that precedes it");
});

test("no matching refs is an explicit empty, not a silent null", async (t) => {
  const { tool } = setup(t);

  const error = await tool
    .read({ url: "https://example.test/article", schema: { type: "object", properties: { nope: { type: "string", "x-ref": "e999" } } } })
    .catch((e) => e);

  assert.equal(error.code, "extraction_empty");
});

test("a schema that cannot extract anything is refused before the page is fetched", async (t) => {
  const { fake, tool } = setup(t);

  // Each of these is a typo, not a question the gateway can answer. Run through it anyway and the
  // answer came back as `extraction_empty` — the gateway finding nothing, when the schema was the
  // part that could not be answered — and only after a whole navigation.
  const typos = [
    { type: "object", properties: { title: { type: "string" } } },
    { type: "object", properties: { title: { type: "string", ref: "e1" } } },
    { type: "object", properties: { title: { type: "string", "x-ref": "" } } },
    { type: "object", properties: { title: "e1" } },
    { type: "object", properties: {} },
    { type: "object" },
  ];

  for (const schema of typos) {
    const error = await tool.read({ url: "https://example.test/article", schema }).catch((e) => e);

    assert.equal(error.code, "unsupported", `${JSON.stringify(schema)} is bad input, not an empty extraction`);
    assert.match(error.message, /x-ref/u, "the message names the key the typo is about");
  }

  // Counted, not inferred from "no calls at all": the liveness probe is allowed to have dialled.
  assert.equal(fake.state.calls.filter((c) => c.path === "/tabs/open").length, 0, "a refused schema must not open a tab");
  assert.equal(fake.state.calls.filter((c) => c.path.endsWith("/extract")).length, 0, "nor be handed to the extractor");
});

test("refuses non-http schemes before touching the gateway", async (t) => {
  const { fake, tool } = setup(t);

  const error = await tool.read({ url: "file:///etc/passwd" }).catch((e) => e);

  assert.equal(error.code, "blocked_url");
  assert.equal(fake.state.calls.filter((c) => c.path !== "/").length, 0);
});

test("blockedHosts is enforced client-side because the gateway has no policy", async (t) => {
  const { fake, tool } = setup(t, { blockedHosts: ["internal.test", "*.corp.test"] });

  for (const url of ["http://internal.test/admin", "https://db.corp.test/x"]) {
    const error = await tool.read({ url }).catch((e) => e);
    assert.equal(error.code, "host_blocked", `${url} should have been blocked`);
  }
  assert.equal(fake.state.calls.filter((c) => c.path !== "/").length, 0);
});

test("does not block a host that merely ends with the blocked label", async () => {
  assert.doesNotThrow(() => assertHostAllowed("https://notinternal.test/x", ["internal.test"]));
});

test("a wall is reported instead of an empty page", async (t) => {
  const { tool } = setup(t, {
    pageContents: new Map([["https://news.test/wall", '- main:\n  - heading "Before you continue to Google" [level=1]']]),
  });

  const error = await tool.read({ url: "https://news.test/wall" }).catch((e) => e);

  assert.equal(error.code, "consent_wall");
});

test("a 403-style page comes back as a readable failure", async (t) => {
  const { tool } = setup(t, {
    pageContents: new Map([["https://denied.test/", "- heading\n- paragraph:\n  - text: 403 Forbidden"]]),
  });

  const error = await tool.read({ url: "https://denied.test/" }).catch((e) => e);
  assert.equal(error.code, "navigation_failed");
});

test("closes the tab even when the page blows up", async (t) => {
  const { client, tool } = setup(t, { failSnapshot: true });

  await tool.read({ url: "https://example.test/boom" }).catch(() => undefined);

  assert.equal(client.openTabCount(), 0);
});

test("an abort in flight still closes the gateway's tab", async (t) => {
  // The teardown close cannot reuse the signal that just aborted: the DELETE would be dropped and
  // the page would stay open until session shutdown.
  const { fake, client, tool } = setup(t, { openLatencyMs: 300 });
  const controller = new AbortController();
  const running = tool.read({ url: "https://example.test/slow", signal: controller.signal }).catch((e) => e);

  setTimeout(() => controller.abort(), 40);
  const error = await running;

  assert.equal(error.code, "aborted");
  assert.deepEqual(fake.liveTabs(), []);
  assert.equal(client.openTabCount(), 0);
});

test("an abort that lands during a settle sleep ends the read and closes the tab", async (t) => {
  // The other abort case cancels during `openTab`, before the loop exists. This one lands inside
  // `delay()`, where the failure modes are a timer left running and a tab left open.
  const { fake, client, tool } = setup(t, {
    snapshotScripts: new Map([["https://spa.test/hang", ['- heading "Loading…" [level=1]']]]),
    config: { read: { settlePollMs: 5_000 } },
  });
  const controller = new AbortController();
  const running = tool.read({ url: "https://spa.test/hang", signal: controller.signal }).catch((e) => e);
  const startedAt = Date.now();

  const abortTimer = setTimeout(() => controller.abort(), 10);
  const error = await running;
  clearTimeout(abortTimer);

  assert.equal(error.code, "aborted");
  assert.match(error.message, /cancelled while waiting for the page to render/u, "the sleep is where it stopped");
  assert.ok(Date.now() - startedAt < 1_000, "the 5s sleep outlived the abort, so the timer was not cleared");
  assert.deepEqual(fake.liveTabs(), []);
  assert.equal(client.openTabCount(), 0);
});

test("a page that renders after the first snapshot is read hydrated, not as a skeleton", async (t) => {
  const skeleton = '- heading "Loading…" [level=1]';
  const hydrated = `- heading "The real article" [level=1]\n${'  - text: body copy that only exists after the app boots. '.repeat(40)}`;
  const { fake, tool } = setup(t, {
    snapshotScripts: new Map([["https://spa.test/", [skeleton, skeleton, hydrated]]]),
    config: { read: { settlePollMs: 10 } },
  });

  const out = await tool.read({ url: "https://spa.test/" });

  assert.match(out.text, /The real article/u, "the read returned the skeleton instead of the page");
  assert.equal(out.thinAfterWait, undefined, "a page that filled in is not reported as thin");
  assert.equal(typeof out.settledInMs, "number", "the time spent waiting is part of the record");
  const snapshots = fake.state.calls.filter((c) => c.path.includes("/snapshot"));
  assert.ok(snapshots.length >= 3, `expected repeated snapshots, got ${snapshots.length}`);
});

test("a page that stops growing is not polled until the deadline", async (t) => {
  // `STABLE_ROUNDS` identical snapshots is the stop signal. Without it every genuinely short page
  // would burn the whole settle budget.
  const { fake, tool } = setup(t, {
    snapshotScripts: new Map([["https://thin.test/", ['- heading "Short" [level=1]']]]),
    config: { read: { settlePollMs: 10 } },
  });

  const out = await tool.read({ url: "https://thin.test/" });

  const snapshots = fake.state.calls.filter((c) => c.path.includes("/snapshot"));
  assert.equal(snapshots.length, 1 + STABLE_ROUNDS, "one look, then the confirmations that prove it is done");
  assert.equal(out.thinAfterWait, true, "the model must be told the page stayed thin");
});

test("waitForSettleMs 0 reads a page with exactly one snapshot", async (t) => {
  const { fake, tool } = setup(t, {
    snapshotScripts: new Map([["https://thin.test/", ['- heading "Short" [level=1]']]]),
    config: { read: { waitForSettleMs: 0 } },
  });

  await tool.read({ url: "https://thin.test/" });

  assert.equal(fake.state.calls.filter((c) => c.path.includes("/snapshot")).length, 1);
});

test("a wall is classified without spending the settle budget on it", async (t) => {
  const { fake, tool } = setup(t, {
    snapshotScripts: new Map([["https://walled.test/", ['- main:\n  - heading "Before you continue to Google" [level=1]']]]),
    config: { read: { settlePollMs: 10 } },
  });

  const error = await tool.read({ url: "https://walled.test/" }).catch((e) => e);

  assert.equal(error.code, "consent_wall");
  assert.equal(fake.state.calls.filter((c) => c.path.includes("/snapshot")).length, 1);
});

test("waitFor asks the gateway to hold for the selector before snapshotting", async (t) => {
  // The client's own deadline is set above `read.waitForTimeoutMs` here so this reads as pure
  // forwarding; what happens when the two disagree is `gateway.test.mjs`'s "never outlast" case.
  const { fake, tool } = setup(t, { client: { timeoutMs: 8_000 } });

  await tool.read({ url: "https://example.test/late", waitFor: "#article" });

  const wait = fake.state.calls.find((c) => c.path.endsWith("/wait"));
  assert.ok(wait, "no POST /tabs/{id}/wait was made");
  assert.equal(wait.body.selector, "#article");
  assert.equal(wait.body.userId, "u1");
  assert.equal(wait.body.timeout, 5_000, "read.waitForTimeoutMs is forwarded while it fits our budget");
  const order = fake.state.calls
    .filter((c) => c.path.endsWith("/wait") || c.path.includes("/snapshot"))
    .map((c) => c.path.split("/").pop().split("?")[0]);
  assert.deepEqual(order, ["wait", "snapshot"], "waiting after the snapshot would be pointless");
});

test("a gateway without the wait route still reads the page, and says the wait was skipped", async (t) => {
  const { tool } = setup(t, { waitRoute: false });

  const out = await tool.read({ url: "https://example.test/late", waitFor: "#article" });

  assert.match(out.text, /Page: https:\/\/example\.test\/late/u);
  assert.match(out.waitNote, /waitFor "#article" was not performed: gateway has no \/wait route/u);
});

test("a selector that never appears does not fail the read, but is reported", async (t) => {
  const { tool } = setup(t, { waitSelectorMisses: true });

  const out = await tool.read({ url: "https://example.test/late", waitFor: "#never" });

  assert.match(out.text, /Page: https:\/\/example\.test\/late/u);
  assert.match(out.waitNote, /waitFor "#never" did not appear within 5000ms/u);
});

test("a wait the gateway refused is reported as a refusal, not as a slow page", async (t) => {
  const { tool } = setup(t, { waitError: "Invalid selector" });

  const out = await tool.read({ url: "https://example.test/late", waitFor: "###" });

  assert.match(out.waitNote, /was refused: Invalid selector/u);
});

test("a wait the gateway never answers still returns the page, with the reason", async (t) => {
  // The client's own deadline can fire before the gateway's selector timeout; that must cost the wait,
  // not the read.
  const { fake, tool } = setup(t, { waitHangsForMs: 500, client: { timeoutMs: 60 } });

  const out = await tool.read({ url: "https://example.test/late", waitFor: "#slow" });

  assert.match(out.text, /Page: https:\/\/example\.test\/late/u, "the page was lost with the wait");
  assert.match(out.waitNote, /waitFor "#slow" was not performed: gateway did not respond within 60ms/u);
  assert.equal(fake.state.calls.filter((c) => c.path.endsWith("/wait")).length, 1);
});

test("a continuation read of a long page is neither polled nor called unrendered", async (t) => {
  // The tail of a rendered page is short, and "short" is what the settle loop watches for. It has to
  // read the whole-page size, or every `offset` call pays two snapshots and gets told to wait.
  const { fake, tool } = setup(t, {
    pageContents: new Map([["https://long.test/", "w".repeat(45_000)]]),
    config: { read: { settlePollMs: 10 } },
  });

  const out = await tool.read({ url: "https://long.test/", maxChars: 1_000, offset: 44_000 });

  assert.equal(out.text.length, 1_000);
  assert.equal(out.thinAfterWait, undefined, "a rendered page is not a skeleton");
  assert.equal(out.settledInMs, undefined);
  assert.equal(fake.state.calls.filter((c) => c.path.includes("/snapshot")).length, 1, "no polls on a finished page");
});

test("a page that navigates itself to an internal address is refused before its text is returned", async (t) => {
  // `openTab` cannot see this one: the url we handed the gateway was public, the page moved on its own.
  const { fake, tool } = setup(t, {
    redirectAfterOpen: new Map([["https://public.test/x", "http://169.254.169.254/latest/meta-data/"]]),
  });

  const error = await tool.read({ url: "https://public.test/x" }).catch((e) => e);

  assert.equal(error.code, "private_network");
  assert.equal(error.details.host, "169.254.169.254");
  assert.equal(fake.state.calls.filter((c) => c.path.includes("/extract")).length, 0);
  assert.deepEqual(fake.liveTabs(), [], "the tab we were redirected into must not stay open");
});

test("an internal address is refused before any gateway call", async (t) => {
  const { fake, tool } = setup(t);

  for (const url of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/admin", "https://localhost/", "http://10.0.4.9/", "http://[::1]:9200/"]) {
    const error = await tool.read({ url }).catch((e) => e);
    assert.equal(error.code, "private_network", `${url} should have been refused`);
  }
  assert.equal(fake.state.calls.filter((c) => c.path !== "/").length, 0, "refusing must not touch the gateway");
});

test("network.allowPrivateHosts restores access to internal hosts", async (t) => {
  const { fake, tool } = setup(t, { config: { network: { allowPrivateHosts: true } } });

  const out = await tool.read({ url: "http://127.0.0.1:8080/admin" });

  assert.match(out.text, /Page: http:\/\/127\.0\.0\.1:8080\/admin/u);
  assert.ok(fake.state.calls.some((c) => c.path === "/tabs/open"));
});

test("a page that moves after the tab opened is refused before any text is returned", async (t) => {
  // `openTab` cannot see this move: the gateway reports no destination there, so its re-check has
  // nothing to compare. The one response that does report it is `/snapshot`, which is why the
  // destination check lives in the client rather than in this tool.
  //
  // The page is scripted thin on purpose. A short response is exactly what `worthPollingAgain` polls
  // again, so if the refusal came after the loop — where this check used to live — the count below
  // would be three, and two of those requests would have been aimed at the internal host.
  const internal = "http://169.254.169.254/latest/meta-data/";
  const { fake, tool } = setup(t, {
    openReportsUrl: false,
    redirectAfterOpen: new Map([["https://spa.test/late", internal]]),
    snapshotScripts: new Map([[internal, ["instance-id"]]]),
  });

  const error = await tool.read({ url: "https://spa.test/late" }).catch((e) => e);

  assert.equal(error.code, "private_network");
  assert.equal(error.details.stage, "destination");
  const snapshots = fake.state.calls.filter((c) => c.path.includes("/snapshot"));
  assert.equal(snapshots.length, 1, "refused on the first look, not after two more polls of the internal host");
});

test("a page nothing can place is not returned as page text", async (t) => {
  // The gateway will not say where the tab is, at either endpoint. Returning the body anyway would put
  // it under the url we asked for, which reads as a clean result.
  const { tool } = setup(t, { snapshotReportsUrl: false, tabsReportUrl: false });

  const error = await tool.read({ url: "https://quiet.test/" }).catch((e) => e);

  assert.equal(error.code, "destination_unreported");
});

test("a page that rotates text at a constant width is not mistaken for a finished one", async (t) => {
  // The failure the settle loop exists to prevent, in the one shape length comparison cannot see: a
  // skeleton that swaps content without changing width.
  const frames = Array.from({ length: 6 }, (_unused, index) => `- text: loading ${index} of 5 [level=1]`);
  assert.equal(new Set(frames.map((frame) => frame.length)).size, 1, "the frames must be the same width, that is the point");

  const { fake, tool } = setup(t, {
    snapshotScripts: new Map([["https://rot.test/", frames]]),
    config: { read: { settlePollMs: 5 } },
  });

  const out = await tool.read({ url: "https://rot.test/" });

  assert.match(out.text, /loading 5 of 5/u, "the loop waits for the frames to stop, not for their width to match");
  const snapshots = fake.state.calls.filter((c) => c.path.includes("/snapshot")).length;
  assert.ok(snapshots > 1 + STABLE_ROUNDS, `declared stable after two look-alikes (${snapshots} snapshots)`);
});

test("a slice the gateway capped does not read as a page that stopped growing", async (t) => {
  // Every response here is exactly `snapshotLimit` characters, so the text is identical from one poll to
  // the next while the page underneath it keeps growing. Only `totalChars` can tell those apart.
  const frames = Array.from({ length: 6 }, (_unused, index) => "x".repeat(400 + index * 100));
  const { fake, tool } = setup(t, {
    snapshotLimit: 50,
    snapshotScripts: new Map([["https://cap.test/", frames]]),
    config: { read: { settlePollMs: 5 } },
  });

  await tool.read({ url: "https://cap.test/" });

  const snapshots = fake.state.calls.filter((c) => c.path.includes("/snapshot")).length;
  assert.ok(snapshots > 1 + STABLE_ROUNDS, `declared stable on capped slices (${snapshots} snapshots)`);
});

test("the poll interval never outlasts the settle budget", async (t) => {
  const { tool } = setup(t, {
    snapshotScripts: new Map([["https://slow.test/", ["- text: thin [level=1]"]]]),
    config: { read: { waitForSettleMs: 40, settlePollMs: 5_000 } },
  });

  const startedAt = Date.now();
  await tool.read({ url: "https://slow.test/" });

  // `loadConfig` rejects a poll interval at or above the budget, so this pair only arrives from a config
  // assembled by hand. The loop must still respect the budget it was given.
  assert.ok(Date.now() - startedAt < 1_000, "the read slept through its own deadline and then polled anyway");
});

// --- the page cache (`cache.pageMs` had no page-cache consumer at all) -------------------------

/** Navigation is the cost: one tab open per read that is not served from cache. */
function opens(fake) {
  return fake.state.calls.filter((c) => c.method === "POST" && c.path === "/tabs/open").length;
}

/**
 * A page a read will actually keep.
 *
 * Padded on fixed text rather than on the marker, so rewording a marker cannot quietly drop the page
 * below `settleMinChars` — a thin page is never stored, and a test about replacing an entry needs one
 * to be in there.
 */
function page(marker) {
  return `- heading "Page: https://example.com/article"\n${marker}\n${"content of the article body. ".repeat(120)}`;
}

test("the second identical read costs the gateway nothing", async (t) => {
  const { fake, tool } = setup(t);

  const first = await tool.read({ url: "https://example.test/article" });
  const afterFirst = opens(fake);
  const second = await tool.read({ url: "https://example.test/article" });

  assert.equal(afterFirst, 1, "the first read must actually have navigated, or this proves nothing");
  assert.equal(opens(fake), afterFirst, "a cached page must not open a tab");
  assert.equal(first.fromCache, undefined);
  assert.equal(second.fromCache, true);
  assert.equal(second.text, first.text);
});

test("maxChars does not split the cache, so a cheap first read cannot cap a later one", async (t) => {
  const { fake, tool } = setup(t, { pageContents: new Map([["https://big.test/", "x".repeat(30_000)]]) });

  const cheap = await tool.read({ url: "https://big.test/", maxChars: 100 });
  const afterFirst = opens(fake);
  const wider = await tool.read({ url: "https://big.test/", maxChars: 5_000 });

  assert.equal(cheap.text.length, 100);
  assert.equal(opens(fake), afterFirst, "the whole window is cached, not the slice that was asked for");
  assert.equal(wider.text.length, 5_000, "a small first read capped the page for everyone after it");
});

test("offset is part of the key, because the gateway returns a window rather than a page", async (t) => {
  const { fake, tool } = setup(t, { pageContents: new Map([["https://big.test/", "z".repeat(30_000)]]) });

  await tool.read({ url: "https://big.test/", maxChars: 10_000 });
  const afterFirst = opens(fake);
  await tool.read({ url: "https://big.test/", offset: 10_000 });

  assert.equal(opens(fake), afterFirst + 1, "a different offset is different content, not a cache hit");
});

test("fresh:true ignores the cache", async (t) => {
  const { fake, tool } = setup(t);

  await tool.read({ url: "https://example.test/article" });
  const afterFirst = opens(fake);
  const fresh = await tool.read({ url: "https://example.test/article", fresh: true });

  assert.equal(opens(fake), afterFirst + 1);
  assert.equal(fresh.fromCache, undefined, "a navigated page must not be labelled as cached");
});

test("a hash-routed url is not confused with the page it hashes", async (t) => {
  const { fake, tool } = setup(t, {
    pageContents: new Map([
      ["https://app.test/#/list", `${"l".repeat(2_000)} list`],
      ["https://app.test/#/detail", `${"d".repeat(2_000)} detail`],
    ]),
  });

  const list = await tool.read({ url: "https://app.test/#/list" });
  const detail = await tool.read({ url: "https://app.test/#/detail" });
  const secondList = await tool.read({ url: "https://app.test/#/list" });

  // Stripping the fragment would collapse these into one entry, and this is where it shows: the third
  // call would serve `detail`, because whichever page was cached second owns any shared key.
  assert.equal(opens(fake), 2, "two fragments are two pages");
  assert.equal(secondList.fromCache, true);
  assert.equal(secondList.text, list.text);
});

test("waitFor and schema always navigate, and never populate the cache", async (t) => {
  const { fake, tool, cache } = setup(t);

  await tool.read({ url: "https://example.test/article", waitFor: "#nothing" });
  await tool.read({
    url: "https://example.test/article",
    schema: { type: "object", properties: { title: { type: "string", "x-ref": "e1" } } },
  });

  assert.equal(opens(fake), 2, "neither of these can be answered from a stored snapshot");
  assert.equal(cache.size, 0, "a read that could not honour its own wait must not leave a partial page behind");

  // The discriminator: once a real page is cached, these must still refuse to use it.
  await tool.read({ url: "https://example.test/article" });
  assert.equal(opens(fake), 3);
  const waited = await tool.read({ url: "https://example.test/article", waitFor: "#nothing" });
  assert.equal(waited.fromCache, undefined, "waitFor served from cache would report a wait that never happened");
});

test("a page that had not finished rendering is not cached", async (t) => {
  const { tool, cache } = setup(t, {
    pageContents: new Map([["https://skeleton.test/", "- text: nothing rendered yet [level=1]"]]),
    config: { read: { waitForSettleMs: 0 } },
  });

  const out = await tool.read({ url: "https://skeleton.test/" });

  // Storing this would make an unfinished render the answer for `cache.pageMs`.
  assert.ok(out.text.length < 1_500, "the fixture must stay thinner than read.settleMinChars");
  assert.equal(cache.size, 0);
});

test("a wall is not cached", async (t) => {
  const { fake, tool, cache } = setup(t, {
    pageContents: new Map([["https://news.test/wall", '- main:\n  - heading "Before you continue to Google" [level=1]']]),
  });

  await tool.read({ url: "https://news.test/wall" }).catch(() => undefined);
  const afterFirst = opens(fake);
  await tool.read({ url: "https://news.test/wall" }).catch(() => undefined);

  assert.equal(opens(fake), afterFirst + 1, "a refusal has to stay retryable");
  assert.equal(cache.size, 0);
});

test("a cached page is re-checked against a policy that has since narrowed", async (t) => {
  const finalUrl = "https://internal.test/report";
  const { fake, tool, config } = setup(t, { redirects: new Map([["https://public.test/r", finalUrl]]) });

  const first = await tool.read({ url: "https://public.test/r" });
  assert.equal(first.url, finalUrl);

  // The request url stays allowed, so only the destination rule can catch this. Turning a host off
  // after the fact is the whole point: the cached body was allowed under an older decision.
  config.blockedHosts = ["internal.test"];

  const error = await tool.read({ url: "https://public.test/r" }).catch((e) => e);

  assert.equal(error.code, "host_blocked");
  assert.equal(error.details.stage, "destination", "the refusal must say it was the destination");
  assert.equal(opens(fake), 1, "the cache was hit, and refused, before any navigation");
});

test("two reads of one page in flight open one tab", async (t) => {
  const { fake, tool } = setup(t);

  const [first, second] = await Promise.all([
    tool.read({ url: "https://example.com/article" }),
    tool.read({ url: "https://example.com/article" }),
  ]);

  // pi issues tool calls in parallel, so this is the common case rather than a corner — and on this
  // gateway it is not only a wasted tab: `/tabs/open` creates the tab server-side before its response
  // is read, so a lost response leaves one behind until session shutdown.
  assert.equal(opens(fake), 1);
  assert.equal(first.text.includes("content"), true);
  assert.equal(second.text.includes("content"), true);
});

test("a page whose destination the gateway will not name is never kept", async (t) => {
  // A Firefox profile with `remote.trustedOrigins` lock-down can leave a tab attached but
  // unreachable, and the gateway then reports a page with no url. Readable once, under the same opt-
  // out that lets a private host be read at all, but not keepable.
  const { fake, tool, cache } = setup(t, { snapshotReportsUrl: false, config: { network: { allowPrivateHosts: true } } });

  const out = await tool.read({ url: "https://example.com/article" });
  assert.equal(opens(fake), 1);
  const again = await tool.read({ url: "https://example.com/article" });

  // Kept, it could never be re-checked on the way out — the guard has nothing to parse — so the entry
  // would fail every later read with `unsupported: "" is not a valid URL` rather than navigate.
  assert.equal(opens(fake), 2, "a page we cannot place must not be reused");
  assert.equal(cache.get("read:https://example.com/article:0"), undefined);
  assert.equal(again.fromCache, undefined);
  assert.equal(out.text.length > 0, true, "and it must still be readable the first time");
});

test("fresh:true refreshes the entry as well as the answer", async (t) => {
  const { fake, tool, cache } = setup(t);
  const url = "https://example.com/article";
  const key = "read:https://example.com/article:0";
  fake.state.snapshotScripts.set(url, [page("SUPERSEDED")]);

  const first = await tool.read({ url });
  assert.equal(first.text.includes("SUPERSEDED"), true);
  // The case this test exists for: an older entry has to be in the cache, or the forced read is
  // filling an empty slot rather than replacing anything.
  assert.notEqual(cache.get(key), undefined, "the first read must leave something to replace");

  // The page changes server-side, and only a forced read goes and looks.
  fake.state.snapshotScripts.set(url, [page("WRITTEN AFTER THE FORCED READ")]);
  const forced = await tool.read({ url, fresh: true });
  assert.equal(forced.text.includes("WRITTEN AFTER"), true);
  assert.equal(opens(fake), 2);

  const after = await tool.read({ url });
  // The forced read holds the more current copy. Serving the older one next time is content moving
  // backwards, which is the one thing a cache should never do.
  assert.equal(after.fromCache, true);
  assert.equal(after.text.includes("WRITTEN AFTER"), true);
});

test("a forced read still cannot smuggle a thin page into the cache", async (t) => {
  const { tool, fake, cache } = setup(t);
  const url = "https://example.com/article";
  fake.state.snapshotScripts.set(url, ['- heading "soon"']);

  await tool.read({ url, fresh: true });
  assert.equal(cache.get("read:https://example.com/article:0"), undefined);
});
