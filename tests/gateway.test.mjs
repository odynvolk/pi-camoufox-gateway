import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient, ENDPOINTS } from "../src/gateway.ts";
import { GatewayError } from "../src/errors.ts";

const BASE = "http://gateway.test:9377";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe attempts recorded against `/`.
 *
 * The status probe passes `retry: "connect-only"`: a connect failure that never landed is retried
 * (two attempts, both free) while a timeout is not (one attempt, already expensive). So these tests
 * assert *growth*, never absolute totals — the retry budget can change without them going red for the
 * wrong reason.
 */
function attempts(fake) {
  return fake.state.calls.filter((c) => c.path === "/").length;
}

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
  assert.ok(snap.text.includes("content"), `slice was: ${snap.text.slice(0, 60)}`);
  assert.ok(
    snap.totalChars > snap.text.length,
    "the gateway reports the whole page, so an offset has to come off the front of it",
  );
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

  assert.equal(attempts(fake), 1, "a success costs one attempt and is not retried");
});

test("a failed preflight is cached, so a dead gateway costs one probe per failure window", async (t) => {
  const { fake, client } = clientWith(t, { unreachable: true });

  await client.preflight().catch(() => undefined);
  const afterFirstProbe = attempts(fake);

  for (let i = 0; i < 10; i += 1) await client.preflight().catch(() => undefined);

  // The 60s cache only ever held successes, so every call re-probed and paid its own timeout.
  assert.equal(attempts(fake), afterFirstProbe, "ten calls behind one cached failure cost nothing extra");
});

test("a failed preflight still throws for every caller that asked", async (t) => {
  const { client } = clientWith(t, { unreachable: true });

  for (let i = 0; i < 3; i += 1) {
    const error = expectError(await client.preflight().catch((e) => e), "gateway_unreachable");
    assert.equal(error.retryable, true);
    assert.match(error.message, /gateway\.test:9377/u);
  }
});

test("a cached preflight failure is retried once the failure window passes", async (t) => {
  const { fake, client } = clientWith(t, { unreachable: true, client: { preflightRetryAfterMs: 20 } });

  await expectError(await client.preflight().catch((e) => e), "gateway_unreachable");
  const afterFailure = attempts(fake);
  await expectError(await client.preflight().catch((e) => e), "gateway_unreachable");
  assert.equal(attempts(fake), afterFailure, "the second call rides the cached failure");

  fake.state.unreachable = false;
  await sleep(30);

  const status = await client.preflight();
  assert.equal(status.ok, true, "a recovered gateway must not stay cached as down");
  assert.equal(attempts(fake), afterFailure + 1, "and it re-probes exactly once, the window having passed");
});

test("a cancelled probe is not remembered as the gateway being down", async (t) => {
  const { client } = clientWith(t);
  const cancelled = new AbortController();
  cancelled.abort();

  await expectError(await client.preflight(cancelled.signal).catch((e) => e), "aborted");

  // The next caller never asked to cancel, and this gateway is up. An abort is one caller's decision,
  // not a fact about the gateway, and the shared probe would otherwise hand it to them.
  const status = await client.preflight();
  assert.equal(status.ok, true);
});

test("a timeout is not retried, because it already spent its deadline", async () => {
  let connects = 0;
  const client = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 20,
    fetchImpl: () => {
      connects += 1;
      return new Promise(() => {});
    },
  });

  expectError(await client.preflight().catch((e) => e), "timeout");

  // An absolute total, and the only place one belongs: this asserts the retry budget itself, which is
  // what `retry: "connect-only"` decides for the status probe.
  assert.equal(connects, 1);
});

test("a probe that fails slowly still holds its window, so the next call does not re-dial", async () => {
  let connects = 0;
  const client = createGatewayClient({
    baseUrl: BASE,
    // A probe is then slower than the window it is given, which is the only shape that can tell a
    // start-stamped window from an end-stamped one: measured from the start, this failure is written
    // down already expired and the very next call re-dials.
    timeoutMs: 40,
    fetchImpl: () => {
      connects += 1;
      return new Promise(() => {}); // never settles, so every attempt burns its whole deadline
    },
    preflightRetryAfterMs: 20,
  });

  expectError(await client.preflight().catch((e) => e), "timeout");
  const afterSlowProbe = connects;

  await client.preflight().catch(() => undefined);

  assert.equal(connects, afterSlowProbe, "a failure that took longer than its window must still hold it");
});

