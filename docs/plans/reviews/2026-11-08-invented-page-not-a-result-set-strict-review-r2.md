# Strict Review, second pass — the folded G.6 plan (2026-11-08)

Plan: `docs/plans/2026-11-08-invented-page-not-a-result-set.md` · Mode: **Strict, second pass** · Scope: **only
the text folded in response to R1–R11** — the first pass had reviewed the plan before those folds, so the U1
mechanism, the widened U3 pin, the named casualties and the two new mutation rows had never been read by
anyone but their author.

**Merge verdict: BLOCK.** F1–F5 all sit in U1, the unit the plan itself calls the one the work rests on. Each
one, left as written, either prevents the plan's own end state from being reached or re-breaks a finding the
first pass already closed. F6–F9 are text fixes due before U3.

**The uncomfortable result: the author's fix to R1 was worse than R1.** R1 said U1 named a guarantee and no
mechanism. The mechanism supplied — a recorder self-probe issuing two requests at preload — is broken in five
independent ways. It was invented, not derived, and the first pass could not catch it because it did not exist
yet. This is the case for a second pass on folded text, and the case against a single review of a plan that a
review subsequently rewrites.

`AUTHOR RUN:` marks claims the author verified after the review returned; the reviewer had `read` only.

---

## A1 — U1's self-probe: broken five ways. Do not implement as written.

**Attribution.** `scripts/measure-unregistered-pages.mjs` → `let current = "(unnamed)";`, whose only writer is
`beforeEach(function () {`, and `observe` takes `const issuer = current;`. At preload no `beforeEach` has run,
so both probe reads land on a case literally named `(unnamed)`.
`AUTHOR RUN:` confirmed the three code facts directly — the deduction is then unavoidable.

Consequences, in order of severity:
- `read it as an engine's results page` is `new Set(asResults.map((one) => one.name)).size`, and the probe's
  engine-prefixed url passes `const owner = [...prefixes.entries()].find(([, prefix]) => url.startsWith(prefix));`
  — so `asResults` gains an `(unnamed)` entry and **the count can never be 0**. That is U2's entire acceptance
  bar, U1's own Goal, and ADR-0003 #2, all defeated by U1's mechanism. **(F1, blocking)**
- `caseNames(cases)` dedupes on `` `${one.file}\u0000${one.name}` ``, so a phantom `(unnamed)` lands **once per
  test file**, inflating `read the fake's invented page` by roughly the file count rather than by one.
- `npm run test:measure` then refuses, since `findDisagreements` compares against the committed places.

**`before any headline prints` is reachable, but not in `byCase`.** `byCase` lives in the child and is emitted
only at `process.on("beforeExit", …)`; the parent's sole view is `parseReport(output)`. The check can sit
between `const { asResults } = classify(cases, prefixes);` and `assertSawTheKnownCase(cases, asResults);`, so
the ordering is achievable — but the plan must say "in `parseReport`'s output", not "in `byCase`".

**The two stubs fight, and one arrangement proves nothing.** `engineResultPrefixes()` does
`const original = globalThis.fetch;` … `finally { globalThis.fetch = original; }`, and while that stub is
installed the adapters are answered by an inline `json: async () => ({ ok: true, tabId: "probe", … })` that
never reaches the fake, so `pageWasInvented` fails at `if (!isText(url) || !isText(text)) return false;`. A
probe written as "run the real adapter and see whether it was recorded" records **nothing** and can never
satisfy its own precondition. And ADR-0003 #3 forbids hardcoding the prefix, so the probe cannot dodge the
derivation either.

**It also dies on `fetch_guard`, which the plan never considered.** `measure()` imports
`tests/helpers/fetch_guard.mjs` **before** the preload, and that file's
`globalThis.fetch = async function blockedFetch(url, init) {` throws. A preload-time call through
`globalThis.fetch` kills every child and the run reports *"exited with status … and produced no summary —
nothing was measured"*. The existing instrument avoids this by construction — `inventedPageText` uses
`fake.fetch(…)`, the helper's own. **(F2, blocking)**

**It un-fixes R6.** With an unconditional preload probe, `byCase` is never empty, so U1's own case — *"a probe
run in which `byCase` is empty while the child suite still reported `ℹ tests N`"* — cannot be constructed, and
the guard it grades can never fire. The mutation row added to satisfy R6 becomes unbreakable again.
**(F3, blocking)**

**Smallest coherent fix.** Record the probe into a **separate map flushed under a distinct prefix** that
`parseReport` cannot match, so it can never enter `byCase`, `asResults` or any denominator; issue it from
inside a root hook so attribution carries a real name; install a fake on `globalThis.fetch` before issuing it
and restore after; and re-point `assertSawTheKnownCase` at **the marker's presence**, replacing the
empty-`byCase` case with "the probe marker is absent while `ℹ tests N` is non-zero → throw".

## A2 — U3's widened pin: two of three assertions uncallable as written.

