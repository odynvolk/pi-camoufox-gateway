/**
 * Does the identical-pair stop now commit to "no organic results" on a page that merely had not rendered?
 *
 * The branch just merged trades a hedge for a commitment: where the old loop said "not known whether it had
 * results", two byte-identical looks plus a spent budget now let `classifySerp`'s own verdict through. That
 * is right for a page that finished empty. It is only right for a page that never started rendering if
 * `classifySerp` can tell the two apart — and the capture in `.context/google-captures/anomaly-5-*.txt`
 * (108 chars: heading + searchbox, no navigation, no chrome at all) is thinner than any page this repo has
 * ever accepted as a finished zero-result page.
 *
 * So: serve that exact recorded frame, byte-identical, slowly enough that the loop cannot afford a third
 * look, and see what the engine says. "google returned no organic results for that query" here would be a
 * false negative this branch introduced.
 *
 * Run: NODE_ENV=test node scripts/probe-commit-on-skeleton.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { createFakeGateway } from "../tests/helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { googleEngine } from "../src/engines/google.ts";
import { classifySerp, detectWall } from "../src/snapshot.ts";
import { SEARCH_SETTLE_MS } from "../src/engines/settle.ts";

const BASE = "http://gateway.test:9377";
const QUERY = "zzzqqqxx nonexisting thing";
const SERP = `https://www.google.com/search?q=${encodeURIComponent(QUERY)}`;

/** The live capture, headers stripped — the frame exactly as the gateway handed it over. */
const capture = readdirSync(new URL("./google-captures/", import.meta.url))
  .filter((name) => name.startsWith("anomaly-") && name.endsWith(".txt"))
  .sort()[0];
const SKELETON = readFileSync(new URL(`./google-captures/${capture}`, import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .join("\n")
  .trim();

console.log(`frame: ${capture} — ${SKELETON.length} chars`);
console.log(`  detectWall=${JSON.stringify(detectWall({ url: SERP, text: SKELETON }))}`);
const oneLook = classifySerp({ url: SERP, text: SKELETON }, "google");
console.log(`  one look → ${oneLook.kind}/${oneLook.code}: ${oneLook.message}\n`);

for (const latencyMs of [0, SEARCH_SETTLE_MS + 1, 5_000]) {
  const fake = createFakeGateway({
    pageContents: new Map([[SERP, SKELETON]]),
    snapshotHangsForMs: latencyMs,
    snapshotLimit: SKELETON.length + 1,
    openLatencyMs: 100,
  });
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  const paths = [];
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 60_000 });

  const startedAt = Date.now();
  const outcome = await googleEngine().search(QUERY, { client, userId: "u1" }).catch((error) => error);
  const totalMs = Date.now() - startedAt;
  globalThis.fetch = original;

  const snapshots = fake.state.calls.filter((call) => call.path.includes("/snapshot")).length;
  const code = outcome.code ?? (outcome.results ? "ok" : "unknown");
  const message = outcome.message ?? "no results";
  const overclaims = code === "empty_results" && !/not known|still rendering/iu.test(message);
  console.log(
    `snapshot cost ${String(latencyMs).padStart(5)}ms → ${snapshots} look(s) in ${totalMs}ms  ` +
      `code=${code} stalled=${String(outcome.details?.stalledAtDeadline ?? "unset")}`,
  );
  console.log(`    "${message}"${overclaims ? "   ⚠️  commits to an absence the frame cannot establish" : ""}\n`);
}
