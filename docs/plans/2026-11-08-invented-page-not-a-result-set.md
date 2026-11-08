# Plan

> Status: ready

**Requirements source:** `docs/improvements/2026-10-18-code.md` → `### G.6 The fake's invented article is a
page nobody registered, and one organic link is enough to pass`, measured on current code 2026-11-08. No
brainstorm backs this plan and none is needed: G.6 is an approved, evidence-bearing ledger item with a
measured baseline, an instrument, and a named end state — the same route `2026-11-02-result-host-attribution`
(C.4) took. The one thing this plan does *not* take from G.6 as filed is its conclusion; see
**Where this plan disagrees with the item**.

## Problem summary

`tests/helpers/fake_gateway.mjs` → `function defaultSnapshotFor(url) {` answers **any url a test did not
register** with an invented article. That article contains exactly one link line,

```js
"  - /url: https://camoufox.com/docs",
```

and `src/snapshot.ts` → `return hostIsEngineDomain(host, rule) && !(rule.wrappers && isWrapper(url));`
says `camoufox.com` is neither engine's domain — so it is not chrome, so it is an organic result, under the
`google` label and the `duckduckgo` label alike. **One link is a result set.** A search whose tab sat at
`https://duckduckgo.com/` returns a result, and the suite cannot tell.

The instrument already measures it: `node scripts/measure-unregistered-pages.mjs` publishes
**471 cases / 64 read the fake's invented page / 11 read it as an engine's results page**. All eleven read
an invented page at a `duckduckgo.com/?q=` url — every one of them a test that navigates to an engine and
registers nothing there.

Two facts about the instrument decide the shape of this work, and both were verified rather than assumed:

- **`classify` matches on the url, not the page** — `const owner = [...prefixes.entries()].find(([, prefix])
  => url.startsWith(prefix));`. So *removing the link does not lower the count of 11.* Only registering a
  real page at those urls does.
- **`assertSawTheKnownCase` holds the instrument's proof-of-life in the hand of the test G.6 must change.**
  `const KNOWN_CASE = "duckduckgo navigates straight to its query url";` — the instrument throws
  `no case reported an invented page, though "duckduckgo navigates straight to its query url" must — the
  recorder saw nothing` unless that one test still reads an invented page **and** still lands in `asResults`.
  The moment it registers a SERP, the instrument cannot publish anything at all.

So the order is forced: **re-arm the instrument, then register, then remove the link.** Doing it in any other
order either lands a red suite or lands a green suite that can no longer measure the thing it fixed.

## Where this plan disagrees with the item

G.6 says the fix "belongs with the callers that lean on it, not with the page." Measured on current code,
that conclusion came from the wrong mutation, and acting on it would cost an order of magnitude more risk
than the fix needs. Four reds in the ledger's own framing, recorded here so the closed entry says what was
actually true:

1. **The "350 of 384 stayed green" number is not a refusal and must not be quoted into a fix.** It came from
   deleting the navigation and opening both engines at their origin root. The mutation that closes this hole
   has a measured radius of **13**, and they are red in the right files.
2. **The page can be fixed, and fixing it there is one line.** Replacing the link with a non-link ref —
   page keeps its heading, its 14 paragraphs (~2.5k chars, well over `settleMinChars`) and its `[e1]` ref,
   and carries **zero `/url:` lines** — costs 13 reds and **zero collateral**. Registering the eleven is
   still required, but for the *count*, not for the suite's health.
3. **`11 read it as an engine's results page` is not the set that goes red.** One of the eleven,
   `a search names the engine it is trying, before it tries it`, asserts only its progress notes and stays
   green under every variant — `camoufox_search` renders the chain's `GatewayError` as tool text rather than
   throwing. Fixing the eleven is necessary to make the count honest; it is not sufficient to make them red.
4. **The item omits a binding constraint.** G.6 cites
   `` `tests/helpers/fake_gateway.mjs` → `- /url: https://camoufox.com/docs` ``, and
   `tests/improvement-refs.test.mjs` binds that citation as a literal-substring assertion over the file.
   Deleting the link turns an *unrelated* test file red unless the ledger is re-anchored in the same commit.

