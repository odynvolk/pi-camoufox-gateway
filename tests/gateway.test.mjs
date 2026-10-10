import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient, ENDPOINTS } from "../src/gateway.ts";
import { GatewayError } from "../src/errors.ts";

const BASE = "http://gateway.test:9377";

function clientWith(t, options = {}) {
  // These tests drive the client directly and close what they open in their own `t.after`, which the
  // per-test check (registered earlier) would mistake for a leak. The file-level hook is the backstop
  // here; per-test enforcement guards the production paths in search/read/engines/resolve.
  const fake = withFakeGateway(t, { assertNoTabLeak: false, ...options });
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 2000, ...options.client });
  return { fake, client };
}

/**
 * Open a tab for the test and close it afterwards. The fake gateway's leak assertion then proves
 * production paths close their own tabs instead of proving the test was tidy.
 */
async function openTab(t, client, userId, url) {
  const tab = await client.openTab({ userId, url });
  t.after(() => client.closeTab({ userId, tabId: tab.tabId }));
  return tab;
}

function expectError(error, code) {
  assert.ok(error instanceof GatewayError, `expected GatewayError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, `message was: ${error.message}`);
  return error;
}

test("openTab posts the url to /tabs/open and returns the tabId", async (t) => {
  const { fake, client } = clientWith(t);

  const tab = await openTab(t, client, "u1", "https://example.com");

  assert.equal(tab.url, "https://example.com");
  assert.ok(tab.tabId);
  const call = fake.state.calls.find((c) => c.path === "/tabs/open");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { userId: "u1", url: "https://example.com" });
});

test("navigateMacro sends macro and query to the tab", async (t) => {
  const { fake, client } = clientWith(t);
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  const result = await client.navigateMacro({ userId: "u1", tabId, macro: "@google_search", query: "a b" });

  assert.equal(result.url, "https://www.google.com/search?q=a%20b");
  const call = fake.state.calls.find((c) => c.path.endsWith("/navigate"));
  assert.equal(call.method, "POST");
  assert.equal(call.body.macro, "@google_search");
  assert.equal(call.body.query, "a b");
  assert.equal(call.body.userId, "u1");
});

test("snapshot requests the tab path with userId and offset", async (t) => {
  const { fake, client } = clientWith(t);
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  const snap = await client.snapshot({ userId: "u1", tabId, offset: 100 });

  assert.equal(snap.url, "https://example.com");
  assert.ok(snap.text.includes("Page:"));
  const call = fake.state.calls.find((c) => c.path.startsWith(`/tabs/${tabId}/snapshot`));
  assert.match(call.path, /userId=u1/u);
  assert.match(call.path, /offset=100/u);
});

test("snapshot reports pagination from the gateway unchanged", async (t) => {
  const { client } = clientWith(t, {
    pageContents: new Map([["https://big.test/", "x".repeat(50_000)]]),
  });
  const { tabId } = await openTab(t, client, "u1", "https://big.test/");

  const snap = await client.snapshot({ userId: "u1", tabId });

  assert.equal(snap.truncated, true);
  assert.equal(snap.hasMore, true);
  assert.equal(snap.totalChars, 50_000);
  assert.equal(snap.text.length, snap.nextOffset);
});

test("extract posts a JSON schema and returns the extracted data", async (t) => {
  const { fake, client } = clientWith(t);
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  const data = await client.extract({
    userId: "u1",
    tabId,
    schema: { type: "object", properties: { title: { type: "string", "x-ref": "e1" } } },
  });

  assert.deepEqual(data, { title: "value-for-title" });
  const call = fake.state.calls.find((c) => c.path.endsWith("/extract"));
  assert.equal(call.body.schema.properties.title["x-ref"], "e1");
});

test("closeTab and deleteSession hit the documented paths", async (t) => {
  const { fake, client } = clientWith(t);
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  await client.closeTab({ userId: "u1", tabId });
  await client.deleteSession({ userId: "u1" });

  assert.ok(fake.state.calls.some((c) => c.method === "DELETE" && c.path === `/tabs/${tabId}?userId=u1`));
  assert.ok(fake.state.calls.some((c) => c.method === "DELETE" && c.path === "/sessions/u1"));
});

test("preflight caches its answer for 60 seconds", async (t) => {
  const { fake, client } = clientWith(t);

  for (let i = 0; i < 10; i += 1) await client.preflight();

  const pings = fake.state.calls.filter((c) => c.path === "/");
  assert.equal(pings.length, 1);
});

test("sends the bearer token when apiKey is configured", async (t) => {
  const { fake, client } = clientWith(t, { requireAuth: true, client: { apiKey: "sekret" } });

  await client.preflight();

  assert.equal(fake.state.calls[0].headers.authorization, "Bearer sekret");
});

test("maps 401 to gateway_unauthorized", async (t) => {
  const { client } = clientWith(t, { requireAuth: true });

  const error = expectError(await client.preflight().catch((e) => e), "gateway_unauthorized");
  assert.match(error.message, /authoriz/iu);
});

test("maps a connection refusal to gateway_unreachable naming the url", async (t) => {
  const { client } = clientWith(t, { unreachable: true });

  const error = expectError(await client.preflight().catch((e) => e), "gateway_unreachable");
  assert.match(error.message, /gateway\.test:9377/u);
});

test("maps 404 tab not found distinctly from transport failures", async (t) => {
  const { client } = clientWith(t);

  const error = expectError(
    await client.snapshot({ userId: "u1", tabId: "nope" }).catch((e) => e),
    "tab_not_found",
  );
  assert.match(error.message, /nope/u);
});

test("retries a 5xx exactly once before failing", async (t) => {
  const { fake, client } = clientWith(t);
  fake.state.failures.set("GET /tabs/tab-1/snapshot", 5);

  const error = await client
    .snapshot({ userId: "u1", tabId: "tab-1" })
    .catch((e) => e);

  expectError(error, "gateway_error");
  const attempts = fake.state.calls.filter((c) => c.path.startsWith("/tabs/tab-1/snapshot")).length;
  assert.equal(attempts, 2);
});

test("opening a tab is not retried once the gateway has answered", async (t) => {
  // A 5xx on /tabs/open means a tab may already exist. Retrying would create a second one whose id
  // we never learn, so the leak could never be closed. Only a failure to connect is retried.
  const { fake, client } = clientWith(t);
  fake.state.failures.set("POST /tabs/open", 5);

  const error = await client.openTab({ userId: "u1", url: "https://example.com" }).catch((e) => e);

  expectError(error, "gateway_error");
  assert.equal(fake.state.calls.filter((c) => c.path === "/tabs/open").length, 1);
});

test("surfaces the gateway's own error message", async (t) => {
  const { client } = clientWith(t);

  const error = expectError(
    await client.openTab({ userId: "u1", url: "https://blocked.test/page" }).catch((e) => e),
    "blocked_url",
  );
  assert.match(error.message, /Blocked URL/iu);
});

test("aborts in-flight work when the caller signal aborts", async (t) => {
  const { client } = clientWith(t);
  const controller = new AbortController();
  controller.abort();

  const error = expectError(
    await client.openTab({ userId: "u1", url: "https://example.com", signal: controller.signal }).catch((e) => e),
    "aborted",
  );
  assert.match(error.message, /cancel/iu);
});

test("an ambiguous openTab timeout sweeps the tab the gateway created", async (t) => {
  // The gateway creates the tab, then the response is lost. Nothing in the response told us the id,
  // so the only way to honour "every tab opened gets closed" is to reconcile afterwards.
  const { fake, client } = clientWith(t, { hangUrls: new Set(["https://example.com/slow"]), hangForMs: 500, client: { timeoutMs: 80 } });

  const error = expectError(
    await client.openTab({ userId: "u1", url: "https://example.com/slow" }).catch((e) => e),
    "timeout",
  );

  assert.ok(error);
  assert.deepEqual(fake.liveTabs(), []);
  assert.equal(client.openTabCount(), 0);
});

test("times out against a gateway that never answers", async (t) => {
  withFakeGateway(t);
  const client = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}),
  });

  const error = expectError(
    await client.openTab({ userId: "u1", url: "https://example.com" }).catch((e) => e),
    "timeout",
  );
  assert.match(error.message, /20\d?ms|20 ms|timeout/iu);
});

test("every endpoint we call still exists in the gateway's OpenAPI description", () => {
  const spec = JSON.parse(readFileSync(new URL("./fixtures/openapi.json", import.meta.url), "utf8"));
  const declared = new Map();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      declared.set(`${method.toUpperCase()} ${normalize(path)}`, path);
    }
  }

  for (const [name, { method, path }] of Object.entries(ENDPOINTS)) {
    const key = `${method} ${normalize(path)}`;
    assert.ok(declared.has(key), `gateway no longer exposes ${name} (${key})`);
  }
});

function normalize(path) {
  return path.replace(/\{[^}]+\}/gu, "{}");
}
