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

/**
 * A navigate that answered `{ "ok": false }` is classified by the central `{ok:false}` rule, from the
 * gateway's own words — not by a per-endpoint guess.
 *
 * `navigateMacro` does not pass `tolerateNotOk`, so `perform()` rejects the body before any navigate-specific
 * reading of it can happen. Rows, because the two messages this classifier recognises are the whole reason it
 * is the better owner: "google served a consent interstitial" and "that url was refused" each say what to do
 * next, and one code for a navigation that failed says neither.
 */
test("a navigate answering { ok: false } is classified by what the gateway said", async () => {
  const rows = [
    { error: "redirected to consent.google.com", code: "consent_wall" },
    { error: "Blocked URL scheme (only http/https allowed)", code: "blocked_url" },
    { error: "navigation timed out inside the browser", code: "gateway_error" },
  ];

  for (const row of rows) {
    const client = createGatewayClient({
      baseUrl: BASE,
      timeoutMs: 200,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: false, error: row.error }),
      }),
    });

    const error = await client
      .navigateMacro({ userId: "u1", tabId: "tab-1", macro: "@google_search", query: "a b" })
      .catch((thrown) => thrown);
    expectError(error, row.code);
    assert.ok(error.message.includes(row.error), `the gateway's own words survive: ${error.message}`);
  }
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

test("the status probe runs to its own deadline, not the request timeout", async () => {
  let connects = 0;
  const client = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 40,
    preflightTimeoutMs: 12,
    fetchImpl: () => {
      connects += 1;
      return new Promise(() => {}); // never settles, so only a deadline ends this
    },
  });

  const error = expectError(await client.preflight().catch((e) => e), "timeout");

  // The number a reader can act on has to be the one that actually fired. It is also the proof of which
  // deadline was applied: a probe still running to `timeoutMs` would report 40.
  assert.match(error.message, /within 12ms/u, `reported the wrong deadline: ${error.message}`);
  assert.equal(error.message.includes("40ms"), false, "the request timeout must not be quoted for a probe");
  assert.equal(connects, 1, "a probe that timed out is not retried either");
});

test("an ordinary request keeps the deadline the probe does not take", async () => {
  const client = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 40,
    preflightTimeoutMs: 12,
    fetchImpl: () => new Promise(() => {}),
  });

  const error = expectError(await client.openTab({ userId: "u1", url: "https://example.com" }).catch((e) => e), "timeout");

  assert.match(error.message, /within 40ms/u, `a real request was cut short: ${error.message}`);
});

test("a probe deadline longer than the request timeout cannot extend it", async () => {
  const client = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 12,
    preflightTimeoutMs: 5_000,
    fetchImpl: () => new Promise(() => {}),
  });

  const error = expectError(await client.preflight().catch((e) => e), "timeout");

  assert.match(error.message, /within 12ms/u, "the client timeout is the ceiling a probe may not raise");
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

test("a window that has expired answers from the last known status and refreshes behind the call", async (t) => {
  // Answering from the old status is what stops the first call of each window paying the probe's round
  // trip on a gateway that is simply up — latency a caller cannot see the reason for.
  //
  // The window is wide against the poll interval below on purpose: waiting for the refresh must not be
  // able to re-expire it, or a poll would start a second one and the count would be measuring the test.
  const { fake, client } = clientWith(t, { client: { preflightTtlMs: 250 } });

  const first = await client.preflight();
  const afterFirstProbe = attempts(fake);

  await sleep(260);
  const second = await client.preflight();
  assert.equal(second.checkedAt, first.checkedAt, "served from what we already knew, not from a new probe");

  // The refresh is deliberately unjoined, so the honest wait is for the fact, not for a fixed tick.
  let refreshed = second;
  const deadline = Date.now() + 1_000;
  while (refreshed.checkedAt === first.checkedAt && Date.now() < deadline) {
    await sleep(2);
    refreshed = await client.preflight();
  }

  assert.notEqual(refreshed.checkedAt, first.checkedAt, "the window did get refreshed, behind the call");
  assert.equal(
    attempts(fake),
    afterFirstProbe + 1,
    "one refresh per window, whatever number of calls arrived at it",
  );
});

