/**
 * A clock the test turns by hand.
 *
 * `src/cache.ts` reads `Date.now()` in both the read path and `set`, and the settle loop reads its
 * deadline from the same clock — so one saved-and-restored stub dates an entry, ages it, and keeps a
 * minute-scale page age from ever being waited for.
 *
 * Restoration is the harness's job, not the test's: a leaked `Date.now` stub makes every TTL and age
 * assertion in the rest of the file lie.
 *
 * A read under a frozen clock has to ask for a page fat enough to settle on the first snapshot. Where
 * the cache lives inside the extension it cannot be seeded from outside, so the clock is also the only
 * way to date an entry at all.
 */

/** Stub `Date.now` at `start` for the duration of `t`, and hand back the dial. */
export function stageClock(t, start) {
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  return {
    /** Move to `ms` after the start. */
    advance: (ms) => {
      now = start + ms;
    },
    /** Move anywhere, including backwards — which is the case a clock cannot promise not to do. */
    setTo: (ms) => {
      now = ms;
    },
  };
}
