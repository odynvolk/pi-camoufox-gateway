/**
 * The fake gateway's own contract.
 *
 * `opens` is how the suite counts navigations — a cached read is proved by a count, not by the snapshot it
 * got back — and `openCalls` is the same predicate with the calls attached, for the tests that have to see
 * where each navigation went. Neither is tested by the tests that depend on it: a predicate that stopped
 * checking `method` would still count every navigation the real client can make, fail nothing, and quietly
 * start counting a request that was not one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createFakeGateway, openCalls, opens } from "./helpers/fake_gateway.mjs";

test("a call counts as a navigation only when the gateway was asked to make one", () => {
  // Pushed straight into `state.calls` rather than sent through the fake's router: no client ever sends a
  // `GET /tabs/open`, so the router cannot produce the pair that separates "counted navigations" from
  // "counted requests to a path". This case tests the helper's predicate, not a production scenario.
  const fake = createFakeGateway();
  fake.state.calls.push(
    { method: "GET", path: "/tabs/open", body: undefined, headers: {} },
    { method: "POST", path: "/tabs/open", body: { url: "https://example.test/" }, headers: {} },
  );

  assert.equal(openCalls(fake).length, 1, "a `GET /tabs/open` reads the same path, it does not navigate");
  assert.equal(opens(fake), 1, "and the count says what the calls say");
});
