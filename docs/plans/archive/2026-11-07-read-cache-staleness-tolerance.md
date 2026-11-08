# Plan: `camoufox_read` gets a staleness tolerance — `maxAgeMs`

> Status: done

Branch: `feat/read-cache-staleness-tolerance`
Date: 2026-11-07
Baseline: `8bed93a` (v0.2.2, 426 tests passing, `tsc --noEmit` clean, `npm run test:measure` exit 0)
Requirements: `docs/brainstorms/2026-11-07-read-cache-staleness-tolerance.md` (approved)
Upstream item: `docs/improvements/2026-10-18-functionality.md` → `### 2.6 Say how stale is acceptable, not whether to refresh`
Review: **strict** — `docs/plans/reviews/2026-11-07-read-cache-staleness-tolerance-strict-review.md`. No unit
added or dropped; four findings folded in below as **R1–R4** (three of them silent-failure gaps), and the
cheaper alternative (report the age, ship no parameter) recorded as a *subset* of this plan rather than a
competitor — decision 5 already ships it.

## Problem summary

`camoufox_read` has one freshness knob, `fresh: true`, which answers **now or not**. Research asks the
other question — *how much staleness is acceptable* — and a boolean cannot say it. 30 minutes of page age
is the right answer to a survey question and the wrong answer to "what's the latest".

The blocker is not the parameter. **Nothing in this repo can answer "how old is this page?"**
`src/cache.ts` → `interface Entry<T> { value: T; expiresAt: number }` stores an expiry and no stored-time,
and `Cache.get` returns the value alone. `cache.pageMs` says when to *stop trusting* an entry; nothing
records when it was fetched. So the feature is a timestamp plus one comparison, and the parameter is
downstream of both.

## Relevant learnings

| Artifact | What it constrains here |
| --- | --- |
| `docs/solutions/architecture/derived-field-must-be-written-with-its-source.md` | The timestamp may not live inside the cached `SnapshotResult`. A field written at one site and read at another is where this repo's C.4 defect was born; `src/tools/read.ts` → `assertDestinationAllowed(stored.url)` already re-checks the stored `url` because a cached value is not credible about its own provenance. |
| `docs/solutions/integration/cleanup-must-not-inherit-the-aborted-signal.md` | The cache's `clear()`/generation boundary is the reason no parallel `key → storedAt` map is acceptable outside `cache.ts`. |
| `docs/solutions/timing/settle-stop-must-be-reachable.md` | "A stop the budget cannot reach is not a wait" — the same shape as the `maxAgeMs: 0` case here: a bound that can be satisfied by nothing must be decided, not left to a comparison that lands on the wrong side by timing. |
| `CONTEXT.md` — the address guard, the cache's two rules | `assertDestinationAllowed` must still run on a hit that a tolerance accepted; `storable` must keep thin pages out; only successes are stored. |

No prior rejection of this feature exists — `docs/out-of-scope/` does not exist in this repo.

## Scope boundaries

**In:** one integer tool parameter, one cache field, one cache read accessor, two model-facing sentences,
the README, and closing ledger item 2.6 with its SERP half filed as its successor.

**Out, each with the reason:**

- **`search`'s SERP cache.** It has `cache.serpMs` and its own `fromCache`, but no `fresh`. A tolerance
  there is a freshness knob whose sibling does not exist. Filed as an open item in U4, not shipped.
- **A config key** (e.g. `read.maxAgeMs`). A default tolerance would be a policy the caller did not ask
  for. `config.example.json` and `tests/config-example.test.mjs` stay untouched.
- **Refusing `maxAgeMs` alongside `schema`/`waitFor`.** Those reads have no cache key
  (`src/tools/read.ts` → `const key = !params.schema && !params.waitFor ? … : undefined`) so a tolerance is
  inert — and that is already what `fresh` does there, silently. Changing it would alter existing
  behaviour that is not wrong.
- **Fixing `fromCache` on the single-flight path.** A caller riding another call's navigation today
  reports `fromCache: false` (`deps.cache.run` serves from its own internal `get`). Pre-existing, rare,
  and it does not create a false claim once age rides on it: no `fromCache`, no age sentence. Pinned in U3
  so the new claim cannot overreach, not fixed.
- **Anything reaching a gateway request body.** `tests/request-contract.test.mjs` fails the suite if it does.

## Architecture decision

