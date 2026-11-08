# Strict Review — `The fake's invented article is a page nobody registered` plan (2026-11-08)

Plan: `docs/plans/2026-11-08-invented-page-not-a-result-set.md` (Status: ready, 4 units) · Mode: **Strict**
(premise challenge, dream state, alternatives, temporal interrogation, error/rescue map, failure modes, test
diagram) · Requirements: `docs/improvements/2026-10-18-code.md` →
`### G.6 The fake's invented article is a page nobody registered, and one organic link is enough to pass`

**Reviewer tooling limitation, stated because it bounds two verdicts.** The reviewer subagent was given only
a `read` tool — no shell — so it could not run the suite, the instrument, a scratch patch, an md5, or
`git status --porcelain`. Claims needing a run were labelled `RUN-NEEDED` with the exact command. **The
author then ran every one of them; the results are recorded inline as `AUTHOR RUN:` and, where the reviewer
was wrong, the correction is recorded too.** Nothing in the tree was modified by the review.

**Outcome: the plan's diagnosis is right, its order is right, and its unit boundaries are wrong in three
places that would have cost a red suite or a false published zero.** R1–R11; **R1, R2, R3 blocking**.

---

## Verification of the four recon claims

### Claim 1 — `classify` matches the url prefix, so link removal does not move the 11. **TRUE.**

`scripts/measure-unregistered-pages.mjs` → `const owner = [...prefixes.entries()].find(([, prefix]) =>
url.startsWith(prefix));` — page content is never consulted. Recording happens upstream, in a recorder whose
only page test is content-identity against the fake's own template:
`return invention !== null && text.length >= MIN_INVENTED_PAGE_CHARS && invention.includes(text);`. Because
`inventionForUrl` derives its template from the **same** `defaultSnapshotFor` the deletion edits, removing
bytes removes them from both sides of the comparison. The recorded url set is invariant under the removal, so
the count cannot move. **The forced order is real; agree with U1→U2→U3.**

### Claim 2 — a published zero is unreportable, and its anchor is one of the eleven. **TRUE, no other exit.**

`export const KNOWN_CASE = "duckduckgo navigates straight to its query url";` guards twice:
`if (!cases.some((one) => one.name === KNOWN_CASE)) {` and `if (!asResults.some((one) => one.name ===
KNOWN_CASE)) {`. That test is one of the eleven, and asserts `assert.ok(outcome.results.length > 0);` with no
registration. No other exit: `assertSawTheKnownCase(cases, asResults);` sits **before** the published arrays
and before `if (write)`; `check()` is `const reading = await measure({ write: false });`, so it goes through
the same throw. And the gate does not rescue it —
`tests/measure-unregistered-pages.test.mjs` → `assert.ok(suite.count > 0 && invented.count > 0, …)` is
**silent on `asResults`**. The gate never forbade the zero; only the instrument's own throw did.

One correction to the plan's framing: the proof-of-life already survives in scratch copies only because
`cpSync(PROBE, join(dir, "tests", "instrument-probe.test.mjs"));` puts a *second* case named `KNOWN_CASE`
into the copy's glob. The instrument's proof-of-life is already a copy of a literal.

### Claim 3 — blast radii 48 / 56 / 13-with-zero-collateral. **PARTLY VERIFIED; the 13 is incomplete.**

`AUTHOR RUN:` the link→non-link-ref scratch patch was **not** reproduced by the reviewer; the author ran it —
see U3's file list under R3, which changes the number's meaning. What is verified from source: google's SERP
is shipped by substring (`if (url.includes("google.com/search")) {`), so a prefix-keyed refusal swallows it —
the 56 is mechanically sound. The **13 is understated**, because provable breakages exist that U3's Files
never listed: `tests/measure-unregistered-pages.test.mjs` and `tests/instrument-probe.mjs`. See **R3**.

### Claim 4 — "the 3 designed casualties". **WRONG, and it hides a test `npm test` cannot see.**