- **`detectWall` takes a snapshot, not a string.** `src/snapshot.ts` →
  `export function detectWall(snapshot: SnapshotLike): GatewayErrorCode | null`, and given a string
  `const text = snapshot.text ?? "";` yields `""` so `if (text.trim().length === 0) return "empty_page";`
  fires — `detectWall(invented) === null` would be **permanently red**, and `npm run typecheck` cannot catch it
  because `tsconfig.json` → `"include": ["src/**/*.ts"]` and the tests are `.mjs`. Correct call, matching what
  `tests/snapshot.test.mjs` already does: `detectWall({ url: THE_URL, text: page }) === null`, with the url
  being the one the page was asked for.
- **Neither threshold is nameable from a test.** `AUTHOR RUN:` confirmed
  `src/snapshot.ts` → `const INTERSTITIAL_MAX_CHARS = 3_000;` and
  `src/snapshot.ts` → `const PARSEABLE_MIN_CHARS = 2_000;` are module-private, appearing in no `export` and in
  no test except as a comment or a literal (`assert.ok(linkless.length > 2_000, …)`). Exporting one would
  break this plan's own scope boundary ("Anything in `src/`"). The house pattern already exists in
  `tests/snapshot.test.mjs`: pin the literal and bind it with an anchored ref — which only counts inside a
  `tests/*.test.mjs`, since `tests/improvement-refs.test.mjs` builds `SOURCES` from `docs/improvements/*.md`
  plus the test files.
- **The `isBrowserRefusal` reasoning is correct.** `AUTHOR RUN:` confirmed exactly one heading line at every
  url probed, so `if (headings.length !== 1 || !/\[level=1\]/u.test(heading ?? "")) return false;` does not
  rescue it, the `/url:` escape is gone after the swap, and `Acknowledged` cannot match
  `const RETRY_AFFORDANCE = /^\s*- button "(?:try again|reload|refresh|retry)/iu;`.

## A3 — The two named casualties: right files, no replacement assertions.

The plan says what goes red and never what goes in.

- `assert.equal(await pageWasInvented(UNREGISTERED, whole.slice(whole.indexOf("- link"))), true);` — the
  assertion's *meaning* is "a proper suffix of the invention is still the invention", because `/snapshot`
  paginates and `read` re-looks at an offset. Replace **positionally**, so no line-shape edit can satisfy it
  vacuously: slice the last ~400 chars, assert the slice is not the whole page, then assert
  `pageWasInvented`. If a marker is preferred, any `indexOf` must be guarded `assert.ok(at > 0)` — an index of
  `-1` or `0` silently turns the assertion into "the whole page is the page", the same unfalsifiable-pin trap
  R1 was about.
- `assert.ok(outcome.results.length > 0, "the invented page parsed as results, which is the hole G.6 counts")`
  never reaches a failed assertion: `src/engines/serp.ts` → `if (verdict.kind === "error") {` throws, and
  post-U3 the page classifies as `parse_error`. **`AUTHOR RUN:`** confirmed the throw path. The replacement
  keeps the navigation (it is what feeds `classify`) and flips the claim:
  `.catch((error) => error)` then `assert.equal(outcome.code, "parse_error", …)`, plus an assertion on the
  opened url.
- **The premise behind deleting it was mistaken.** This case never proved the classifier can fire —
  `classify` reads only the url. The classifier's real proof is
  `test("a page is attributed to the engine whose results url it is, and to no other")`, the
  `engineResultPrefixes()` deepEqual in the gate, and end-to-end U1's scratch-rig count-of-1 case.

## A4 — One new mutation row is dead, one is live.

- *"trim ~60 characters toward `INTERSTITIAL_MAX_CHARS`"* — **dead**. 2987 − 60 stays inside the band and
  crosses nothing; the direction is also wrong, since going above 3000 turns the phrase branch **off** and
  makes `detectWall === null` *safer*. The edit with a real consequence is **trim below 2_000**, which flips
  the linkless page from `parse_error` to `empty_results` at
  `if (blocks.length === 0 && text.length > PARSEABLE_MIN_CHARS) {`. Replace the row with that.
- *"add a `- button \"Try again\"` line"* — **live**. Caveat: it reddens every `read` of the invented page, so
  the row may not claim "and only it" the way row 1 does.

## A5 — Consistency: the plan is not implementable as written.

- **F4 (blocking for U1's RED set).** *"A probe suite whose fake ships the linkless page → reports 0"* is
  false: the probe's `test(KNOWN_CASE, …)` still opens a duckduckgo url with nothing registered, and `classify`
  matches on url alone — it reports **1**. That scenario's rig must *register* a page at the derived url; the
  linkless fake becomes a third scenario that still reports 1.
- **F5 (blocking).** Nothing states what `assertSawTheKnownCase` *becomes*. Until it does, the guard throws
  before any headline prints and U2's `0 of N` is unreachable.
- **F8.** "13 reds and zero collateral" now contradicts U3's own file list (three casualties across four files,
  one invisible to `npm test`). U4 would publish a number the unit already disproved. Qualify the 13 as
  *in `tests/engines.test.mjs`, pre-U2*, and have U4 publish the post-U2 count.
