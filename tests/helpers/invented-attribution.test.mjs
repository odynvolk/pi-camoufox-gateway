/**
 * A read that lands after its own case stopped waiting — the shape the G.6 recorder must not mis-attribute.
 *
 * `scripts/measure-unregistered-pages.mjs` records which case read the fake's invented page, and it can only
 * answer that by remembering which case was running when the request was *made*. These two cases are that
 * question: the first fires a `/snapshot` it never waits for, the second waits for it. Whichever case the
 * record lands on is the answer, and the recorder's own stderr is the evidence — so this file is run by
 * `tests/measure-unregistered-pages.test.mjs`, which reads that stderr, and not by `npm test`, whose glob is
 * `tests/*.test.mjs` and which runs it without the preload that makes the record at all.
 *
 * Keep both cases in this one file, in this order: the runner executes a file's cases one after another, and
 * "the next case" only means something if they cannot run side by side.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createFakeGateway } from "./fake_gateway.mjs";

const BASE = "http://gateway.attribution.test:9377";
/** Registered with nothing, so the only page the fake can answer with is the one it invents. */
const UNREGISTERED = "https://duckduckgo.com/?q=camoufox";
/** Longer than the gap between two cases, so the read below cannot land inside the one that sent it. */
const SETTLES_AFTER_MS = 400;

/**
 * Which case the read belongs to is the answer the parent reads out of the recorder's stderr; these two
 * markers say which case *sent* it and which one it *settled* during, so the parent never has to copy a case
 * name and cannot be quietly detached from what these two cases are called.
 */
const ISSUER = "the case that asked for the page and then stopped listening";
const LATER = "the case that opens nothing of its own";
const ISSUED_MARK = "PROBE-ISSUED\t";
const SETTLED_MARK = "PROBE-SETTLED-DURING\t";

const fake = createFakeGateway({ snapshotHangsForMs: SETTLES_AFTER_MS });
// Assigned while the recorder's preload is already installed, so the setter there wraps this fetch and every
// call below, made through `globalThis.fetch`, is one the recorder sees. Calling `fake.fetch` directly would
// hand the response back unobserved and leave the recorder with nothing to attribute.
globalThis.fetch = fake.fetch;

let pending;
let tabId;

test(ISSUER, async (t) => {
  const opened = await globalThis
    .fetch(`${BASE}/tabs/open`, { method: "POST", body: JSON.stringify({ userId: "u1", url: UNREGISTERED }) })
    .then((response) => response.json());
  tabId = opened.tabId;

  // Deliberately not awaited. The fake holds this response past the end of the case, exactly as a gateway
  // that never finishes rendering holds a real one past the client's deadline — which is what the shipped
  // suite already exercises, without ever asking who the answer gets credited to.
  pending = globalThis.fetch(`${BASE}/tabs/${tabId}/snapshot?userId=u1`);
  // Printed after the request is in flight: the parent needs to know this case really did send it.
  console.error(`${ISSUED_MARK}${t.name}`);
});

test(LATER, async (t) => {
  const page = await (await pending).json();
  // The read really happened, and really was the invention: without this the parent could be reading an
  // empty stderr and calling a silent recorder a correct one.
  assert.equal(page.url, UNREGISTERED);
  assert.ok(String(page.snapshot).length > 200, "the fake invented this page, nobody registered it");
  console.error(`${SETTLED_MARK}${t.name}`);

  await globalThis.fetch(`${BASE}/tabs/${tabId}?userId=u1`, { method: "DELETE" });
  assert.deepEqual(fake.liveTabs(), [], "and this case leaves nothing open behind it");
});