## Relevant learnings

- `docs/solutions/testing/committed-measurement-must-be-pinned-to-a-run.md` (high) — this plan's whole
  verification surface. Its prevention note is binding here: *"adding test cases moves a committed
  denominator. Schedule the re-measure in the same unit."* U4 carries it.
- `docs/solutions/architecture/derived-field-must-be-written-with-its-source.md` (high) — the same defect
  family: *"a bug survives because every test that could see it supplies the answer instead of computing
  it"*, and *"Never let a fixture hand-write a field the system-under-test owns."* Here the fixture hands
  over an entire answer — a results page — that the engine was supposed to earn. Its fix shape is the one to
  copy: **make the helper honest, then add a case asserting the helper is honest**, because a fixed helper
  that nobody pins can quietly go back to fabricating.
- `docs/solutions/integration/wall-detection-must-be-structural.md` (high) — why one link decides it: the
  organic-vs-chrome judgement is structural (`hostIsEngineDomain`), so a page's *shape* is what makes it a
  result set, and the shape is the thing to change.
- `docs/solutions/architecture/single-flight-cache-has-two-read-paths.md` (high) — the pattern for a count
  that can be silently bypassed; applies to the instrument's two predicates diverging.

**Prior art that was designed and never merged.** `.context/u2-offline-brief.md` specifies a
`syntheticPages: true/false` knob (`false: answer an unregistered url with an empty page, never an invented
one`), with `grep syntheticPages` returning zero hits in tracked code. It also carries a ban this plan
honours: *"Do not blanket-apply `syntheticPages: false`"*, and *"Do not 'fix' the generic page by moving its
link onto a google host."* See **Rejected**.

## Scope boundaries

**In:**
- `defaultSnapshotFor`'s invented article — its link line, which is the whole defect.
- Registering recorded pages for the eleven engine reads, keyed to adapter-derived urls.
- Re-arming `assertSawTheKnownCase` so a published `0` is a reading rather than a silence.
- The three designed casualties the measurement names, each handled deliberately rather than deleted.
- The ledger's re-anchor, its corrected mutation attributions, and the missing `CONTEXT.md` vocabulary.

**Out — with reasons:**
- **The 43 incidental readers of the 53.** They read the invented page and assert nothing about its content:
  cache ages, tab accounting, request shape, refusal-without-reading. Making them register a fixture would
  invent a page for no reason, which is the defect wearing a different hat. **The end state is `0 read it as
  an engine's results page`, not `0 read the invented page`.**
- **`syntheticPages` and any refusal mode.** A knob whose safe value nobody sets is a scoreboard, not a
  cure; blanket-false is both banned by prior art and measurably worse — a thin refusal page costs **48**
  reds (25 of them pure settle-loop artifact, exactly the cost `defaultSnapshotFor`'s own comment guards:
  *"read re-snapshots anything thinner than read.settleMinChars"*), and refusing by engine-results prefix
  costs **56**, because `https://www.google.com/search` is *shipped by substring* in this fake, not
  registered, so a prefix-based refusal deletes google's free SERP and takes 30+ collateral cases with it.
  "Unregistered" and "engine results url" are not the same predicate here — which is why the instrument has
  two predicates and intersects them only at `classify`.
- **Moving the link to an engine host.** Every `read` test depends on this page being non-engine chrome.
- **`a search names the engine it is trying, before it tries it` asserting results.** It passes with every
  engine failing. That is a real weakness and the same family as G.6, but it is not G.6's claim; it is filed
  as a follow-up in U4 rather than quietly widening this unit.
- Anything in `src/`. This is a suite-fidelity change; no production behaviour moves.

## Architecture decisions

**ADR-0003 — the fake answers an unregistered url with a page that cannot pass as a result set.** Created in
U1, before the risky change rather than after it. Three decisions meet the threshold because each has a
rejected alternative and a cost:

1. The invented page keeps its **bulk** and its **ref** and loses its **link** — rejecting both refusal modes,
   with the measured 48/56 collateral and the settle-loop reason recorded.
2. A published **zero** is reachable only when the instrument separately proves it can still see the page and
   can still classify a results read — rejecting "`assertSawTheKnownCase` stays as-is and a zero is accepted",
   which is a gate that passes when it stops measuring.
3. Pages are registered at **adapter-derived** urls via `engineResultPrefixes()`, never at a literal — the
   rule the instrument already states: *"a prefix pasted here would keep matching after the engine moved, and
   a measurement that matches the old url while the engine serves a new one reports the hole as closed."*

## Implementation units

### U1 — Re-arm the instrument, so a zero is a reading and not a silence

**Goal.** `node scripts/measure-unregistered-pages.mjs` can publish
`read it as an engine's results page: 0 of N`, and that zero is only reachable when the recorder demonstrably
saw pages *and* demonstrably can still classify a results read. Today it cannot: `assertSawTheKnownCase`
throws on a zero, and its anchor is the test U2 is about to fix.

**Files.** `scripts/measure-unregistered-pages.mjs`, `tests/measure-unregistered-pages.test.mjs`,
`tests/instrument-probe.mjs`, `docs/adr/0003-*.md` (create).

**Patterns to follow.** The instrument's own rule — *"Which pages are invented is answered by the unmodified
fake, which owns that decision"* — so the probe asks the fake rather than being told. And cases 13–15's
existing `mkdtemp` pattern (`cpSync(PROBE, join(dir, "tests", "instrument-probe.test.mjs"))`), which already
runs the instrument against a scratch suite with planted figures: that is where a controlled count of 1 and a
controlled count of 0 belong, because neither is reachable in the real suite on demand.

**Test scenarios.** RED first, all three before any change to `assertSawTheKnownCase`:
- A probe suite whose fake still ships the linked article → the instrument reports `1`, and the
  proof-of-life assertions pass. **This is the case that keeps the asResults detector from becoming
  unfalsifiable once the real suite reports 0.**
- A probe suite whose fake ships the fixed, linkless page → the instrument reports `0` and *publishes*,
  rather than throwing.
- A probe run in which the recorder sees nothing at all → it must still throw. A zero that came from a blind
  recorder is not a reading. This is the case the whole unit exists for.
- `an invented page is recognised, and the pages the fake ships are not` stays green throughout — the
  invention must remain detectable as an invention.
- The real suite still publishes 11 at the end of this unit: U1 changes the instrument's *guarantees*, not
  what the suite reads.

**Verification.**
`NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs tests/measure-unregistered-pages.test.mjs`
then `NODE_ENV=test npm test` and `node scripts/measure-unregistered-pages.mjs` (must still print
`11 of 471`, `ℹ fail 0`).
Mutations: make `pageWasInvented` always false → the asResults-probe case must go red (a detector that can
never fire cannot prove anything); make the recorder blind → the throw case must go red.

**Dependencies.** None. **Blocks U2.**

### U2 — Register a real results page for every engine read

**Goal.** `read it as an engine's results page` goes **11 → 0**. All eleven open a
`duckduckgo.com/?q=` url and register nothing there; each is handed google's shipped SERP or a registered
google page, then falls through to duckduckgo where the article answers.

**Files.** `tests/engines.test.mjs` (7), `tests/search-tool.test.mjs` (2), `tests/camoufox-gateway.test.mjs`
(2), new fixture(s) under `tests/fixtures/` only if `serp-duckduckgo.txt` cannot serve.

**Patterns to follow.** `tests/search-tool.test.mjs` → `C.4: the third line of a result names the host we
read off its url…`, whose comment already states the rule: *"registering the page is what keeps the case off
G.6's invented-page count"*. And `tests/engines.test.mjs` → `an adapter reports only links from the page it
was sent to`, which derives rather than pastes: `const prefixes = await engineResultPrefixes();` then
`setup(t, { pageContents: new Map([[url, page]]) })`. **No unit may hardcode `https://duckduckgo.com/?q=` as
a fixture key** — three consumers derive it so that an adapter which stops opening at a results page fails
naming itself, and a pasted url would report the hole as closed while the engine moved.

