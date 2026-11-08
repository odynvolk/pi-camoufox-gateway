# The fake answers an unregistered url with a page that cannot pass as a result set

**Status:** accepted (2026-11-08). Decisions 2 and 3 are implemented on `fix/invented-page-not-a-result-set`
(unit U1); decision 1 is what unit U3 changes.

> Requirement: `docs/improvements/2026-10-18-code.md` → G.6 · Plan:
> `docs/plans/archive/2026-11-08-invented-page-not-a-result-set.md`

## Context

`tests/helpers/fake_gateway.mjs` answers any url a test did not register with an invented article. That article
carried exactly one link, to a host neither engine owns, and the organic-versus-chrome judgement is structural —
`hostIsEngineDomain` in `src/snapshot.ts` — so one link was a result set. A test could navigate to an engine,
register nothing, and be handed results; `node scripts/measure-unregistered-pages.mjs` counted 11 such cases.

Fixing the page is easy. Fixing it *honestly* is not, because the instrument that measures the hole measured it
with two predicates that can each break silently — "was this page invented", answered by comparing text against
what the fake invents, and "is this url an engine's results page", answered from the url alone. And because the
proof that the recorder was still running was one named case: `assertSawTheKnownCase` refused to publish a
reading in which `duckduckgo navigates straight to its query url` had not read an invented page. Closing the
hole removes that case's ability to read one, so the instrument would have thrown on exactly the run that proved
the fix worked.

Three forks, each with a rejected alternative that was measured rather than imagined.

## Decision

**1. The invented page keeps its bulk and its ref and loses its link.** It survives, by decision and not by
omission: `read` re-snapshots anything thinner than `read.settleMinChars`, so a thin default page makes every
unrelated read in the suite pay for the settle loop.

Rejected, with its cost: refuse to answer unregistered urls at all. A thin refusal page cost **48** failures, 25
of them pure settle-loop artifact — the cost `defaultSnapshotFor`'s own comment already guards. Refusing only at
engine-results prefixes cost **56**, because `https://www.google.com/search` is *shipped by substring* in this
fake rather than registered, so a prefix-based refusal deletes google's free SERP and takes thirty collateral
cases with it. "Unregistered" and "engine results url" are not the same predicate here. Also rejected: moving
the link onto an engine host — every `read` test depends on this page not being engine chrome.

**2. A published zero requires the recorder to prove it can still see.** Every recorded child reads one page for
itself, at an engine's own results url, and prints whether it recognised it as an invention; what
`assertSawTheKnownCase` requires is one recognised read across the run — a child whose own fixture answers first
proves nothing about the instrument — and it refuses the run without it.

Rejected: leaving the guard keyed on the named case, and accepting a bare 0. That is a gate which passes precisely
when it has stopped measuring — and a count that cannot reach 0 is not a measurement of the hole either. The
probe is flushed under `PROBE_PREFIX`, a line `parseReport` cannot match, because the probe url is an engine's
own results url and `classify` matches on the url alone: one entry in the case list and the count could never
reach 0.

**3. Engine pages are registered at adapter-derived urls, never at a literal.** `engineResultPrefixes()` runs the
shipped adapters and takes the url each opened.

Rejected: pasting `https://duckduckgo.com/?q=` into a fixture. A pasted prefix keeps matching after the engine
moves, and reports the hole as closed while the adapter opens somewhere else now. For the same reason the child
does not derive the probe url itself — the derivation only answers because the parent put a stub on the global to
ask the adapters with, so a child that ran it would record nothing and satisfy its own precondition by accident.

## Consequences

**The fake still invents, and 0 is the goal.** The end state is `read it as an engine's results page: 0`, not `0
read the fake's invented page`: 53 cases read the invented page to assert something else entirely — cache ages,
tab accounting, request shape — and registering a fixture for each would be inventing a page for no reason, the
same defect wearing a different hat. The terminal shape, where an unregistered url answers `""` and
`src/snapshot.ts` says `empty_page`, is filed as its own ledger item rather than implied by this one.

**A zero can now be refused for a good reason.** `--check` and the default mode both throw when no probe read was
recognised as an invention, which is also what happens if the fake ever stops inventing at all. That is the
instrument saying its own job is undone, and it must not be answered by weakening the guard.

**Two figures, two denominators.** `read the fake's invented page` dedupes on file and name,
`read it as an engine's results page` on name alone, and the probe belongs to neither. `tests/measure-unregistered-pages.test.mjs`
pins the asymmetry, because a "simplification" that fuses them would un-grade one counter without a test noticing.
