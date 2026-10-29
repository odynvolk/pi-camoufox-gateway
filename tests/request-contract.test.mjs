/**
 * Every request body this client sends has to be one the recorded contract accepts.
 *
 * B.7. `httpError` maps a 400 to `gateway_error` unless it recognises the message, and the finding was
 * that this is a guess: if a field *we* assembled is what the gateway rejected, calling that a gateway
 * fault sends the reader to check a service that is fine. The honest answer is not a different label —
 * relabelling to `internal_error` is equally a guess, and wrong whenever the gateway has drifted from
 * `openapi.json`. It is to stop guessing about our own half.
 *
 * So: our bodies are checked against the recorded contract here, on the way out of the client — the
 * real object the real code assembled, not a literal transcribed to match. Two consequences, and both
 * are the point:
 *
 * - a field renamed or misspelled on our side fails this suite, instead of surfacing as a 400 that we
 *   would have blamed on the gateway;
 * - what a 400 then *means* is narrower, and defensible: we shipped a body the published contract
 *   accepts, so a gateway rejecting it has drifted from its own document. Which is a gateway fault.
 *
 * Deliberately a hand-rolled check over the subset the contract actually uses, not a JSON Schema
 * engine: there is no validator dependency in this repo, adding one to make three flat objects conform
 * is a dependency for a `for` loop, and a partial validator that says which keywords it understands
 * beats one that silently ignores the ones it does not.
 */

import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";

const BASE = "http://gateway.test:9377";
const spec = JSON.parse(readFileSync(new URL("./fixtures/openapi.json", import.meta.url), "utf8"));

/** One entry per operation that declares a JSON request body, keyed by its templated path. */
const CONTRACTS = new Map();
for (const [template, operations] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(operations)) {
    const schema = operation.requestBody?.content?.["application/json"]?.schema;
    if (schema) CONTRACTS.set(`${method.toUpperCase()} ${template}`, schema);
  }
}

/**
 * Concrete path back to its template: `/tabs/e7/navigation` → `/tabs/{tabId}/navigation`.
 *
 * Segment-wise and exact in count, so a path we invented matches nothing rather than matching the
 * nearest-looking declared route and being checked against the wrong schema.
 */
function templateFor(path) {
  const segments = path.split("/").filter((segment) => segment !== "");
  for (const key of CONTRACTS.keys()) {
    const template = key.slice(key.indexOf(" ") + 1);
    const templateSegments = template.split("/").filter((segment) => segment !== "");
    if (templateSegments.length !== segments.length) continue;
    if (templateSegments.every((segment, index) => segment.startsWith("{") || segment === segments[index])) {
      return template;
    }
  }
  return undefined;
}

const TYPES = {
  string: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === "number" && Number.isFinite(value),
  object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  array: (value) => Array.isArray(value),
};

/**
 * Every way a body can fail its schema, as strings so one run reports all of them.
 *
 * Three, not four. A key present with an `undefined` value is *not* checkable here and is deliberately
 * absent: the client serialises with `JSON.stringify`, the fake parses with `JSON.parse`, so such a key
 * is gone before anything this file can observe. Asserting it anyway would add a line that can never
 * fail — the one outcome worse than no assertion, because it reads as cover.
 */
function violationsOf(body, schema) {
  const declared = schema.properties ?? {};
  const found = [];

  for (const required of schema.required ?? []) {
    if (!(required in body)) found.push(`required key "${required}" is missing`);
  }

  for (const [key, value] of Object.entries(body)) {
    const rule = declared[key];
    if (!rule) {
      found.push(`key "${key}" is not in the contract (declared: ${Object.keys(declared).join(", ") || "none"})`);
      continue;
    }

    const check = TYPES[rule.type];
    if (!check) {
      found.push(`contract type "${rule.type}" for "${key}" is not one this check understands`);
    } else if (!check(value)) {
      found.push(`key "${key}" is ${typeof value} ${JSON.stringify(value)}, contract says ${rule.type}`);
    }
  }

  return found;
}

