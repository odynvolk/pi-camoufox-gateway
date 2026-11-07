---
title: A single-flight cache has two read paths — a policy enforced on one is silently ignored by the other
category: architecture
severity: high
tags: [cache, single-flight, ttl, read-policy, staleness, maxAgeMs, duplicate-code-path, mutation-testing, derived-state, camoufox]
applies_when:
  - adding any per-call policy to a cache (staleness, tenancy, feature gate, redaction, budget)
  - the cache's `run`/`getOrCompute` performs its own lookup before calling the producer
  - a caller-side check passes its own test while the shared path serves the very value it was meant to refuse
  - a value can be shared between concurrent callers that asked for different things
  - a cache hit is about to carry a per-call claim (an age, a cost, a provenance) into model-facing or logged text
---

# Problem

A per-call policy added to a cache looks like a one-line change at the call site, and it passes its test
while doing nothing.

`camoufox_read` gained `maxAgeMs`: *serve a stored page this young, navigate past it.* The first
implementation bounded the lookup in the tool and was green. It was also wrong, and only a mutation proved
it: dropping the bound from the *other* read path — the one inside the cache — turned four cases red,
including the one the feature exists for (`maxAgeMs: 0` must navigate past a live entry).

The tool's read path is not the only reader. `src/tools/read.ts` → `if (key && !params.fresh)` consults the
cache, misses, and then calls `deps.cache.run(...)`, whose first act is its **own** lookup before it decides
whether to produce. Bounding the caller's `get` while leaving that internal hit alone means the caller's
refusal is reversed one statement later, by the call the caller made *because* it refused. The path that
looks like the retry is the path that actually answers.

# Context

Found on `feat/read-cache-staleness-tolerance` (2026-11-07), while shipping item 2.6. It is invisible to
reading: the two lookups are in different files, they are textually identical in the ways a reviewer pattern-matches
on (`cache.get(key)`), and the miss-then-produce sequence makes the second one look like plumbing rather than
a decision point. It is also invisible to the obvious test: a single caller with a cold cache exercises only
one of the two paths, so the feature appears to work.

Two corollaries surfaced in the same round, both from the same root — a shared value is not a per-call value:

- **A shared hit cannot carry a per-call claim.** A caller riding someone else's in-flight navigation receives
  the page, but did not pay for it and cannot vouch for when it was fetched. The age claim therefore lives
  behind the same gate as `fromCache`, and a shared read says nothing about age.
- **The layer that owns the fact must own the decision.** A caller-side bound is a rule the cache is free to
  ignore, and a second place deciding one question. The bound lives where `expiresAt` is already tested
  (`src/cache.ts` → `peek(key: string, bound?: ReadBound)`), and `ageMs` is computed there rather than stored
  — which is also why it cannot be forged by the cached value. See
  [derived-field-must-be-written-with-its-source](../architecture/derived-field-must-be-written-with-its-source.md)
  for the write-side half of the same lesson.

# Solution

Put the policy inside the cache, in the single read path, and make every other reader go through it.

```ts
// One reader decides. Everything else delegates to it.
peek(key: string, bound?: ReadBound): CachedEntry<T> | undefined   // age test lives here, beside expiresAt
get(key: string): T | undefined                                     // = this.peek(key)?.value
run(key, produce, ttlMs, options?: RunOptions<T> & ReadBound)       // const hit = this.peek(key, options)
```

Three rules that fall out of it, each with the test that holds it:

1. **The bound is an argument to the shared path, not a wrapper around it.** `run` takes it in `options` and
   passes it to its own hit. Pinned by `tests/read-tool.test.mjs` → *maxAgeMs of 0 is seen as 0 and navigates
   past an entry inside its TTL* — the case a caller-side check passes by accident and fails on purpose.
2. **Non-destructive.** A policy that one caller asserted must not mutate state other callers depend on. An
   expired entry is deleted (it was always going away); an over-tolerance entry is skipped and left in place,
   so a re-fetch that fails cannot destroy a page a looser ask could still have used
   (`docs/adr/0002-staleness-is-a-read-bound-not-an-eviction.md`).
3. **Do not keep the weak version of the accessor.** `get` initially took a `bound` too, with no production
   caller — a second way to ask one question where the weaker one loses information silently (a caller gets
   the bound honoured, the age discarded, and no signal either way). Deleting it makes the type route a caller
   who needs age to the accessor whose name promises one.

# Why this works

The defect class is **duplicated decision**, not duplicated code. Two readers, two chances to apply a rule,
and only one of them is under the person adding the rule. Nothing in the source says the internal hit is a
policy surface — it reads as "return the cached value if there is one", which is exactly what a policy is
there to qualify.

It survives review so often because the natural test shape hides it: cold cache, one caller, assert the
producer ran. Both paths agree in that scenario. The bug is only reachable when the lookup misses *and* the
produce path finds something — which is the single-flight path, and the reason this repo's assertions are
written as navigation counts (`opens(fake)`) rather than as return values: the navigation is the only witness
of which path answered.

Corollary reasoning: a value stored once and returned to many is a value whose *properties* are facts about
the store, not about any one read. Age, cost, provenance — any of them can be true for the caller who produced
the entry and false for the one who merely rode along. Claims like those belong behind the same flag that says
"this call did not fetch", and the flag has to come from the layer that knows.

# Prevention

- When adding a per-call policy to a cache, grep the cache module for **every** internal lookup before
  touching the call site. If the module has a `getOrCompute`/`run` that calls its own `get`, that call is the
  policy surface; the call site is not.
- Test the shared path deliberately: warm the entry, then issue the call that must be refused, and assert on
  the *side effect* (a navigation, a request, a log line), not on the return value. A return-value assertion
  passes on both paths; a side-effect assertion only passes on the honest one.
- Prove each policy with a mutation before calling it done: delete the bound from the internal hit and require
  a named test to go red. A policy no mutation can kill is a policy nobody is using.
- When a cache gains a per-call claim about a shared value, gate it on "did this call fetch", not on "was a
  value returned". If the module cannot answer the first question, the claim does not exist yet.
- Prefer deleting an accessor whose weaker form loses information silently over documenting it.
