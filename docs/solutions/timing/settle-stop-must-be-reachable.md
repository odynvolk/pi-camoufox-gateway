---
title: A stop condition the budget cannot reach is not a stop — make every exit reachable at measured latency
category: timing
severity: high
tags: [polling, deadline, timeout, settle, snapshot, state-machine, error-attribution, camoufox]
applies_when:
  - writing a loop that re-polls until a page, job, or stream "stops changing"
  - a flag is initialised to its bad value and cleared only by a break
  - a budget is compared against the clock before an await rather than after it
  - a timeout-or-stall message reaches a model or a log line
---

# Problem

`camoufox_search` on an ordinary query returned `empty_results` with:

> google's results page was still rendering when the 600ms wait ran out, so it is not known whether it had
> results

while the loop's own `samePage` comparison had already found its two frames **byte-identical**. ~10.9 s on
the live gateway. The tool told the model a page was still arriving when the evidence in hand said it had
stopped, and reported the same unsupported fact as data under `stalledAtDeadline`.

# Context

`src/settle.ts` → `snapshotSettled` re-snapshots a page until it stops growing. Three facts, each defensible
alone, unreachable in combination:

1. `STABLE_ROUNDS = 2`, and `samePage` compares each frame with its **predecessor** — so the stability stop
   needs **three** looks, not two.
2. `while (Date.now() < deadline)` is tested **before** the sleep and the request, so request time is never
   inside the budget.
3. `stalledAtDeadline` starts `true` and is cleared **only** by the `break`.

So the `break` required a `/snapshot` to answer in under ~450 ms. On this gateway a `/snapshot` costs
**seconds**. Above that latency the stop is unreachable by construction: the budget expires with the flag at
its initial value, and the caller reads that as "still rendering".

Measured, offline, on a byte-identical recording (`tests/fixtures/serp-no-results.txt`, `snapshotHangsForMs`
on the fake gateway) — the row that matters is 449 ms, where a "600 ms" wait reported a stable page as
arriving:

| one `/snapshot` costs | looks | `stalledAtDeadline` | message |
| --- | --- | --- | --- |
| 0 / 250 / 400 ms | 3 | unset | honest ✅ |
| **449 / 460 / 700 / 5 000 ms** | **2** | **true** | **"still rendering … not known whether it had results"** ❌ |

# Solution

**Ask how many iterations the budget can actually afford, at the latency the dependency really has.** A stop
that needs three round trips cannot live in a budget that funds one.

Two changes, neither of which is "raise the timeout":

1. **Make the stop reachable, but only when it has to be.** Stop on the first identical pair *when the budget
   can no longer admit another look*; keep demanding the second comparison while it can. Fast dependencies
   pay exactly what they paid before, slow ones get the right answer instead of a lie.

   ```ts
   let expired = Date.now() >= deadline;
   while (!expired) {
     await delay(Math.min(pollMs, deadline - Date.now()), signal);
     const next = await client.snapshot(...);
     unchanged = samePage(next, latest) ? unchanged + 1 : 0;
     latest = next;
     expired = Date.now() >= deadline;                        // one reading, consumed by both decisions
     if (unchanged >= STABLE_ROUNDS || !worthLookingAgain(next) || (unchanged >= 1 && expired)) {
       stalledAtDeadline = false;
       break;
     }
   }
   ```

2. **Do not bound the poll request by the remaining budget.** The tempting "make the budget a real cap" fix
   aborts the very request that would have proved stability, and the lie comes back dressed as a correctness
   win. Keep the honest overshoot and say so: the worst case is the deadline plus one request.

Rejected: setting `STABLE_ROUNDS = 1` (weakens fast dependencies where the extra look is free), and raising
the budgets until three looks fit (~15 s per engine, and the lie stays reachable for anything slower than
the new number).

# Evidence

The invariant is closed by structure, not by latency luck. Falling out of `while (!expired)` with the flag
set requires the `if` to have been false, which by short-circuit order means `worthLookingAgain(next)`
returned true **and** `unchanged === 0` — no identical pair in hand. Proven by exhaustion over exit paths,
then confirmed by mutation:

- loop top reverted to a fresh `Date.now()` read → the regression test goes **red** on the flag alone.
- the entire pre-fix file restored → **red** on that one assertion, with its three premise assertions
  passing. So the test measures the loop, not its own fixtures.
- the stop clause given its own independent read → **green**, correctly: reads are monotone within an
  iteration, so a later read can only fire the stop sooner. That is why the wording is "one reading, shared"
  and why no `Date.now()` call-count assertion exists.

Acceptance after the fix: every latency row honest, 3 looks at 0 ms, 2 at 5 000 ms, zero leaked tabs.

# Prevention

- **A flag initialised to its bad value must have an exit for every way the loop can end.** Enumerate the
  exits and ask, for each, what the flag says. Two independent review rounds were needed to catch the second
  one here — the first review passed the version where the stop clause and the loop exit each read the clock.
- **Never let two decisions read the same clock independently.** One reading, shared, is the fix; the bug was
  ~10⁻⁴ per wait in natural frequency and invisible to every test until the clock was pinned.
- **Measure the dependency's real cost before sizing a budget against it.** This budget was justified in a
  comment as small *relative to snapshots costing milliseconds*, against a gateway where they cost seconds.
  A comment that reasons about a latency the system does not have is how a wrong constant survives review.
- **Pin the number of requests, not just the outcome.** "2 snapshots at a slow gateway, 3 at a fast one" is
  the assertion that would have shown the unreachable stop years ago. Assert from the premise too — a loop
  whose driving url is also its oracle passes happily when half its rows are refused before they start.
