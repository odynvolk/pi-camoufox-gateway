import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { testConfig } from "./helpers/config.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { createCache } from "../src/cache.ts";
import { gatewaySessionId } from "../src/session.ts";
import { urlPolicyFromConfig } from "../src/net-policy.ts";
import { createExtension, formatError, resolveConfig } from "../src/extension.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { GatewayError } from "../src/errors.ts";

const CONFIG = testConfig({ gatewayUrl: "http://gateway.test:9377", timeoutMs: 2000 });

/**
 * What the error boundary is allowed to know about config: a url from a config that loaded. One shared
 * value so the decision lives in one place — the only other shape, an empty context, is deliberate.
 */
const ERROR_CONTEXT = Object.freeze({ gatewayUrl: CONFIG.gatewayUrl });

function extensionFor(t, userId = "pi-abcdef", options = {}) {
  // `config` belongs to the extension, not to the fake gateway; passing it through unsplit used to
  // land it in the fake's state, where it was silently ignored and the test ran on the defaults.
  // `client` is a third kind: the probe's windows and deadline are client construction, not config, and
  // the loader has no key for them.
  const { config: configOverrides, client: clientOverrides, wrapFetch, ...gatewayOptions } = options;
  const fake = withFakeGateway(t, gatewayOptions);
  const config = testConfig({ gatewayUrl: "http://gateway.test:9377", timeoutMs: 2000, ...configOverrides });
  const client = createGatewayClient({
    baseUrl: config.gatewayUrl,
    timeoutMs: config.timeoutMs,
    urlPolicy: urlPolicyFromConfig(config),
    // Lets a test act at the moment one request goes out, which is the only way to be exactly as late as
    // a caller who gives up halfway through.
    ...(wrapFetch ? { fetchImpl: wrapFetch(fake.fetch) } : {}),
    ...clientOverrides,
  });
  return { fake, client, config, extension: createExtension({ config, client, cache: createCache(), userId }) };
}

/** Requests against the diagnostic endpoint, which is the only one never asked for on a good call. */
function healthCalls(fake) {
  return fake.state.calls.filter((call) => call.path === "/health");
}

test("the gateway session id is stable, prefixed, and safe for a url path", () => {
  assert.equal(gatewaySessionId("abc-123"), gatewaySessionId("abc-123"));
  assert.notEqual(gatewaySessionId("abc-123"), gatewaySessionId("xyz-999"));
  const weird = gatewaySessionId("  weird id/../..  ");
  assert.match(weird, /^pi-[A-Za-z0-9._-]+$/u, `not url-safe: ${weird}`);
  assert.equal(weird.length <= 128, true);
});

test("teardown deletes the gateway session and repeating it is harmless", async (t) => {
  const { fake, extension } = extensionFor(t);

  await extension.shutdown();
  const first = fake.state.calls.filter((c) => c.method === "DELETE" && c.path === "/sessions/pi-abcdef");
  assert.equal(first.length, 1);

  await extension.shutdown();
  const after = fake.state.calls.filter((c) => c.method === "DELETE" && c.path === "/sessions/pi-abcdef");
  assert.equal(after.length, 2, "the second call is a no-op on the gateway, not an error");
  assert.equal(fake.liveTabs().length, 0);
});

test("an aborted search leaves no tab behind", async (t) => {
  const { client, extension } = extensionFor(t);
  const controller = new AbortController();
  controller.abort();

  const thrown = await extension.search({ query: "camoufox" }, { signal: controller.signal }).catch((e) => e);

  assert.equal(thrown.code, "aborted");
  assert.equal(client.openTabCount(), 0);
});

test("search leaves no tabs behind when it succeeds", async (t) => {
  const { client, extension } = extensionFor(t);
  await extension.search({ query: "camoufox" });
  assert.equal(client.openTabCount(), 0);
});

test("read leaves no tabs behind when it succeeds", async (t) => {
  const { client, extension } = extensionFor(t);
  await extension.read({ url: "https://example.test/page" });
  assert.equal(client.openTabCount(), 0);
});