test("an aborted caller does not cancel the refresh it started", async (t) => {
  // "The refresh takes no caller's signal" is a decision, not an oversight: cancelling it because one
  // caller gave up would leave every later caller re-dialling a gateway that was about to be reported
  // healthy. Threading the signal through — the natural-looking edit, since the blocking branch does
  // exactly that — is the mutation this test exists to catch.
  const { fake, client } = clientWith(t, { client: { preflightTtlMs: 250 } });

  const first = await client.preflight();
  const beforeRefresh = attempts(fake);
  await sleep(260);

  const cancelled = new AbortController();
  cancelled.abort();
  const served = await client.preflight(cancelled.signal);

  assert.equal(served.checkedAt, first.checkedAt, "the cancelled caller is served the status we hold, not an abort");

  // Counted at the transport, and deliberately without calling `preflight()` again: re-asking would
  // start a *fresh* refresh and pass either way, which is exactly how a first draft of this test passed
  // under that mutation while guarding nothing.
  const deadline = Date.now() + 1_000;
  while (attempts(fake) === beforeRefresh && Date.now() < deadline) await sleep(2);

  assert.equal(
    attempts(fake),
    beforeRefresh + 1,
    "the refresh the cancelled caller started still goes out",
  );
});

test("a gateway that dies mid-window is refused once the refresh learns, not before", async (t) => {
  // The honest cost of answering from a stale status: the call that happens to straddle the window
  // finds out the hard way, from its own request rather than from a probe.
  const { fake, client } = clientWith(t, { client: { preflightTtlMs: 20, preflightRetryAfterMs: 5_000 } });

  const first = await client.preflight();
  fake.state.unreachable = true;
  await sleep(30);

  const straddling = await client.preflight();
  assert.equal(straddling.checkedAt, first.checkedAt, "the straddling call is not the one that discovers it");

  await sleep(30);
  await expectError(await client.preflight().catch((error) => error), "gateway_unreachable");
});

test("a gateway that stays dead stays refused once the failure window passes", async (t) => {
  // The stale-success window and the failure window are measured separately, so a call can arrive past
  // both. If a failed refresh left the success it invalidated in place, that call would be served the
  // older answer and be told "up" — once per window, however many refreshes have failed since.
  const { fake, client } = clientWith(t, { client: { preflightTtlMs: 40, preflightRetryAfterMs: 200 } });

  await client.preflight();
  fake.state.unreachable = true;

  // The one stale answer this design accepts: the call that straddles the success window has nothing
  // fresher, and it is the call that starts the refresh which learns the gateway went away.
  await sleep(50);
  await client.preflight();
  await sleep(20); // the refresh is unjoined by design; bound the wait for its failure being recorded

  for (let i = 0; i < 3; i += 1) {
    await expectError(await client.preflight().catch((error) => error), "gateway_unreachable");
    await sleep(10);
  }

  // Two windows, so a refusal that resumed and then lapsed would not pass this by being late.
  for (let round = 0; round < 2; round += 1) {
    await sleep(220);
    const before = attempts(fake);
    await expectError(await client.preflight().catch((error) => error), "gateway_unreachable");
    assert.ok(attempts(fake) > before, "with nothing fresher to answer from, this call had to re-dial");
  }
});

