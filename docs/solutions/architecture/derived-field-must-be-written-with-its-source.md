---
title: A derived field is a written field — recompute it at every write site, and never let a fixture supply it
category: architecture
severity: high
tags: [derived-state, provenance, search-result, host, url, resolve, cache, fixture, test-blindness, camoufox]
applies_when:
  - a field is derived from another field (host from url, slug from title, checksum from body)
  - code replaces the source field while spreading an object (`{ ...result, url: next }`)
  - a cache stores part of a derived pair
  - a test helper hand-writes the field the code under test is supposed to derive
  - a bug survives because every test that could see it supplies the answer instead of computing it
---

# Problem

`SearchResult.host` was meant to say who a search result belongs to. It was derived from the url once, at
parse time — and then three sites replaced `url` and left `host` behind:

```ts
return { ...result, url: opened.url, resolved: true };        // resolve.ts, fresh open
if (known) return { ...result, url: known.url, resolved: known.resolved };  // resolve.ts, cache hit
```

A resolved Google wrapper therefore reported `host: google.com` while pointing at somebody else's site. The
same shape appeared a second time in the same file on the review round: the fix cleared `resolvable` on the
fresh open and forgot the cache hit — until a reviewer named it, at which point the *else* branch of that
ternary (a cached refusal, which must keep the flag) had no test either.

The reason no test caught any of it was worse than the bug:

```ts
// tests/resolve.test.mjs
function result(url, { resolvable }) {
  return { title, url, host: "example.test", /* ... */ };   // the field under test, hand-written
}
```

A fixture that *supplies* the derived field cannot see a code path that fails to derive it. Every assertion in
that file was built on a value no code had produced.

# Context

`src/resolve.ts`, `src/snapshot.ts`, `src/tools/search.ts`, closed on `fix/result-host-attribution` (C.4).
The attribution half of the defect was page-supplied text — see
[`wall-detection-must-be-structural.md`](./wall-detection-must-be-structural.md), which settled "host evidence
means the host". This artifact is the *other* half: the field was ours, derived correctly, and then kept
stale. It survived two releases of fixture tests, and the plan written for it named one write site when there
were three.

# Solution

**One rule: wherever the source is written, the derived field is written — in the same statement.** Not at
print time, not "when convenient"; a rule that lives in two statements is two rules.

```ts
if (known) return { ...result, url: known.url, resolved: known.resolved,
                    host: resultHost(known.url), resolvable: known.resolved ? false : result.resolvable };
```

Three consequences that each cost a finding to learn:

- **Do not cache the derived value.** The cache kept `{ url, resolved }` only, and the host was recomputed off
  `known.url`. That is what makes the fix immune to entries written by the old code — a cache that carries a
  derived field carries the old code's mistakes too.
- **Every success path *and* every failure path.** `resolved: false` means the url never moved, so host stays
  and `resolvable` stays. A fix that clears a flag on one path and not its twin is the same bug moved.
- **Fix the fixture before trusting the suite.** Make the helper derive the field
  (`host: resultHost(url)`), then add a case asserting the helper derives it — otherwise the helper can quietly
  go back to fabricating. Take the failing-first evidence by deliberately restoring the old helper: a helper
  fixed *and* asserted cannot be made to fail, so the red has to be provoked.

# Why this works

Object spread makes "keep the other fields" free, which is exactly why derived fields rot: the line looks
conservative and is a silent inconsistency generator. Making the pairing syntactic — both fields in one
literal, next to each other — turns a missing recompute into something a reader and a mutation test both see.
The mutation is the proof: drop `host:` from one return and one named case goes red; the pre-fix suite stayed
green for two releases because the assertion it needed was being handed its answer.

# Prevention

- A derived field gets **one** reader, exported, and named for what it derives from (`resultHost(url)`).
  Two readers in one file with different trust properties (`hostOf` vs `hostFrom`) is how this shipped.
- `02-plan`: count the write sites before sizing the unit. Grep for `...result` / spread-returns of the type,
  and put the cache path in the plan explicitly — it is the one every author misses.
- `04-review`: for any `return { ...x, <source>: value }`, ask what else is derived from `<source>` and whether
  this line recomputed it. Then ask whether a **test helper** supplies that field.
- Never let a fixture hand-write a field the system-under-test owns. If it must be stubbed, stub it at the
  boundary that owns it, not in the object being asserted on.
