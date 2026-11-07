---
title: Say how stale is acceptable, not whether to refresh — `maxAgeMs` on camoufox_read
date: 2026-11-07
status: proposed
baseline_commit: 8bed93a
version: 0.2.2
tags: [read, cache, freshness, context-budget, item-2.6]
---

# How stale is acceptable

Item [2.6](../improvements/2026-10-18-functionality.md#26-say-how-stale-is-acceptable-not-whether-to-refresh)
of the functionality ledger: the unshipped half of the per-call cache bypass. `fresh: true` is the
`x-no-cache` half of Jina's pair and shipped; `x-cache-tolerance: <seconds>` — *how much staleness is
fine* — did not. A boolean answers **now or not**. Research asks the other question: thirty minutes of
page age is the right answer to a survey question and the wrong answer to "what's the latest", and a
boolean cannot say which was meant.

Opened as "do 2.6". Six decisions were put to the author; all six are recorded below with the reason
that carried them.

## What we are building

`camoufox_read(url, maxChars?, offset?, waitFor?, schema?, fresh?, maxAgeMs?)`.

`maxAgeMs` — *anything under this old is an acceptable answer to this call; older than that, navigate.*

## The load-bearing gap is not the parameter

Nothing in this repo can answer "how old is this page?". `src/cache.ts` →
`interface Entry<T> { value: T; expiresAt: number }` keeps an expiry and no stored-time, and `Cache.get`
returns the value alone. `cache.pageMs` says *when to stop trusting an entry*; nothing anywhere records
*when it was fetched*. So the feature is a timestamp and one comparison, and the parameter is downstream
of both. A `maxAgeMs` built on top of the current cache would be a tolerance measured against a fact
nobody stores.

## Approaches considered

| | Verdict | Why |
| --- | --- | --- |
| Stamp the `SnapshotResult` at write time in `read.ts` | **rejected** | A provenance field inside the cached body. `docs/solutions/architecture/derived-field-must-be-written-with-its-source.md` is this repo's prior payment for exactly that class, and `src/tools/read.ts` → `assertDestinationAllowed(stored.url)` already re-runs the destination rule on a hit because the stored value cannot be trusted about where it came from. A field the page can reach is a field the page can forge; `storedAt` inside a page-shaped object is the same mistake one layer down. |
| A parallel `key → storedAt` map in `read.ts` | **rejected** | `prune()` evicts on the cache's own schedule and `clear()` bumps a generation counter precisely so an in-flight producer cannot resurrect a dropped value. A map outside that boundary dates keys that no longer exist, and inherits the generation problem without solving it. |
| `Entry.storedAt` + a read-path accessor | **chosen** | Only `set()` sees the write, so only the cache can date it. Precedent for an absolute stamp already in the repo: `src/liveness.ts` → `this.known = { kind: "up", value, at: Date.now() }`, compared as `now - known.at < this.ttlMs`. |
| Delete the entry when it is over tolerance | **rejected** | See below. |
| Skip it for that caller, leave it in place | **chosen** | See below. |

**The delete/skip fork, and why it is not cosmetic.** `fresh: true` skips a lookup and gets away with it
because skipping is not a mutation. Deleting is a mutation, and it is one triggered by a *single caller's*
tight tolerance — so the entry a loose ask could still have used is gone, and the re-fetch that deletion
forced can fail. Leaving the entry in place costs nothing on the success path, because the fresh page
overwrites it on write-back either way (`fresh` already relies on this: "`fresh` skips the lookup, not the
write-back"). It keeps one more thing true, which is the part worth writing down: **a gateway that is down
cannot take away the stale-but-readable page a looser ask could still have used.**

## Decisions, with the reason that carried each

1. **`maxAgeMs`, integer milliseconds.** Milliseconds is the unit every other duration in this repo
   speaks — `cache.pageMs`, `cache.serpMs`, `timeoutMs`, `read.waitForSettleMs`. Jina's seconds would be
   the only seconds-valued duration in the codebase, which is how a misread `30` becomes 30 ms.
2. **The timestamp lives on the cache entry**, per the table above.
3. **`fresh: true` and `maxAgeMs` together are refused** — before anything is fetched, code `unsupported`,
   naming which of the two to drop. They answer one question and one is strictly stronger, so accepting
   both makes the caller's tolerance a decoration. This repo already refuses an ask it cannot honour
   rather than rounding it: `search.maxResults` above the page width is refused, `n: 2.5` is refused,
   `"1,000"` is refused.
4. **`maxAgeMs: 0` is legal and means navigate** — `fresh` spelled in the new unit. It is also the
   deterministic answer to a case that would otherwise be timing-dependent: an entry stored in the same
   millisecond has age `0`, so a naive `age <= maxAgeMs` would sometimes serve it and sometimes not. The
   comparison is `age < maxAgeMs`.
5. **The age is said on every cache hit**, not only when the caller asked. Same rule that put
   `(via google)` in the search header: a claim a model cannot read is a claim it cannot weigh. A model
   that cannot see a page's age cannot decide whether to ask for `fresh` next time.
6. **An over-tolerance entry gets its own note** — "older than your tolerance, so re-fetched". Without
   it a guard rejection and a cold cache are byte-identical outputs, and the caller cannot tell "nothing
   was stored" from "your tolerance threw it away and cost you a navigation".
7. **Scope is `read`.** `src/tools/search.ts` has a `cache.serpMs` (30 min) lookup with its own
   `fromCache`, but search has no `fresh` today — so a tolerance there would be a freshness knob whose
   sibling does not exist, and the pair is what makes either one meaningful. The accessor lands generic
   in `cache.ts`, so search can adopt it later without a second design. The SERP half is **filed as an
   open item rather than shipped quietly or dropped** — which is how 2.6 came to exist at all: it is the
   unshipped half of a deleted 2.4.

## Two behaviours pinned without being asked

- **`maxAgeMs` above `cache.pageMs` is accepted, not refused.** It is honourable, and that is the whole
  difference from `search.maxResults: 25`, which was refused because every call came back clamped: here
  every unexpired entry qualifies, which *is* today's default behaviour. Refusing it would turn down a
  request the code can carry out. The two remain distinguishable in the output because the age is named.
- **`maxAgeMs` alongside `schema` or `waitFor` is accepted and inert.** Those reads have no cache key at
  all — `src/tools/read.ts` → `const key = !params.schema && !params.waitFor ? … : undefined` — because
  extraction needs refs, which die at the next navigation, and a `waitFor` is a question a page fetched
  earlier cannot answer. They navigate whatever the tolerance says, which is the outcome every tolerance
  would have produced. Note: that is also what `fresh` does there today, and silently. It is left alone
  rather than widened here, because refusing it would change existing behaviour that is not wrong.

## What it is not

- **Not a refresh, not a prefetch.** It cannot make a page younger and it never fetches ahead of a call.
- **Not a new TTL.** `cache.pageMs` stays the outer bound on how long anything is trusted; `maxAgeMs`
  only ever asks for *less*, never more.
- **Not a search feature**, per decision 7.
- **Not exposed to the gateway.** Nothing here enters a request body; `tests/request-contract.test.mjs`
  validates outbound bodies against `tests/fixtures/openapi.json` and would fail if it did.

## Premise challenge

**Does a model know how stale it wants?** It knows the question, which is the usable proxy — "what's the
latest" and "survey this space" want opposite tolerances — and the model is the party paying for the
navigation. **What breaks if we ship it?** A model that sets a generous tolerance to save turns gets a
stale answer; that is exactly what decision 5 is the mitigation for. **What it does not fix:** nothing
about wall detection, settle, or what a page contains. **Honest ceiling on value:** this feature saves
navigations and says what it did. It is not worth more than that, and the README should not imply it is.

## Files in scope

| File | Change |
| --- | --- |
| `src/cache.ts` | `Entry.storedAt`; a read accessor that applies an age bound where `expiresAt` is applied today |
| `src/tools/read.ts` | `maxAgeMs` on `ReadParams`; validation in the `isCountUsable` idiom; the age bound on the lookup; age and drop-reason on `ReadOutcome` |
| `src/camoufox-gateway.ts` | `ReadSchema` (a `Type.Integer` with the floor stated in words and the word `unsupported`), `ReadOutputSchema`, `readResult` — a new outcome field must be added in all three |
| `src/extension.ts` | `ReadToolArgs`, `READ_DESCRIPTION` (the only model-visible tool text, asserted by test), `renderRead` notes |
| `README.md` | the `camoufox_read(...)` signature line, the cache bullets, and the `fresh` prose they already carry |
| `docs/improvements/2026-10-18-functionality.md` | 2.6 closed in place, with the SERP half filed as its successor |

No `config.example.json` change: this is a per-call argument, not a config key, so
`tests/config-example.test.mjs` is untouched. Adding a config default for it was not proposed — a default
tolerance would be a policy the caller did not ask for.

## Verification

- `tests/read-tool.test.mjs`'s `opens(fake)` navigation counter is the instrument for "a page within
  tolerance cost the gateway nothing", and every cache case already asserts against it.
- Ageing an entry deliberately needs `Date.now` stubbed; the only precedent is
  `tests/engines.test.mjs` saving and restoring it in a `t.after`, and `src/cache.ts` reads `Date.now()`
  in both `get` and `set`, so one stub covers the pair.
- Gates that must be updated in the same commit or the suite goes red: the exact param-key list and the
  numeric-parameter description assertions in `tests/camoufox-gateway.test.mjs`, and the README-vs-schema
  comparison. Descriptions naming a config key must not interpolate a `DEFAULT_CONFIG` number, so the
  tolerance description says `cache.pageMs` and quotes no milliseconds.
- `docs/improvements/*.md` and every `tests/**/*.test.mjs` are scanned by `tests/improvement-refs.test.mjs`
  — anchors must resolve by fragment, and bare file paths must exist.
- `NODE_ENV=test npm test`, `npm run typecheck`, and `npm run test:measure` as the last step.

## Read this alongside

- [2026-10-18-functionality.md](../improvements/2026-10-18-functionality.md) — item 2.6, and 2.4's
  unshipped half that became it
- `docs/solutions/architecture/derived-field-must-be-written-with-its-source.md` — why the timestamp is
  not allowed to live inside the cached value
- `docs/solutions/integration/cleanup-must-not-inherit-the-aborted-signal.md` — the cache's
  generation/`clear()` boundary a parallel map would sit outside of
- `CONTEXT.md` — the cache's two rules ("only successes are stored", single-flight), and why
  `storable` keeps a thin page out
