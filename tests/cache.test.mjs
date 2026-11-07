/**
 * Cache surface the search tests never reach: eviction order, expiry accounting, what clear() means
 * for a producer that is still running, and the age bound a caller may put on a read.
 *
 * Hit/miss/expiry/single-flight/failure-never-cached are already exercised through the search tool
 * (`search-tool.test.mjs`), so this file only pins down the contracts nothing else asserts.
 *
 * Age is stubbed, never slept for: `src/cache.ts` reads `Date.now()` in both the read path and `set`,
 * so one saved-and-restored stub dates an entry and ages it in the same test.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCache, MAX_ENTRIES } from "../src/cache.ts";
import { stageClock } from "./helpers/clock.mjs";

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

test("size prunes entries that expired between reads", async () => {
  const cache = createCache();
  cache.set("live", "1", 60_000);
  // A ttl of 0 would be pruned inside set() itself, so `size` would never be asked to do the work.
  // This one expires untouched — it is still sitting in the map until the getter prunes it.
  cache.set("expired", "1", 10);

  await sleep(30);

  assert.equal(cache.size, 1, "an expired entry is not counted just because it is still in the map");
});

test("an expired entry stops being visible without needing a read to evict it", async () => {
  const cache = createCache();
  cache.set("short", "value", 30);

  assert.equal(cache.get("short"), "value");
  await sleep(60);

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

test("run returns what shouldStore rejects, and does not store it", async () => {
  const cache = createCache();
  const value = { text: "still rendering" };

  const out = await cache.run("k", async () => value, 1000, { shouldStore: () => false });

  // The caller still gets the answer; only the keeping is refused. Without this, a caller that needs
  // one in-flight producer (`read`) would have to give up the rule about what is worth keeping.
  assert.equal(out, value);
  assert.equal(cache.get("k"), undefined);
});

test("a value shouldStore rejects does not block the next producer for that key", async () => {
  const cache = createCache();

  await cache.run("k", async () => ({ v: 1 }), 1000, { shouldStore: () => false });
  assert.equal(cache.get("k"), undefined);

  // Rejected, not remembered: the next read of the same url must be free to try again.
  const next = await cache.run("k", async () => ({ v: 2 }), 1000);
  assert.deepEqual(next, { v: 2 });
  assert.deepEqual(cache.get("k"), { v: 2 });
});

const MINUTE = 60_000;

test("peek reports how old the entry it returned is", (t) => {
  const cache = createCache();
  const clock = stageClock(t, 1_000_000);

  cache.set("page", "value", 10 * MINUTE);
  clock.advance(4 * MINUTE);

  const peeked = cache.peek("page");
  assert.equal(peeked?.value, "value");
  assert.equal(peeked?.ageMs, 4 * MINUTE, "the age is the entry's, measured from when it was stored");
});

test("a tight bound rejects an entry and leaves it for a looser reader", (t) => {
  const cache = createCache();
  const clock = stageClock(t, 1_000_000);

  cache.set("page", "value", 10 * MINUTE);
  clock.advance(4 * MINUTE);

  // Two calls on one cache — the ADR's whole assertion. An implementation that deletes what its own
  // bound rejected passes the first line and fails the second.
  assert.equal(cache.peek("page", { maxAgeMs: MINUTE })?.value, undefined, "over tolerance, so not this caller's answer");
  assert.equal(cache.peek("page", { maxAgeMs: 5 * MINUTE })?.value, "value", "the entry is still there to be read");
});

test("an over-tolerance entry is skipped, not evicted; an expired one still goes", (t) => {
  const cache = createCache();
  const clock = stageClock(t, 1_000_000);

  cache.set("stale", "still-readable", 10 * MINUTE);
  cache.set("expired", "past-its-ttl", MINUTE);
  clock.advance(2 * MINUTE);

  assert.equal(cache.get("expired"), undefined);
  assert.equal(cache.peek("stale", { maxAgeMs: MINUTE })?.value, undefined);

  // The expired key is gone and the merely-stale one is held, which is the pair the ADR draws: expiry
  // is the cache's own rule and evicts, a caller's tolerance is not and does not.
  assert.equal(cache.size, 1, "a read that skipped an entry must not have taken it away");
});

test("maxAgeMs of 0 never serves, not even an entry stored in the same millisecond", (t) => {
  const cache = createCache();
  stageClock(t, 1_000_000);

  cache.set("page", "value", 10 * MINUTE);

  // The premise: nothing advanced the clock, so the entry is as young as an entry can be.
  assert.equal(cache.peek("page")?.ageMs, 0);
  assert.equal(cache.peek("page", { maxAgeMs: 0 })?.value, undefined, "0 means navigate, so never a hit");
});

test("run honours the bound on its own hit and stores what it produced", async (t) => {
  const cache = createCache();
  const clock = stageClock(t, 1_000_000);

  cache.set("page", "stored", 10 * MINUTE);
  clock.advance(4 * MINUTE);

  let produced = 0;
  const out = await cache.run(
    "page",
    async () => {
      produced += 1;
      return "fresh";
    },
    10 * MINUTE,
    { maxAgeMs: 0 },
  );

  assert.equal(produced, 1, "the bound applies inside run too, not only to a bare get");
  assert.equal(out, "fresh", "the produced value answers the call that had to produce it");
  assert.equal(cache.get("page"), "fresh", "and the re-fetched page replaced the one the bound skipped");
});

test("two concurrent bounded calls still share one producer", async () => {
  const cache = createCache();
  let produced = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const produce = async () => {
    produced += 1;
    await gate;
    return "value";
  };

  const first = cache.run("page", produce, 10 * MINUTE, { maxAgeMs: 5 * MINUTE });
  const second = cache.run("page", produce, 10 * MINUTE, { maxAgeMs: 5 * MINUTE });
  release();

  assert.equal(await first, "value");
  assert.equal(await second, "value");
  assert.equal(produced, 1, "a bound is a filter on the answer, not a reason to fetch twice");
});

test("both ways of storing an entry date it", async (t) => {
  const cache = createCache();
  const clock = stageClock(t, 1_000_000);

  cache.set("direct", "set", 10 * MINUTE);
  await cache.run("inside-run", async () => "stored", 10 * MINUTE);
  clock.advance(90_000);

  assert.equal(cache.peek("direct")?.ageMs, 90_000, "set() stamps the entry it writes");
  assert.equal(cache.peek("inside-run")?.ageMs, 90_000, "and so does the store inside run()");
});

test("an entry stamped in the future reports age 0, not a negative", (t) => {
  // A clock that steps backwards (an NTP correction, a suspended machine) would otherwise hand back an
  // age that cannot exist — one that passes every bound and gets printed as a fact about a page.
  const cache = createCache();
  const clock = stageClock(t, 2_000_000);

  cache.set("page", "value", 10 * MINUTE);
  clock.setTo(1_000_000); // an hour behind the stamp it is being read against

  assert.equal(cache.peek("page")?.ageMs, 0, "an age cannot go below the moment it is asked at");
  assert.equal(cache.peek("page", { maxAgeMs: 0 })?.value, undefined, "so it cannot sail through the tightest bound");
});

test("an unbounded get and run behave exactly as they always did", async (t) => {
  // search.ts and resolve.ts pass no bound, and their behaviour is the tripwire for this unit.
  const cache = createCache();
  const clock = stageClock(t, 1_000_000);

  cache.set("page", "value", 10 * MINUTE);
  clock.advance(9 * MINUTE);

  assert.equal(cache.get("page"), "value", "unexpired is still enough for a caller that asked for nothing");

  let produced = 0;
  const out = await cache.run(
    "page",
    async () => {
      produced += 1;
      return "fresh";
    },
    10 * MINUTE,
  );
  assert.equal(produced, 0, "no bound, no second fetch");
  assert.equal(out, "value");
});