| # | Case | Proof it goes red | In U3's Files as written? |
| --- | --- | --- | --- |
| 1 | `tests/engines.test.mjs` → `an adapter reports only links from the page it was sent to` | `["https://camoufox.com/docs"],` | yes |
| 2 | `tests/measure-unregistered-pages.test.mjs` → `an invented page is recognised, and the pages the fake ships are not` | `whole.slice(whole.indexOf("- link"))` → `slice(-1)` | **no** |
| 3 | `tests/instrument-probe.mjs` → `test(KNOWN_CASE, …)` | `assert.ok(outcome.results.length > 0, …)` | **no**, and `package.json` → `"test": "… tests/*.test.mjs"` never runs it |

`AUTHOR RUN:` all three citations confirmed verbatim in the tree. The plan's **U2 allocation was exactly
right** — 7 / 2 / 2 across `engines` / `search-tool` / `camoufox-gateway`, all eleven at
`https://duckduckgo.com/?q=` and none at the google prefix — read off a run, not guessed. That deserves
credit and is why U2 is not a finding.

---

## 1. Premise challenge

| Premise a human must accept | Verdict |
| --- | --- |
| **G.6 is the right problem to solve first.** | **Yes, with one caveat.** It is the only ledger item where the *test helper* fabricates the answer the code under test must earn — the family `docs/solutions/architecture/derived-field-must-be-written-with-its-source.md` names. But `### B.8 A page that says we were blocked is reported as a search that returned one result` is a live **model-facing** wrong answer on the same `classifySerp` seam, only half closed. G.6 is defensible first *because it re-arms the instrument every other item measures with* — the plan should say that rather than rest on "the item has a baseline". |
| **"Keep the bulk and the ref, strip the link" is the cure G.6 claims.** | **Narrower than the item, honestly so — but unlabelled.** Afterwards, an engine navigating *nowhere it registered* still gets a page; it just cannot be credited with a result. `read` at an unregistered url still fabricates ~3k chars nobody registered, which 52-ish tests assert against. Say the invented page survives **by decision**, because the closing entry will be read as "G.6 fixed" by someone who then trusts that page as a document. |
| **Doing nothing is fine.** | **No.** `an adapter reports only links from the page it was sent to` is the only thing between an adapter that stopped navigating and a green suite, and its own message admits it will go vacuous. The instrument's `11` stays frozen as a published fact. |
| **The order is forced (re-arm → register → strip).** | **True and correctly derived** from Claims 1–2. The plan's best contribution; not to be re-litigated during implementation. |
| **The incidental readers must stay incidental.** | **Right call, wrong number.** 64 − 11 − 1 deliberate (`One of the 64 reads it on purpose`) = **52**, not the 43 the plan asserts twice. 43 has no derivation. The decision stands; the figure must go. **R9.** |
| **No refusal mode.** | **Accepted — and better than the plan argues.** See Approach C. |
| **`a search names the engine it is trying, before it tries it` is filed, not fixed.** | **Correctly scoped.** `AUTHOR RUN:` its whole assertion is `assert.deepEqual(notes, ['searching "camoufox" with google', 'searching "camoufox" with duckduckgo']);` — green whether or not any engine answered. Widening here is scope creep; filing is right. |

## 2. Dream state mapping

```
CURRENT STATE                       THIS PLAN                            12-MONTH IDEAL
defaultSnapshotFor(url) answers     same helper, but an                   The fake has no "default" page
ANY url: google's SERP for a        unregistered url now gets a           at all. Every page is a recording
substring hit, consent for          document that cannot be               or is registered by the case that
substring, else one invented        credited to an engine — one           reads it, and reading an
article (heading + [e1] link +      heading, ~14 paragraphs,              unregistered url fails naming
14 paragraphs) whose single         [e1] on a non-link, zero              the url. The instrument's two
/url: is an organic result under    /url: lines. The instrument           predicates become unreachable in
BOTH labels. 471 cases, 64 read     publishes 0 asResults and can         the happy path and live only as
the invention, 11 credited as       prove it still sees the               the refusal, and
engine results.                     invention.                            assertSawTheKnownCase retires.
```

