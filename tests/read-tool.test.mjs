import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { testConfig } from "./helpers/config.mjs";
import { createGatewayClient } from "../src/gateway.ts";
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
  return { fake, client, config, tool: readTool({ client, config, userId: "u1" }) };
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

test("a page that renders after the first snapshot is read hydrated, not as a skeleton", async (t) => {
  const skeleton = '- heading "Loading…" [level=1]';
  const hydrated = `- heading "The real article" [level=1]\n${'  - text: body copy that only exists after the app boots. '.repeat(40)}`;
  const { fake, tool } = setup(t, {
    snapshotScripts: new Map([["https://spa.test/", [skeleton, skeleton, hydrated]]]),
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
  const { fake, tool } = setup(t);

  await tool.read({ url: "https://example.test/late", waitFor: "#article" });

  const wait = fake.state.calls.find((c) => c.path.endsWith("/wait"));
  assert.ok(wait, "no POST /tabs/{id}/wait was made");
  assert.equal(wait.body.selector, "#article");
  assert.equal(wait.body.userId, "u1");
  assert.equal(wait.body.timeout, 5_000);
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