**Test scenarios.**
- Each of the eleven registers a recorded page at its adapter-derived url; each keeps every assertion it has
  today, unweakened. `duckduckgo navigates straight to its query url` must still assert
  `results.length > 0` — and must get that result from a *recorded* page, not the invention.
- `reports empty_results and keeps trying the chain` needs a duckduckgo page with **zero** organic results;
  its chrome-only counterpart already exists as `DUCKDUCKGO_NO_RESULTS` in the same file. Do not reach for
  `serp-no-results.txt` if it is google-shaped.
- `a search served from cache reports no wait it did not pay` registers a page for **both** engines at
  `?q=late`, not just the google side it registers today.
- `a search names the engine it is trying, before it tries it` registers too — it counts in the 11 even
  though nothing about it goes red.
- **The two directory sweeps are live consumers:** `tests/snapshot.test.mjs` →
  `const FIXTURES = readdirSync(new URL("./fixtures/", …))` and `tests/engines.test.mjs` →
  `const RECORDED_PAGES = readdirSync(…)` treat every `.txt` in `tests/fixtures/` as a recorded page. Any new
  fixture changes both, which is why the measurement fixture lives in `tests/fixtures/measure/`.
- `consentWallOn` keeps working unchanged: it rewrites the *tab url* at `/tabs/open` and is not a page
  registration. Do not route it through `pageContents`.

**Verification.**
`NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs tests/engines.test.mjs
tests/search-tool.test.mjs tests/camoufox-gateway.test.mjs tests/snapshot.test.mjs`, then `npm test`,
`npm run typecheck`, and `node scripts/measure-unregistered-pages.mjs` — **which must now print
`read it as an engine's results page: 0 of N` with `ℹ fail 0`**, and `npm run test:measure` must publish it.

**Dependencies.** U1.

### U3 — The invented page stops being a result set

**Goal.** The fake still answers an unregistered url — 43 tests legitimately need a page — with a page that
**no engine can be credited with a result on**. One line changes; everything else in this unit is answering
what that line correctly breaks.

**Files.** `tests/helpers/fake_gateway.mjs`, `tests/engines.test.mjs`,
`docs/improvements/2026-10-18-code.md`.

**Patterns to follow.** The comment already in the file is the spec for what must *not* change:
`// Realistically long on purpose: read re-snapshots anything thinner than read.settleMinChars, so a two-line
default page would make every unrelated read pay for the settle loop.` Keep the heading
(`- heading "Page: ${url}" [level=1]`, which six tests match on), keep the ~14 paragraphs, keep an `[e1]`
ref (four extract-path tests need a ref to exist). Change only the link.

**Test scenarios.**
- **The pin for the defect itself, RED first:** the fake's invented page yields **zero organic results under
  both the `google` label and the `duckduckgo` label**, while still being longer than `settleMinChars` and
  still carrying a ref. Red before the change, green after — this is the assertion that did not exist and is
  the reason the hole survived.
- The four readers that depend on `[e1]` and the six that depend on `Page: <url>` stay green: that is the
  evidence the page kept its bulk and its ref.
- **`an adapter reports only links from the page it was sent to` retires exactly as it asks to.** Its own
  assertion message already reads `the fake no longer invents a google results page at an unregistered url,
  so the guard above is vacuous — G.6 is closed, retire this case deliberately`. Retiring means **replacing**,
  not deleting: a case that registers a page per engine and still asserts each adapter reports only its own
  links. Coverage may not be traded for a green count.
- The ledger is re-anchored **in this commit**: G.6's citation
  `` `tests/helpers/fake_gateway.mjs` → `- /url: https://camoufox.com/docs` `` is a literal-substring
  assertion, so removing the line without re-anchoring redden `tests/improvement-refs.test.mjs` for a reason
  no reader would connect to this change.
