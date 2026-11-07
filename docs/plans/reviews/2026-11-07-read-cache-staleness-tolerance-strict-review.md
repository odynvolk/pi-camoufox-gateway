# Strict Review — `maxAgeMs` plan (2026-11-07)

Plan: `docs/plans/2026-11-07-read-cache-staleness-tolerance.md` · Mode: **Strict** (CEO steps 1–4 + error/rescue
map, failure modes, test diagram) · Reviewer: pi, against `8bed93a`.

**Outcome: three gaps found and folded into the plan (R1–R3 below), one honest limitation added as a stated
limit (R4), and one cheaper alternative (A) recorded as contained rather than competing.** No unit was
dropped and none was added.

## 1. Premise challenge

| Premise | Verdict |
| --- | --- |
| The model has a use for a staleness tolerance | **Unprovable from inside this repo.** There is no usage data at all — ledger open question #3 says outright that nothing collects the real-world rate of any failure code, and open question #2 asks whether `resolve: true` is "an escape hatch nobody reaches". A shipped tool parameter with no measurement behind its adoption is a documented guess. |
| The pain is real without the parameter | **Yes, independent of the parameter.** A model that cannot see a page's age cannot decide whether to ask for `fresh`. That is fixed by the age note alone, which the plan already ships (decision 5). This is what makes the plan worth doing even under the premise above. |
| Doing nothing is fine | Mostly. Nothing breaks; a call either pays a navigation or takes whatever age the cache holds. The pain is cost and turn count, not correctness — which is why this is a 4-unit plan and not a 12-unit one. |
| The cache is long-lived enough for a tolerance to mean anything | **Only within one pi session.** F.2 in the code ledger is explicit: `### F.2 Cache is per-pi-session — nothing shared, nothing surviving a restart`, and the cache is an in-process `Map` created per session in `src/camoufox-gateway.ts` → `cache: createCache()`. A tolerance longer than the session is inert. → **R4**, stated rather than left a surprise. |
| Is this the most direct path to the outcome | **A is more direct for half the value** — see §3. |

## 2. Dream state mapping

```
CURRENT STATE                     THIS PLAN                          12-MONTH IDEAL
two tools, two knobs each.        read gains a per-call            read is a budget-aware fetcher:
read's only freshness answer      staleness tolerance; the         region scoping (1.2), content-type
is a boolean; "how old is         cache finally reports its        awareness (2.3), multi-url reads
this text?" is unanswerable       own age on every hit.            (2.5), search-with-content (1.1),
by anyone.                                                     and freshness as one concept shared
                                                               by read and search (2.6's SERP half).
```

Aligned: the functionality ledger's own thesis is *"the highest-leverage direction is not new capability.
It is output-shape control — let the model ask for less, and the right thing, per call."* This plan is that
thesis with one knob, on the tool that has the most chrome to trim. The `ReadBound` accessor is deliberately
generic so the SERP half inherits it without a second design — that is the piece that makes it a step rather
than a spike.

## 3. Implementation alternatives

```
APPROACH A: Say how old it is, and stop there
  Summary: ship U1's storedAt + age reporting and the always-on age note, but no `maxAgeMs` parameter.
           The model reads the age and decides about `fresh` itself.
  Effort:  S   Risk: Low
  Pros:    - Every read benefits whether or not any caller ever discovers the parameter — immune to the
             `resolve: true` failure mode in premise #1.
           - No new argument surface: the param-key-list test, the numeric-description gate and the
             README signature line all stay untouched.
           - Still forces the one genuinely new thing (the cache cannot currently date its own entries).
  Cons:    - Cannot express "I accept an hour old" — the model must either navigate or accept what it gets.
           - Leaves item 2.6 open, so the ledger keeps an item whose premise the next reader re-litigates.
  Reuses:  opens(fake), the Date.now stub idiom, the renderRead note block.

APPROACH B: The plan as written  (age reported + `maxAgeMs` bound)      ← RECOMMENDED
  Summary: U1–U4 as planned. The bound is applied in the cache's read path, non-destructively.
  Effort:  M   Risk: Low–Med (one shared file, `src/cache.ts`, gains a rule)
  Pros:    - Contains A entirely: decision 5 already prints the age on every hit, so A's immunity is kept.
           - Closes 2.6 as written, and files the SERP half instead of silently widening scope.
           - `ReadBound` is generic, so search adopts the same concept later with no redesign.
  Cons:    - A third parameter on a tool that is deliberately small; if nobody passes it, it is documentation
             nobody reads — mitigated, not eliminated, by A's always-on age note.
           - Touches the cache, which every tool shares. Mitigated by making the bound optional so
             `search.ts`/`resolve.ts` are provably unaffected.
  Reuses:  liveness.ts's absolute-stamp-and-compare; isCountUsable; assertOffsetUsable's shape; the
           single-flight `run`; the `cappedAt` note as the template for "name which limit did it".

APPROACH C: Freshness as a first-class concept, both tools at once
  Summary: `ReadBound` plus `fresh` on search plus `maxAgeMs` on both, one shared vocabulary.
  Effort:  L   Risk: Med
  Pros:    - The pair is complete on both tools in one round; no follow-up item left standing.
           - One vocabulary entry in CONTEXT.md instead of a plan-time note.
  Cons:    - Violates the scope discipline the plan already states: search today has no `fresh`, so this
             ships two new knobs on a tool nobody asked to change.
           - Doubles the surface under review, including the engine chain's caching — where the failure
             classes are timing, not staleness, and are where this repo's most expensive bugs have lived.
  Reuses:  cache.get/run in search.ts, the chain's existing `fromCache`.
```

