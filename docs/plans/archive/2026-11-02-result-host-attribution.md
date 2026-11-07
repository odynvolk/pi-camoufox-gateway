# Plan: a search result's `host` is ours, derived from the url — never text the page supplied

> Status: executing

Branch: `fix/result-host-attribution`
Date: 2026-11-02
Baseline: `525dc74` (v0.2.2, **393 tests passing**, `tsc --noEmit` clean)
Related: `docs/improvements/2026-10-18-code.md` → `C.4`, `C.5`;
`docs/solutions/integration/wall-detection-must-be-structural.md` (*Host evidence means the host, not the
url*); `src/snapshot.ts`, `src/resolve.ts`, `src/tools/search.ts`

## Problem

`src/snapshot.ts` → `hostFrom` decides a result's `host` from a line the **page wrote**:

```ts
const citeUrl = cite?.match(/^(https?:\/\/[^ >]+|www\.[^ >/]+)/iu)?.[1];   // :86 — page content
```

`cite` arrives from `linkBlocks` (`:130-133`), which fills it from `CITE_LINE` while scanning the snapshot —
so it is as trustworthy as any other text a page can emit. `src/tools/search.ts` → `engineLabel` (`:75`)
hands that field to the model as the third line of every result it prints (`:107`), and the declared schema
publishes it as data (`src/camoufox-gateway.ts` → `SearchResultSchema`, `host: Type.String()` with no
description, while every sibling field has one arguing its meaning).

So one link block served from any attacker-reachable public host:

```
- link "You won" [e2]:
  - /url: https://attacker.test/offer
  - cite: https://www.google.com/official
```

is reported as `{ url: "https://attacker.test/offer", host: "google.com" }` — a host we did not observe,
printed in the one column a reader (model or script) uses to decide who a link belongs to.

`src/resolve.ts` then makes it worse in a second way: it replaces the url and keeps the host.
`return { ...result, url: opened.url, resolved: true };` (`:90`) turns a Google `goto` wrapper into a
result that says `host: google.com` while pointing at somebody else's site. It does so at **three** sites,
not one: the fresh open (`:90`), the **cache hit** (`:78`, whose cached value is only `{ url, resolved }` —
the host never travels with the destination), and the two `resolved: false` returns (`:93`, `:96`).

Nothing in the suite can see any of this. `tests/resolve.test.mjs:17` builds every fixture with
`host: "example.test"` written by hand next to an unrelated url — a test helper that *supplies* the field
the code under test is supposed to derive.

## Why it survived: the honest value is the less useful one

`src/tools/search.ts:164` is `const resolve = params.resolve === true;` — resolution is **opt-in, default
off**. Google serves organic links as `google.com/goto?url=…` wrappers (CONTEXT.md, *goto URL*), so on the
default path the url's own host is `google.com` for **every** result, and `cite:` is the only byte in the
response that says "this one is github.com, that one is reddit.com". `hostFrom`'s docstring says exactly
that: *"preferring Google's `cite:` line, which is already human-facing."*

That is the trade this plan makes, and the user's decision on 2026-11-02 chose honesty over the cue:

**`host` is derived from `result.url`, always, and the page's `cite:` stays where it already is — its own
`cite` field.** No new output text, no `(unverified)` tags, no quoted "page says …" column. A wrapper
therefore reports the wrapper's host, which is true: that *is* where the link points, and the schema
already says so (`resolvable`: "True when only navigating to it reveals where it goes"), as does the
`[url unresolved]` suffix on the printed line. A caller who wants the destination asks with `resolve: true`,
and gets a host that followed it.

## Root cause, in the shape of a rule this repo already has

`docs/solutions/integration/wall-detection-must-be-structural.md` settled the family this belongs to:
**host evidence has to be read off the host** — parsed with `new URL()`, normalised with `normalizeHost`,
compared by labels, never taken from bytes a page or a query supplied. That lesson was applied to
`detectWall` (`:291`) and to `classifySerp`'s model-facing message (`:493`), both through the private
`hostOf` (`:414`). The per-result column on the path the model actually reads was the one place left
reading page text.

The same file therefore holds **two host readers with opposite trust properties**:

