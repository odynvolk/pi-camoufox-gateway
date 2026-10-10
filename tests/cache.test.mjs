/**
 * Cache surface the search tests never reach: eviction order, expiry accounting, and what clear()
 * means for a producer that is still running.
 *
 * Hit/miss/expiry/single-flight/failure-never-cached are already exercised through the search tool
 * (`search-tool.test.mjs`), so this file only pins down the contracts nothing else asserts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCache } from "../src/cache.ts";

const MAX_ENTRIES = 128; // mirrored from cache.ts; keep in sync when the ceiling changes

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("eviction drops the oldest inserted key, not the least used", () => {
  const cache = createCache();

  // A re-read entry keeps its original Map slot, so repeated `get`s cannot save it from eviction.
  cache.set("oldest", "1", 60_000);
  for (let i = 0; i < 20; i += 1) assert.equal(cache.get("oldest"), "1");
  for (let i = 1; i <= MAX_ENTRIES; i += 1) cache.set(`k${i}`, "x", 60_000);

  assert.equal(cache.size, MAX_ENTRIES);
  assert.equal(cache.get("oldest"), undefined, "insertion order, not LRU, decides what goes");
  assert.equal(cache.get(`k${MAX_ENTRIES}`), "x", "the newest entry survives");
});

test("size prunes entries that expired between reads", () => {
  const cache = createCache();
  cache.set("live", "1", 60_000);
  cache.set("expired", "1", 0);

  assert.equal(cache.size, 1, "an expired entry is not counted just because it is still in the map");
});

test("an expired entry stops being visible without needing a read to evict it", async () => {
  const cache = createCache();
  cache.set("short", "value", 1);

  assert.equal(cache.get("short"), "value");
  await sleep(5);

  assert.equal(cache.get("short"), undefined);
  await cache.run("short", async () => "fresh", 60_000);
  assert.equal(cache.get("short"), "fresh", "a run must produce again once the ttl has passed");
});

test("clear() during an in-flight producer drops the value instead of resurrecting it", async () => {
  const cache = createCache();
  let release;
  const started = new Promise((resolve) => {
    release = resolve;
  });

  const running = cache.run(
    "key",
    async () => {
      await started;
      return "stale-by-the-time-it-lands";
    },
    60_000,
  );

  cache.clear();
  release();
  assert.equal(await running, "stale-by-the-time-it-lands", "the waiting caller still gets its answer");

  assert.equal(cache.get("key"), undefined, "clear() means drop everything, including what was in flight");

  const next = await cache.run("key", async () => "fresh", 60_000);
  assert.equal(next, "fresh", "the next call is free to produce again");
});