test("concurrent preflights against a dead gateway share one probe", async (t) => {
  const { fake, client } = clientWith(t, { unreachable: true });

  const settled = await Promise.allSettled(Array.from({ length: 5 }, () => client.preflight()));

  // One failed probe is the two attempts described above; five callers must not fan out to ten.
  assert.ok(attempts(fake) <= 2, `expected one shared probe, got ${attempts(fake)} attempts`);
  assert.equal(
    settled.filter((r) => r.status === "rejected").length,
    5,
    "deduplicating the probe must not swallow anyone's failure",
  );
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

test("waitFor posts selector, userId and timeout to the wait endpoint", async (t) => {
  const { fake, client } = clientWith(t);
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  const wait = await client.waitFor({ userId: "u1", tabId, selector: "#article", timeoutMs: 1500 });

  assert.equal(wait.ok, true);
  assert.equal(wait.skipped, undefined);
  const call = fake.state.calls.find((c) => c.path.endsWith("/wait"));
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { userId: "u1", selector: "#article", timeout: 1500 });
});

test("waitFor reports a selector that never appeared without throwing", async (t) => {
  const { client } = clientWith(t, { waitSelectorMisses: true });
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  const wait = await client.waitFor({ userId: "u1", tabId, selector: "#nope" });

  assert.equal(wait.ok, false, "ok:false is an answer, not a failure");
  assert.equal(wait.skipped, undefined, "the wait ran, so this is not a missing route");
  assert.equal(wait.error, undefined, "nothing was refused, it just did not match");
});

test("waitFor carries the gateway's own reason for refusing", async (t) => {
  const { client } = clientWith(t, { waitError: "Invalid selector" });
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  const wait = await client.waitFor({ userId: "u1", tabId, selector: "###" });

  assert.equal(wait.ok, false);
  assert.equal(wait.error, "Invalid selector", "a refused wait must not be reported as a slow page");
});

test("waitFor on a gateway with no wait endpoint says so instead of failing", async (t) => {
  // `read` still has to return the page: an old gateway is not a reason to lose the content.
  const { client } = clientWith(t, { waitRoute: false });
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  const wait = await client.waitFor({ userId: "u1", tabId, selector: "#article" });

  assert.equal(wait.ok, false);
  assert.equal(wait.skipped, "gateway has no /wait route");
});

test("waitFor counts only an explicit true as a wait that happened", async (t) => {
  // A successful wait is silent in `read`, and silence is what the model reads as "the selector
  // appeared". A gateway that omits the field gets the benefit of the doubt; one that answers `null`,
  // `0`, or the string `"false"` does not get to mean success.
  const cases = [
    [{}, true],
    [{ ok: true }, true],
    [{ ok: null }, false],
    [{ ok: 0 }, false],
    [{ ok: "true" }, false],
    [{ ok: "false" }, false],
    [{ ok: [] }, false],
  ];

  for (const [body, expected] of cases) {
    const { client } = clientWith(t, { waitBody: body });
    const { tabId } = await openTab(t, client, "u1", "https://example.com");

    const wait = await client.waitFor({ userId: "u1", tabId, selector: "#article" });

    assert.equal(wait.ok, expected, `answered ${JSON.stringify(body)}`);
  }
});

test("a missing /wait route is told apart by status, not by the sentence around it", async (t) => {
  // The phrase "gateway has no route" is ours, composed in `httpError`, and free to be reworded. What
  // decides this branch is the 404 — so a 500 that happens to say the same thing is still a gateway
  // failure, and a reworded 404 is still a gateway without the endpoint.
  const { client } = clientWith(t, { waitReject: { status: 500, message: "gateway has no route /wait" } });
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  const wait = await client.waitFor({ userId: "u1", tabId, selector: "#article" });

  assert.equal(wait.ok, false);
  assert.notEqual(wait.skipped, "gateway has no /wait route", "a server error is not a missing endpoint");
  assert.match(wait.skipped, /gateway error 500/u);
});

test("waitFor never asks the gateway to outlast our own deadline", async (t) => {
  // Two knobs, one request. Asking for 5s of waiting we will cut off at 200ms buys work the gateway
  // does and we never collect. Config validation keeps the configured pair coherent, so this guards a
  // client wired up by hand.
  const { fake, client } = clientWith(t, { client: { timeoutMs: 200 } });
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  await client.waitFor({ userId: "u1", tabId, selector: "#article", timeoutMs: 5_000 });
  await client.waitFor({ userId: "u1", tabId, selector: "#article" });

  const waits = fake.state.calls.filter((c) => c.path.endsWith("/wait"));
  assert.equal(waits[0].body.timeout, 200, "the gateway deadline was capped at our own");
  assert.equal("timeout" in waits[1].body, false, "no deadline asked for, none sent");
});

test("waitFor gives up on a gateway that hangs, without spending the retry budget", async (t) => {
  // A gateway that ignores its own `timeout` argument must not turn an optional wait into a failed
  // read, and must not be retried: the caller already paid the deadline once.
  const { fake, client } = clientWith(t, { waitHangsForMs: 500, client: { timeoutMs: 60 } });
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  const wait = await client.waitFor({ userId: "u1", tabId, selector: "#slow" });

  assert.equal(wait.ok, false);
  assert.match(wait.skipped, /did not respond within 60ms/u);
  assert.equal(fake.state.calls.filter((c) => c.path.endsWith("/wait")).length, 1, "the wait got retried");
});

test("waitFor still propagates a tab that vanished underneath us", async (t) => {
  const { client } = clientWith(t);
  const { tabId } = await openTab(t, client, "u1", "https://example.com");

  const error = await client.waitFor({ userId: "other", tabId, selector: "#article" }).catch((e) => e);

  expectError(error, "tab_not_found");
});

test("each client enforces the policy it was constructed with", async (t) => {
  const { fake, client } = clientWith(t);
  const guarded = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 2000,
    urlPolicy: { blockedHosts: ["forbidden.test"], allowPrivateHosts: false },
  });

  expectError(await guarded.openTab({ userId: "u1", url: "https://forbidden.test/x" }).catch((e) => e), "host_blocked");
  expectError(await guarded.openTab({ userId: "u1", url: "http://192.168.0.1/" }).catch((e) => e), "private_network");
  assert.equal(fake.state.calls.filter((c) => c.path === "/tabs/open").length, 0, "the guard is client-side, so nothing left");

  // The policy is a constructor argument, not a module-level flag: a second client against the same
  // gateway, built without the block, still opens the url the guarded one refused. Without this the
  // test above would also pass if the policy leaked between instances.
  const tab = await client.openTab({ userId: "u1", url: "https://forbidden.test/x" });
  assert.ok(tab.tabId, "an unguarded client is unguarded");
  assert.equal(fake.state.calls.filter((c) => c.path === "/tabs/open").length, 1, "and it reached the gateway");
  await client.closeTab({ userId: "u1", tabId: tab.tabId });
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
