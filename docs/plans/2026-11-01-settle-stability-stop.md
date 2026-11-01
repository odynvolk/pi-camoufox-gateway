# Plan: the settle loop must not claim "still rendering" about a page it saw twice

Branch: `fix/settle-stability-stop-unreachable`
Date: 2026-11-01
Status: executed on `fix/settle-stability-stop-unreachable` — U1–U4, acceptance gate green
Baseline: `fdfd61b` (v0.2.1, 378 tests passing, `tsc --noEmit` clean)
Related: `.context/compound-engineering/findings/2026-10-28T00-10-00-000Z-finding-settle-stalled-at-deadline.md`,
`docs/plans/2026-10-27-google-direct-open-serp.md` (*Known remaining defect*), `src/settle.ts`, `src/engines/settle.ts`

## Problem

`camoufox_search` on an ordinary query comes back `empty_results` with:

> google's results page was still rendering when the 600ms wait ran out, so it is not known whether it had
> results

while the loop's own `samePage` comparison had already found its two frames **byte-identical**. Measured on
the live gateway at **~10.9 s** — two `/snapshot` calls of ~5 s each — and reproduced offline on
`tests/fixtures/serp-no-results.txt` with `snapshotHangsForMs`
(`.context/measure-stalled-at-deadline.mjs`, table in the finding above). Reproduced on a real query, not
only a nonsense one: `camoufox_search("why does consent.google.com keep appearing", engine: google)` at
1,242 ms with `details.stalledAtDeadline: true`.

The tool tells the model a page was still arriving when the evidence in hand said it had stopped. It also
reports the same unsupported fact as data, under `stalledAtDeadline`.

## Root cause (three facts that only hold together badly)

1. `src/settle.ts` → `STABLE_ROUNDS` is 2, and `samePage` compares each new frame with its **predecessor**,
   so the stability stop needs **three** looks, not two.
2. The loop's `while (Date.now() < deadline)` test runs **before** the sleep and the request, and `startedAt`
   is taken after the first look — so request time is never inside the budget.
3. `stalledAtDeadline` starts `true` and is cleared **only** by the `break`.

Together: the `break` is reachable only if a `/snapshot` answers in under ~450 ms. On this gateway a
`/snapshot` costs **seconds**. Above that latency the stability stop is *unreachable by construction*, the
budget expires with the flag still at its initial value, and `undecidedVerdict` (`src/engines/settle.ts`)
turns it into a claim about a page the loop had already seen answer identically twice.

## The claim this breaks

`undecidedVerdict`'s own justification is the thing that is false:

> the loop only reaches its deadline while another look is still wanted, and a page that had answered stable
> and empty already stopped it

That premise is sound reasoning about a stop the code cannot actually reach. Fix the reachability and the
claim becomes true again — which is why the fix belongs in the loop, not in the message. The message is
correct for the case it was written for, and `tests/session.test.mjs` → `"a page still growing when the
budget runs out gets the budget named"` pins that case: a page that is *genuinely* still growing must keep
reporting `stalledAtDeadline: true` and keep being offered `raise read.waitForSettleMs`.

## Decision 1 — the stop becomes reachable, only when it has to be

Stop on the first identical pair **when the budget can no longer admit another look**; keep requiring the
second comparison while it can.

```ts
if (
  unchanged >= STABLE_ROUNDS
  || !options.worthLookingAgain(next)
  // The stop we could not reach: we hold an identical pair, and the request that produced it is what spent
  // the budget, so demanding a third look is demanding something this call cannot do.
  || (unchanged >= 1 && Date.now() >= deadline)
) { stalledAtDeadline = false; break; }
```

Rejected alternatives, and why:

- **`STABLE_ROUNDS = 1` outright.** Gives up the "one repeat is a slow script, two is a finished page"
  guarantee on fast gateways too, where the third look costs milliseconds and is already paid for.
- **Leave the loop, raise the budgets.** Three looks at ~5 s each is ~15 s per engine, and the lie stays
  reachable for any snapshot slower than the new number. It treats a symptom whose cause is a stop condition
  that no latency can satisfy.

What this changes for each caller:

| snapshot cost | looks today | looks after | verdict today | verdict after |
| --- | --- | --- | --- | --- |
| 0–400 ms | 3 | 3 (unchanged) | honest | honest |
| ≥ ~450 ms | 2 | 2 | "still rendering … not known" ❌ | the classifier's own verdict ✅ |
| page genuinely growing | 2–3 | 2–3 | stalled ✅ | stalled ✅ (unchanged stays 0) |

