# Plan

> Status: done — U1–U4 landed on `fix/invented-page-not-a-result-set`, 2026-11-08

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

**Strict Review run 2026-11-08:** `docs/plans/reviews/2026-11-08-invented-page-not-a-result-set-strict-review.md`.
Eleven findings, three blocking, all folded in below. Two corrected instructions this plan had gotten wrong on
its own authority — R2 named a constant that does not exist and gave one unit backwards, and R9 caught a
figure asserted with no run behind it. Every reviewer claim that needed a command was run by the author before
folding; where the reviewer was wrong, the correction is recorded in the artifact.

**A second Strict pass then reviewed the folded text** — `docs/plans/reviews/2026-11-08-invented-page-not-a-result-set-strict-review-r2.md`
— and **blocked** the plan: the U1 mechanism written in response to R1 was broken five ways (F1–F5), including
one that made the plan's own `0 of N` end state unreachable. It also measured a claim this author had asserted
from a single ad-hoc sample (F6). That mechanism as corrected is what U1 now specifies; read the r2 artifact
before implementing U1. **Lesson for the next plan: a review that rewrites a plan leaves the rewrite
unreviewed — budget the second pass.**

## Where this plan disagrees with the item

G.6 says the fix "belongs with the callers that lean on it, not with the page." Measured on current code,
that conclusion came from the wrong mutation, and acting on it would cost an order of magnitude more risk
than the fix needs. Four reds in the ledger's own framing, recorded here so the closed entry says what was
actually true:

1. **The "350 of 384 stayed green" number is not a refusal and must not be quoted into a fix.** It came from
   deleting the navigation and opening both engines at their origin root. The mutation that closes this hole
   has a measured radius of **13** *(in `tests/engines.test.mjs`, measured pre-U2 — F8: post-U2 the set is the
   named casualties across four files, and `npm test` cannot even see one of them)*, and they are red in the
   right files. U4 publishes the **post-U2** count, not this one.
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
- **The incidental readers — 52 of the 64, once the eleven and the instrument's own deliberate reader are
  subtracted.** (An earlier draft said "43 of the 53" with no derivation at all; the review caught it as R9.)
  They read the invented page and assert nothing about its content:
  cache ages, tab accounting, request shape, refusal-without-reading. Making them register a fixture would
  invent a page for no reason, which is the defect wearing a different hat. **The end state is `0 read it as
  an engine's results page`, not `0 read the invented page`.**