- `pageAtIsInvented` / `pageWasInvented` must still recognise the invented page after it loses its link. The
  measurement saw this case fail under the link-removal variant, and the plan does not know why yet — U3 must
  establish it and keep the invention detectable, not delete the assertion that noticed.

**Verification.**
`NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs tests/helpers/… tests/engines.test.mjs
tests/read-tool.test.mjs tests/gateway.test.mjs tests/improvement-refs.test.mjs`, then `npm test`,
`npm run typecheck`, `npm run test:measure`.
**Report the red delta.** Before U2 the link-removal variant measured 13 failures (10 correct engine reds + 3
designed). After U2, the correct expectation is **the 3 designed casualties only**. Any engine-side red
surviving past U2 is a test reading the invention at an engine url that the instrument did not count — a
finding, not noise, and it must be reported rather than registered away.

**Dependencies.** U2.

### U4 — Close G.6 honestly, and name the two things that have no word

**Goal.** The ledger says what is now true, in the ledger's own voice, with the measurements attributed to
the mutations that produced them.

**Files.** `docs/improvements/2026-10-18-code.md`, `CONTEXT.md`,
`tests/fixtures/measure/invented-page-count.txt` + the two restatements, `docs/improvements/…` (follow-up).

**Test scenarios / content.**
- Close G.6 in place (`— closed:`, the code ledger's convention) with **both** numbers attributed: 350-of-384
  came from deleting the navigation and opening at origin roots; **13** came from removing the link. The two
  are not the same experiment and the entry must not let a reader conflate them.
- Record the follow-up this plan declined to absorb: `a search names the engine it is trying, before it tries
  it` passes when every engine fails, because it asserts only its progress notes.
- `CONTEXT.md` gains the vocabulary the work needs and the repo does not have — there is currently no word
  for a page a test registered, for the invented page, or for the count. The `Age bound` entry is the model:
  one term, the rule it carries, and the code fragment that owns it.
- Re-measure and reconcile the committed figures **in this unit** (`committed-measurement` prevention note):
  `node scripts/measure-unregistered-pages.mjs`, then the fixture, the doc's fenced block, and the script
  header all restated from the measurement — never hand-edited into agreement.

**Verification.** `NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs
tests/improvement-refs.test.mjs tests/measure-unregistered-pages.test.mjs`, then `npm test`,
`npm run typecheck`, `npm run test:measure` → exit 0.

**Dependencies.** U3.

## Verification strategy

Per unit, targeted first; then the whole:

```
NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs tests/<touched>.test.mjs
NODE_ENV=test npm test          # 471 today; may move, never below green
npm run typecheck               # tsc --noEmit, silent
NODE_ENV=test npm run test:measure   # the only thing that may publish a figure; exit 0
node scripts/measure-unregistered-pages.mjs   # must reach `0 of N` asResults by U2
```

**The mutation table is the deliverable, not the green.** For every pin above, the name of the change that
turns it red, or the assertion is credited rather than proven:

| Pin | Mutation | Expected |
| --- | --- | --- |
| Invented page is not a result set | restore the link line | the new pin red, and only it |
| asResults detector is not dead | `pageWasInvented` always false | the probe's count-of-1 case red |
| A zero requires a seeing recorder | blind the recorder | the throw case red |
| Registration is not a paste | hardcode a duckduckgo prefix and move `SEARCH_URL` in `src/engines/duckduckgo.ts` | the adapter names itself red |
| Page kept its bulk | thin the invented article below `settleMinChars` | settle-polling reds reappear (~25, the artifact this plan refuses to import) |
| Page kept its ref | drop the `[e1]` ref | the four extract-path readers red |
| Committed figures are a run | hand-edit one of the three copies | `test:measure` refuses, naming the stale place |

**Full-suite repeat:** run `npm test` twice at the end of U2 and U3 — several of these tests count requests
and reads, and a pass once is a coin flip.
