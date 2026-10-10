import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { assertHostAllowed, readTool } from "../src/tools/read.ts";

const BASE = "http://gateway.test:9377";

function setup(t, options = {}) {
  const fake = withFakeGateway(t, options);
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 2000 });
  const config = {
    gatewayUrl: BASE,
    engines: [
      { name: "google", enabled: true },
      { name: "duckduckgo", enabled: true },
    ],
    cache: { serpMs: 60_000, pageMs: 60_000 },
    read: { defaultMaxChars: 12_000 },
    search: { maxResults: 10 },
    blockedHosts: options.blockedHosts ?? [],
    timeoutMs: 2000,
  };
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
