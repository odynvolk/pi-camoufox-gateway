/**
 * Live gate for the settle-loop fix: does the query that reproduced the false "still rendering" claim
 * still report a stall it never earned?
 *
 * The finding (`.context/compound-engineering/findings/2026-11-...settle-stalled-at-deadline.md`) recorded
 * this exact query coming back `empty_results` with `details.stalledAtDeadline: true` while the loop's own
 * `samePage` comparison had found its two frames byte-identical. A real gateway, a real engine, no fakes.
 *
 * Run: CAMOUFOX_GATEWAY_URL=http://... NODE_ENV=test node scripts/verify-settle-live.mjs
 */

import { loadConfig } from "../src/config.ts";
import { urlPolicyFromConfig } from "../src/net-policy.ts";
import { createCache } from "../src/cache.ts";
import { createGatewayClient } from "../src/gateway.ts";
import { createExtension } from "../src/extension.ts";

const config = loadConfig();

/**
 * Count the gateway requests one call makes, so the number of looks is measured, not described.
 *
 * Handed in as `fetchImpl` rather than swapped onto `globalThis`: `createGatewayClient` binds
 * `globalThis.fetch` at construction (`src/gateway.ts` -> `this.fetchImpl`), so a wrapper installed after
 * the client is built is never called, and every count silently reads zero.
 */
const calls = [];
const countingFetch = ((original) => async (url, init) => {
  calls.push(new URL(String(url)).pathname);
  return original(url, init);
})(globalThis.fetch.bind(globalThis));

const client = createGatewayClient({
  baseUrl: config.gatewayUrl,
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  timeoutMs: config.timeoutMs,
  urlPolicy: urlPolicyFromConfig(config),
  fetchImpl: countingFetch,
});
const userId = `pi-settle-live-${process.pid}`;
const extension = createExtension({ config, client, cache: createCache(), userId });

const QUERIES = [
  ["why does consent.google.com keep appearing", "google"],
  ["zzzqqqxx nonexisting thing", "google"],
  ["camoufox anti-detect browser", "google"],
  // The chain as shipped, too: an engine that hops must not report a stall for the engine that gave up.
  ["why does consent.google.com keep appearing", undefined],
  ["camoufox anti-detect browser", undefined],
];

let failures = 0;
for (const [query, engine] of QUERIES) {
  calls.length = 0;
  const startedAt = Date.now();
  const outcome = await extension
    .search(engine ? { query, engine } : { query })
    .catch((error) => error);
  const totalMs = Date.now() - startedAt;
  const snapshots = calls.filter((path) => path.includes("/snapshot")).length;
  const details = outcome.details ?? {};
  const stalled = details.stalledAtDeadline === true || outcome.stalledAtDeadline === true;
  const claimsStillRendering = /still rendering/u.test(outcome.text ?? "");
  // The defect: a stall named while the page had stopped changing. A genuine stall on a page that was
  // still growing is allowed, and is what `tests/session.test.mjs` pins — this gate only fails on the
  // combination the finding recorded.
  const lied = stalled || claimsStillRendering;

  // A call that never snapshotted measured nothing, and a gate that passes on nothing is worse than one
  // that fails: this probe passed once while its own counter was unwired.
  if (snapshots === 0) {
    failures += 1;
    console.log(`❌  "${query}" (${engine ?? "chain"}) — 0 snapshots, so this row measured nothing`);
    continue;
  }
  if (lied) failures += 1;
  console.log(
    `${lied ? "❌" : "✅"}  "${query}" (${engine ?? "chain"}) — ${totalMs}ms, ${snapshots} snapshot(s), ` +
      `code=${outcome.code ?? "ok"}, results=${details.results?.length ?? 0}, ` +
      `stalledAtDeadline=${String(details.stalledAtDeadline ?? outcome.stalledAtDeadline ?? "unset")}`,
  );
  if (lied) console.log(`    text: ${(outcome.text ?? outcome.message ?? "").slice(0, 220)}`);
}

const leftovers = await client.listTabs?.({ userId }).catch(() => null);
console.log(`\n${failures === 0 ? "GATE: PASS" : "GATE: FAIL"} — ${failures} of ${QUERIES.length} queries claimed a stall.`);
if (leftovers) console.log(`tabs still open for ${userId}: ${leftovers.tabs?.length ?? leftovers.length ?? "?"}`);
process.exit(failures === 0 ? 0 : 1);
