/**
 * The clock helper's own contract.
 *
 * Every age assertion in `tests/cache.test.mjs` and every tolerance test trusts this file, so a dial that
 * moves the wrong way is a suite that reports ages it never set — and a stub that silently never moves is
 * a settle loop that never ends. Neither is tested by the tests that depend on it, because both fail in a
 * way those tests cannot see: a rewind still reads as "an old entry", and a freeze still reads as a page
 * that settled.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MAX_CLOCK_READS, stageClock } from "./helpers/clock.mjs";

const MINUTE = 60_000;

test("advance moves on from where the clock got to, not back to the start", (t) => {
  const clock = stageClock(t, 1_000_000);

  clock.advance(4 * MINUTE);
  const afterFirst = Date.now();
  clock.advance(MINUTE);

  // Two `advance` calls must mean the sum of their arguments. Read as `start + ms` the second one lands
  // back at one minute past the start, and a test that turned the clock four minutes and then one more
  // quietly re-dates every entry it was about to read.
  assert.equal(Date.now(), afterFirst + MINUTE, "the second move has to go forward from where the first left us");
  assert.equal(Date.now() - 1_000_000, 5 * MINUTE, "and the two moves add up to where the clock now stands");
});

test("a frozen clock that keeps being read is called out instead of left to hang", (t) => {
  stageClock(t, 1_000_000);

  // Nothing ages this clock, so nothing can end whatever is asking. The ceiling is the helper's own
  // number, asserted through it rather than beside it, so a ceiling someone widened cannot leave this
  // case testing a number nobody uses.
  assert.throws(
    () => {
      for (let read = 0; read <= MAX_CLOCK_READS; read += 1) Date.now();
    },
    (error) => {
      assert.ok(error instanceof Error, "a thrown Error from the helper, not a line printed and forgotten");
      assert.match(error.message, /frozen clock/u, "it names the state the loop is stuck in");
      assert.match(error.message, /src\/settle\.ts/u, "and points at the loop whose deadline can never pass");
      assert.match(error.message, /fake_gateway\.mjs/u, "and at the fake whose clamped script is what stops it today");
      return true;
    },
  );
});
