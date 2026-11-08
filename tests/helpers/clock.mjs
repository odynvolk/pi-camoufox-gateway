/**
 * A clock the test turns by hand — and a read count that fails when the hand stops turning.
 *
 * `src/cache.ts` reads `Date.now()` in both the read path and `set`, and the settle loop reads its deadline
 * from the same clock — so one saved-and-restored stub dates an entry, ages it, and keeps a minute-scale
 * page age from ever being waited for.
 *
 * Two things are enforced here rather than left to care. `advance` is cumulative, so a second move ages
 * the clock instead of rewinding it; only `setTo` may travel backwards, which is the case a clock cannot
 * promise not to happen. And a test that keeps asking this clock whether it is time throws at
 * `MAX_CLOCK_READS`: reads only pile up when nothing is ageing, and a loop driven by them never ends. The
 * shape that does it is `src/settle.ts` → `while (!expired)`, which asks this clock `Date.now() >= deadline`
 * — under a frozen `now` the deadline is unreachable, so the only exits left are `unchanged >= STABLE_ROUNDS`
 * and `!options.worthLookingAgain(next)`. The first fires today solely because
 * `tests/helpers/fake_gateway.mjs` → `const index = Math.min(tab.snapshotCalls ?? 0, script.length - 1)`
 * sticks on the last scripted frame; a script that cycled instead of clamping would hang, never fail.
 *
 * Measured across the whole suite, the busiest test that is not proving this guard reads the clock 13 times.
 * The ceiling is 50 — roughly four times that, enough for a settle loop under a staged clock (about two
 * reads per poll) to finish on stability, low enough that a looping test dies in milliseconds instead of
 * never. The price is that a test driving a loop by advancing inside it must stay under that many reads too;
 * that is the same count, so it is the point rather than an exception.
 *
 * What the freeze costs quietly, and why nothing asserts it: `src/settle.ts` → `settledInMs: Date.now() -
 * startedAt` is `0` here, so any positive assertion on that number would be vacuous. None exists today.
 *
 * The two reasons to still reach for this helper: a read under a frozen clock wants a page fat enough to
 * settle on the first snapshot, and where the cache lives inside the extension it cannot be seeded from
 * outside, so the clock is also the only way to date an entry at all.
 *
 * Restoration is the harness's job, not the test's: a leaked `Date.now` stub makes every TTL and age
 * assertion in the rest of the file lie.
 */

/**
 * How many reads one staged clock will answer before it refuses.
 *
 * Exported so the test that proves this fires uses the same number, instead of a copy that can drift away
 * from it and start asserting a ceiling nobody enforces.
 */
export const MAX_CLOCK_READS = 50;

/** Stub `Date.now` at `start` for the duration of `t`, and hand back the dial. */
export function stageClock(t, start) {
  const realNow = Date.now;
  let now = start;
  let reads = 0;
  Date.now = () => {
    reads += 1;
    if (reads > MAX_CLOCK_READS) {
      throw new Error(
        `stageClock: this frozen clock was read ${MAX_CLOCK_READS} times by one test — that is a loop`
          + " waiting on a clock nobody is turning. The usual shape is `src/settle.ts`: it asks this clock"
          + " `Date.now() >= deadline`, and a clock that does not move cannot reach one. Its only exits then"
          + " are `unchanged >= STABLE_ROUNDS` and `worthLookingAgain`, and the stability one works today"
          + " only because `tests/helpers/fake_gateway.mjs` clamps a scripted page to its last entry — a page"
          + " that kept changing here would hang the test instead of failing it. Age the clock with"
          + " `clock.advance(ms)` where the loop turns, or leave it unstaged.",
      );
    }
    return now;
  };
  t.after(() => {
    Date.now = realNow;
  });
  return {
    /** Move `ms` further on from where the clock stands now — cumulative, never a rewind. */
    advance: (ms) => {
      now += ms;
    },
    /** Move anywhere, including backwards — which is the case a clock cannot promise not to do. */
    setTo: (ms) => {
      now = ms;
    },
  };
}