| Reader | Source of truth | Feeds |
| --- | --- | --- |
| `hostOf(url)` (`:414`) | the url, normalised | `detectWall`, `classifySerp`'s message — the verdicts |
| `hostFrom(cite, url)` (`:85`) | **the page's own text**, url only as fallback | `SearchResult.host` — the thing the model reads per result |

`C.5` names the third copy: `src/tools/search.ts:75`'s `result.host || new URL(result.url).hostname`, raw
and unnormalised, and `src/resolve.ts:88`'s second wrapper test, `/google\.com\/(goto|url)\?/u` — which
does not require `?url=` the way the real predicate `isWrapper` (`:142`) does. Two predicates answering one
question, disagreeing in both directions.

## Decision 1 — one host reader, and page text does not get a vote

Collapse `hostFrom` into `hostOf`, keeping the display convention that already exists (peel one `www.`):

```ts
// One reader. It reads the url and nothing else: a `cite:` line is page content, and content that can name
// its own host is content that can name anybody's.
export function resultHost(url: string): string {
  return hostOf(url).replace(/^www\./u, "");
}
```

`organicResults` (`:223`) calls it; `block.cite` is still carried verbatim on the result (`:234`) so nothing
is hidden — it just cannot become an attribution. `engineLabel` (`search.ts:75`) becomes `return result.host;`,
and the `|| new URL(result.url).hostname` fallback is **deleted, not normalised**: `organicResults` already
drops a block whose url is not `^https?://` (`:209`) and `isChrome` drops one whose host does not parse
(`:170`, `if (!host) return true`), so no reported result can have an empty host. An unreachable branch
nobody tests is this repo's signature defect, not a safety net — so the unreachability gets pinned (U2).

## Decision 2 — resolve recomputes the host everywhere it replaces the url

`host` is derived from `url`, so any site that writes `url` must write `host` in the same statement. Three
sites, one rule; the cache keeps its shape (`{ url, resolved }`) precisely so a host cannot be resurrected
from a pre-fix cache entry:

```ts
const known = cache.get(key) as { url: string; resolved: boolean } | undefined;
if (known) return { ...result, url: known.url, resolved: known.resolved, host: resultHost(known.url) };  // :78
...
if (opened.url && !isWrapper(opened.url)) {                                                             // :88
  cache?.set(key, { url: opened.url, resolved: true }, ttlMs ?? 600_000);
  return { ...result, url: opened.url, resolved: true, host: resultHost(opened.url) };                  // :90
}
```

The `resolved: false` returns keep both fields as they were — the url never moved, so its host is still the
host of the url being shown. `:88` stops asking its own version of "is this still a wrapper": `isWrapper` is
exported from `src/snapshot.ts` and is the only answer. `resolve.ts` importing it is not a new dependency
direction — `resolve.ts` already imports `SearchResult` from that module.

## Decision 3 — the schema says where each field came from

`SearchResultSchema` grows two descriptions, matching the file's own convention of arguing every field:
`host` states it is ours and derived (`the host we read off this url — not text the page supplied; a
wrapper reports the wrapper's host while resolvable is true`), `cite` states it is theirs and unverified
(`page-supplied display text, shown as-is and never used for attribution`). No shape change, no new field,
nothing for a caller to migrate.

## Scope boundaries

**In scope:** the two host readers, `isWrapper`'s duplication in `resolve.ts`, the three host-keeping sites
in `resolve.ts`, two schema descriptions, and the doc's `C.4`/`C.5` records.

**Out of scope, deliberately:**

- **No new output text.** No `page says …`, no `(unverified)`, no per-result flag. Decision A on 2026-11-02.
- **Not making `resolve` the default.** It opens a tab per url; that is a product decision with a latency
  cost, not a side effect of a bug fix.
- **Not `detectWall`, `classifySerp`'s ownership rule, or `engineOwnsUrl`** — those already read the host
  correctly. A change that "tidies" them into this fix is scope creep, and their pins are protected:
  `tests/snapshot.test.mjs` → `a page the asked engine does not own is never credited as its results` and
  `B.8's open half:` must stay green and unedited.