**Recommendation: B.** A is not a competing option, it is a subset — decision 5 already ships it — so the
only real question is whether the bound is worth one parameter, and item 2.6 exists because the answer is yes.
C is declined for the reason the ledger gives about every tempting addition: two new knobs on a tool the
user did not ask about is scope corruption, and it drags the engine chain into a cache change.

## 4. Temporal interrogation

**Hour 1 (foundations).** The implementer must know: the bound is **optional** on `get`/`peek`/`run` —
`search.ts` and `resolve.ts` keep compiling and keep behaving identically, and their tests are the tripwire.
`peek` is added to the `Cache` interface (it is the only reader that can report age); `get` delegates.

**Hour 2–3 (core logic).** Ambiguities, all resolved here rather than at the keyboard:
- **`params.maxAgeMs` must never be tested for truthiness** — `0` is legal and falsy. → **R2.**
- The bound must reach `run`, not just `get`. Not stylistic; see U2's `maxAgeMs: 0` case.
- `ageMs` of a value served from inside `run` is unknowable per call → no `fromCache`, no age claim.
- Naming settled so it is not invented under pressure: `pageAgeMs`, `staleSkippedMs`.
- The age sentence goes **inside** the existing `fromCache` note, not as a fifth note.

**Hour 4–5 (integration).** What will surprise them:
- `tests/camoufox-gateway.test.mjs` asserts the exact param-key list, and that a numeric param's description
  states its floor and contains `unsupported` while *not* interpolating a `DEFAULT_CONFIG` number.
- The suite count is a committed number in three files; `npm run test:measure` reconciles them and the
  numbers are re-measured, never hand-edited.
- `tests/improvement-refs.test.mjs` greps every `` `path` → `fragment` `` anchor in the rewritten 2.6.

**Hour 6+ (polish).** They will wish they had planned for: the negative-age case (→ **R1**), the
"re-fetch failed, was the stale page still there" case (→ **R3**), and `Date.now` stub hygiene — a leaked
stub silently makes every TTL assertion in `tests/cache.test.mjs` lie.

## 5. Error and rescue map

| Method / codepath | What can go wrong | Exception class | Rescued? | Rescue action | User sees |
| --- | --- | --- | --- | --- | --- |
| `assertMaxAgeUsable` | `"1,000"`, `1.5`, `-1`, `NaN`, `Infinity`, `{}` | `GatewayError("unsupported")` | Y | throws before any navigation or cache read | refuses, naming the argument |
| `assertMaxAgeUsable` | `maxAgeMs: 0` mistaken for absent by a truthiness test | silent | **N → R1/R2** | — | navigates or not, by accident (**GAP → fixed by R2**) |
| pair guard | `fresh: true` + `maxAgeMs` | `GatewayError("unsupported")` | Y | refuses, naming which to drop | an actionable sentence |
| pair guard | `fresh: false` + `maxAgeMs` refused too | silent over-refusal | Y (by test) | refuse only on `params.fresh === true` | a working call |
| `Cache.peek` | clock steps backwards → `storedAt > now` → negative `ageMs` | none (silent) | **N** | **clamp `Math.max(0, …)` → R1** | an age that cannot be negative |
| `Cache.peek` | bound rejects the only entry | none | Y | skip, leave in place, navigate | a fresh page; the drop note |
| `Cache.run` bound forgotten | tolerance betrayed by the internal hit | silent | Y (by test) | U2's `maxAgeMs: 0` case pins it | — |
| re-fetch after a skip | gateway down → `navigate` throws | `GatewayError("gateway_unreachable"…)` | Y | entry was never deleted, so a later looser read still gets it (**R3** asserts this) | the usual gateway error, **and the stale page survives** |
| `describeAge` | non-finite input | unreachable — validated upstream | Y | `isCountUsable` gate precedes it | — |
| `readResult` / `ReadOutputSchema` | new field not declared | `assertDeclaredBy` fails | Y | test fails in CI | — |