**What the fake should do when a test reads an unregistered url:** the plan's answer is the right *interim*
and the wrong *terminal* one. Terminal shape, consistent with the two `docs/solutions/` artifacts: (1)
`defaultSnapshotFor` returns `""` — which `src/snapshot.ts` already names `empty_page` — unless the caller
registered the url or it resolves to a file in `tests/fixtures/`; (2) a case that wants bulk registers bulk,
because the ~3k article exists only to keep `read` off the settle loop, a **fixture cost optimisation
currently paid by every case in the suite**; (3) the invented-page count becomes structurally zero and the
proof-of-life machinery retires with it. **Drift risk the plan does not name:** keeping bulk *and* `[e1]`
keeps 52-ish tests dependent on a fabricated document, so step 2 becomes ~10× harder *after* this plan,
because this plan makes the fabrication comfortable.

## 3. Implementation alternatives

**A — Strip the link, register only what the instrument counts.** *Minimal viable.* S (3–4 files). Risk: low
for the suite, **high for the item** — G.6 cannot close at 11. Lands the real defect while the evidence is
fresh and never touches `assertSawTheKnownCase`, so the riskiest part of the plan is simply not taken. Cons:
the item's own end state is unmet; the eleven keep passing off an invented page at an engine url; A-then-B
re-measures the committed figures twice, against the prevention note. Reuses `parseSerp`, the ledger's
`— closed:` convention.

**B — The plan as written: re-arm → register → strip → close.** *Recommended, with R1/R2/R3 folded.* M–L
(~8 files). Risk Med, concentrated entirely in U1's proof-of-life. Pros: the forced order is derived from code
not taste; registration at adapter-derived urls already has two living examples; every published figure stays
behind the instrument; U4 carries the re-measure in-unit as that document demands. Cons: U1 is under-specified
(R1), U3's file list is short by two files (R3), one mutation row is not breakable (R6).

**C — The `syntheticPages` knob (prior art, priced honestly).** M. Risk Med, **higher than the plan credits.**
It is designed and costed, settled two constraints this plan re-derives, and is the only alternative giving a
per-case escape from the invented page. **Decisive con the plan never found: the instrument cannot see it, and
if it could, it would break.** The instrument asks an untouched fake — `article ??=
inventedPageText(INVENTION_PROBE);` — so a knob defaulting to `true` measures only the dishonest mode forever;
flip the default to `false` and `pageAtIsInvented` collapses: `inventionForUrl` returns `""`,
`invention !== null` is `true`, and `return invention !== null && served === invention;` is `true` for **every
url including registered pages and the shipped SERP** — the invented count silently becomes the suite total.
A knob whose safe value inverts the instrument is worse than a knob nobody sets. It also does not fix G.6: at
`true`, ~340 tests keep a page on which one link is still a result set.

**D — The fake stops owning the answer.** *Ideal architecture.* L. Delete the generic branch; `""` for an
unregistered url; bulk is registered; the instrument's predicates retire to the `empty_page` refusal. The only
alternative that closes the **family** rather than one instance, and it kills R4's threshold fragility
outright. Cons: 4–5× the file count, drags every `read` case into a search-fidelity item, cannot ship in this
window. **→ file as a ledger item rather than pretending B reaches it.**

**On rejecting the knob: the decision is sound, the reason given is not.** "A knob whose safe value nobody
sets is a scoreboard" is true but weak, and dismisses finished design work on a weaker argument than was
available. The decisive reasons are (a) instrument-blindness above, and (b) **the plan rejects a second fake
in the suite and then requires a second fake in a scratch directory** — U1 needs the fake to answer two
different invented pages, and the scratch rig saves it via
`cpSync(join(REPO, "tests", "helpers"), join(dir, "tests", "helpers"), { recursive: true });`. Say that in
the Rejected section in those words, or the rejection reads as preference.

## 4. Temporal interrogation