/**
 * Every way a batch of recorded calls fails the contract, as strings so one run reports all of them.
 *
 * Shared by both tests on purpose: the case where a path resolves to no declared operation is not
 * "nothing to check", it is this client calling a route the recorded 1.14.0 contract does not have —
 * exactly how a gateway upgrade becomes a silent 404 — and it has to be reported by the same code path
 * that reports a bad field, not by a second filter that could drift away from it.
 */
function problemsOf(calls) {
  const problems = [];

  for (const call of calls) {
    const template = templateFor(call.path);
    const schema = template === undefined ? undefined : CONTRACTS.get(`${call.method} ${template}`);
    if (!schema) {
      problems.push(`${call.method} ${call.path} is not a declared operation with a request body`);
      continue;
    }
    for (const problem of violationsOf(call.body, schema)) {
      problems.push(`${call.method} ${template}: ${problem}`);
    }
  }

  return problems;
}

function clientWith(t, options = {}) {
  const fake = withFakeGateway(t, { assertNoTabLeak: false, ...options });
  return { fake, client: createGatewayClient({ baseUrl: BASE, timeoutMs: 2000, ...options.client }) };
}

/** Bodies only: a GET has a path to match and nothing to check against it. */
function bodiesOf(fake) {
  return fake.state.calls.filter((call) => call.body !== undefined && call.body !== null);
}

test("every body the client sends is one the recorded contract accepts", async (t) => {
  const { fake, client } = clientWith(t);
  const userId = "contract-user";
  const tab = await client.openTab({ userId, url: "https://example.test/article" });
  // Closed here rather than via the per-test check, which this file disables: the bodies are what is
  // under test, and a tab left behind would be reported by the file-level backstop — as it was, on the
  // first run of this file. Kept because a conformance test that leaks is still a leak.
  t.after(() => client.closeTab({ userId, tabId: tab.tabId }));

  // `timeout` and not `timeoutMs`: the contract renamed it, and the client renames it back on the way
  // out. The one field where both names are plausible, so the one worth pinning from the spec side.
  await client.waitFor({ userId, tabId: tab.tabId, selector: "h1", timeoutMs: 250 });
  await client.extract({ userId, tabId: tab.tabId, schema: { type: "object", properties: { t: { type: "string" } } } });

  const withBodies = bodiesOf(fake);
  assert.ok(withBodies.length >= 3, `expected the three body-carrying calls, saw ${withBodies.length}`);

  assert.deepEqual(problemsOf(withBodies), [], "the client is sending bodies the recorded contract does not accept");
});

/**
 * The unmatched route, seen firing.
 *
 * The first test asserts nothing is unmatched across the three body-carrying calls this client makes, which is the
 * guarantee. It cannot show that the unmatched branch *works*, and an assertion nobody has watched go
 * red is a guess dressed as a guard — this file's header says as much about an absent check, and
 * `b32fbcb` removed exactly this shape from `gateway.test.mjs` one commit before this branch.
 *
 * A route the client can reach that the contract lacks is not reachable by inventing a client method:
 * every path in `ENDPOINTS` is declared. It is reachable the way a real one arrives — a gateway served
 * behind a path prefix. `url()` joins baseUrl and path by concatenation, so the prefix is sent, and the
 * recorded contract is still 1.14.0 without it. That is the same shape as a gateway that renamed a
 * route, which is what this file exists to notice.
 */
test("a body sent to a route the contract does not have is reported, not skipped", async (t) => {
  const { fake, client } = clientWith(t, { client: { baseUrl: `${BASE}/proxy` } });

  // The fake has no route under a prefix either, so this answers the way an undeclared route does: a
  // 404, after the body has already been assembled, sent and recorded. The response is not asserted and
  // does not need to be — what is under test is the path a body left the client on, which is recorded
  // before routing happens.
  await client.openTab({ userId: "undeclared-route", url: "https://example.test/a" }).catch(() => undefined);

  const withBodies = bodiesOf(fake);
  // The guard against the mistake this file was written to avoid: an installed fake that saw no
  // traffic checks nothing, so the traffic is asserted before the check is.
  assert.equal(withBodies.length, 1, "no body was sent, so the assertion below would be checking an empty log");

  assert.deepEqual(problemsOf(withBodies), [
    "POST /proxy/tabs/open is not a declared operation with a request body",
  ]);
});
