/**
 * Scratch measurement: does the settle loop's "still rendering" line mean what it says when one snapshot
 * costs more than `SEARCH_SETTLE_MS`?
 *
 * Not a test — a probe. It drives the real engine, the real `snapshotSettled`, and the real fake gateway, and
 * prints what the loop actually had in hand when it decided to say "not known whether it had results".
 *
 * Run: NODE_ENV=test node scripts/measure-stalled-at-deadline.mjs
 */

import { readFileSync } from "node:fs";
import { createFakeGateway } from "../tests/helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { googleEngine } from "../src/engines/google.ts";
import { SEARCH_SETTLE_MS, SEARCH_SETTLE_POLL_MS } from "../src/engines/settle.ts";
import { STABLE_ROUNDS } from "../src/settle.ts";

const BASE = "http://gateway.test:9377";
const QUERY = "zzzqqqxx nonexisting thing";
const URL_OPENED = `https://www.google.com/search?q=${encodeURIComponent(QUERY)}`;
/** A google-hosted page that answered cleanly with nothing organic in it: stable, owned, empty. */
const PAGE = readFileSync(new URL("../tests/fixtures/serp-no-results.txt", import.meta.url), "utf8");

/**
 * One search, with every gateway request timed and every snapshot body kept.
 *
 * `latencyMs` is put on the snapshot route only, which is the case being measured: a page whose text the
 * gateway is slow to hand over, and nothing else slow.
 */
async function measure(latencyMs) {
  const fake = createFakeGateway({
    pageContents: new Map([[URL_OPENED, PAGE]]),
    snapshotHangsForMs: latencyMs,
    openLatencyMs: 250,
  });
  const original = globalThis.fetch;
  const timing = [];
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const started = Date.now();
    const response = await fake.fetch(url, init);
    const elapsed = Date.now() - started;
    timing.push({ path, ms: elapsed });
    if (path.includes("/snapshot")) bodies.push(await (await response.json()).snapshot);
    return response;
  };

  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 30_000 });
  const startedAt = Date.now();
  const outcome = await googleEngine().search(QUERY, { client, userId: "u1" }).catch((error) => error);
  const totalMs = Date.now() - startedAt;
  globalThis.fetch = original;

  const snapshots = timing.filter((call) => call.path.includes("/snapshot"));
  return {
    latencyMs,
    totalMs,
    snapshots: snapshots.length,
    snapshotMs: snapshots.map((call) => call.ms),
    settleMs: snapshots.reduce((total, call) => total + call.ms, 0),
    code: outcome?.code,
    message: outcome?.message,
    stalledAtDeadline: outcome?.details?.stalledAtDeadline,
    framesIdentical: bodies.length > 1 && bodies.every((body) => body === bodies[0]),
    tabsLeft: client.openTabCount(),
  };
}

console.log(
  `SEARCH_SETTLE_MS=${SEARCH_SETTLE_MS}  SEARCH_SETTLE_POLL_MS=${SEARCH_SETTLE_POLL_MS}  STABLE_ROUNDS=${STABLE_ROUNDS}` +
    `  (a stable stop needs ${STABLE_ROUNDS} identical comparisons = ${STABLE_ROUNDS + 1} looks)`,
);
console.log(`page: serp-no-results.txt, ${PAGE.length} chars, google-hosted, stable, no organics\n`);

const rows = [];
for (const latency of [0, 250, 400, 449, 460, 700, 5_000]) rows.push(await measure(latency));

for (const row of rows) {
  console.log(
    `snapshot cost ${String(row.latencyMs).padStart(4)}ms each` +
      ` → ${row.snapshots} look(s) [${row.snapshotMs.join(", ")}ms = ${row.settleMs}ms of the ${total(row)}]` +
      ` in ${row.totalMs}ms total`,
  );
  console.log(`    stalledAtDeadline=${row.stalledAtDeadline} code=${row.code} framesIdentical=${row.framesIdentical} tabsLeftOpen=${row.tabsLeft}`);
  console.log(`    message: ${row.message}\n`);
}

function total(row) {
  return `${row.totalMs}ms`;
}