**Hour 1 (U1).** Decide before typing: **what replaces `KNOWN_CASE` as the live proof-of-life**, given that
after U2 nothing in the shipped suite reads an invention at an engine url. The plan does not say. In preference
order: (1) **recorder self-probe** — at preload install, open a tab at `INVENTION_PROBE` **and** at
`<engine-prefix>__measure-probe__` through the same `observe`-wrapped fetch and require both in `byCase`
before any headline prints; the only version that proves the *recorder*, and it matches the instrument's own
rule that the unmodified fake owns the invention decision. (2) synthetic — hand `classify` a planted record;
proves a pure function and nothing about the recorder. If (2) is chosen, say so out loud. Also keep the
asymmetry the plan noticed: the two headline figures use **different denominators** (`caseNames(cases)` on
file+name vs `new Set(asResults.map(one => one.name)).size` on name only); a proof-of-life written against
`cases` is not one for `asResults`.

**Hours 2–3 (U2).** Registering at a ddg url is not free: a registered page with zero organics trips
`src/engines/settle.ts` → `if (classifySerp(snapshot, engine).kind === "results") return false;` and pays
stability looks, which neighbours count (`… .length, 3);`). **The plan's instruction for
`reports empty_results and keeps trying the chain` is backwards** and **the constant it names does not
exist** — R2. New fixtures must satisfy two sweeps whose assertions the plan does not quote — R10.

**Hours 4–5 (U3).** The plan's one open question, decided: **`pageAtIsInvented` cannot stop recognising the
invented page by losing a link** — R5. Five-minute check instead of an hour:
`CAMOUFOX_MEASURE_INVENTED=1 node --test --import ./tests/helpers/fetch_guard.mjs --import
./scripts/measure-unregistered-pages.mjs tests/engines.test.mjs 2>&1 | grep INVENTED-PAGE` — if the eleven
lines still print, the recorder is intact and the observed failure was never the invention predicate. And they
will discover unaided that the page sits at **2987 against `INTERSTITIAL_MAX_CHARS = 3_000`** — R4.

**Hour 6+ (U4).** The retiring case's **title is cited from the ledger as an anchored fragment** (twice,
including `**G.6's pin asserts a page, not a result.** `), and `tests/improvement-refs.test.mjs` greps it out
of the named file — a rename orphans the ledger in the commit that re-anchors it. And the plan's prose quote
of the settle comment is not byte-identical to the file (backticks, a line wrap); pasted into the ledger it
reddens the same gate. **R7.**

## 5. Error and rescue map

The "user" is a maintainer running a green suite. Nothing throws at runtime in `src/`; every failure is a
suite failure or a wrong published figure.

| Codepath added | What can go wrong | Exception | Rescued? | Maintainer sees |
| --- | --- | --- | --- | --- |
| U1 relaxed `assertSawTheKnownCase` | 0 published from a recorder that saw nothing | `Error` | **N → R1** | `… 0 of N`, green, **and it is a lie** |
| U1 relaxed `assertSawTheKnownCase` | 0 published from a suite whose child cases all crashed | none — the summary reader only demands `ℹ tests N` | **N → R1** | the same false 0 |
| U1 proof-of-life via planted `classify` record | proves a pure function, not the recorder | n/a | **N → R1** | a green pin that cannot fail |
| U1 scratch-fake rewrite | scratch helper drifts from shipped | none | partial (`cpSync` copies the real helper) | a red naming a page nobody ships |
| U1 blind-recorder case | mutation as specified cannot redden it | n/a | **N → R6** | a credited pin that is not a pin |
| U2 derived prefix | short prefix map from the `catch {}` + `if (at > 0)` | none | Y (pinned by attribution) | that case red, naming the map |
| U2 stale literal registration | a pasted url keeps matching after the engine moves | none | Y (`assert.equal(opened, url,`) | the adapter names itself |
| U2 zero-organic page where a result is needed | settle looks, wrong `outcome.engine` | `GatewayError("parse_error")` | Y by test | two reds the plan does not predict (R2) |
| U2 new fixture under `tests/fixtures/` | trips the two sweeps | none | Y | two unrelated files red (R10) |
| U3 linkless invented page | `INTERSTITIAL_MAX_CHARS` phrase branch consulted on a url-echoing heading | `GatewayError("consent_wall"/"navigation_failed")` | **N → R4** | a `read` that returns a wall |
| U3 linkless invented page | `isBrowserRefusal` loses its `/url:` exemption | same | **N → R4** | every reader refuses, one edit away |
| U3 link removal | eleven fall to `parse_error`, chain hops, suite slower | `GatewayError("parse_error")` | Y (`parse_error` not terminal) | predicted reds |
| U3 retiring-pin replacement | replacement asserts its own premise | none | **N → R8** | a "coverage preserved" case that cannot fail |
| U3 re-anchor | one commit late, or not byte-identical | none | Y | `every anchored ref still names code that is there` (R7) |
| U4 re-measure | one of three places hand-edited | none | Y | the stale place, both figures |
| U1/U3 ADR number | `docs/adr/0003-*` already taken | n/a | **resolved by author** — `docs/adr/` holds only 0001, 0002 | — |