- **`syntheticPages` and any refusal mode.** Rejected on the reason the first draft missed, which is stronger
  than the one it gave: the instrument asks an **untouched** fake — `article ??= inventedPageText(INVENTION_PROBE);`
  — so a knob defaulting to `true` measures only the dishonest mode forever, and flipping the default to
  `false` makes `pageAtIsInvented`'s `return invention !== null && served === invention;` true for **every**
  url, registered pages and the shipped google SERP included, so the invented count silently becomes the suite
  total. A knob whose safe value inverts the instrument is worse than a knob nobody sets — and refusing a
  second fake in the suite while U1 requires one in a scratch directory is not a coherent reason either. A
  knob whose safe value nobody sets is a scoreboard too, but that is the weak argument, not the reason:
  blanket-false is both banned by prior art and measurably worse — a thin refusal page cost **48** reds, 25 of
  them pure settle-loop artifact (recon run, not this author's estimate), exactly the cost
  `defaultSnapshotFor`'s own comment guards — a two-line default page makes every unrelated read pay for the
  settle loop. *(Paraphrased, deliberately: the file wraps that comment and backticks* `read`*, so it is not
  byte-identical — R7. Any copy of it into the ledger must come from the source file, not from this page.)*
  And refusing by engine-results prefix
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
   with the measured 48/56 collateral and the settle-loop reason recorded. **And it survives by decision, not
   by omission:** the closed entry has to say so in those words, or the next reader will trust a ~3k-char
   article nobody registered as if it were a document.
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
`docs/adr/0003-*.md` (create).

**Patterns to follow.** The instrument's own rule — *"Which pages are invented is answered by the unmodified
fake, which owns that decision"* — so the probe asks the fake rather than being told. And cases 13–15's
existing `mkdtemp` pattern (`cpSync(PROBE, join(dir, "tests", "instrument-probe.test.mjs"))`), which already
runs the instrument against a scratch suite with planted figures: that is where a controlled count of 1 and a
controlled count of 0 belong, because neither is reachable in the real suite on demand.

**Test scenarios.** RED first, all three before any change to `assertSawTheKnownCase`:
- A probe suite whose fake still ships the linked article → the instrument reports `1`, and the
  proof-of-life assertions pass. **This is the case that keeps the asResults detector from becoming
  unfalsifiable once the real suite reports 0.**
- A probe suite whose fake ships the fixed, linkless page **and whose case registers a page at the derived
  engine url** → the instrument reports `0` and *publishes*, rather than throwing. (F4: the first version
  omitted the registration, and since `classify` matches on the url alone it reported `1` — a RED case that was
  red for the wrong reason and would have shipped with the unit.) The linkless fake *without* registration
  stays as a third scenario that must still report `1`, because that is the case proving the detector fires.
- **A recorder self-probe — the mechanism R1 demanded, as corrected by the second pass (F1–F3). The first
  version of this bullet was broken and would have defeated the unit's own goal.** Do **not** issue probe
  requests through the recorded path: `let current = "(unnamed)";` is written only by
  `beforeEach(function () {`, so a preload-time request is attributed to a case literally named `(unnamed)`,
  `caseNames(cases)` then counts one phantom per file, and — because `classify` matches on the url alone — that
  probe url enters `asResults` and **`read it as an engine's results page` can never reach 0**. The shape that
  works:
  - issue the probe into a **separate map flushed under its own prefix** that `parseReport` cannot match, so it
    is invisible to `byCase`, `asResults` and every denominator; the proof-of-life is the **marker's presence in
    the run's output**, not an entry in `byCase`;
  - **install a fake on `globalThis.fetch` before issuing and restore after** — `measure()` imports
    `tests/helpers/fetch_guard.mjs` *before* the preload and that file throws on any live request, so a probe
    calling the global directly kills every child and the run reports nothing was measured. Follow
    `inventedPageText`, which uses `fake.fetch(…)` for exactly this reason;
  - **do not** derive the probe url by running an adapter through a stubbed `globalThis.fetch`:
    `engineResultPrefixes()` saves and replaces the global itself and answers the adapters from an inline stub
    that never reaches the fake, so the probe would record nothing and satisfy its own precondition by
    accident. Pass the prefix in from the parent instead, keeping ADR-0003 #3's no-literal rule at the place
    that matters.
- **What `assertSawTheKnownCase` becomes — state it in code, or U2's `0 of N` is unreachable (F5).** It can no
  longer be a name test on `KNOWN_CASE`, since U2 registers that very page. It becomes: the probe marker is
  present in the parsed output **and** the probe's url classified against a real engine prefix; throw
  otherwise. Name the existing gate cases this rewrites — `assert.throws(() => assertSawTheKnownCase([], []),
  /the recorder saw nothing/u)` among them — rather than leaving them to fail mysteriously.
- **The blindness case, redefined (F3 — the first version could not be constructed).** *Probe marker absent
  while the child suite still printed `ℹ tests N` → the instrument must still throw.* With an unconditional
  preload probe, `byCase` is never empty, so the earlier "empty `byCase`" wording made the guard untestable and
  its mutation row unbreakable. Delete that wording and its row; this replaces them.
- The two headline figures use **different denominators** — `caseNames(cases)` on file+name, and
  `new Set(asResults.map((one) => one.name)).size` on name only — so a proof-of-life written against `cases`
  is not one for `asResults`. Pin the asymmetry, or a future "simplification" fuses them and one counter stops
  being graded.
- `an invented page is recognised, and the pages the fake ships are not` stays green throughout — the
  invention must remain detectable as an invention.
- The real suite still publishes 11 at the end of this unit: U1 changes the instrument's *guarantees*, not
  what the suite reads.

**Verification.**
`NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs tests/measure-unregistered-pages.test.mjs`
then `NODE_ENV=test npm test` and `node scripts/measure-unregistered-pages.mjs` (must still print
`11 of N` — **not** `11 of 471`; U1 adds cases, and the denominator is the child runner's `ℹ tests N`, so it
moves by construction. Restate all three committed places in this unit, not in U4 — F9), `ℹ fail 0`.
Mutations: make `pageWasInvented` always false → the count-of-1 probe case must go red (a detector that can
never fire cannot prove anything); **delete the `throw` in `assertSawTheKnownCase`** → the empty-`byCase`
refuse case must go red. *(The first draft's mutation here — "blind the recorder" — was unbreakable: blinding
the recorder makes the throw case's own expectation true. An assertion you cannot break is asserting nothing;
that is R6, and it is why this row names deleting the guard rather than exercising it.)*

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
- `reports empty_results and keeps trying the chain` needs a duckduckgo page that **answers**. The case stubs
  an `empty` engine and then asserts `assert.equal(outcome.engine, "duckduckgo",`, so the real adapter has to
  produce results — the first draft said "zero organic results" and would have made it red (R2). Use
  `DUCKDUCKGO_SERP`, or `DUCKDUCKGO_SKELETON` for the chrome-only shape. **There is no
  `DUCKDUCKGO_NO_RESULTS`**: the file defines `GOOGLE_NO_RESULTS` and `DUCKDUCKGO_BLIND_PAGE`, and reaching for
  a phantom constant is how an implementer ends up inventing a fixture nobody asked for. Mind the neighbours
  too — a page that is not `results`-shaped trips `src/engines/settle.ts` →
  `if (classifySerp(snapshot, engine).kind === "results") return false;` and pays stability looks, which
  request-count assertions in adjacent cases will read as a regression.
- `a search served from cache reports no wait it did not pay` registers a page for **both** engines at
  `?q=late`, not just the google side it registers today.
- `a search names the engine it is trying, before it tries it` registers too — it counts in the 11 even
  though nothing about it goes red.
- **The two directory sweeps are live consumers:** `tests/snapshot.test.mjs` →
  `const FIXTURES = readdirSync(new URL("./fixtures/", …))` and `tests/engines.test.mjs` →
  `const RECORDED_PAGES = readdirSync(…)` treat every `.txt` in `tests/fixtures/` as a recorded page. Any new
  fixture changes both, which is why the measurement fixture lives in `tests/fixtures/measure/`.
- **Acceptance bar for any new `.txt`** (R10): existing is not enough, it must satisfy both sweeps' *claims* —
  `tests/snapshot.test.mjs` → `assert.deepEqual(matching, ["page-network-error.txt"]);` and the
  `RECORDED_PAGES` sweep's `assert.equal(snapshots, wanted ? 2 : 1, …)`, per engine, at every reported url. A
  fixture that is refusal-shaped, or whose text and url disagree about the predicate, reddens two files that
  have nothing to do with this item.
- **Derive everywhere, including where the suite already cheats.** If a case today keys `pageContents` on a
  literal duckduckgo url, convert it in this unit: a literal left standing makes the "registration is not a
  paste" mutation fire on a google-only engine move, which is a false alarm that will get the mutation
  deleted.
- `consentWallOn` keeps working unchanged: it rewrites the *tab url* at `/tabs/open` and is not a page
  registration. Do not route it through `pageContents`.

**Verification.**
`NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs tests/engines.test.mjs
tests/search-tool.test.mjs tests/camoufox-gateway.test.mjs tests/snapshot.test.mjs
tests/measure-unregistered-pages.test.mjs`, then `npm test`,
`npm run typecheck`, and `node scripts/measure-unregistered-pages.mjs` — **which must now print
`read it as an engine's results page: 0 of N` with `ℹ fail 0`**, and `npm run test:measure` must publish it.

**Dependencies.** U1.

### U3 — The invented page stops being a result set

**Goal.** The fake still answers an unregistered url — the incidental readers genuinely need a page — with a
page that **no engine can be credited with a result on**. One line changes; everything else in this unit is
answering what that line correctly breaks.

**Files.** `tests/helpers/fake_gateway.mjs`, `tests/engines.test.mjs`,
`tests/measure-unregistered-pages.test.mjs`, `tests/instrument-probe.mjs`, `docs/improvements/2026-10-18-code.md`.
The last two test files were missing from the first draft (R3): the first asserts
`whole.slice(whole.indexOf("- link"))`, which becomes `slice(-1)` — one character, under
`MIN_INVENTED_PAGE_CHARS` — the moment no `- link` exists; and the probe asserts
`assert.ok(outcome.results.length > 0, "the invented page parsed as results, which is the hole G.6 counts")`,
which the link removal also breaks. **`npm test` cannot see that second one**: `package.json` →
`"test": "NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs tests/*.test.mjs"` stops short of
`instrument-probe.mjs`, so it must be run and reported explicitly rather than counted.

**Patterns to follow.** The comment already in the file is the spec for what must *not* change:
`// Realistically long on purpose: read re-snapshots anything thinner than read.settleMinChars, so a two-line
default page would make every unrelated read pay for the settle loop.` Keep the heading
(`- heading "Page: ${url}" [level=1]`, which six tests match on), keep the ~14 paragraphs, keep an `[e1]`
ref (four extract-path tests need a ref to exist). Change only the link.

**Test scenarios.**
- **The pin for the defect itself, RED first:** the fake's invented page yields **zero organic results under
  both the `google` label and the `duckduckgo` label**, while still carrying a ref. Red before the change,
  green after — this is the assertion that did not exist, and it is the reason the hole survived. Four
  corrections the second pass forced (F6, F7), each of which made the pin as originally written lie:
  - the headline claim must go through **`parseSerp`**, not `classifySerp` — an off-engine url returns
    `empty_results` from `if (!engineOwnsUrl(engine, url)) {` **before** any parsing, so `classifySerp` reports
    "no results" for a page it never read, which is the pin passing for the wrong reason;
  - `detectWall` takes a snapshot, not a string: `export function detectWall(snapshot: SnapshotLike):`.
    Pass `detectWall({ url: THE_URL, text: page }) === null` as `tests/snapshot.test.mjs` already does — hand it
    a bare string and `const text = snapshot.text ?? "";` yields `""`, `empty_page` fires, and the assertion is
    **permanently red with `typecheck` silent**, since `tsconfig.json` → `"include": ["src/**/*.ts"]` and these
    are `.mjs` files;
  - **name the url**, and assert on the page for that url. The heading `- heading "Page: ${url}" [level=1]`
    echoes it, so every length claim below is a property of *(page, url)* — see the table under "the length is
    the url's, not the page's";
  - the three thresholds are **module-private** (`const INTERSTITIAL_MAX_CHARS = 3_000;`,
    `const PARSEABLE_MIN_CHARS = 2_000;`, and `settleMinChars` only inside `DEFAULT_CONFIG`). Do not export one
    — that breaks this plan's own `src/` boundary. Pin the literals with an anchored ref beside each, the way
    `tests/snapshot.test.mjs` already does, and use `DEFAULT_CONFIG.read.settleMinChars` for the lower bound.

  So the band is `DEFAULT_CONFIG.read.settleMinChars < len < 3_000` **and** `len > 2_000` — three bounds, not
  two, because `PARSEABLE_MIN_CHARS` is what decides whether the linkless page is `parse_error` or
  `empty_results`, which is the behaviour U3 depends on and the eleven's reds are made of. And
  - `!/\/url:/u.test(page)` — no `/url:` line survives.

  **the length is the url's, not the page's (F6, measured).** Because the heading echoes the requested url, one
  invented page sits on both sides of the phrase-evidence window depending on how long the url that asked for
  it happens to be:

  | url asked for | page length | `<= INTERSTITIAL_MAX_CHARS` |
  | --- | --- | --- |
  | `https://example.test/` | 2976 | yes — phrase evidence taken |
  | `https://duckduckgo.com/?q=camoufox` | 2989 | yes |
  | `https://duckduckgo.com/?q=camoufox%20anti-detect` (`KNOWN_CASE`) | **3003** | **no** |
  | the instrument's own `INVENTION_PROBE` url | **3012** | **no** |

  The first draft's single "2987, 13 characters from flipping" was measured at a url invented on the spot, and
  is wrong at both urls the instrument itself uses. State the measured length for the named url in the
  assertion message. `isBrowserRefusal` is today short-circuited by
  `if (lines.some((line) => /\/url:/u.test(line))) return false;` — remove the link and the page stands on one
  condition only, the absence of a `RETRY_AFFORDANCE` line. That is why the substitute must not be a
  `"Try again"`-shaped button, and why a pin without a named url asserts a coincidence.
- The four readers that depend on `[e1]` and the six that depend on `Page: <url>` stay green: that is the
  evidence the page kept its bulk and its ref.
- **`an adapter reports only links from the page it was sent to` retires exactly as it asks to.** Its own
  assertion message already reads `the fake no longer invents a google results page at an unregistered url,
  so the guard above is vacuous — G.6 is closed, retire this case deliberately`. Retiring means **replacing**,
  not deleting: a case that registers a page per engine and still asserts each adapter reports only its own
  links. Coverage may not be traded for a green count. **Keep the title verbatim** — the ledger cites it as an
  anchored fragment, twice, so renaming it orphans the ledger in the commit that re-anchors it (R7). And the
  replacement must carry its own reachable self-vacuity red (R8): state, and test, what makes it fail if the
  fake starts inventing a linked page again — the case it replaces carried that self-report in its own
  assertion message, and a replacement without one is a pin that cannot go red.
- The ledger is re-anchored **in this commit**: G.6's citation
  `` `tests/helpers/fake_gateway.mjs` → `- /url: https://camoufox.com/docs` `` is a literal-substring
  assertion, so removing the line without re-anchoring redden `tests/improvement-refs.test.mjs` for a reason
  no reader would connect to this change.
- **The first draft's open question, resolved (R5): stop looking at `pageAtIsInvented`.** It is
  `return invention !== null && served === invention;` — template against template, true by construction for
  any generically answered url — and `pageWasInvented` compares against a template derived from the same
  helper, so removing content cannot un-match it. Decide it in minutes rather than hours:
  `CAMOUFOX_MEASURE_INVENTED=1 node --test --import ./tests/helpers/fetch_guard.mjs --import ./scripts/measure-unregistered-pages.mjs tests/engines.test.mjs 2>&1 | grep INVENTED-PAGE`
  — if the eleven lines still print, the recorder is intact and the observed failure was never the invention
  predicate. Re-attribute it to one of three real causes, each with a different fix: `assertSawTheKnownCase`
  throwing, the `indexOf("- link")` assertion above, or the eleven moving onto the `parse_error` path.

**Verification.**
`NODE_ENV=test node --test --import ./tests/helpers/fetch_guard.mjs tests/engines.test.mjs
tests/read-tool.test.mjs tests/gateway.test.mjs tests/improvement-refs.test.mjs`, then
`npm test`,
`npm run typecheck`, `npm run test:measure`.
**Report the red delta.** Before U2 the link-removal variant measured 13 failures. After U2 the expectation is
**the named casualties only**: `an adapter reports only links from the page it was sent to`,
`an invented page is recognised, and the pages the fake ships are not`, and the `instrument-probe.mjs`
case that `npm test` never runs. Any engine-side red surviving past U2 is a test reading the invention at an
engine url the instrument did not count — a finding, not noise, and it must be reported rather than registered
away. Note also that row 1 of the mutation table below is only true **in the post-U2 tree**; measured in U3's
own commit before registration it is false, which is why the units may not be reordered.

**Dependencies.** U2.

### U4 — Close G.6 honestly, and name the two things that have no word

**Goal.** The ledger says what is now true, in the ledger's own voice, with the measurements attributed to
the mutations that produced them.

**Files.** `docs/improvements/2026-10-18-code.md`, `CONTEXT.md`,
`tests/fixtures/measure/invented-page-count.txt` + the two restatements, `docs/improvements/…` (follow-up).

**Test scenarios / content.**
- Close G.6 in place (`— closed:`, the code ledger's convention) with **both** numbers attributed: 350-of-384
  came from deleting the navigation and opening at origin roots; **13** came from removing the link, and that 13
  is the **pre-U2** figure confined to `tests/engines.test.mjs`. Publish the count U3 actually observed
  post-U2, naming the two files `npm test` does not run. The two are not the same experiment and the entry must
  not let a reader conflate them.
  **MEASURED IN U4 — and this bullet's own qualification was wrong.** The 13 is not confined to
  `tests/engines.test.mjs`: a worktree at the U1 commit with only the fake's line removed gives **8** there, 1
  in `tests/camoufox-gateway.test.mjs`, 2 in `tests/search-tool.test.mjs`, 1 in
  `tests/measure-unregistered-pages.test.mjs`, 1 in `tests/improvement-refs.test.mjs`. The post-U2 figure is
  **4**, plus **1** in `tests/instrument-probe.mjs`; the other file `npm test` never runs,
  `tests/instrument-rig.mjs`, stayed green because its cases plant either shape of fake on demand.
- Record the follow-up this plan declined to absorb: `a search names the engine it is trying, before it tries
  it` passes when every engine fails, because it asserts only its progress notes.
- `CONTEXT.md` gains the vocabulary the work needs and the repo does not have — there is currently no word
  for a page a test registered, for the invented page, or for the count. The `Age bound` entry is the model:
  one term, the rule it carries, and the code fragment that owns it.
- Re-measure and reconcile the committed figures **in this unit** (`committed-measurement` prevention note):
  `node scripts/measure-unregistered-pages.mjs`, then the fixture, the doc's fenced block, and the script
  header all restated from the measurement — never hand-edited into agreement.
- **Say that the invented page survives by decision**, not by oversight, and why: `read` needs a page thick
  enough to settle on, and the incidental readers assert nothing about the one they get. Without that sentence
  the closed entry reads as "the fake no longer invents pages", which is not what this did.
- **File the terminal shape as its own ledger item** rather than letting this one imply it was reached: the
  fake should one day answer an unregistered url with *nothing* — `""`, which `src/snapshot.ts` already names
  `empty_page` — with bulk registered by whoever wants it, and the instrument's two predicates retiring
  because no invention is left to count. This plan deliberately does not do that, and the review's reason for
  the gap is the drift risk worth recording: keeping bulk *and* a ref makes ~52 cases comfortable with a
  fabricated document, which makes the terminal step harder **after** this than before it. Naming that cost is
  what stops the follow-up from being quietly dropped.
- **Every fragment copied into the ledger comes from the source file, never from this plan** (R7): the ref gate
  is a literal-substring comparison, and this page paraphrases the `defaultSnapshotFor` comment rather than
  quoting it byte-for-byte.

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
| Invented page is not a result set | restore the link line | the new pin red, and only it — **and only in the post-U2 tree**; measured before registration it is false, which is what makes the order load-bearing |
| asResults detector is not dead | `pageWasInvented` always false | the probe's count-of-1 case red. Breakable **only because** the scratch rig copies `scripts/` and spawns the copy — say so in the case, because a refactor to import the module instead silently un-breaks this row |
| A zero requires a seeing recorder | **delete the `throw`** in `assertSawTheKnownCase` | the empty-`byCase` refuse case red |
| A zero requires a seeing recorder, second form | probe marker absent while the child suite still prints `ℹ tests N` | the refuse case red *(the first draft's "blind the recorder" row was unbreakable, and its replacement — empty `byCase` — was unconstructable once the probe was unconditional: F3)* |
| Registration is not a paste | hardcode a duckduckgo key and move `SEARCH_URL` in `src/engines/duckduckgo.ts` | the adapter names itself red |
| Page kept its bulk | thin the invented article below `settleMinChars` | settle-polling reds reappear — **measured in U4: 30 failures**, and `the page the fake invents is not a result set, and not a refusal either` among them |
| Page stays parseable | trim the invented article **below 2_000** characters, staying above `settleMinChars` | **measured in U4: 1 red — the pin's own 2_000 bound, and nothing else**, which is what "the page crosses `const PARSEABLE_MIN_CHARS = 2_000;` and flips from `parse_error` to `empty_results`" looks like once the eleven are registered. *(An earlier version of this row said "trim ~60 characters"; 2987−60 crosses nothing — F4 of the second pass, a row that could not turn anything red.)* |
| Page is not a browser refusal | add a `- button "Try again"` line | the `detectWall({ url, text }) === null` assertion goes red — **and so does every `read` of the invented page**, so unlike row 1 this row may not claim "and only it" |
| Page kept its ref | drop the `[e1]` ref | **measured in U4: 4 failures**, every one of them an extract-path reader |
| Committed figures are a run | hand-edit one of the three copies | `test:measure` refuses, naming the stale place |

**Full-suite repeat:** run `npm test` twice at the end of U2 and U3 — several of these tests count requests
and reads, and a pass once is a coin flip.