test("the first probe ever is still waited for", async (t) => {
  // Nothing is known yet, so there is no stale status to answer with — and a cold gateway that is down
  // must cost one cheap refusal rather than one full request timeout per call.
  const { fake, client } = clientWith(t, { unreachable: true, client: { preflightTtlMs: 20 } });

  await expectError(await client.preflight().catch((error) => error), "gateway_unreachable");

  assert.ok(attempts(fake) > 0, "a cold client cannot answer from a status it never got");
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

/**
 * `GET /health` — the other status endpoint, and not the probe.
 *
 * It is never called before a request and never gates one: it answers "what was the gateway's state"
 * after something already failed, which is the only question `GET /` cannot answer. The two documented
 * responses are 200 (state) and 503 (*unhealthy or recovering*), and a 503 has to arrive as data — read
 * it as a 5xx and the one field worth having, `recovering`, is destroyed by the transport.
 */
function healthCalls(fake) {
  return fake.state.calls.filter((c) => c.path === "/health");
}

test("health reports the counts and booleans the gateway answers with", async (t) => {
  const { fake, client } = clientWith(t);

  const health = await client.health();

  assert.equal(health.answered, true);
  assert.equal(health.ok, true);
  assert.equal(health.browserConnected, true);
  assert.equal(health.browserRunning, true);
  assert.equal(health.activeTabs, 0);
  assert.equal(health.activeSessions, 0);
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(healthCalls(fake).length, 1);
});

test("a 503 from the health endpoint is a status we read, not an error we throw", async (t) => {
  const { fake, client } = clientWith(t, { healthStatus: 503 });

  const health = await client.health();

  assert.equal(health.answered, true, "an unhealthy answer is still an answer");
  assert.equal(health.ok, false);
  assert.equal(health.recovering, true, "`recovering` is the field this call exists for");
  assert.equal(health.activeTabs, undefined, "the 503 shape does not carry it, so nothing is invented");
  assert.equal(healthCalls(fake).length, 1, "a diagnostic is not retried");
});

test("a health answer naming only some fields invents nothing for the rest", async (t) => {
  // No field of either recorded response is `required`, so absence is a conforming answer rather than a
  // shape to repair.
  const { client } = clientWith(t, { healthBody: { browserConnected: false } });

  const health = await client.health();

  assert.equal(health.answered, true);
  assert.equal(health.browserConnected, false);
  assert.equal(health.activeTabs, undefined);
  assert.equal(health.ok, undefined, "`ok` included: a gateway that omits it is not read as either state");
});

test("a 200 that answers `ok: false` is reported, not raised", async (t) => {
  // A 200 is not a promise of health, and `{ ok: false }` is a legal body on it. Left to the ordinary
  // `{ ok: false }` rule this becomes a `gateway_error` with no status at all, which would be reported as
  // a gateway that never answered.
  const { client } = clientWith(t, { healthBody: { ok: false, browserConnected: false, activeTabs: 0 } });

  const health = await client.health();

  assert.equal(health.answered, true);
  assert.equal(health.ok, false, "the gateway's own verdict survives the call that asked for it");
  assert.equal(health.browserConnected, false);
});

test("a health field of the wrong type is not passed through as a fact", async (t) => {
  // `details` is where a script reads these, and an `activeTabs` it has to type-check is worse than one
  // the gateway did not report.
  const { client } = clientWith(t, { healthBody: { activeTabs: "0", browserConnected: "no" } });

  const health = await client.health();

  assert.equal(health.answered, true);
  assert.equal(health.activeTabs, undefined);
  assert.equal(health.browserConnected, undefined);
});

test("only the documented 503 is read as an answer, not any 5xx", async (t) => {
  // The mutation this guards: `status >= 500` is one character wider than the two statuses the contract
  // has, and it would read a body served by a broken gateway as live state.
  const { client } = clientWith(t, { healthStatus: 500, healthBody: { ok: false, recovering: true } });

  const health = await client.health();

  assert.equal(health.answered, true, "a 500 is still a gateway that answered");
  assert.equal(health.recovering, undefined, "and a body on an undocumented status is not state");
});

test("a 503 accepted on the health request is not accepted on any other", async () => {
  // Per-request by construction, and asserted as one: the same response answers both calls, and only
  // one of them is allowed to treat it as an answer.
  const client = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 200,
    fetchImpl: async () => ({
      status: 503,
      ok: false,
      text: async () => JSON.stringify({ ok: false, recovering: true }),
    }),
  });

  assert.equal((await client.health()).recovering, true, "the health call read it as a status");
  const error = expectError(await client.snapshot({ userId: "u1", tabId: "t1" }).catch((e) => e), "gateway_error");
  assert.match(error.message, /503/u, "an ordinary request still reports it as a gateway failure");
});

test("a gateway with no /health route is reported as nothing learned", async (t) => {
  // An older gateway answers 404, which says nothing about its browser. Reporting "no answer" here would
  // be a claim about a gateway that plainly answered.
  const { fake, client } = clientWith(t, { healthRoute: false });

  assert.equal(await client.health(), undefined);
  assert.equal(healthCalls(fake).length, 1, "the route was asked for, and was not there");
});

test("a gateway that cannot be reached is reported as no answer", async (t) => {
  const { fake, client } = clientWith(t, { unreachable: true });

  assert.deepEqual(await client.health(), { answered: false });
  assert.equal(healthCalls(fake).length, 1, "and it is paid for once, not once per retry");
});

test("a response that said nothing is an answer, not a gateway that never spoke", async () => {
  // A 2xx with nothing in it did reach the gateway. That is the fact the verdict has to rest on, not on
  // whether our own throw happened to carry a status.
  const client = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 200,
    fetchImpl: async () => ({ status: 204, ok: true, text: async () => "" }),
  });

  assert.deepEqual(await client.health(), { answered: true }, "answered, with no state to report");
});

/**
 * One row per thing `perform()` can throw, covering both directions of the rule `health()` depends on: an
 * error thrown with a response in hand carries its status, and one thrown without it cannot.
 *
 * The verdict is decided off an absence, so all of its soundness lives in who may write the other half.
 * Pinning it per throw site is what stops a `details` added at a transport throw, or a dropped one at a
 * response throw, from becoming a statement about a gateway that never made one.
 */
const OUTCOMES = [
  { name: "a 5xx", response: { status: 500, ok: false, body: { error: "boom" } }, code: "gateway_error", status: 500 },
  { name: "a 200 answered `{ ok: false }`", response: { status: 200, ok: true, body: { ok: false, error: "captcha challenge" } }, code: "consent_wall", status: 200 },
  { name: "a 200 with no body at all", response: { status: 200, ok: true, body: undefined }, code: "gateway_error", status: 200 },
  { name: "a gateway that refused the connection", fail: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), code: "gateway_unreachable", status: undefined },
  { name: "a request that never got back", hangs: true, code: "timeout", status: undefined },
  { name: "a transport failure we do not recognise", fail: new Error("socket half-closed"), code: "gateway_error", status: undefined },
];