- **Not `B.6`/`B.8`**, which are blocked on live measurement rather than code.
- **No new config keys.**

## Relevant learnings

- `docs/solutions/integration/wall-detection-must-be-structural.md` — same family, and it already names
  what `04-review` will ask: *what is the false-positive case?* Here the false-positive direction is a
  legitimate Google result losing a useful cue, which is a usability cost, not a wrong verdict — stated
  plainly above rather than argued away.
- `docs/solutions/timing/settle-stop-must-be-reachable.md` — the discipline of pinning an invariant
  *structurally* and proving the test fails on mutation. Every unit below names its mutation.
- `docs/improvements/2026-10-18-code.md` → `G.6`'s instrument and its three-way pin: adding test cases
  changes the committed reading, and the reading is **already stale** (see U5).

## Implementation units

Units run in the listed order. U1+U2 share `tests/snapshot.test.mjs` and must not be parallelised; U3–U5
touch no file another unit touches.

### U1 — the regressions that fail first

**Goal:** the laundered byte is asserted against, at the parser and on the line the model reads, before any
code changes.

**Files:** `tests/snapshot.test.mjs` (new cases, appended), `tests/search-tool.test.mjs` (one new case).

**Patterns to follow:** register the page yourself — `withFakeGateway(t, { pageContents: new Map([[url, page]]) })`
(`tests/helpers/fake_gateway.mjs:29`), which is also what keeps this case off the invented-page count
(`tests/measure-unregistered-pages.test.mjs` → *a page a case registered is not counted as one the fake
invented*). The `widePageContents()` helper at `tests/search-tool.test.mjs:33` is the closest existing
"build my own SERP" pattern. `tests/engines.test.mjs:134` shows the derive-the-url-from-the-adapter habit
G.6's pin demands.

**Test scenarios**

1. `C.4:` parser level — a page registered at `https://attacker.test/offer` with one link block carrying
   `- /url: https://attacker.test/offer` and `- cite: https://www.google.com/official`:
   `host === "attacker.test"`, and `cite` still `=== "https://www.google.com/official"` (the fix must
   demote the field, not delete it).
2. `C.4:` the printed line — through `searchTool`, assert the third line of that result block contains
   neither `google.com` nor the cite text, and assert the first two lines are unchanged in shape
   (`N. title` / `   url`).
3. **The false-positive budget** — the same page with an *honest* cite (`- cite: https://attacker.test/offer`)
   must yield the identical `host`. The fix has to be indifferent to the cite, so it cannot break the case
   the cite was there to help.
4. Recorded fixtures still answer: hosts parsed from `tests/fixtures/serp-google.txt` all equal the host of
   their own `/url:` line — asserted from the fixture, not copied into the test.
5. `www.` and the FQDN terminator survive the collapse: a result whose url is
   `https://www.Example.test./x` reports `example.test`.

**Verification:** `NODE_ENV=test node --test tests/snapshot.test.mjs tests/search-tool.test.mjs` → **RED**,
with the failure naming the host assertion (record the output; a red that fails on an earlier line credits
nothing — see `invalidatedAssumptions` in the last handoff). Then `NODE_ENV=test npm test` → 393 − pass +
fail, and every failure is one of the cases above.

**Dependencies:** none. **Blocks:** U2.

### U2 — one host reader

**Goal:** page text cannot name a host; `hostOf` is the only reader; the unnormalised fallback is gone.

**Files:** `src/snapshot.ts`, `src/tools/search.ts`.

**Patterns to follow:** `hostOf` (`:414`) and `rawHostOf` already exist and are the trusted path; keep
`normalizeHost` in `src/net-policy.ts` as the only place a host is shaped. Comment style: one short line
saying *why*, as `:285-289` does.

**Implementation:** per Decision 1 — add `export function resultHost`, repoint `:223`, delete `hostFrom`,
delete the `||` fallback in `engineLabel`, `export function isWrapper` for U3.

**Test scenarios:** U1's cases turn green. Plus:

6. The deleted fallback's premise: every result `parseSerp` can emit has a non-empty `host` — so the branch
   has nowhere to live. (This is the pin that makes the deletion honest rather than convenient.)

