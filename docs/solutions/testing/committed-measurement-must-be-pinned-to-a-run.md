---
title: A committed measurement is not a measurement — pin figures to a run, never to each other
category: testing
severity: high
tags: [metrics, fixtures, self-referential-test, vacuous-assertion, instrument, counts, false-confidence, ci-less]
applies_when:
  - a measured number is committed to the repo (a count, a size, a baseline, a snapshot)
  - that number is restated in a doc, a comment, or a script header
  - a test asserts the copies agree with each other
  - a test asserts a diagnostic "named" something, by searching the whole output
  - the repo has no CI, so the only gate is the suite
---

# Problem

`docs/improvements/2026-10-18-code.md` → G.6 publishes how often the fake gateway answers a url nobody
registered — "47 of 387". The figure lives in three places: a committed fixture, the doc's fenced block, and
the measuring script's own header. A test held them to account:

```ts
assert.deepEqual(fencedBlockStartingWith(doc, "cases in the suite:"), committed, "…");
assert.deepEqual(statedFigures(scriptHeader), [suite.count, invented.count, asResults.count], "…");
```

It looked like a three-way check. It was a three-way echo: **all three compared against the committed
fixture, and nothing compared the fixture against a run.** Measured on 2026-11-02 the suite had 413 cases and
all three places still said 387 — 26 cases of drift, through a published release, with the suite green. The
instrument rewrites its own fixture on every run, so the only way to notice is to run it and look.

The same failure appeared twice more in the same unit:

- the only test that *spawned* the instrument asserted `run.status === 0` — of a probe file, not the suite —
  so it proved the script starts, not that its numbers are true;
- `const named = (output, place) => output.includes(place)` made "the check named this place" true for the
  script's own path, because the failure footer prints `Re-measure with \`node <that path>\``. A positive
  assertion satisfied by the tool's help text.

# Context

Discovered while planning an unrelated fix, because the plan quoted the doc's figure and the script printed a
different one. The repo has no CI, so "the suite is green" is the entire quality signal — which is exactly when
a self-referential gate is most expensive.

# Solution

Separate the three roles the trio had fused together.

1. **The run is the only source of truth.** The script measures; nothing else may *produce* a figure.
2. **A committed figure is a claim.** It gets refreshed, never hand-edited into agreement.
3. **A check mode that cannot grade its own homework.** `--check` measures, **writes nothing**, and exits
   non-zero naming each stale place. Keep write and check behind one flag: `if (write)` was the single guard,
   and a mutation that let the write leak past it reddened exactly the staleness case and no other.

```
npm run test:measure     # measure + refuse; ~15s; not in `npm test` (it runs the suite a second time)
node scripts/…           # measure + commit the fixture; the doc block and header are restated by hand
```

Then make the assertions bite. Prove each one by **breaking the thing it watches**:

| Assertion | Mutation | Result |
| --- | --- | --- |
| `--check` names all three places | filter one place out of the disagreement list | 3 cases red |
| "writes nothing" | let the write leak past `if (write)` | 1 case red — only that one: in the others the fixture is already fresh, so a stray write is byte-identical |
| `named()` is not vacuous | `includes` instead of "path alone on a line" | green — **so `includes` was the bug**, and a trailing-space mutation also stayed green because `.trim()` absorbed it |

# Why this works

A figure that no longer costs anything to maintain has stopped being a measurement and become decoration, and
decoration is copy-editable: the drift was invisible precisely *because* the gate was green. Each of the three
fixes restores a cost — the check refuses until something is re-measured, the writer is one flag away, and an
assertion can only pass for the reason it claims.

# Prevention

- Any committed figure needs an owner command that can **fail on a fresh measurement**, not just on
  disagreement between copies. If it can only fail when two files disagree, it is a formatter, not a gate.
- Prefer one place that states a figure and pointers everywhere else, over N places plus an agreement test.
- Never assert a substring of a whole diagnostic dump. Match the structure the check emits (a line that *is*
  the path), and ask what else in that output contains the string — the footer, a help line, a filename.
- `02-plan`: adding test cases moves a committed denominator. Schedule the re-measure **in the same unit**, or
  the unit lands with a stale published number.
- `04-review`: for every pin, name the mutation that would turn it red. An assertion you cannot break is
  asserting nothing — say so rather than crediting it.