**Staleness is a read bound, not an eviction** — ADR-worthy, because the alternative is one line shorter
and a future maintainer will be tempted to write it.

`src/tools/read.ts` → `fresh` skips a lookup and gets away with it because skipping is not a mutation.
Deleting an over-tolerance entry is, and it is triggered by *one caller's* tight tolerance: the page a loose
ask could still have used is gone, and the re-fetch the deletion forces can fail. Leaving it costs nothing
on the success path — the fresh page overwrites it on write-back, which is what `fresh` already relies on —
and keeps one more thing true: **a gateway that is down cannot take away the stale-but-readable page a
looser ask could still have used.**

So the age test lives where `entry.expiresAt <= Date.now()` already lives, in the cache's read path: **an
expired entry is deleted (today's behaviour), an over-tolerance entry is left in place.** One place decides
whether a stored page may answer — which is not stylistic, it is the bug in U2's sharpest case (below).

→ `docs/adr/0002-staleness-is-a-read-bound-not-an-eviction.md` (U1 writes it).

## Target shape

```ts
// src/cache.ts
interface Entry<T> { value: T; storedAt: number; expiresAt: number }
interface ReadBound { /** Serve an entry at most this old. Absent = today's behaviour: unexpired is enough. */ maxAgeMs?: number }
interface CachedEntry<T> { value: T; ageMs: number }

interface Cache<T> {
  get(key: string): T | undefined;   // narrowed in review — see the amendment below
  /** The reader that may bound a read by age, and the only one that reports how old what it returned is. Never deletes a within-TTL entry. */
  peek(key: string, bound?: ReadBound): CachedEntry<T> | undefined;
  run(key: string, produce: () => Promise<T>, ttlMs?: number, options?: RunOptions<T> & ReadBound): Promise<T>;
  // size, set, clear unchanged
}
```

**Amendment, landed in review (`cb30973`) and recorded here so this plan matches the code.** `get` does
**not** take a `bound`, though the block above said it should. Nothing in `src/` ever passed one —
`src/tools/search.ts` and `src/resolve.ts` call `get(key)`, and `src/tools/read.ts` reads through `peek`
because it needs the age — so the parameter was a second way to ask a question `peek` answers better, and the
worse one failed silently: a caller wanting freshness could take `get(key, bound)`, get the bound honoured and
the age discarded, and never learn they had lost a fact. Removing it makes the type push a caller who needs
age to the accessor whose name already promises one. ADR 0002's "one place decides" holds either way, because
`get` delegates.

The same round moved `stageClock` and `opens(fake)` into `tests/helpers/` (`clock.mjs`, and `opens` beside the
fake whose call log it counts). Both carry an obligation rather than a shorthand — `stageClock`'s value is that
`t.after` always restores `Date.now`, and a leaked stub makes every TTL and age assertion in three files lie —
so they are one copy now. `tests/engines.test.mjs`'s inline stub predates this branch and was left alone.

`get` delegates to `peek`; `run`'s internal hit passes the caller's bound through. `ageMs` is
`Math.max(0, Date.now() - entry.storedAt)` — **R1**: a clock that steps backwards would otherwise hand back a
negative age, which passes every bound and gets printed to the model as a fact about a page nobody can place.

```ts
// src/tools/read.ts — ReadParams, ReadOutcome
maxAgeMs?: number;                      // param: whole ms, 0 or more; refused alongside `fresh`
maxAgeMs?: number;                      // outcome: the caller's own ask, echoed the way `waitForRequested`
                                        //   echoes a wait, so renderRead stays a function of the outcome alone
pageAgeMs?: number;                     // set only when the page came from the cache
staleSkippedMs?: number;                // age of the cached page the tolerance rejected, forcing a re-fetch
```

One word for one thing across both layers: `maxAgeMs` at the tool, `maxAgeMs` in `ReadBound`.

## Implementation units

Strictly sequential: U2 reads U1's accessor, U3 renders U2's fields, U4 documents all of it.

---

### U1 — the cache can say how old a page is, and bound a read by it

**Goal.** `Entry.storedAt` exists; `peek` reports `ageMs`; the age bound is applied *in the cache's read
path*, non-destructively; `run` honours the same bound as `get`.

**Files.** `src/cache.ts` · `tests/cache.test.mjs` · `docs/adr/0002-staleness-is-a-read-bound-not-an-eviction.md`

**Patterns to follow.** `src/liveness.ts` → `this.known = { kind: "up", value, at: Date.now() }` with
`now - known.at < this.ttlMs` is the repo's existing absolute-stamp-and-compare. Keep `src/cache.ts`'s
header comment current — it states the two rules ("only successes are stored", single-flight) and this unit
adds a third thing the cache decides. `prune()` and the generation counter are not to be touched.

**Test scenarios.**
- `peek` on an entry stored at `T` answers `ageMs` under a stubbed `Date.now` — the one existing idiom is
  `tests/engines.test.mjs` saving `const realNow = Date.now`, staging returns, restoring in `t.after`.
  `src/cache.ts` reads `Date.now()` in both `get` and `set`, so one stub covers the pair.
- **The bound rejects without evicting:** a tight `maxAgeMs` returns `undefined`, and a *second* read of the
  same key with a loose one still gets the value. This is the ADR's assertion — write it as two calls on one
  cache, and it is the test that a delete-on-stale implementation cannot pass.
- **Expired still deletes, over-tolerance still does not:** past `expiresAt` a later `size` getter no longer
  counts the key (matches `an expired entry stops being visible without needing a read to evict it`); past a
  tolerance and inside the TTL it still does.
- `maxAgeMs: 0` never serves, including an entry stored in the **same millisecond** (`ageMs === 0`). A naive
  `age <= maxAgeMs` passes every other case here and fails this one.
- `run` honours the bound on its own internal hit: with a stored entry inside its TTL and `maxAgeMs: 0`, the
  producer runs and its value is returned and stored.
- `run`'s single-flight still shares: two concurrent bounded calls, one `produce`.
- `set` stamps `storedAt` on both paths that use it — `set()` directly and the store inside `run()`.
- **R1, the clock steps backwards:** a `storedAt` ahead of `Date.now()` answers `ageMs: 0`, not a negative —
  and so does not sail through a tight bound on the strength of an age that cannot exist.

**Verification.** `NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs tests/cache.test.mjs`
green; `npm run typecheck` clean (the `Cache` interface widens, and `search.ts`/`resolve.ts` call sites must
still compile).

**Dependencies.** None.

---

### U2 — `maxAgeMs` is validated, and a page older than it is not the answer

**Goal.** `read({ url, maxAgeMs })` serves a stored page within tolerance, navigates when it is over,
refuses the ask it cannot honour, and never opens a tab to answer a question it can settle first.

**Files.** `src/tools/read.ts` · `tests/read-tool.test.mjs`

**Patterns to follow.** `src/tools/read.ts` → `isCountUsable(value, minimum)` is the one predicate,
`assertOffsetUsable` is the closest guard in shape (`0` is legal, because that is where a page starts) and
`assertMaxCharsUsable` the closest in argument — refuse, do not clamp, and say which value is at fault
through `describeArgument`. All guards run **before** any navigation or cache read; the comment on that
block is the reason: "a budget we cannot size has no answer worth a round trip". Error code is
`unsupported`.

**Test scenarios.**
- **Refused before anything is fetched:** `fresh: true` + `maxAgeMs` → `unsupported`, naming which of the two
  to drop, with `opens(fake)` unchanged at `0`. Same placement for a bad number.
- **The numeric contract, one case per failure mode:** `1.5`, `-1`, `NaN`, `"60000"`, `"1,000"`, `{}`,
  `Infinity` all refused with `unsupported`; `0` accepted.
- **R2, `0` is seen as `0` and not as absent:** the parameter is tested with `params.maxAgeMs !== undefined`,
  never truthiness — `0` is legal and falsy, and an `if (params.maxAgeMs)` would send the one case invented to
  be deterministic back to being decided by timing. Asserted by observing the navigation, not the flag.
- **R2, the pair guard is exact:** refused on `params.fresh === true` only, so `fresh: false` alongside
  `maxAgeMs` is a working call rather than an over-refusal.
- **A hit within tolerance costs the gateway nothing** — the repo's existing instrument,
  `const afterFirst = opens(fake); … assert.equal(opens(fake), afterFirst, "a cached page must not open a tab")`.
- **Over tolerance costs exactly one** navigation, and the second read at the same tolerance costs none
  (the re-fetch replaced the entry — the tolerance is not a permanent miss).
- **`maxAgeMs: 0` navigates past a live entry** — inside its TTL, with no `fresh`. The sharpest case in the
  unit: it is the one that breaks if the bound is applied to the `get` path and forgotten in `run`, because
  after the `get` misses, `deps.cache.run` answers from its own internal `get` and the ask is betrayed.
  It needs U1's `ReadBound` on `run` to be green, and it is the test that keeps it there.
- **`maxAgeMs` above `config.cache.pageMs` is accepted**, and behaves as the default does (any unexpired
  entry qualifies). Not refused — contrast with `search.maxResults`, which was refused because every call
  came back clamped.
- **The guard on the hit still runs:** a stored page accepted by a tolerance is still refused when
  `blockedHosts` has since narrowed — the existing `a cached page is re-checked against a policy that has
  since narrowed` case, run again *with* a generous tolerance, so the new path cannot bypass the guard.
- **Tolerance is inert where there is no key:** `maxAgeMs` with `schema`, and with `waitFor` — navigates, no
  error, and nothing is written to the cache that was not written before.
- **Single-flight still holds under a tolerance:** two reads in flight, one tab (`opens(fake) === 1`).
- Ageing entries uses the same `Date.now` stub idiom as U1, never a real `sleep` for a minute-scale age.
- **R3, the ADR's payoff, proven rather than asserted:** an over-tolerance entry forces a re-fetch, the
  re-fetch fails, the error surfaces as usual — and a *second* read with a loose tolerance still gets the
  stale page from cache, `opens(fake)` proving nothing new was fetched. Nothing else in the unit list touches
  this property, which is the entire reason the bound skips instead of deleting.

**Verification.** `NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs tests/read-tool.test.mjs`
green, then `NODE_ENV=test npm test` — the existing cache block in that file (`fresh:true ignores the cache`,
`fresh:true refreshes the entry as well as the answer`, `two reads of one page in flight open one tab`) must
all still pass unchanged.

**Dependencies.** U1.

---

### U3 — the model is told the age, and told when the tolerance threw a page away

**Goal.** Two claims reach the text a model reads, not only `details`: every cache hit names the page's age
and the tolerance that accepted it; an over-tolerance entry gets its own note. Both are declared in the
output schema.

**Files.** `src/tools/read.ts` (`pageAgeMs`, `staleSkippedMs` on `ReadOutcome`) ·
`src/extension.ts` (`renderRead` notes) · `src/camoufox-gateway.ts` (`ReadOutputSchema`, `readResult`) ·
`tests/read-tool.test.mjs` · `tests/camoufox-gateway.test.mjs`

**Patterns to follow.** `renderRead` pushes notes in a fixed order — `fromCache`, `cappedAt`,
`thinAfterWait`, `waitNote` — and each carries the *reason* it exists in a comment above it; the new age text
belongs **inside** the existing `fromCache` note rather than as a fifth note, because it is the same claim
with one more fact. `cappedAt` is the model to copy: it exists because "the output claiming more than it
returned" was the defect, and it names which of two limits did the cutting. Add a field in all three places
or `assertDeclaredBy` fails — that is the point.

**Test scenarios.**
- A hit inside tolerance says the age and the tolerance; the age is the entry's, not the call's.
- A navigation says no age at all (`pageAgeMs` absent, not `0`) — a fresh fetch has no age to claim.
- The drop note appears only when an entry was rejected, and names its age; it is absent on a cold cache.
  Assert the two are distinguishable, which is the whole reason the note exists.
- A hit that was shared through `run` (no `fromCache`) says no age — the pin that keeps the new claim from
  overreaching what the cache can vouch for.
- Both fields are declared in `ReadOutputSchema` and copied by `readResult`; both are absent-not-`undefined`
  on a plain read, matching how `fromCache` is asserted today.
- Formatting: a tiny `describeAge`-style helper, one case each for sub-second (`900ms`) and
  seconds-and-up (`240s`) — the repo prints raw ms elsewhere (`waiting ${outcome.settledInMs}ms`), so the
  unit stays ms and the helper only trims what a model has to squint at. No new vocabulary in `CONTEXT.md`
  for it.

**Verification.** `NODE_ENV=test npm test` green; `npm run typecheck` clean.

**Dependencies.** U2.

---

### U4 — say it in the description, and close item 2.6 with its leftover filed

**Goal.** The parameter is described before anything dereferences it, the README carries it, and the ledger
records 2.6 closed in place with the SERP half as an open successor — the way 2.6 itself arrived as 2.4's
unshipped half.

**Files.** `src/extension.ts` (`ReadToolArgs`, `READ_DESCRIPTION`) · `src/camoufox-gateway.ts` (`ReadSchema`) ·
`README.md` · `docs/improvements/2026-10-18-functionality.md` · `tests/camoufox-gateway.test.mjs`

**Patterns to follow.** `maxChars` and `offset` in `ReadSchema` are the template for a numeric parameter:
`Type.Integer`, the floor stated in words, and the word `unsupported` in the sentence —
`tests/camoufox-gateway.test.mjs` asserts all three. A description that names a config key must **not**
interpolate a `DEFAULT_CONFIG` number, so it says `cache.pageMs` and quotes no milliseconds. `fresh`'s
description is the prose neighbour to stay consistent with, not to duplicate.

**Test scenarios.**
- The exact param-key list becomes `["fresh", "maxAgeMs", "maxChars", "offset", "schema", "url", "waitFor"]`;
  `required` stays `["url"]`.
- `maxAgeMs` has a non-empty description, is `Type.Integer`, states its floor, contains `unsupported`, and
  does not contain `DEFAULT_CONFIG.cache.pageMs`'s numeric value.
- `READ_DESCRIPTION` still equals the exported constant the tool surface uses, and the README-vs-schema
  comparison holds for the updated signature line
  (`### \`camoufox_read(url, maxChars?, offset?, waitFor?, schema?, fresh?, maxAgeMs?)\``).
- `tests/improvement-refs.test.mjs` stays green against the rewritten 2.6 — anchors resolve by fragment, bare
  paths resolve, and no `` `file.ts:12` `` style ref is introduced.
- New ledger item for the SERP half states plainly that `search` has `cache.serpMs` and no `fresh`, and why
  the pair is what makes either one meaningful.
- **R4** — the README says, beside the existing cache bullets, that the cache lives and dies with the pi
  session, so a tolerance longer than a session is inert. One sentence, no new config key, no refusal.

**Verification.** `NODE_ENV=test npm test` green · `npm run typecheck` clean ·
`npm run test:measure` exit 0 · `npm run test:live` unchanged from baseline (its `resolve` failure is
pre-existing on `main` and unrelated — do not "fix" it here).

**Dependencies.** U1, U2, U3.

## Verification strategy

1. Per unit, the targeted file's tests go RED first with the unit's own assertion named, then GREEN.
2. `NODE_ENV=test npm test` — expect **426 + new** passing, 0 failing. The suite count is a committed number
   in `README.md`, `tests/fixtures/measure/invented-page-count.txt` and `scripts/measure-unregistered-pages.mjs`;
   if new tests change it, `npm run test:measure` is what reconciles the three, and the numbers are
   re-measured, never hand-edited (`docs/solutions/testing/committed-measurement-must-be-pinned-to-a-run.md`).
3. `npm run typecheck` clean.
4. Three mutations, each reported in the commit body, each proving a named assertion is live:
   - make `peek` **delete** on over-tolerance → U1's "looser reader still gets it" goes red;
   - drop `ReadBound` from `run`'s internal hit → U2's `maxAgeMs: 0` case goes red;
   - replace `params.maxAgeMs !== undefined` with a truthiness test → U2's R2 case goes red (**R1**'s
     clock-backwards case is the fourth, red without the `Math.max(0, …)` clamp).
5. Lint/format as the final step (repo convention: everything works first, then format).

## Risks

- **A model sets a generous tolerance to save turns and gets a stale page.** U3's always-on age sentence is
  the mitigation, and the reason the age is printed even when the caller did not ask.
- **R4, a tolerance cannot outlive the session — stated, not discovered.** `### F.2 Cache is per-pi-session`
  in the code ledger is explicit, and the cache is an in-process `Map` made per session at
  `src/camoufox-gateway.ts` → `cache: createCache()`. A tolerance longer than the pi session holding it is
  inert. This goes in the README beside the cache bullets; it is **not** refused in code, because a refusal
  there would invent a bound the config does not carry.
- **A second reader of the cache.** `search.ts` and `resolve.ts` call `get`/`run` with no bound, which must
  behave exactly as today — U1 keeps the bound optional for that reason, and their tests are the tripwire.
- **`Date.now` stubbing leaks between tests.** Restore in `t.after`, the way `tests/engines.test.mjs` does it;
  a leaked stub would make every TTL assertion in `tests/cache.test.mjs` lie.