**Verification:** `NODE_ENV=test node --test tests/snapshot.test.mjs tests/search-tool.test.mjs` → green;
`npm run typecheck` → clean (deleting `hostFrom` must leave no caller).
**Mutation:** restore `const citeUrl = cite?.match(...)` as the first branch → U1 case 1 goes red on the host
assertion alone. Record it.

**Dependencies:** U1. **Blocks:** U3 (exports `resultHost`, `isWrapper`).

### U3 — resolve recomputes the host, and asks one wrapper question

**Goal:** a resolved url carries the host of its destination, on the cache-hit path as much as the fresh one.

**Files:** `src/resolve.ts`, `tests/resolve.test.mjs`.

**Patterns to follow:** `tests/helpers/fake_gateway.mjs` already models both shapes — `redirects`
(*requested url → final url the browser lands on*) and `resolveFailures` (*goto urls that never resolve*);
`withDeadline` and the `finally` that always calls `closeTabQuietly` (`:98`) are unchanged.

**Test scenarios**

7. **Fix the blindness first:** the `result()` helper at `tests/resolve.test.mjs:17` stops hand-writing
   `host: "example.test"` and derives it from the url — with a case asserting the helper derives it, so the
   helper cannot quietly become a launderer of the bug it is meant to catch.
8. A wrapper (`resolvable: true`) whose destination is `https://someone-else.test/deal`: `resolved: true`,
   `url` is the destination, `host === "someone-else.test"`.
9. Same, then **again on the cache hit** — the second call must produce the same host without opening a tab
   (assert `/tabs/open` call count did not move, as `does not open a single tab for urls that are already
   final` at `:88` already does).
10. A destination whose url merely *contains* the bytes `google.com/goto?` (no `?url=`) is **resolved**, not
    reported `stayed on the redirect wrapper` — the case only the shared `isWrapper` gets right.
11. A `resolveFailures` url: `resolved: false`, `resolveError` set, url **and host** both unchanged.
12. Tabs: every case above leaves `trackTabLeaks(fake)` reporting zero.
13. **A `resolved: true` result never carries an empty `host`.** `resultHost` returns `""` for a url it cannot
    parse, and on the parser side that is rescued upstream (`isChrome` drops an ownerless block, `:170`) — but
    on the resolve side the only thing standing between a malformed gateway-reported destination and a blank
    third column on a result line is a guard in another module (`src/net-policy.ts`). Pin the property here
    rather than inherit it, or the rescue is a rumour. *(Found by the Strict Review's error map; the one gap
    it surfaced.)*

**Verification:** `NODE_ENV=test node --test tests/resolve.test.mjs` → green; `npm run typecheck` → clean.
**Mutations (each must go red, and on the assertion named):** (a) revert `:88` to
`/google\.com\/(goto|url)\?/u` → case 10 red; (b) drop the `host:` from the cache-hit return → case 9 red;
(c) drop it from the fresh-open return → case 8 red. A mutation that stays green is a test that asserts
nothing — say so in the commit rather than crediting it.

**Dependencies:** U2 (`resultHost`, `isWrapper`).

### U4 — the schema says who said it, and the doc records what was measured

**Goal:** `C.4` closed and `C.5`'s two named exceptions closed, with the evidence a future reader can re-run.

**Files:** `src/camoufox-gateway.ts` (two descriptions, Decision 3), `docs/improvements/2026-10-18-code.md`.

**Patterns to follow:** how `B.9` was written up — the item keeps its number, states what the fix was, names
the recording it was measured on, and says which pin now asserts the *right* answer. `C.2`'s treatment is the
model for a doc edit that closes an item without deleting its reasoning.

**Test scenarios:** none new (no behaviour). Two constraints bind:

