---
title: A gate that the fix disarms is not a gate — re-arm the instrument before closing the hole
category: testing
severity: high
tags: [instrument, guard, self-probe, proof-of-life, vacuous-assertion, measurement, reachability, test-double, counts, false-confidence]
applies_when:
  - a measurement gate refuses a run until some evidence appears, and a planned fix could remove that evidence
  - an instrument probes itself to prove it is not blind
  - a probe read shares a namespace with the reads it measures, and classification matches on one field
  - a health figure reads as the same fraction on every run of every tree
  - a committed count is about to move from nonzero to zero
---

# Problem

`docs/improvements/2026-10-18-code.md` → G.6: the fake gateway answers any url with a page, and one `- link`
line in that page was enough for `parseSerp` to credit an engine with organic results it never earned. The plan
was: register a real page for the 11 cases reading the invention as results, then delete the link. Both moves
were gated by `scripts/measure-unregistered-pages.mjs`, and three separate defects in that gate had to be found
before the fix could land at all.

1. **The guard was keyed on a case the fix removes.** `assertSawTheKnownCase` refused any run where
   `duckduckgo navigates straight to its query url` did not appear among the invented reads. That case is one of
   the 11. Registering its page — the whole fix — would have made the instrument throw on the exact run where
   the hole closed, and a gate that refuses good news is not a gate.
2. **A self-probe that reports into the measured namespace makes the good value unreachable.** The replacement
   proof-of-life had the recorder read a page at an engine's own results url. `classify` matches on the url
   alone, so flushing that read into the case list credits the run with an engine results read at the probe's own
   url: `read it as an engine's results page: 0` becomes arithmetically impossible, and no amount of fixing can
   produce it.
3. **A proof-of-life denominator may not include states that can never satisfy it.** The first shipped version
   printed `probe: 19 of 38 engine urls it read for itself were inventions`, on every run, forever. Each child
   probes one url per derived engine prefix, and `tests/helpers/fake_gateway.mjs` answers google's prefix from
   `url.includes("google.com/search")` — so half of every run is `registered` by construction. A figure that
   reads as a permanent 50% failure is a figure people stop reading.

The order was forced by defect 2, not chosen: `classify` matches on url, so re-arm the instrument, *then*
register, *then* delete the link. Any other order lands either a red suite or a green suite that can no longer
measure the thing it fixed.

# Context

The figures this branch publishes, each restated in a fixture, the ledger, and the script header:

```
cases in the suite:                   478, all passing
read the fake's invented page:        53 of 478
read it as an engine's results page:  0 of 478
```

`11 → 0` on the third line is the point of the work, and none of it was publishable while the gate could not
reach 0. Three definitions of "invented page" were tried before the right one, and each printed a different
wrong number (35, 40, 17) — the reason the question is asked of the fake rather than answered inside the script.

# Solution

**Ask the guard about the instrument, never about a case.** `assertSawTheKnownCase(probes, prefixes)` now grades
the recorder's own probe: it reads one page per derived engine prefix through the fake and reports whether it
recognised the invention. What it requires is one recognised read across the run — not a quota per child, since a
child whose own fixture answers first says nothing about the instrument. No probe, or one it cannot recognise,
and the run is refused rather than published.

**Give probe output its own namespace.** `PROBE_PREFIX` is a line `parseReport` cannot match, precisely because
the probe's url *is* an engine's results url. Pin the invisibility, don't assume it: the case
`the recorder's probe is flushed where no denominator can read it` is what fails if the prefixes ever collide.

**State health over what can satisfy it, and name the rest.** `probeFigures` counts reads only at prefixes where
an invention is reachable and prints the exception rather than averaging it in:

```
probe:  19 of 19 engine urls it read for itself were inventions — asked 2 prefixes;
https://www.google.com/search?q= is answered by the fake as its own page, so an invention is not reachable there
```

**Make the good value reachable on demand, and prove it.** `tests/instrument-rig.mjs` is a suite the instrument
runs against a scratch copy of itself, shaped by `CAMOUFOX_MEASURE_RIG_REGISTER`, so both states exist to order:
a case reading an engine's results page that nobody registered (the count must be 1), and the same case with that
page registered (the count must be 0, and the run must publish rather than throw).

# Why this works

A zero and a closed hole print identically; the only thing separating them is evidence that the instrument could
still have seen the thing it did not see. Any precondition drawn from the *bug's* current witnesses inherits the
bug's lifetime — the fix deletes the witnesses, and the gate then certifies nothing, or worse, blocks the fix. A
precondition drawn from the instrument's own behaviour survives, because the instrument is not what gets fixed.

Url-only classification is the specific trap here: a probe designed to look like a real read is indistinguishable
from one to anything matching on url. Excluding it by name does not work either, because the name is the thing
under test. A separate marker namespace is the only exclusion that survives both.

And a denominator is a claim about what could have happened. Include states that could not, and the healthy state
looks broken — which is the same failure mode as an unreadable log line, just with more authority attached.

# Prevention

- Before a unit that moves a committed figure to zero, name the run that must produce the zero and the run that
  must produce a nonzero. If neither can be produced on demand, the figure is not pinned — build the rig first
  (U1 here, and `tests/instrument-rig.mjs` is its artifact).
- Audit reachability of a *good* value the way `docs/solutions/timing/settle-stop-must-be-reachable.md` audits a
  loop's exit: not "can this terminate", but "can it terminate in the state we intend to publish".
- Mutation-test the gate, not just the feature. Deleting the throw in `assertSawTheKnownCase` must redden exactly
  the gate's case; reverting `probeFigures` to count every asked prefix reddens one case
  (`a case that registers the engine's own results page takes that count to zero, and the zero publishes`).
- If a guard's condition mentions a test name, treat it as a defect report: a case is exactly what a fix changes.
- Register fixture pages at urls derived by running the adapter (`tests/helpers/engine_page.mjs` →
  `engineResultsUrl`), never pasted — the sibling failure in
  `docs/solutions/architecture/derived-field-must-be-written-with-its-source.md`. A pasted results url keeps
  matching after the adapter moves, so the case still serves its page and still believes it registered one.
- Related reading: `docs/adr/0003-the-fakes-invented-page-cannot-pass-as-a-result-set.md` (the decision and the
  rejected alternatives), `docs/solutions/testing/committed-measurement-must-be-pinned-to-a-run.md` (where the
  figures come from), G.6 and G.7 in `docs/improvements/2026-10-18-code.md`.