## 6. Failure modes registry

| Codepath | Failure mode | Rescued? | Test? | User sees | Logged? |
| --- | --- | --- | --- | --- | --- |
| `assertMaxAgeUsable` | unusable number | Y | Y | `unsupported` | n/a |
| pair guard | both knobs passed | Y | Y | refusal naming one to drop | n/a |
| `maxAgeMs: 0` | treated as absent | **R2** | Y (added) | wrong freshness claim | n/a |
| `peek` | negative age | **R1** | Y (added) | wrong age in the note | n/a |
| `peek` | over tolerance | Y | Y | drop note + re-fetch | n/a |
| `run` | bound not applied | Y | Y (U2) | — | n/a |
| skip + failed re-fetch | stale page lost | **R3** | Y (added) | gateway error | n/a |
| hit shared via `run` | age claimed without evidence | Y | Y (U3) | no age sentence | n/a |
| hit after policy narrowed | guard bypassed | Y | Y (U2) | `blockedHosts` refusal | n/a |
| `describeAge` | unreadable ms | Y | Y (U3) | `900ms` / `240s` | n/a |
| search/resolve cache use | behaviour drift from an optional param | Y | Y (existing suites) | — | n/a |

**No row is RESCUED=N + TEST=N + silent.** The three that were RESCUED=N before this review are the folded
additions.

## 7. Test diagram

| New thing | Happy | Failure | Edge |
| --- | --- | --- | --- |
| `Entry.storedAt` | `peek` reports `ageMs` | — | same-millisecond entry (`ageMs === 0`) |
| `peek` + bound | in-tolerance hit | over-tolerance → `undefined` | **looser reader still gets it after a tight one rejects (R-ADR)** |
| `peek` + clock skew | — | `storedAt` in the future → clamped to 0 (**R1**) | — |
| `run` + bound | producer runs, value stored | — | `maxAgeMs: 0` with a live entry |
| `run` single-flight | one `produce`, two callers | — | both bounded, differing tolerances |
| `assertMaxAgeUsable` | `0` accepted | 7 unusable values | `0` seen as `0`, not absent (**R2**) |
| pair guard | `fresh:false` + `maxAgeMs` works | pair refused | `fresh:false` must not trip it |
| skip then failed re-fetch | — | error surfaces, **entry survives** (**R3**) | a later loose read gets it |
| `pageAgeMs` note | age + tolerance named | navigation claims no age | shared hit claims no age |
| `staleSkippedMs` note | drop is distinguishable from cold cache | absent on cold cache | absent when nothing was stored |
| `ReadSchema.maxAgeMs` | described, `Type.Integer`, floor, `unsupported` | param-key list test | no interpolated `DEFAULT_CONFIG` number |
| `search`/`resolve` | unchanged | — | their suites unchanged |

## Folded into the plan

- **R1** — `ageMs = Math.max(0, Date.now() - storedAt)`, with a clock-backwards test. Without it a negative
  age passes every bound and is printed to the model as a fact about a page nobody can place.
- **R2** — the parameter is tested with `params.maxAgeMs !== undefined`, never truthiness (`0` is legal and
  falsy), and the pair guard fires only on `params.fresh === true`, so `fresh: false` + `maxAgeMs` works.
  One test each.
- **R3** — a test for the ADR's actual payoff: an over-tolerance entry, the forced re-fetch fails, the entry
  is still there and a looser read still gets it. The ADR asserts this property; nothing in the original
  unit list proved it.
- **R4** — the plan states the limit rather than leaving it hidden: the cache is per-pi-session and
  in-process (`### F.2 Cache is per-pi-session`), so a tolerance longer than a session is inert. Said in the
  README, not in code — a refusal there would invent a bound the config does not have.