- `tests/improvement-refs.test.mjs` scans `docs/improvements/*.md` **and every** `tests/*.test.mjs`: a ref
  written `` `src/resolve.ts` → `resultHost(known.url)` `` must find that fragment, a backticked path must
  exist, and `:123` line refs are banned outright. Fix a drifted ref honestly; never edit the doc to dodge a
  failure (last handoff's `activeRules`).
- `src/camoufox-gateway.test.mjs`'s registration-level contract check (6 calls, schema vs structuredContent)
  must stay green — descriptions are free, a shape change is not.

**Verification:** `NODE_ENV=test npm test` → all green, **and** the count stated in the doc must be the one
the instrument prints (U5 makes that check real; U4 must not claim a number it has not re-measured).

**Dependencies:** U2, U3 (the doc cites the final code).

### U5 — the committed G.6 reading cannot age silently again *(optional; cut it at the gate if you want the branch to stay one-idea)*

**Goal:** what I found while planning becomes impossible. `node scripts/measure-unregistered-pages.mjs` prints
`47 of 393` today; the committed fixture, the doc's fenced block and the script's header all say **387**.
`tests/measure-unregistered-pages.test.mjs:163-196` holds those three to *each other*
(`assert.deepEqual(fencedBlockStartingWith(doc, …), committed)`), and the only test that spawns the script
(`:69-88`) runs it against the tiny attribution probe and asserts `run.status === 0`. So #25 added six cases
and three places went stale in agreement — the same class the round that shipped the instrument described
fixing.

**Files:** `scripts/measure-unregistered-pages.mjs`, `package.json`, `tests/measure-unregistered-pages.test.mjs`.

**Implementation:** the script gains a `--check` mode that measures, **writes nothing**, and exits non-zero
naming each place whose figures differ (fixture, doc block, header). `package.json` gains
`"test:measure": "NODE_ENV=test node scripts/measure-unregistered-pages.mjs --check"`. The default
(write) mode is untouched, because the suite must not start measuring itself.

**Test scenarios:**

13. `--check` on the current tree **fails**, naming `387` against the measured `393` — the gate's own proof.
14. `--check` after a re-measure passes, and leaves the tree byte-identical (`git diff --exit-code`).
15. A planted disagreement (header off by one) is named, not silently rewritten.

**Verification:** `NODE_ENV=test npm run test:measure` → the only honest outcome either way, recorded.

**Dependencies:** none, but it must land with U4: U4 refreshes the trio to the live reading, and U5 is what
keeps it there.

## Verification strategy

| Level | Command | Expected |
| --- | --- | --- |
| Focused RED | `NODE_ENV=test node --test tests/snapshot.test.mjs tests/search-tool.test.mjs` (U1, before U2) | red, failing **on the host assertion** |
| Focused GREEN | same, after U2; `NODE_ENV=test node --test tests/resolve.test.mjs` after U3 | green |
| Suite | `NODE_ENV=test npm test` | 393 + new cases, 0 fail |
| Types | `npm run typecheck` | clean — it is also the proof `hostFrom` has no callers left |
| Regressions that must not move | `a page the asked engine does not own is never credited as its results`, `B.8's open half:`, `an adapter reports only links from the page it was sent to`, `a long page that merely mentions captchas is content, not a wall` | untouched, green |
| Mutations | the four named above | each red on its own assertion, output recorded in the commit |
| Property | U3 case 13: no `resolved: true` result with an empty `host` | green, and red when the `host:` is dropped |
| Instrument | `NODE_ENV=test npm run test:measure` (U5) | fails before the re-measure, passes after |
| Live spot check | `CAMOUFOX_GATEWAY_URL=http://192.168.8.110:9377 node scripts/verify-host-live.mjs` — one search with `resolve: false` and one with `resolve: true`, printing `host`/`url`/`cite` per result | **ran: 10 rows, 0 lies**, both paths. It also shows Decision A's cost in the raw: unresolved rows print `host="google.com"` beside `cite="https://github.com › daijro › ca…"`. **Inline override only — never edit config or `.env`** |
| Live suite | `CAMOUFOX_LIVE=1 npm run test:live` | **4 pass / 1 fail / 1 skipped** — `live: resolve turns wrappers into final urls` fails on a `goto` wrapper that never redirects. **Reproduced identically on `main`**, so it is the recorded live-google degradation, not this branch |

Formatting and lint are the last step once everything is green, per the repo's standing instructions.

## Acceptance

One sentence has to be true afterwards: **nothing in a search response can name a host the gateway did not
report.** `host` comes from `url`, the `url` it is derived from is the one being shown, and the only place
page-supplied text about provenance survives is the field that already carries it verbatim and is named for
what it is — `cite`.

## Execution record

All five units landed on `fix/result-host-attribution` (`c0b04bd` plan, `c645989` U1+U2, `cb24117` U3,
`8b8cc0b` U5, `a9e2028` U4). Final: **413 pass / 0 fail**, `tsc --noEmit` clean, `npm run test:measure`
exit 0. Where the plan turned out to be wrong, stated so the next plan does not repeat them:

- **"U3–U5 touch no file another unit touches" was false.** `tests/improvement-refs.test.mjs` reads
  `docs/improvements/*` refs as code, so any unit that *deletes cited code* inherits that doc's ref line. U2
  and U3 both hit it at 1-fail and both were ruled: repoint what your own deletion broke, leave the item's
  claims to the doc unit.
- **U1 was not "append only".** `tests/snapshot.test.mjs:48` asserted `host === "camoufox.com"` on a `goto`
  wrapper — the laundered byte, written into the suite as an expectation. Converted to the truth plus a
  `cite` assertion, in the B.9 tradition. A plan that promises append-only invites a plan author to not look
  for pins that assert the bug.
- **U2 case 6's premise had a hole.** `isChrome` is handed the *raw* hostname, so `https://./x` survives it and
  comes back `host: ""`. Pre-existing, cosmetic, pinned in `C.6` rather than guarded.
- **U3 case 7 cannot be written RED-first as written** — "fix the helper, with a case asserting the helper
  derives" is self-satisfying the moment the helper derives. The failing-first evidence had to be taken with
  the old helper deliberately restored (6 red, 2 of them the helper's own pin).
- **U5's "Dependencies: none" was wrong twice.** It depends on the doc's *shape* (exactly one fenced block
  starting `cases in the suite:`), and adding its own cases moved the figure the instrument publishes — the
  trio is 413 now, not the 407 the unit started against. A plan that adds test cases to a repo with a
  committed suite count must schedule the refresh in the same unit.
- **Decision 3 overstated its premise.** `host` and `cite` were not the only undescribed fields — `title`,
  `snippet` and `engine` have no stated source either. Only the two in scope were described; `engine` is
  page-influenced text too, and nothing says so.

## Review record

**Strict Review**, 2026-11-02 (CEO pass + error/failure maps + test diagram).

- **Approach A** (one derived reader) chosen over **B** (delete `host` from the schema and derive at print
  time — smaller, but a breaking change to a field published three days ago at 0.2.2) and **C** (a provenance
  type on every model-facing field — right class, 100x the diff, no second instance demanding it yet).
- **U5 stays in**, so the branch carries the instrument gate U4's numbers depend on.
- **One gap found and folded in:** U3 case 13, the `resolved: true` ⇒ non-empty `host` property. The failure
  modes registry has no `RESCUED=N / TEST=N / silent` row left.
- **The premise the review could not evidence, recorded honestly:** no exploit of this defect has been
  observed, live or in the wild. The case is that this is a tool whose whole job is reading pages served by
  sites actively trying to deceive it (`camofox-browser` is an anti-detect browser), and it publishes an
  attribution column a page can write. Door, not break-in.
- Rejected framing worth keeping: fixing the *printer* instead of the parser would leave `structuredContent`
  laundering the same byte — the same lesson as the settle round, where the message was right and the loop
  was wrong.

## Out-of-band findings from this planning session (recorded, not acted on)

- The stale instrument reading is U5, and it is real: measured `393`/`47`/`11` against a committed `387`.
  Running the instrument rewrites `tests/fixtures/measure/invented-page-count.txt` in place, so the drift is
  only visible if somebody runs it and looks — which is how it survived a release.
- `SearchResultSchema`'s `host` had no description while its six siblings do. A field with no stated source
  is how this defect stayed plausible, which is why Decision 3 is not polish.
- The scout subagent assigned to this recon wedged mid-thought (53 tool calls, no progress in 5 minutes) and
  the recon was done directly; noted so the run history does not read as if it contributed.