`read` gets the same machine, so a thin page on a slow gateway stops after the second look instead of
claiming patience it never spent — and `extension.ts` → `raise read.waitForSettleMs` fires only when a bigger
budget could actually have changed the answer.

## Decision 2 — `SEARCH_SETTLE_MS` goes to 1 500 ms, still not a config key

600 ms was justified against snapshots costing milliseconds ("measured at 606 ms where the same gateway took
1 173 ms"); at a real ~5 s per `/snapshot` the number was never the thing deciding the outcome anyway. 1 500
ms gives the second look room to be issued deliberately rather than by accident of the deadline test
happening before the request.

The documented no-knob rationale stands: search runs a chain, and a knob here is a way to put a document's
patience on the critical path of every search.

**Cost must be accounted, not assumed.** The budget is not a cap — the worst case remains *deadline plus one
request*, as the loop's own comment says — so one engine can now spend 1 500 ms + one snapshot, and the chain
pays that per engine. `src/engines/chain.ts` carries one wall-clock budget of two request deadlines; U3
asserts the raised settle still fits inside it rather than trusting the arithmetic.

## Implementation units

Each unit is TDD-gated: failing test first, minimal code, green, one conventional commit.

### U1 — the identical pair is a stop when the budget is spent

- `tests/settle` coverage in `tests/engines.test.mjs` (and the read analogue in `tests/session.test.mjs`),
  driven by `tests/helpers/fake_gateway.mjs` → `snapshotHangsForMs` on `serp-no-results.txt`.
- Assert: the case that today yields `stalledAtDeadline: true` yields `false`, the message is
  `google returned no organic results for that query`, and **the number of `/snapshot` calls is asserted,
  not described** (repo convention: a cost the loop pays is a cost a test names).
- Pin the no-regression case in the same commit: at ~0 ms snapshots the loop still takes
  `STABLE_ROUNDS + 1` looks.
- `src/settle.ts` — the clause above, with the comment stating *why the third look was unreachable*, since
  that is the defect a future reader will otherwise re-file.

### U2 — the claim follows the evidence

- `src/engines/settle.ts` → `undecidedVerdict`: restate the doc comment so its premise names the new stop
  (it is now true, but only because U1 made it true — say so, and name the edit that would break it again).
- `tests/engines.test.mjs` — the invariant `serpWorthAnotherLook` and `classifySerp` stay one rule must
  still hold across every recorded page; extend it to the overspent-budget frame.
- Read side: a thin-but-stable page must produce
  `stopped growing there, so it is thin rather than unfinished` and must **not** offer
  `raise read.waitForSettleMs` — the mirror of the pin in `tests/session.test.mjs` →
  `"a page still growing when the budget runs out gets the budget named"`, which stays green untouched.

### U3 — the budget, and where it is documented

- `src/engines/settle.ts` → `SEARCH_SETTLE_MS` = 1 500, with the comment saying what the number is now sized
  for and that it is not a cap.
- Assert the chain still lands inside its single wall-clock budget with the raised per-engine settle, on both
  engines.
- `src/config.ts` → `assertCoherent` documents "the settle loop tests its deadline *before* sleeping"; check
  that sentence still describes the code after U1 and correct it if it drifted.

### U4 — the record

- `CONTEXT.md` → **Settle**: the definition says "re-snapshotting … until it stops growing". Make the stop
  condition state what it now is, including that a stop the budget cannot reach is not a wait.
- `docs/improvements/2026-10-18-code.md` — nothing to add if the finding is closed; if `stalledAtDeadline`
  semantics stay open in any direction, it is recorded there rather than in a commit message.
- Move the finding file's status from `open — reported, deliberately not fixed` to closed, with the fix's
  commit named.

## Out of scope

- **The overshoot itself.** A "1 500 ms" wait can still cost 1 500 ms + one snapshot, because the deadline is
  tested before the request. Truncating the poll request instead would abort the very look that proves
  stability, so the lie comes back dressed as a cap. Deliberately not done here; the code and the comment
  must keep saying it.
- **B.6 / B.8.** Both are blocked on measurement, not code — every predicate tried for B.6 failed its
  false-positive budget. They need live-gateway probing before anyone writes a classifier.
- **`read`'s char threshold** (`read.settleMinChars`) and its predicate. Shared machine, per-caller
  judgement — that split is the design and this fix does not move it.

## Verification

- `NODE_ENV=test npm test` — green, including the pins named above.
- `npm run typecheck` — clean.
- `NODE_ENV=test node .context/measure-stalled-at-deadline.mjs` — the **449 ms and 5 000 ms rows must flip
  from ❌ to ✅** (honest "no organic results", `stalledAtDeadline` unset) while the 0/250/400 ms rows stay ✅
  at 3 looks. That probe is the acceptance gate: it is what the defect was measured with.
- `npm run test:live` against a real gateway, if it is reachable — the same query the finding reproduces on.

## Execution — what actually happened

Twelve commits on `fix/settle-stability-stop-unreachable` (`e726d68`..`cc024e8` for U1–U4, then
`9e4c7cc`..`5548c9f` for the six review findings). **384 tests pass, `tsc --noEmit` clean**, `tests/session.test.mjs` purely additive — both
protected pins untouched.

**Acceptance gate, offline.** Every row of `measure-stalled-at-deadline.mjs` is now honest:

| snapshot cost | looks | `stalledAtDeadline` | verdict |
| --- | --- | --- | --- |
| 0 / 250 / 400 ms | 3 | unset | honest ✅ (unchanged) |
| 449 / 460 / 700 ms | 3 | unset | honest ✅ (was ❌ — the raised budget affords the third look) |
| 5 000 ms | **2** | unset | honest ✅ (was ❌ — the identical pair is the stop) at ~10.4 s, the live case |

**Live, against `camofox-browser` at `192.168.8.110:9377`.** `CAMOUFOX_LIVE=1 npm run test:live` → 5 pass,
1 skipped (the metadata-endpoint case, skipped by design under `allowPrivateHosts`). The finding's own
query, plus a nonsense one and the chain as shipped, via `.context/verify-settle-live.mjs`: **no query
reports a stall it did not earn**, and the finding's query now returns 10 results through the chain.

One gate-design note earned the hard way: that probe first *passed while measuring nothing*, because
`createGatewayClient` binds `globalThis.fetch` at construction (`src/gateway.ts` → `this.fetchImpl`) and a
counter installed afterwards never fires. The probe now takes `fetchImpl` and fails a row that reports zero
snapshots — a row that observes nothing must not be able to report ✅.

## Found while verifying, not caused by this branch

Pinning `engine: "google"` against the live gateway now fails on every query tried, while the shipped chain
recovers by hopping to DuckDuckGo — so Google is currently a fallback rather than an engine:

- three queries, `code=consent_wall`, 1–2 snapshots each;
- a direct re-open of the same results url minutes later: **238 chars, 1 ref, 0 organics, and
  `detectWall` returns `null`** — so the same destination arrives sometimes as a named wall and sometimes as
  a thin page that is not one.

That is open-question 3 in `docs/improvements/2026-10-18-functionality.md` ("what is the observed real-world
rate of each failure code?") answering itself, and it belongs to the wall-classification line of work, not
here: this branch changes no wall or classification path. Recorded here rather than fixed, and the fix for
this branch's own defect does not depend on the answer.

## Execution

U1–U4 landed as four commits on this branch, each green before the next. Two things worth recording.

The read-side thin-but-stable case (`tests/session.test.mjs` → `"a thin page that answered stable at a slow
gateway is thin, not unfinished"`) is the failing test that drove U1's clause, so it is in U1's commit and
not in U2 — writing U1 without it would have meant writing the loop against one caller's test. The pin named
under U2 (the overspent-budget frame across every recording) is comment-era work and is green on arrival; it
was checked for teeth instead, by raising the new clause's `unchanged >= 1` to `STABLE_ROUNDS` and watching
both it and the engine case fail.

`SEARCH_CHAIN_BUDGET_IN_DEADLINES` stayed at 2. The raised settle had to fit inside the chain's one
wall-clock budget, not the other way round, and the new chain case asserts that fit rather than moving the
bound.

Acceptance: every probe row honest with `stalledAtDeadline` unset and `tabsLeftOpen=0`; the 0 ms row still 3
looks; 383 tests passing; `tsc --noEmit` clean. Not run: `npm run test:live` — no gateway was reachable from
the implementation environment, so the live half of Verification is still open.