## 6. Failure modes registry

Rows with RESCUED=N + TEST=N + SEES=Silent are **CRITICAL GAPS**.

| Codepath | Failure mode | Rescued? | Test? | Sees? |
| --- | --- | --- | --- | --- |
| U1 `assertSawTheKnownCase` | publishes 0 while recorder is blind | **N** | planned, mechanism unspecified | **Silent** |
| U1 `assertSawTheKnownCase` | publishes 0 from an all-crashed child suite | **N** | **N** | **Silent** |
| U1 asResults proof-of-life | satisfiable by a synthetic `classify` call | **N** | Y but unfalsifiable | **Silent** |
| U1 blind-recorder mutation | cannot produce its promised red | **N** | **N** | **Silent** |
| U1 scratch fake rewrite | drifts from shipped | partial | Y | a red naming a page nobody ships |
| U2 `engineResultPrefixes()` | empty/short map → asResults 0 | Y | Y | named case red |
| U2 pasted url | hole reported closed after the engine moved | Y | Y | named case red |
| U2 wrong page shape | extra settle looks + wrong `outcome.engine` | Y | Y | two unplanned reds |
| U2 new fixture | trips either sweep | Y | Y | unrelated file red |
| U3 invented page | `INTERSTITIAL_MAX_CHARS` phrase branch on a url-echoing heading | **N** | **N** | **Silent** |
| U3 invented page | `isBrowserRefusal` 2-of-3 once `/url:` is gone | **N** | **N** | **Silent** today |
| U3 link removal | eleven now `parse_error`, chain hops | Y | Y | predicted reds |
| U3 `pageAtIsInvented` | regresses to always-true — no length floor, unlike `pageWasInvented` | **N** | **N** | **Silent** |
| U3 retiring-pin replacement | asserts its own premise | **N** | planned, unfalsified | **Silent** |
| U3 retiring case renamed | ledger title ref orphaned | **N** | Y, wrong unit | red attributed to U4 |
| U4 restatement | a place hand-edited | Y | Y | the stale place |
| U4 denominator | 471 moves, two places follow | Y | Y | named |

**Six critical gaps; four of them in U1 — the unit the plan itself calls the one the work rests on.** The
fifth is R4's threshold; the sixth is R8's self-premise.

## 7. Test diagram

| New thing | Happy | Failure | Edge | Verdict |
| --- | --- | --- | --- | --- |
| `assertSawTheKnownCase` accepts a zero | probe publishes 0 | recorder saw nothing → throws | **saw pages but no results-page read** | **missing — that third column is the whole unit** |
| Proof-of-life surviving U2 | — | — | — | **missing**, no mechanism (R1) |
| `pageWasInvented` always-false | — | count-of-1 probe red | — | ✓ breakable |
| Recorder-blind | — | **cannot go red as specified** | — | **R6** |
| Eleven registrations at derived urls | each keeps its assertions | prefix moved → adapter names itself | google side too (`?q=late`) | ✓, with R2 |
| Invented page is not a result set | 0 organics under both labels | restore the link → red | `settleMinChars < len < INTERSTITIAL_MAX_CHARS` **and** `detectWall === null` | edge **missing** (R4) |
| Page kept its ref | extract readers green | drop `[e1]` → red | ref on a non-link block | ✓ (`refsCount` counts `[eN]`) |
| Page kept its bulk | no settle polling | thin it → settle reds | 2987 vs 3000 | wrong threshold pinned (R4) |
| Retiring pin's replacement | per-engine registered links | — | must fail if the fake starts inventing again | **unfalsified** (R8) |
| Directory sweeps | new fixture passes both | — | refusal-shaped / predicate-inconsistent fixture | named, property unstated (R10) |
| Ledger re-anchor | refs green | delete a fragment → red | byte-identical quotation | ✓ (R7 caveat) |
| Committed figures are a run | `--check` exit 0 | hand-edit → names it | **0 published legitimately** | **the central risk** |

