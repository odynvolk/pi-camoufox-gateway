# Staleness is a read bound, not an eviction

**Status:** accepted (2026-11-07), implemented on `feat/read-cache-staleness-tolerance` (unit U1)

> Requirement: `docs/brainstorms/2026-11-07-read-cache-staleness-tolerance.md` · Plan unit: U1 of
> `docs/plans/archive/2026-11-07-read-cache-staleness-tolerance.md`

## Context

A per-call staleness tolerance asks the cache a question it had never been asked: *how old is this page?*
Answering it needed a stored time (`src/cache.ts` → `storedAt: number;`) and one comparison. The comparison
raised the fork this ADR records: when the entry a caller's `maxAgeMs` rejects is sitting in the map, do we
**delete** it or **skip** it?

Deleting is the one-line-shorter option, and the file already does it — `entries.delete(key)` is what the
expired case does on a read. It is also the option a future maintainer will reach for, because `fresh: true`
already establishes that a caller's freshness ask can keep a page out of the answer. The two are not alike.
`fresh` skips a lookup, and skipping is not a mutation; deleting is, and it would be a mutation triggered by
**one caller's** tolerance.

## Decision

**An expired entry is deleted (the behaviour it has always had), an over-tolerance entry is left in place.**

Both decisions live in one place — the cache's read path, `src/cache.ts` → `peek(key: string, bound?: ReadBound)`
— with `get` delegating to it and `run`'s internal hit passing the caller's bound through
(`const hit = this.peek(key, options);`). One place decides whether a stored page may answer, which is not
stylistic: `run` answers from its own hit, so a bound applied only to a caller's `get` is betrayed by the
call that was meant to honour it.

The age test is `ageMs < maxAgeMs` (`src/cache.ts` → `!(ageMs < bound.maxAgeMs)`), so `maxAgeMs: 0` never
serves — including an entry stored in the same millisecond, whose age is `0` and which a `<=` would
sometimes hand out depending on timing.

## Consequences

**What skipping buys, and deleting would not.** A gateway that is down cannot take away the
stale-but-readable page a looser ask could still have used. The forced re-fetch after a skip can fail; had
the tight bound deleted the entry first, a page that was perfectly readable the whole time would have been
destroyed by a fetch that never landed — and by a caller who did not want it, for a reason that applied only
to that caller.

**What it costs: nothing on the success path.** The re-fetched page overwrites the skipped one on write-back,
which is the same property `fresh` already relies on when it skips the lookup and still stores. And nothing is
kept past its trust window for the sake of this: `expiresAt` still evicts, because a tolerance may only ever
ask for *less* than `cache.pageMs`, never more.

**The age is clamped.** `src/cache.ts` → `const ageMs = Math.max(0, now - entry.storedAt);` — a clock that
steps backwards (an NTP correction, a woken laptop) would otherwise hand back a negative age, which passes
every bound and gets printed to a model as a fact about a page nobody can place.

Pinned by `tests/cache.test.mjs` → a tight bound rejects an entry and leaves it for a looser reader, and by
an over-tolerance entry is skipped, not evicted; an expired one still goes. Making `peek` delete on
over-tolerance turns both red and nothing else in the new set does — the property is tested, not asserted.

## Considered options

- **Delete the entry its own bound rejected.** Rejected for the reason above: one caller's ask must not
  exercise eviction over the whole cache, and eviction here is lossy — the only way to get the page back is a
  navigation that can fail.
- **Decide the bound in `src/tools/read.ts` instead of the cache.** Rejected: the age lives on the entry, and
  `deps.cache.run` answers from its own internal hit, so a caller-side bound would be a rule the cache is
  free to ignore. It would also be a second place deciding the same question.
- **Stop deleting expired entries too.** Rejected: `expiresAt` is the outer bound on how long a page is
  trusted, set by config and asked for by nobody in particular. Relaxing it would let one call's tolerance
  extend what every later call sees.