- **F9.** U1's bar says "must still print `11 of 471`" while U1 adds cases — the child runner's `ℹ tests N` is
  the denominator, so 471 moves by construction, which is the exact figure the plan's own cited prevention
  note says to re-measure **in the same unit**. And U2 is told `npm run test:measure` must publish, but that
  refreshes only the fixture, leaving the doc block and script header disagreeing — so the exit-0 requirement
  fails at the end of U2 and U3.
- **F13.** One quantity spelled three ways (`~2.5k`, `2987`, `~3k-char`); `tests/instrument-probe.mjs` listed
  in U1's Files though no U1 scenario edits it.

---

## Findings

| # | Sev | Finding | Change |
| --- | --- | --- | --- |
| **F1** | **blocking · high** | The probe pollutes `byCase` with `(unnamed)`; `asResults` can never reach 0 | Flush the probe to a separate map under a prefix `parseReport` cannot match |
| **F2** | **blocking · high** | The probe dies on `fetch_guard`, killing every child | Install a fake on `globalThis.fetch` before issuing, restore after |
| **F3** | **blocking · high** | An unconditional probe makes `byCase` never empty, re-breaking R6 | Redefine blindness as "marker absent while `ℹ tests N` non-zero" |
| **F4** | **blocking · moderate** | U1's linkless-probe scenario reports 1, not 0 | Register a page in that rig; keep linkless as a third scenario |
| **F5** | **blocking · moderate** | `assertSawTheKnownCase`'s replacement predicate is never named | State it (marker present + probe classified) and list the gate cases rewritten |
| **F6** | moderate | The page's length and its `/url:` freedom are functions of the **url** | The pin must fix the url, name it, and state the measured length |
| **F7** | moderate | `PARSEABLE_MIN_CHARS` is a third threshold the band straddles; `classifySerp` answers `empty_results` before parsing for an off-engine url | Put 2_000 in the band; the headline pin must use `parseSerp` |
| **F8** | moderate | "13 with zero collateral" contradicts U3's own file list | Qualify as pre-U2/`engines` only; U4 publishes the post-U2 count |
| **F9** | moderate | Denominators move in U1/U2 but are restated only in U4 | Restate in every unit that moves a figure; U1's bar becomes `11 of N` |
| F10 | low | The "not a paste" mutation reddens a file U2's command never runs | Add `tests/measure-unregistered-pages.test.mjs` to U2's targeted run |
| F11 | low | U3's command contains a literal `tests/helpers/…` placeholder | Name the file; treat `tests/helpers/invented-attribution.test.mjs` like the probe |
| F12 | low · needs-run | Ledger anchors into files U2/U3 rewrite | Only the `- /url:` one breaks and it is covered; **provided test titles stay verbatim** |
| F13 | low | Figure spelled three ways; orphaned Files entry | One measured figure everywhere; drop the U1 Files entry |

## `AUTHOR RUN` — verification of the reviewer's central claims

`classify`'s url-only match, `let current = "(unnamed)"` with its `beforeEach` writer and `const issuer =
current`, both snapshot constants private, `classifySerp`'s early `empty_results` for an off-engine url, and
`src/engines/serp.ts`'s throw on `kind === "error"` — **all confirmed from source.**

**F6, measured, and the truth is worse than either party stated.** The heading
`- heading "Page: ${url}" [level=1]` echoes the requested url, so the page's length — and therefore whether the
wall-phrase branch is consulted at all — is a property of *(page, url)*:

| url asked for | page length | `<= INTERSTITIAL_MAX_CHARS` |
| --- | --- | --- |
| `https://example.test/` | 2976 | yes |
| `https://duckduckgo.com/?q=camoufox` | 2989 | yes |
| `https://duckduckgo.com/?q=camoufox%20anti-detect` (the `KNOWN_CASE` url) | **3003** | **no** |
| `https://invention-probe.invalid/a-page-no-test-registered` (the instrument's probe) | **3012** | **no** |

So one "2987" was an artifact of a url the author invented on the spot, and the honest statement is not
"13 characters from flipping" but: **one invented page sits both inside and outside the phrase-evidence window
depending on how long the url that asked for it happens to be** — including at both urls the instrument itself
uses. That strengthens the case for the terminal shape in U4's follow-up: a fixture whose text varies with a
test-chosen url is not a stable fixture, and U3's pin must name its url or it asserts a coincidence.

## Folded into the plan

F1–F3 → U1's probe rewritten: separate prefixed marker map, its own fake installed on `globalThis.fetch`,
proof-of-life re-pointed at the marker, the empty-`byCase` case and its mutation row deleted. F4 → that
scenario registers a page; linkless becomes a third scenario. F5 → the replacement predicate stated, with the
gate cases to rewrite. F6/F7 → the pin takes `{ url, text }`, names its url, uses `parseSerp` for the headline
claim, and carries all three thresholds as anchored literals. F8 → the 13 qualified, U4 told to publish the
post-U2 count. F9 → restatement moved into every figure-moving unit; U1's bar is `11 of N`. F10–F13 applied.