### The central risk, stated exactly

Not a red suite. A green `npm test` **and** a green `npm run test:measure` publishing
`read it as an engine's results page: 0 of N` **when the recorder has simply stopped being able to see one.**
After U2 the shipped suite contains no case reading an invention at an engine-results url, so `asResults` is
empty for two indistinguishable reasons — and the code that used to separate them is the code U1 is chartered
to relax. `assert.ok(suite.count > 0 && invented.count > 0, …)` does not look at `asResults` at all. Every
defence must live in U1, and U1 currently specifies one of three.

### The seven-row mutation table, row by row

| # | Plan's pin | Mutation that actually turns it red | Verdict |
| --- | --- | --- | --- |
| 1 | Invented page is not a result set | restore `'  - /url: https://camoufox.com/docs',` → the new pin red **and only it** | ✓ **but only in the post-U2 tree**; the row must say so or it is false in U3's own commit |
| 2 | asResults detector is not dead | `pageWasInvented` always false → count-of-1 probe red | ✓ breakable **only because** the scratch rig copies `scripts/` — load-bearing and unstated |
| 3 | A zero requires a seeing recorder | plan says *blind the recorder → throw case red* | **UNBREAKABLE AS SPECIFIED — asserting nothing. R6.** Breakable form: *delete the throw* → refuse case red; plus *empty `byCase` with non-zero `ℹ tests N`* → refuse case red |
| 4 | Registration is not a paste | move `SEARCH_URL` in `src/engines/duckduckgo.ts` | ✓ via `assert.equal(opened, url,`; **note** a pre-existing literal registration must be derived too, or this row breaks on a google-only move |
| 5 | Page kept its bulk | thin below `settleMinChars` → ~25 settle reds | breakable but **insufficient** — pin the *upper* bound too (`INTERSTITIAL_MAX_CHARS`), plus a ~60-char trim mutation |
| 6 | Page kept its ref | drop the `[e1]` | ✓; the count "four" is `RUN-NEEDED` |
| 7 | Committed figures are a run | hand-edit one place | ✓; cases 13/15 already prove it |

**Pins the plan credits that the reviewer could not break:** row 3 as written; U1's live-run proof-of-life (no
mechanism); `pageAtIsInvented`'s ability to say *no* (no length floor — nothing makes it say no except a url
the fake answers with a non-generic page); and U3's retiring-pin replacement until its falsifier is stated.

---

## Findings for the author

- **R1 — BLOCKING · high.** U1 names a guarantee and no mechanism, and after U2 nothing in the shipped suite
  can satisfy it. **Change:** recorder self-probe at install (`INVENTION_PROBE` **and**
  `<engine-prefix>__measure-probe__` through the wrapped fetch, both required in `byCase` before any headline
  prints) + a case asserting an empty `byCase` alongside a non-zero `ℹ tests N` still throws.
- **R2 — BLOCKING · high.** U2's instruction for `reports empty_results and keeps trying the chain` is
  **backwards** — it asserts `assert.equal(outcome.engine, "duckduckgo",` after a stub `empty` engine, so
  duckduckgo must **answer**; a zero-organic page makes it red — and it cites `DUCKDUCKGO_NO_RESULTS`, **which
  does not exist** (the chrome-only duckduckgo page is `const DUCKDUCKGO_SKELETON = DUCKDUCKGO_SERP.split("\n")
  .slice(0, 66).join("\n");`). **Change:** "register a page that **answers**", and name real constants.
  `AUTHOR RUN:` confirmed both; my plan was wrong on both counts.