test("a broken config file is surfaced instead of silently using defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "camoufox-broken-"));
  const path = join(dir, "camoufox.json");
  writeFileSync(path, '{"gatewayTimout": 5}', "utf8");

  try {
    const { usedDefaults, error } = resolveConfig({ CAMOUFOX_CONFIG_PATH: path });
    assert.equal(usedDefaults, true);
    assert.match(error ?? "", /unknown config key/u);

    const client = createGatewayClient({ baseUrl: CONFIG.gatewayUrl, timeoutMs: 2000 });
    const extension = createExtension({
      config: CONFIG,
      client,
      cache: createCache(),
      userId: "pi-x",
      configError: error,
    });

    return extension.search({ query: "anything" }).then(
      () => assert.fail("should have refused to run"),
      (thrown) => {
        assert.equal(thrown.code, "config_error");
        assert.match(thrown.message, /unknown config key/u);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("an explicit config path that does not exist is a hard error, not defaults", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camoufox-missing-"));
  const path = join(dir, "nope.json");
  const client = createGatewayClient({ baseUrl: CONFIG.gatewayUrl, timeoutMs: 2000 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { usedDefaults, error } = resolveConfig({ CAMOUFOX_CONFIG_PATH: path });
  assert.equal(usedDefaults, true);
  assert.match(error ?? "", /was not found/u);

  const extension = createExtension({ config: CONFIG, client, cache: createCache(), userId: "pi-x", configError: error });
  const thrown = await extension.search({ query: "camoufox" }).catch((e) => e);
  assert.equal(thrown.code, "config_error");
  assert.match(thrown.message, /was not found/u);
});

test("with no config file present, the environment decides the gateway", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camoufox-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { config, usedDefaults, error } = resolveConfig({
    PI_CODING_AGENT_DIR: dir,
    CAMOUFOX_GATEWAY_URL: "http://env.wins:1234",
  });

  assert.equal(error, undefined);
  assert.equal(usedDefaults, false);
  assert.equal(config.gatewayUrl, "http://env.wins:1234");
});

test("the extension's read details carry metadata, not a second copy of the page", async (t) => {
  const { extension } = extensionFor(t);
  const outcome = await extension.read({ url: "https://example.test/page" });

  assert.ok(outcome.text.length > 0);
  assert.equal("text" in outcome.details, false);
  assert.equal(typeof outcome.details.totalChars, "number");
  assert.ok("truncated" in outcome.details);
  assert.equal(
    /\[page was still only/u.test(outcome.text),
    false,
    "a page that filled in must not be annotated as thin",
  );
});

test("the extension's search details are its outcome, prose aside", async (t) => {
  // `SearchDetails` is the type the registration boundary spells `structuredContent` against, so a key the
  // runtime carries and the type omits is a contract that under-reports. `requested` is that key: it
  // enters the outcome through a literal that spreads a non-literal, which is where `tsc` stops checking
  // for keys the type does not have.
  const { extension } = extensionFor(t);
  const outcome = await extension.search({ query: "camoufox" });

  assert.equal("text" in outcome.details, false);
  assert.equal(outcome.details.requested, CONFIG.search.maxResults, "what was asked for is part of the outcome");
});

test("a config override reaches the client policy and the read budgets", async (t) => {
  // `extensionFor` used to hand `config` to the fake gateway and build everything else from the module
  // defaults, so an override here silently did nothing. Both halves are asserted structurally, not by
  // timing. The refusal below is a destination, which only the client's own policy can see; the missing
  // settle polling is the read tool's budget, which is a different object on the same call.
  const { extension } = extensionFor(t, "pi-config-override", {
    redirects: new Map([["https://public.test/x", "https://blocked.test/admin"]]),
    pageContents: new Map([["https://thin.test/", "s".repeat(200)]]),
    config: { blockedHosts: ["blocked.test"], read: { settleMinChars: 0 } },
  });

  const refused = await extension.read({ url: "https://public.test/x" }).catch((error) => error);
  assert.equal(refused.code, "host_blocked", "the client refused the destination the gateway reported");
  assert.equal(refused.details.stage, "destination");

  const outcome = await extension.read({ url: "https://thin.test/" });
  assert.equal(outcome.details.settledInMs, undefined, "nothing to wait for, so nothing was polled");
});

test("a page that stayed thin is annotated in the text the model reads", async (t) => {
  const { extension } = extensionFor(t, "pi-thin", {
    snapshotScripts: new Map([["https://spa.test/", ['- heading "Loading…" [level=1]']]]),
    config: { read: { settlePollMs: 10 } },
  });

  const outcome = await extension.read({ url: "https://spa.test/" });

  assert.match(outcome.text, /\[page was still only \d+ chars after waiting/u);
  assert.match(outcome.text, /retry with waitFor set to a selector you expect/u, "the note names the way out");
  assert.equal(outcome.details.thinAfterWait, true);
});

test("a thin page is offered only the levers that can still move it", async (t) => {
  // The page stopped growing, the whole thing fits the default text budget, and `waitFor` was already
  // tried on a gateway that has no /wait route. None of the three knobs can help, and the old note
  // recommended two of them.
  const { extension } = extensionFor(t, "pi-thin-waited", {
    snapshotScripts: new Map([["https://spa.test/", ['- heading "Loading…" [level=1]']]]),
    waitRoute: false,
    config: { read: { settlePollMs: 10 } },
  });

  const outcome = await extension.read({ url: "https://spa.test/", waitFor: "#article" });

  assert.match(outcome.text, /\[waitFor "#article" was not performed:/u, "a wait that could not run must be admitted");
  assert.match(outcome.text, /stopped growing there, so it is thin rather than unfinished/u);
  assert.equal(/retry with waitFor/u.test(outcome.text), false, "the call that was just made is not advice");
  assert.equal(/maxChars/u.test(outcome.text), false, "the page is smaller than the budget already in force");
  assert.equal(/waitForSettleMs/u.test(outcome.text), false, "the budget was not what stopped the polling");
});

test("a page still growing when the budget runs out gets the budget named", async (t) => {
  const growing = Array.from({ length: 10 }, (_unused, index) => `- text: ${"p".repeat((index + 1) * 40)}`);
  const { extension } = extensionFor(t, "pi-thin-growing", {
    snapshotScripts: new Map([["https://spa.test/", growing]]),
    config: { read: { settlePollMs: 10, waitForSettleMs: 40 } },
  });

  const outcome = await extension.read({ url: "https://spa.test/" });

  assert.equal(outcome.details.stalledAtDeadline, true, "the deadline, not stability, ended the polling");
  assert.match(outcome.text, /raise read\.waitForSettleMs/u);
});

test("a thin page we cut short is offered the text budget", async (t) => {
  const { extension } = extensionFor(t, "pi-thin-cut", {
    pageContents: new Map([["https://short.test/", "s".repeat(900)]]),
    config: { read: { settlePollMs: 10 } },
  });

  const outcome = await extension.read({ url: "https://short.test/", maxChars: 100 });

  assert.equal(outcome.details.truncated, true);
  assert.match(outcome.text, /read with a larger maxChars/u);
});

test("a capped read names the ceiling, and offers the one knob that can still reach more", async (t) => {
  const ceiling = CONFIG.read.maxCharsCeiling;
  // `snapshotLimit` is the fake's own window (20 000 chars), not a gateway contract: left at the default
  // it, and not the ceiling, would be what bounds this reply.
  const { extension } = extensionFor(t, "pi-capped", {
    snapshotLimit: ceiling * 4,
    pageContents: new Map([["https://huge.test/", "h".repeat(ceiling * 4)]]),
  });

  const outcome = await extension.read({ url: "https://huge.test/", maxChars: ceiling * 12 });

  assert.equal(outcome.details.cappedAt, ceiling);
  assert.match(outcome.text, new RegExp(`capped at ${ceiling} by read\\.maxCharsCeiling`, "u"), "the text says what did the cutting");
  assert.match(outcome.text, /continue with offset/u);
  // The knob this branch used to reach for is "read with a larger maxChars" — the one parameter that is
  // provably useless here, since the bigger request is exactly what got capped. Asserting the phrase,
  // not the words "larger maxChars", because the note above legitimately contains those.
  assert.equal(/read with a larger maxChars/u.test(outcome.text), false, "no knob that cannot move the outcome");
});

test("a ceiling that cost nothing goes unmentioned", async (t) => {
  const { extension } = extensionFor(t, "pi-capped-whole-page", {
    pageContents: new Map([["https://tiny.test/", "t".repeat(300)]]),
  });

  const outcome = await extension.read({ url: "https://tiny.test/", maxChars: 500_000 });

  assert.equal(outcome.details.cappedAt, CONFIG.read.maxCharsCeiling, "the policy fact stands");
  assert.equal(/capped at/u.test(outcome.text), false, "but the whole page came back, so there is no offset to continue to");
});

test("a cached read says so in the text the model gets", async (t) => {
  const { extension } = extensionFor(t, "pi-cached");

  const first = await extension.read({ url: "https://example.test/article" });
  const second = await extension.read({ url: "https://example.test/article" });

  assert.doesNotMatch(first.text, /served from the page cache/u);
  assert.equal(second.details.fromCache, true);
  // A page that was not re-fetched has to look different in the transcript, or a model reading it
  // later cannot tell a stale read from a fresh one. `fresh` is the only lever, so name it.
  assert.match(second.text, /served from the page cache/u);
  assert.match(second.text, /fresh:true/u, "the note has to name the way out");
});

test("an error we could not classify is blamed on us, not on the gateway", () => {
  // The catch-all used to be `gateway_error`, which is how a fault in our own session-id derivation
  // ended up reading as "the gateway is down". The client leaves no bare throw behind, so anything
  // still unclassified at this boundary is ours.
  const formatted = formatError(new Error("cannot derive a gateway session id"), ERROR_CONTEXT);

  assert.equal(formatted.details.code, "internal_error");
  assert.match(formatted.text, /^internal_error:/u);
  assert.match(formatted.text, /own plumbing/u, "the reader has to be told where to look");
  assert.equal(/(^|\n)gateway_error:/u.test(formatted.text), false, "one code per line, or the model reads two culprits");
});

test("an unusable pi session id fails as our own invariant, at the source", () => {
  // Anything that sanitises away to nothing is the same fault: pi handed us nothing to namespace by.
  // None of it is a gateway outage, and none of it is left as a bare `Error` for the boundary to guess at.
  // Three of these four are anything but empty, which is why the message names the condition.
  for (const unusable of ["", "   ", "---", "???"]) {
    assert.throws(
      () => gatewaySessionId(unusable),
      (error) => {
        assert.ok(error instanceof GatewayError && error.code === "internal_error", `"${unusable}" must fail as an internal invariant`);
        assert.match(error.message, /reduces to nothing once sanitised/u);
        assert.equal(/\bempty\b/u.test(error.message), false, "'empty' sends the reader hunting for a missing id");
        assert.ok(error.message.includes(JSON.stringify(unusable)), `"${unusable}" must be quoted in the message`);
        return true;
      },
    );
  }
});

test("an over-long pi session id is capped without discarding what distinguishes it", () => {
  const long = "a".repeat(200);
  assert.equal(gatewaySessionId(long).length, 128, "the gateway namespace is capped");
  assert.equal(gatewaySessionId(long), gatewaySessionId(long), "and the cap is stable across calls");

  // What truncation used to cost: the tail past 128 discriminated nothing, so two ids agreeing on the
  // first 125 characters shared one gateway namespace and its tabs. The overflow now carries a digest
  // of the whole id, so the tail still separates them.
  assert.notEqual(gatewaySessionId(`${long}x`), gatewaySessionId(long), "the tail past 128 must still discriminate");
  assert.notEqual(
    gatewaySessionId(`${long}y`),
    gatewaySessionId(`${long}x`),
    "and two different tails must not meet each other either",
  );
  assert.match(gatewaySessionId(long), /^pi-[A-Za-z0-9._-]+$/u, "a capped id stays safe for a url path");
});

test("a pi session id that fits is passed through unhashed", () => {
  // The digest exists only for the overflow. An id that already fits must keep its readable name,
  // or every ordinary namespace becomes opaque and a gateway tab list stops being diagnosable.
  const atTheLimit = "b".repeat(128 - "pi-".length);

  assert.equal(gatewaySessionId(atTheLimit), `pi-${atTheLimit}`);
  assert.equal(gatewaySessionId("b".repeat(128 - "pi-".length + 1)).length, 128, "one past it is still capped");
});

test("punctuation that survives sanitising is still a usable namespace", () => {
  // Refusing these would be a new way to break ordinary reads: only a name that reduces to nothing
  // is unusable.
  assert.equal(gatewaySessionId("..."), "pi-...");
  assert.equal(gatewaySessionId("a/../b"), "pi-a-..-b");
});

test("with no config resolved for the call, the error names no gateway", () => {
  // A type-level guard on `ErrorContext`: `guard()` short-circuits a config fault before this code is
  // reachable through a tool call, so driving it means calling `formatError` directly with no url.
  const formatted = formatError(new GatewayError("gateway_unreachable", "cannot reach the gateway"), {});

  assert.match(formatted.text, /No gateway url is known for this client/u);
  assert.equal(formatted.text.includes(DEFAULT_CONFIG.gatewayUrl), false, "no shipped default is quoted");
  assert.equal(/https?:\/\//u.test(formatted.text), false, "and no other address either");
  assert.equal(/undefined/u.test(formatted.text), false, "an absent url must not print as one");
});

test("a code the model acts on cannot be overwritten by error details", () => {
  // Details arrive from wherever an error carries them, including a gateway payload. One of them must
  // not be able to relabel the fault after the fact — the misattribution that narrowing the
  // `gateway_error` catch-all exists to stop.
  const formatted = formatError(
    new GatewayError("timeout", "gateway did not respond", { details: { code: "gateway_error", url: "https://x.test/" } }),
    ERROR_CONTEXT,
  );

  assert.equal(formatted.details.code, "timeout");
  assert.equal(formatted.details.url, "https://x.test/", "the rest of the evidence survives");
});

test("a refusal after the browser moved does not claim nothing was sent", () => {
  // The same codes come from the pre-flight check and from re-checking the destination the gateway
  // reports; only the first of those can say the gateway was never contacted.
  const blocked = formatError(
    new GatewayError("host_blocked", "refused", { details: { host: "a.test", stage: "request" } }),
    ERROR_CONTEXT,
  );
  assert.match(blocked.text, /blockedHosts list, so its content was not returned\.$/u);

  const afterRedirect = formatError(
    new GatewayError("host_blocked", "refused", { details: { host: "a.test", stage: "destination" } }),
    ERROR_CONTEXT,
  );
  assert.match(afterRedirect.text, /The browser was redirected there\./u);
  assert.equal(/nothing was sent|nothing was fetched/iu.test(afterRedirect.text), false);

  const unsupportedAfterRedirect = formatError(
    new GatewayError("unsupported", "not a url", { details: { stage: "destination" } }),
    ERROR_CONTEXT,
  );
  assert.equal(/Nothing was fetched/u.test(unsupportedAfterRedirect.text), false, "a tab was opened and a page was fetched");

  const unsupportedUpFront = formatError(
    new GatewayError("unsupported", "empty query"),
    ERROR_CONTEXT,
  );
  assert.match(unsupportedUpFront.text, /Nothing was fetched from the gateway\./u);
});

test("an exhausted chain names every engine it tried, and with what", async (t) => {
  // Two engines fail differently: google answers with the interstitial, duckduckgo serves a page wide
  // enough to have been results and with nothing link-shaped in it. The chain re-throws the *first* of
  // those, so before this the model read `consent_wall`, was told "the fallback engine usually clears
  // this", and had no way to know that fallback had already run and gone blind for a different reason.
  const linkless = `- heading "DuckDuckGo" [level=1]\n${"- paragraph:\n  - text: nothing here is shaped like a link.\n".repeat(60)}`;
  assert.ok(linkless.length > 2_000, `needs to be past PARSEABLE_MIN_CHARS to be parse_error, got ${linkless.length}`);

  const { extension } = extensionFor(t, "u1", {
    consentWallOn: new Set(["u1"]),
    pageContents: new Map([["https://duckduckgo.com/?q=camoufox", linkless]]),
  });

  const error = await extension.search({ query: "camoufox" }).catch((e) => e);
  const formatted = formatError(error, ERROR_CONTEXT);

  assert.equal(error.code, "consent_wall", "the first engine still leads, because it is the one about the query");
  assert.match(formatted.text, /Engines tried: google=consent_wall, duckduckgo=parse_error\./u);
  // The advice is printed one line above that one and reads as one block with it, so it may not send the
  // reader to an engine the next line reports as already run.
  assert.equal(/fallback engine/u.test(formatted.text), false, "the fallback is not a lever left here");
  assert.match(formatted.text, /a narrower query/u, "the one lever still standing is named");
});

test("a chain of one is not dressed up as a chain, and a malformed one prints nothing", () => {
  // The line is only worth its width when there is more than one engine in it, and `details` travels
  // through pi as whatever it is — so the shape that would print `engine=undefined` prints nothing.
  const one = formatError(
    new GatewayError("consent_wall", "google did not serve results", { details: { tried: [{ engine: "google", code: "consent_wall" }] } }),
    ERROR_CONTEXT,
  );
  assert.equal(/Engines tried/u.test(one.text), false, "one step is the same fact the message already gives");
  // The other half of the pair above: with only google attempted, the fallback really is the advice.
  assert.match(one.text, /a narrower query or the fallback engine usually clears this/u, "with only google tried, the fallback is still the honest advice");

  const malformed = formatError(
    new GatewayError("consent_wall", "google did not serve results", { details: { tried: ["google", null, { code: "x" }] } }),
    ERROR_CONTEXT,
  );
  assert.equal(/Engines tried/u.test(malformed.text), false);
  assert.equal(/undefined/u.test(malformed.text), false, "a half-shaped step must not print as one");
});

test("parse_error says whose fault it probably is", () => {
  // `empty_results` is a fact about the query and a narrower one can move it; this is a fact about our
  // parser, and the model needs to not read the two as the same dead end.
  const formatted = formatError(new GatewayError("parse_error", "google served a page we could not read"), ERROR_CONTEXT);

  assert.match(formatted.text, /likelier our parser than your query/u);
  assert.match(formatted.text, /repeating it is unlikely to change the answer/u);
});

/**
 * `GET /health` as a diagnosis of a failure that is already being reported.
 *
 * The liveness gate stays on `GET /`, unchanged: a 503 is a documented *recovering* answer, and a gate
 * that consulted it would record a failure during the one window the gateway is promising to come back —
 * turning a self-healing blip into a hard outage. So this endpoint is only ever asked after something has
 * already failed, which is also the only moment its numbers mean anything.
 */
const BROKEN_PAGE = { failSnapshot: true };

/** The roadmap's own scenario: a gateway that is up and answering, with nothing behind it. */
const NO_BROWSER = {
  ok: true,
  browserConnected: false,
  browserRunning: false,
  activeTabs: 0,
  activeSessions: 1,
  consecutiveFailures: 3,
};

test("a gateway that answers while a read fails reports its own state on the error", async (t) => {
  const { fake, extension } = extensionFor(t, "pi-health-state", { ...BROKEN_PAGE, healthBody: NO_BROWSER });

  const error = await extension.read({ url: "https://example.test/article" }).catch((e) => e);

  assert.equal(error.code, "gateway_error", "the fault stays the one the gateway reported");
  const health = error.details.gatewayHealth;
  assert.equal(health.answered, true);
  assert.equal(health.browserConnected, false);
  assert.equal(health.browserRunning, false);
  assert.equal(health.activeTabs, 0);
  assert.equal(health.activeSessions, 1);
  assert.equal(health.consecutiveFailures, 3);
  assert.equal(healthCalls(fake).length, 1);
});

test("what the gateway said goes in details, and the reading of it in the text", async (t) => {
  // The split item 1.4 shipped the tools for: a script takes the named fields off `details`, a model
  // reads a line. Asserted against the same failure, because the two halves drifting apart is the defect.
  const { extension } = extensionFor(t, "pi-health-rendered", { ...BROKEN_PAGE, healthBody: NO_BROWSER });

  const error = await extension.read({ url: "https://example.test/article" }).catch((e) => e);
  const formatted = formatError(error, ERROR_CONTEXT);

  assert.match(formatted.text, /^gateway_error: gateway error 500: snapshot exploded$/mu, "the failure still leads, on its own line");
  assert.match(formatted.text, /Gateway state after the failure: .*browserConnected=false/u);
  assert.match(formatted.text, /activeTabs=0/u, "the count a model can tell the user about");
  assert.equal(formatted.details.gatewayHealth.browserConnected, false, "and the same fact, unnarrated, for a script");
});

test("a call that works never asks the gateway how it is", async (t) => {
  // The cost this feature must never incur: a second round trip on every success, for a number nobody
  // read on the way past it.
  const { fake, extension } = extensionFor(t, "pi-healthy");

  await extension.search({ query: "camoufox" });
  await extension.read({ url: "https://example.test/article" });

  assert.equal(healthCalls(fake).length, 0, "neither tool pays for a diagnostic on a good call");
});

test("a refusal of our own does not go and ask the gateway about itself", async (t) => {
  // `blocked_url` is decided before anything is sent, so a gateway question here would be answering a
  // question nothing asked — and would make a policy refusal look like a gateway fault.
  const { fake, extension } = extensionFor(t, "pi-refused");

  const error = await extension.read({ url: "ftp://example.test/" }).catch((e) => e);

  assert.equal(error.code, "blocked_url");
  assert.equal(error.details?.gatewayHealth, undefined, "a refusal carries no gateway record at all");
  assert.equal(healthCalls(fake).length, 0);
});

test("a gateway that cannot be reached is not asked the same question twice", async (t) => {
  // The probe that produced `gateway_unreachable` already established that nothing answers, and a cached
  // one re-throws before a tool runs at all — so dialling here would make some of these failures pay a
  // second timeout and the rest none, which is worse than never dialling for either.
  const { fake, extension } = extensionFor(t, "pi-unreachable", { unreachable: true });

  const error = await extension.search({ query: "camoufox" }).catch((e) => e);

  assert.equal(error.code, "gateway_unreachable");
  assert.equal(healthCalls(fake).length, 0);
});

test("a cancelled call spends no further request on explaining itself", async (t) => {
  const { fake, extension } = extensionFor(t, "pi-cancelled");
  const cancelled = new AbortController();
  cancelled.abort();

  const error = await extension.search({ query: "camoufox" }, { signal: cancelled.signal }).catch((e) => e);

  assert.equal(error.code, "aborted");
  assert.equal(healthCalls(fake).length, 0, "a cancel is our own doing, and needs no diagnosis");
});

test("a call that timed out is diagnosed, and still reported as a timeout", async (t) => {
  // The other code worth asking about: a gateway that hung may be a gateway with nothing to hand a page
  // to. The code must not be rewritten by the asking, either — a timeout stays a timeout.
  const { fake, extension } = extensionFor(t, "pi-slow", {
    hangUrls: new Set(["https://slow.test/"]),
    hangForMs: 400,
    client: { timeoutMs: 40 },
  });

  const error = await extension.read({ url: "https://slow.test/" }).catch((e) => e);

  assert.equal(error.code, "timeout", "the original code stands");
  assert.equal(error.retryable, true, "including whether a retry is worth it");
  assert.equal(error.details.gatewayHealth.answered, true, "and the gateway got to say what it was doing");
  assert.equal(healthCalls(fake).length, 1);
});

test("a browser that closes our tab mid-read says whether it is still there at all", async (t) => {
  // The failure mode the item exists for, and the one that reads worst without it: `tab_not_found` alone
  // tells a model a tab vanished, which is a retry; a browser that has gone is not.
  const { fake, extension } = extensionFor(t, "pi-tab-gone", {
    pageContents: new Map([["https://thin.test/", "- heading \"still rendering\""]]),
    dropsTabAfterSnapshot: true,
    healthBody: NO_BROWSER,
  });

  const error = await extension.read({ url: "https://thin.test/" }).catch((e) => e);

  assert.equal(error.code, "tab_not_found", "the second look is what failed, not the first");
  assert.equal(error.details.gatewayHealth.browserConnected, false, "and the gateway says why");
  assert.equal(healthCalls(fake).length, 1);
});

test("a page that reads as the browser refusing is diagnosed the same way", async (t) => {
  // `navigation_failed` this side comes from the wall classifier, not from a refused navigation, so it is
  // driven as a page: a 403-shaped tree is what produces this code in production.
  const { fake, extension } = extensionFor(t, "pi-refused-page", {
    pageContents: new Map([["https://denied.test/", "- heading\n- paragraph:\n  - text: 403 Forbidden"]]),
    healthBody: NO_BROWSER,
  });

  const error = await extension.read({ url: "https://denied.test/" }).catch((e) => e);

  assert.equal(error.code, "navigation_failed");
  assert.equal(error.details.gatewayHealth.browserConnected, false);
  assert.equal(healthCalls(fake).length, 1);
});

test("a gateway with no /health route gets its failure back exactly as it was sent", async (t) => {
  // The case a diagnostic must never be able to reach: the thing it was called to explain has to arrive
  // unchanged, or an optional extra has become the report.
  const { fake, extension } = extensionFor(t, "pi-no-health", { ...BROKEN_PAGE, healthRoute: false });

  const error = await extension.read({ url: "https://example.test/article" }).catch((e) => e);

  assert.equal(error.code, "gateway_error");
  assert.equal(error.message, "gateway error 500: snapshot exploded");
  assert.equal(error.details.status, 500, "the original details keep their own keys");
  assert.equal("gatewayHealth" in error.details, false, "and not even an empty key is added when nothing was learned");
  assert.equal(healthCalls(fake).length, 1, "the route was asked for, and was not there");
});

test("a health check that never answers cannot replace the failure it was asked about", async (t) => {
  const { extension } = extensionFor(t, "pi-health-silent", {
    ...BROKEN_PAGE,
    healthHangsForMs: 500,
    client: { preflightTimeoutMs: 20 },
  });

  const error = await extension.read({ url: "https://example.test/article" }).catch((e) => e);

  assert.equal(error.code, "gateway_error", "the code is still the snapshot's");
  assert.equal(error.message, "gateway error 500: snapshot exploded", "and so is the message");
  assert.equal(error.details.status, 500, "and so is the status it carried");
  assert.deepEqual(error.details.gatewayHealth, { answered: false }, "the only addition is that nothing answered");
});

test("a diagnosis the caller walks away from attaches nothing", async (t) => {
  // The failure this is annotating is already decided, so an abandoned diagnosis has to add nothing and
  // change nothing — and it has to stop asking, rather than sit out its own deadline on a cancelled call.
  const gaveUp = new AbortController();
  const { fake, extension } = extensionFor(t, "pi-abandoned", {
    ...BROKEN_PAGE,
    healthHangsForMs: 5_000,
    wrapFetch: (fetch) => (url, init) => {
      if (String(url).endsWith("/health")) gaveUp.abort();
      return fetch(url, init);
    },
  });

  const error = await extension.read({ url: "https://example.test/article" }, { signal: gaveUp.signal }).catch((e) => e);

  assert.equal(error.code, "gateway_error", "the failure it was asked about still arrives");
  assert.equal(error.message, "gateway error 500: snapshot exploded", "unchanged");
  assert.equal("gatewayHealth" in error.details, false, "and nothing is said about a state nobody waited for");
  assert.equal(healthCalls(fake).length, 1, "one attempt, then it stopped asking");
});

test("one failed search pays one health request, however many engines were tried", async (t) => {
  // Both engines fail at the same endpoint, so the chain runs twice and reports once. The diagnostic
  // belongs to the report.
  const { fake, extension } = extensionFor(t, "pi-chain", { ...BROKEN_PAGE, healthBody: NO_BROWSER });

  const error = await extension.search({ query: "camoufox" }).catch((e) => e);

  assert.equal(error.code, "gateway_error", "the first engine still leads, because it is the one about the query");
  assert.equal(error.details.tried.length, 2, "both engines were attempted");
  assert.equal(healthCalls(fake).length, 1, "and the gateway was asked about once");
});

test("nothing is said about gateway state when none was asked for", () => {
  // A line rendered from an absent record is how an absent record starts reading like a reported one.
  const formatted = formatError(new GatewayError("gateway_error", "gateway error 500: nope"), ERROR_CONTEXT);

  assert.equal(/health|Gateway state/iu.test(formatted.text), false, `said something: ${formatted.text}`);
});

test("a gateway that answered is told apart from one that did not", () => {
  // The distinction the whole item is made of, and it has to reach the message rather than stay a boolean.
  const base = { details: { gatewayHealth: { answered: true, ok: true, browserConnected: false } } };
  const answered = formatError(new GatewayError("timeout", "gateway did not respond within 30000ms", base), ERROR_CONTEXT);
  const silent = formatError(
    new GatewayError("timeout", "gateway did not respond within 30000ms", { details: { gatewayHealth: { answered: false } } }),
    ERROR_CONTEXT,
  );

  assert.match(answered.text, /browserConnected=false/u);
  assert.equal(/did not answer/iu.test(answered.text), false, "an answer must not also be called a silence");
  assert.match(silent.text, /did not answer `GET \/health`/u);
  assert.equal(/browserConnected/u.test(silent.text), false, "and a silence must not be filled in with state");
});

test("what is printed is what was reported, including when it was nothing", () => {
  const recovering = formatError(
    new GatewayError("navigation_failed", "the browser refused the page", {
      details: { gatewayHealth: { answered: true, ok: false, recovering: true } },
    }),
    ERROR_CONTEXT,
  );
  const bare = formatError(
    new GatewayError("navigation_failed", "the browser refused the page", { details: { gatewayHealth: { answered: true } } }),
    ERROR_CONTEXT,
  );

  assert.match(recovering.text, /ok=false, recovering=true/u, "the 503's own two fields, and no others");
  assert.equal(/browserConnected|activeTabs/u.test(recovering.text), false, "nothing is invented for a shape that lacks them");
  assert.match(bare.text, /answered `GET \/health` without reporting any state/u);

  // Read defensively, as the engine chain above is: a field that arrived the wrong shape is not a fact.
  const mistyped = formatError(
    new GatewayError("gateway_error", "gateway error 500: nope", {
      details: { gatewayHealth: { answered: true, activeTabs: "0" } },
    }),
    ERROR_CONTEXT,
  );
  assert.equal(/activeTabs/u.test(mistyped.text), false, "a field of the wrong type is not printed as a fact");
});

test("a gateway-health record that is not a record prints nothing", () => {
  // `details` travels through pi as whatever it is, and a half-shaped one must not print `=undefined`.
  for (const malformed of ["up", 7, [], null]) {
    const formatted = formatError(
      new GatewayError("gateway_error", "gateway error 500: nope", { details: { gatewayHealth: malformed } }),
      ERROR_CONTEXT,
    );
    assert.equal(/Gateway state/iu.test(formatted.text), false, `${JSON.stringify(malformed)} printed a line`);
    assert.equal(/undefined/u.test(formatted.text), false, `${JSON.stringify(malformed)} printed a hole`);
  }
});

test("a dead gateway costs one liveness probe per window, not one timeout per call", async (t) => {
  const fake = withFakeGateway(t, { unreachable: true });
  const client = createGatewayClient({
    baseUrl: CONFIG.gatewayUrl,
    timeoutMs: 100,
    // Pinned so this asserts the mechanism — a cached failure suppresses the redial — rather than the
    // length of the shipped default window, which is free to change.
    preflightRetryAfterMs: 60_000,
  });
  const extension = createExtension({ config: CONFIG, client, cache: createCache(), userId: "pi-dead" });

  // The fake's own call log, not a private counter: it is the only thing that can see a dial this
  // test did not intend, such as one made outside the client under test.
  const dials = () => fake.state.calls.length;

  const first = await extension.search({ query: "camoufox" }).catch((e) => e);
  const afterFirstProbe = dials();
  const second = await extension.search({ query: "camoufox again" }).catch((e) => e);

  assert.equal(first.code, "gateway_unreachable");
  assert.equal(second.code, "gateway_unreachable");
  assert.ok(afterFirstProbe > 0, "the first call must actually have dialled, or this proves nothing");
  // Asserting only the two codes above passed while every call paid its own connect, because a failed
  // probe was never cached.
  assert.equal(dials(), afterFirstProbe, "the second tool call must not dial the gateway again");
});

test("shutdown sweeps sessions in one call", async (t) => {
  const { fake, extension } = extensionFor(t);
  await extension.search({ query: "camoufox" });
  await extension.shutdown();
  assert.equal(fake.liveTabs().length, 0);
});