test("only an error a response caused claims a response", async () => {
  for (const row of OUTCOMES) {
    const client = createGatewayClient({
      baseUrl: BASE,
      timeoutMs: 30,
      fetchImpl: async () => {
        if (row.hangs) return new Promise(() => {});
        if (row.fail) throw row.fail;
        return {
          status: row.response.status,
          ok: row.response.ok,
          text: async () => (row.response.body === undefined ? "" : JSON.stringify(row.response.body)),
        };
      },
    });

    const error = await client.snapshot({ userId: "u1", tabId: "tab-1" }).catch((thrown) => thrown);
    assert.equal(error.code, row.code, `${row.name} → ${error.code}`);
    assert.equal(error.details?.status, row.status, `${row.name}: a status is how health() knows the gateway answered`);
  }
});

test("the health request runs to the probe deadline, not the request timeout", async () => {
  const startedAt = Date.now();
  const client = createGatewayClient({
    baseUrl: BASE,
    timeoutMs: 400,
    preflightTimeoutMs: 20,
    fetchImpl: () => new Promise(() => {}),
  });

  assert.deepEqual(await client.health(), { answered: false });
  // Which deadline fired is only visible in how long this took, so the margin is wide: 20ms asked for,
  // 400ms would have been the request timeout, and anything under 300 cannot be that.
  assert.ok(Date.now() - startedAt < 300, `an unanswered health check cost ${Date.now() - startedAt}ms`);
});

test("a caller that stops the health request is not answered with a claim about the gateway", async (t) => {
  const cancelled = new AbortController();
  cancelled.abort();
  const { fake, client } = clientWith(t);

  assert.equal(await client.health(cancelled.signal), undefined);
  assert.equal(healthCalls(fake).length, 0, "a signal already given up on is not dialled at all");
});

test("the health request is never cached, so a reported state is never a stale one", async (t) => {
  // Deliberate, and only assertable here: `activeTabs` describes the gateway right now, and a cached
  // "0 active tabs" attached to a fresh failure is a false statement about live state.
  const { fake, client } = clientWith(t);

  await client.health();
  await client.health();

  assert.equal(healthCalls(fake).length, 2);
});

test("every field health surfaces is one the recorded contract declares for GET /health", async (t) => {
  const spec = JSON.parse(readFileSync(new URL("./fixtures/openapi.json", import.meta.url), "utf8"));
  const responses = spec.paths["/health"].get.responses;
  const declared = {};
  const required = [];
  for (const response of Object.values(responses)) {
    Object.assign(declared, response.content?.["application/json"]?.schema?.properties ?? {});
    required.push(...(response.content?.["application/json"]?.schema?.required ?? []));
  }

  const sample = Object.fromEntries(
    Object.entries(declared).map(([key, rule]) => [key, rule.type === "boolean" ? true : rule.type === "integer" ? 7 : "camoufox"]),
  );
  assert.ok(Object.keys(sample).length >= 7, `the recorded response shrank to ${Object.keys(sample).join(", ")}`);

  const { client } = clientWith(t, { healthBody: sample });
  const health = await client.health();

  // `engine` is the one declared field we do not surface: `GET /` declares it too, and nothing reads it.
  const surfaced = Object.keys(health).filter((key) => key !== "answered");
  assert.deepEqual(
    surfaced.filter((key) => !(key in declared)),
    [],
    `health invents a field the recorded contract does not declare: ${surfaced.filter((key) => !(key in declared)).join(", ")}`,
  );
  assert.deepEqual(
    Object.keys(declared).filter((key) => key !== "engine" && !surfaced.includes(key)),
    [],
    "health stopped surfacing a field the recorded contract declares",
  );
  assert.deepEqual(required, [], "every field of both responses is optional, which is why every one is optional here too");
  // A 2026-10-09 probe record (`docs/brainstorms/2026-10-09-pi-camoufox-gateway.md`) has a live gateway also
  // answering `memory: { rssMb, heapUsedMb }`, which this 1.14.0 recording does not declare — so it is read
  // nowhere here and asserted nowhere. Refreshing the recording is how that settles; coding the note is not.
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

test("times out against a gateway that never answers", async () => {
  // No `withFakeGateway` here, deliberately. Every request this client makes is answered by
  // `fetchImpl`, so a global fake would carry no traffic, track no tabs, and observe nothing — while
  // quietly replacing `fetch_guard.mjs`'s blocked global fetch with a healthy gateway. That guard is
  // the one thing that catches a request escaping to the real network, and installing an unused stub
  // is exactly how it gets defeated.
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