- **R3 — BLOCKING · high.** U3's Files and its "3 designed casualties" omit provable breakages in
  `tests/measure-unregistered-pages.test.mjs` and `tests/instrument-probe.mjs`, the latter invisible because
  `npm test`'s glob is `tests/*.test.mjs`. **Change:** add both files; name the casualties; report the probe
  case separately as outside the glob.
- **R4 — high.** One deletion moves the suite's most-read page across `INTERSTITIAL_MAX_CHARS` and leaves
  `isBrowserRefusal` standing on one condition. **`AUTHOR RUN:` the real shape is worse than stated** — the
  page is **2987** chars, already *under* 3000, so the phrase branch is live on it today; the `/url:` line is
  what currently short-circuits `isBrowserRefusal` (`if (lines.some((line) => /\/url:/u.test(line))) return
  false;`), and after removal only `RETRY_AFFORDANCE` absence saves it. The reviewer's "crosses from above"
  is wrong in direction; the exposure is real and pre-existing. **Change:** U3's pin asserts
  `detectWall(invented) === null`, `settleMinChars < len < INTERSTITIAL_MAX_CHARS`, and `!/\/url:/u.test(page)`
  — plus a trim mutation.
- **R5 — moderate.** U3's open question aims at the wrong predicate: `pageAtIsInvented` is
  `invention !== null && served === invention;` — template against template, true by construction. **Change:**
  replace "the plan does not know why yet" with the `grep INVENTED-PAGE` check and re-attribute the failure.
- **R6 — moderate.** Mutation row 3 cannot turn anything red. **Change:** two rows, both breakable.
- **R7 — moderate.** The retiring case's title is an anchored fragment in the ledger (twice), and the plan's
  quote of the settle comment is not byte-identical. **Change:** replacement keeps the title verbatim; every
  ledger fragment copied from source, never from the plan.
- **R8 — moderate.** "Retiring means replacing" is right in principle and unfalsified in practice. **Change:**
  require a reachable self-vacuity red in the replacement.
- **R9 — low.** "43 incidental readers of the 53" is underivable (64 − 11 − 1 = **52**); "~25", "10 engine
  reds" and "four extract readers" have no run behind them. **Change:** drop them or mark `RUN-NEEDED` and let
  U4 publish measured values.
- **R10 — low.** The two sweeps are named but their assertions are not. **Change:** one sentence quoting
  `assert.deepEqual(matching, ["page-network-error.txt"]);` and `assert.equal(snapshots, wanted ? 2 : 1, …)`
  as the acceptance bar for any new `.txt`.
- **R11 — low.** Confirm `docs/adr/0003-*` is free. **`AUTHOR RUN:` resolved — `docs/adr/` contains only
  0001 and 0002.**

**Not findings — the plan is right and should not be moved by implementation pushback:** the U1→U2→U3 order;
the 7/2/2 allocation of the eleven; refusing a refusal mode (Approach C's instrument-blindness is the stronger
argument); refusing to register the incidental readers; filing rather than widening
`a search names the engine it is trying, before it tries it`; the derived-never-pasted registration rule; the
four-reds-vs-350-of-384 correction; and not routing `consentWallOn` through `pageContents`.

## Folded into the plan

R1 → U1 gains the recorder self-probe and two named cases. R2 → U2's bullet rewritten, real constants named.
R3 → U2/U3 Files extended, casualties named, the probe case flagged outside the glob. R4 → U3's pin widened to
`detectWall` plus the two-sided length band, and a trim mutation added. R5 → U3's open question replaced with
the decisive check. R6 → mutation row 3 split into two breakable rows. R7 → U3 keeps the retiring title
verbatim; ledger fragments copied from source. R8 → U3's replacement must carry a reachable self-vacuity red.
R9 → uninstrumented figures removed from Scope. R10 → U2 states the fixture acceptance bar. R11 → closed here.
Also folded: Approach D filed as a ledger item, and the knob rejection rewritten on the instrument-blindness
reason rather than the scoreboard one.
