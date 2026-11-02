# Make search work again — the google path, the terminal timeout, and results that were chrome

> **Recovered 2026-11-01** from `fix/search-engine-path-and-chain-timeout` (`ab4ed28`), which was never merged;
> the round itself landed as PR #22. Provenance and the list of artifacts deliberately left behind are in
> `docs/brainstorms/2026-10-26-google-search-reliability.md`. Code claims below are as-of 2026-10-26.
>
> **Read this before following anything below.** Plans are not scanned by `tests/improvement-refs.test.mjs`, so
> nothing gates what is written here. Three things in it are false *as instructions* today:
>
> - **"`navigateMacro` stays"** — the method no longer exists anywhere in `src/`, and the test this file cites
>   for its contract coverage, `tests/gateway.test.mjs` → `navigateMacro sends macro and query to the tab`, is
>   gone with it. What replaced it is recorded at `docs/plans/2026-10-27-google-direct-open-serp.md`.
> - **U4's anchored citations into `### B.9 …`** name a heading `docs/improvements/2026-10-18-code.md` has
>   since deleted as closed.
> - **Five refs are still `path:123`** — `src/gateway.ts:797`, `src/net-policy.ts:176`, `google.ts:14`,
>   `google.ts:15`, `diagnose-wall.ts:52` — which is the shape that file's own header says was deleted on
>   purpose, and two of those line numbers no longer point where this file thinks they do.

> Status: **complete** — shipped as PR #22 (2026-10-27); the flip that was held for *named unknown 2* landed
> via `docs/plans/2026-10-27-google-direct-open-serp.md`. It was recovered still marked "executing", which is
> how a plan that finished a week ago kept issuing instructions.

*Two Strict plan reviews, 2026-10-26 (independent reviewer sessions, 42 and 62 tool uses), both merged.*
*Round 1 blocked on 3 CRITICALs; round 2 blocked on 2 more. All are applied below, and the two claims the*
*parent did not accept as written are recorded in the review log with the evidence that changed them.*

## Problem summary

Requirements: `docs/brainstorms/2026-10-26-google-search-reliability.md` (approved, baseline `2197c7c`).
Measured live, five probes:

| Probe | Result |
| --- | --- |
| `read` of a hand-built `https://www.google.com/search?q=expressen` | **works** — real google SERP, seconds, no `consent.google.com` hop |
| `search engine:google` × 2 | `timeout` at 30 000 ms, gateway healthy (`ok=true, browserConnected=true, activeTabs=0`) |
| `search` (default chain) | `timeout` at 30 000 ms — google runs first, `timeout` is terminal, duckduckgo never tried |
| `search engine:duckduckgo` | "5 result(s)" — every one duckduckgo promo chrome (`apps.apple.com…serp-atb-serp`, `play.google.com`, `duck.ai`, `insideduckduckgo.substack.com`, `reddit.com/r/duckduckgo`) |

**Probe 1 is not new evidence — it is a page this repo already recorded.** B.9 has the same url, the same
heading (`expressen - Sök på Google`), seven organic results, "and the call still answered `ok: false`
with `googleResultsAvailable: false`". Read together:

- **F1 — the macro arms a fallback list that a false negative pulls the trigger on.** Google answers a
  hand-built url correctly, with its organic titles wrapped in `google.com/goto?url=`. Upstream's
  predicate (`docs/improvements/2026-10-18-code.md` → B.9, transcribed from `lib/google-serp.js`)
  "requires a host that is *not* google's", so a fully-rendered google SERP counts as **0** organic
  results — measured "identical immediately and four seconds later, so not a race" — the gateway logs
  *"google search returned no organic results; using fallback"*, and re-navigates the same tab to
  duckduckgo and then bing. Three navigations, one request of ours, one 30 s deadline. The page handed to
  `classifySerp` is duckduckgo's, parsed under the name google.
  **The consent interstitial is nowhere in this chain**, and is contradicted twice: probe 1, and B.9's
  four hand-built google navigations, which all reached google and none of which mentioned a wall. The
  macro is neither the stale shield its header claims nor the cause — it is the switch that enables
  upstream's wrong answer.
- **F2 — `timeout` is terminal.** `src/engines/chain.ts` → `const TERMINAL_CODES` contains `timeout`, so
  one slow engine is reported as a service outage. See `docs/adr/0001`.
- **F3 — chrome can be returned as results**, because the only thing deciding organic-vs-chrome is host
  ownership (`src/snapshot.ts` → `if (!host.endsWith("google.com")) return false;`).

## Relevant learnings

- `docs/solutions/integration/wall-detection-must-be-structural.md` — structural evidence, a stated
  threshold, evidence quoted back in the error, an awkward-shape case buried in a *long* body. The
  false-positive direction is the expensive one, and a SERP verdict is worse than a read's: terminal
  **and cached** (`cache.serpMs` = 30 min).
- `docs/solutions/integration/cleanup-must-not-inherit-the-aborted-signal.md` — for U3b: a deadline that
  owns an abort aborts *its own* controller and relays the caller's; `finally` paths use
  `closeTabQuietly`; a timeout on a create is never retried; assert the **server side** (`fake.liveTabs()`).
- `docs/improvements/2026-10-18-code.md` → **B.6** — *"Three predicates measured against it first, all
  rejected"*, and at `classifySerp`: **"Nothing structural separates the two."** U4 starts from that
  result instead of rediscovering it.
- `docs/improvements/2026-10-18-code.md` → **B.9** — F1's mechanism, and the 30-vs-22 measurement that
  commits both directions of the host rule today.
- `docs/improvements/2026-10-18-functionality.md` → **2.1** — the gateway persists cookies and
  localStorage to `~/.camofox/profiles/<hashed-userId>/storage_state.json`, and the blocker to using it
  is ours: `gatewaySessionId()` returns `"pi-" + <pi session id>`, so the namespace rotates per pi
  session. This is what makes U1's cold/warm axis mean anything at all.
- `tests/snapshot.test.mjs` → `exactly one fixture in the recorded set has the browser-error structure` —
  this repo's answer to a classifier that quietly overreaches: **a whole-fixture-set budget assertion**.
  U4 borrows the shape.

## Scope boundaries

**In:** the google adapter's navigation; the chain's conclusion about a timed-out engine and its budget;
the organic-vs-chrome decision *as a measurement*; one deadline argument at the resolve call site (U5);
the stale comments these units falsify.

**Out**, each considered and refused:
- Cookie import (`POST /sessions/{userId}/cookies`) — the named remedy only if U1's gate refuses U2.
- `click` / `type` / `press` / `scroll` / `/act` / raw `evaluate` — refused by
  `docs/improvements/2026-10-18-functionality.md` → `Deliberately leave alone`. Untouched.
- `hl` / `gl` / `num` / `start` — U1 probes the shape, ships nothing.
- Reading the gateway's `searchEngine` / `fallbackFrom` (B.9 proper). B.9 stays open as filed.
- **`reconcileStrayTabs` and `closeTabQuietly` stay per-request-bounded, not per-search.** ADR-0001 says
  why. U5 covers the third path (`resolveUrls`), which turns out to be a call-site argument and nothing
  more.
- The SERP settle threshold (`SEARCH_SETTLE_MS`, `read.settleMinChars`) as a *tuning* question — U3b
  clamps it to the remaining deadline, which is a bound, not a re-tune.
- `read`, the address guard, cache eviction, `gatewaySessionId` stability (that is 2.1's own item).

## Architecture decisions

One ADR: **`docs/adr/0001-timeout-from-an-engine-is-not-terminal.md`** (U3b), including the section
stating exactly what the deadline bounds.

Two decisions below the ADR threshold, recorded so review does not re-litigate them:

- **`navigateMacro` stays.** After U2 no *engine* calls it, but it is the only client method reaching
  `ENDPOINTS.navigate`, with a request-shape test (`tests/gateway.test.mjs` →
  `navigateMacro sends macro and query to the tab`) and contract coverage
  (`tests/request-contract.test.mjs`). Precedent for keeping a macro entry for the recorded contract's
  sake: `docs/plans/2026-10-23-external-review-reconciliation.md` → the `MACROS` entry in
  `tests/helpers/fake_gateway.mjs` staying for exactly that reason.
- **No new config key.** The per-search total budget is the existing `timeoutMs`, read once at the top of
  `searchWithFallback`.

## Implementation units

**Order: U3a → U3b → U1 → gate → U2 → U5, with U4 independent and parallel-safe.**

That order is not tidiness. U3b alone is the mitigation for the reported symptom — a google that exceeds
its slice stops ending the chain, so duckduckgo answers again — and it puts the slice in place *before*
google starts returning pages, rather than discovering at that moment that a slice has never coexisted
with the settle loop.

---

### U3a — Give the fake gateway the knobs U3b's RED needs

**Goal.** `tests/helpers/fake_gateway.mjs` can fail a *named route* on a timer and record whether a
request arrived already-aborted. Nothing else.

**Files** `tests/helpers/fake_gateway.mjs`, `tests/gateway.test.mjs` (or a small dedicated file) for the
harness's own tests.

**Patterns to follow** the existing knobs, which are close and are the reason this unit is small:
`hangUrls` + `hangForMs` (and it registers the tab *before* sleeping, which is why ambiguous-timeout leak
tests are honest today), `openLatencyMs`, `redirects` / `redirectAfterOpen`, `pageContents`,
`snapshotScripts`, and `withFakeGateway`'s default `assertNoTabLeak` on `fake.liveTabs()`.

**Test scenarios**
1. **RED first:** a hang scoped to `{ method: "POST", path: "/tabs/:tab/navigate" }` delays only that
   route; `POST /tabs/open` still answers immediately. (Today nothing can hang anything but
   `/tabs/open`.)
2. `state.calls` records, per request, whether the signal that arrived was already aborted — U3b's
   shape assertion reads this and cannot be written without it.
3. A `sleep` that respects its signal: an aborted request settles, it does not sit out its delay.
   (`state`'s existing `sleep` is signal-blind.)
4. Existing harness behaviour is unchanged — the whole suite is this unit's regression net.

**Verification** `NODE_ENV=test node --test tests/*.test.mjs` — GREEN throughout (this unit adds no
production behaviour), with the three new cases observed RED before they are implemented.

**Dependencies** none. Blocks U3b.

---

### U3b — A slow engine is a step in the chain, not a fault

**Goal.** `timeout` stops ending the chain; one bounded budget covers the chain. F2 closed, per
`docs/adr/0001-timeout-from-an-engine-is-not-terminal.md` — **including its "What the bound actually
bounds" section, which is the part this unit must not overclaim.**

**Files**
- `src/engines/chain.ts` — drop `timeout` from `TERMINAL_CODES`; read one total deadline on entry; give
  each attempt the time left divided by the engines left.
- `src/engines/types.ts` — carry an **absolute** deadline into `EngineContext` (a duration re-based per
  attempt is how a budget silently becomes N × itself).
- `src/tools/search.ts` — supply it, from the one place that already knows `config.timeoutMs`.
- `src/settle.ts` / `src/engines/settle.ts` — clamp the settle budget to the deadline that is left.
- `tests/engines.test.mjs`, `docs/improvements/2026-10-18-functionality.md` (open question 3 says
  `formatError` carries **18 codes**; `src/errors.ts` has 19 — fix the number while this file is open).

**Patterns to follow**
`src/resolve.ts` → `async withDeadline<T>`, and specifically the part that is load-bearing rather than
incidental: it aborts with `controller.abort(new GatewayError("timeout", …))` as the *reason*, because
`src/gateway.ts` → `abortError` only preserves a `GatewayError` reason. **Compose, do not conflate**: the
chain's slice signal and the caller's signal must stay distinguishable at the chain boundary —
`AbortSignal.any([...])` of the caller's signal and the slice timer, so the slice is an additional source
rather than a re-use of the caller's. Note that the client already separates these internally
(`onAbort` aborts with `"caller"` or `"timeout"`) and that a third source of a timeout reason is what
makes them ambiguous again.
Teardown stays on `closeTabQuietly` (no signal, by design). `SEARCH_SETTLE_MS` (600 ms, per *request*,
re-armed by every snapshot) is a different budget from this one and must stay visibly separate.

**Test scenarios** (`tests/engines.test.mjs`, using U3a's knobs)
1. **RED first:** engine one hangs past its slice, engine two answers → results returned, and `tried` is
   `[{google, timeout}, {duckduckgo, ok}]`.
2. **Inverted by this unit, updated not "fixed":** `every terminal code stops the chain before the next
   engine is tried` loops `["gateway_unreachable", "gateway_unauthorized", "timeout", "host_blocked"]`
   asserting `secondRan === false`. Drop `"timeout"`; **keep the other three** — that is the assertion
   that this change is narrow.
3. **A caller budget tighter than the total.** Caller signal fires while engine one is up → engine two is
   *not* tried, and the error says the search was cancelled, not that google timed out. This is the
   scenario that keeps the two abort sources from being merged.
4. **Shape, not duration:** assert which request carried an already-aborted signal (U3a scenario 2) and how
   many requests engine two made. Timing assertions are the wrong instrument; the suite's one loose
   precedent (`tests/camoufox-gateway.test.mjs` → `the configured timeoutMs is the deadline a call actually
   obeys`, a `< 5_000` bound) is about the per-request deadline, which this unit does not touch, and stays
   green.
5. **Production arithmetic, not toy numbers.** With the shipped default (`timeoutMs: 30000`, two engines)
   the first slice is 15 000 ms, while a settle loop can spend `SEARCH_SETTLE_MS` again on every snapshot.
   Assert a slice that cuts the settle loop goes out through the honest path that already exists —
   `stalledAtDeadline` / `undecidedVerdict` — and **not** through `src/settle.ts` → `delay`, which rejects
   `new GatewayError("aborted", cancelledMessage)` unconditionally and would report *"the search was
   cancelled while waiting for the results page to render"* for a search nobody cancelled, discarding the
   second look's results.
6. **Document the asymmetry this creates, in the code:** a forced `engine: "google"` call gets the whole
   30 000 ms; a default-chain google gets 15 000 ms. Half the patience, in the configuration that broke.
   Say it where the slice is computed, not in a commit message.
7. All engines time out → the **first** error is thrown (existing `firstError` behaviour) with `tried`
   attached, and its message names the slice that fired, not the 30 000 ms default.
8. `gateway_unreachable` / `host_blocked` / `private_network` still terminal: engine two never reached.
9. A deadline mid-`openTab` leaves nothing behind — `fake.liveTabs()` empty. Note in the test what it does
   *not* cover: the `reconcileStrayTabs` such an abort triggers is bounded only per request, so a green
   leak assertion is not a latency statement.
10. One sentence in the code: `src/tools/search.ts` runs the chain through `src/cache.ts` → `run`, which is
    deliberately single-flight, so this deadline bounds the *owner* of an in-flight search, not a caller
    that joined it.

**Verification**
- `NODE_ENV=test node --test tests/engines.test.mjs` — RED (scenario 1), then GREEN.
- `NODE_ENV=test node --test tests/gateway.test.mjs tests/camoufox-gateway.test.mjs`
- `NODE_ENV=test node --test tests/*.test.mjs`, `npm run typecheck`.
- `NODE_ENV=test node --test tests/improvement-refs.test.mjs` — after the open-question-3 edit.

**Dependencies** U3a. Independent of U1/U2, and it must land before them.

---

### U1 — The probe matrix (a gate that can actually veto)

**Goal.** Establish, live, whether a hand-built google url yields **results** for *our* parser — not
merely whether it avoids a wall.

**Files**
- `scripts/probe-google-urls.mjs` — new, shaped by `scripts/diagnose-wall.mjs`.
- `tests/probe-google-urls.test.mjs` — new.
- this plan — a "U1 gate results" section filled from the run, before U2 starts.
- `tests/fixtures/` — record anything new, as `scripts/record-fixtures.py` does.

**Patterns to follow** `scripts/diagnose-wall.mjs` exactly: importable and not run-at-import, own session
id via `gatewaySessionId(\`diag-${randomUUID()})`, teardown covered by a test, and reporting the
destination the gateway *returned* rather than the one asked for.

**Test scenarios** (`tests/probe-google-urls.test.mjs`, against `tests/helpers/fake_gateway.mjs`)
1. Importing performs no request and opens no tab.
2. **Assert an absence, not an exact list: zero requests to `/tabs/{tabId}/navigate`.** The rest is
   `diagnose-wall`'s own shape — its `finally` also calls `DELETE /sessions/{userId}`, and
   `src/gateway.ts` → `snapshot` issues a `GET /tabs` when the destination is unreported and a policy can
   refuse (`snapshotReportsUrl` is true only on the extension's client, and no test pins it), so tolerate
   those two or default the probe's fake to `snapshotReportsUrl: false`.
3. A probe that raises still closes its tab — `fake.liveTabs()` empty.
4. A row reports: url requested, **destination returned**, snapshot chars **with `truncated`/`hasMore`**
   (a snapshot is a rendered chunk, ~74 800 — a bare char count is a proxy that lies), `classifySerp`
   verdict, **organic result count**, `detectWall` verdict, the `userId` it ran under, ms.
5. Rows are data: one row is runnable alone.

**The matrix**
- `https://www.google.com/search?q=expressen` — **the canonical row, which must yield ≥1 organic result
  via `classifySerp`.** B.9 already recorded 7 here, so a run yielding 0 is a regression, not a pass.
- a long query, a non-ASCII query, an injection-shaped one (`a&b#c`).
- a locale host, e.g. `https://www.google.se/search?q=expressen`.
- a params-bearing url (`…&hl=sv&gl=se&num=10&start=10`) — proves the shape U2's successor wants.
- **n ≥ 3 per row**, and say which kind of n: 3 iterations of one `userId`, or 3 fresh ones. Both, ideally.
- **a volume row** — N sequential google opens in one session. This prices the rate-limit family, whose
  only handle in this repo is `detectWall`'s size-gated phrase branch under
  `INTERSTITIAL_MAX_CHARS = 3_000`; a wide rate-limit page is invisible to the gate's own wall column.

**Cold and warm, stated correctly.** `docs/improvements/2026-10-18-functionality.md` → 2.1: the gateway
persists cookies per `userId`, and `gatewaySessionId()` rotates on every pi session — so **a fresh
`userId` is the first-contact case, which is also what a new pi session is.** A rotating probe id is
therefore production-representative rather than flattering, and the warm case is a *reused* id, which is
what the middle of one pi session looks like. **Run every row both ways and record which is which** — a
consent interstitial is a first-contact event, so the fresh-id column is the load-bearing one.

**The 404 trap, which is why "destination" is a column and not a footnote.** With the default policy,
`assertTabUrlAllowed` refuses nothing for a public host; `detectWall` has no 404 phrase; and a google error
page carries a `Try again` link — so `classifySerp` answers `results: 1` and the row is neither "reached
google" nor "0 organic". A row with no organic results is only meaningful against its destination.

**Verification**
- `NODE_ENV=test node --test tests/probe-google-urls.test.mjs` — RED (absent), then GREEN.
- `NODE_ENV=test node --test tests/improvement-refs.test.mjs` — **required**: `SOURCES` derives every
  `tests/*.test.mjs` by `readdirSync`, so this file is in the ref-scanned set the moment it exists.
- `node scripts/probe-google-urls.mjs` — the run; every row pasted here, **with the exact url string it
  used** — that string, not an inference, is what U2's constant must match.
- The gate is reproducible because the SERP cache cannot suppress it: `src/tools/search.ts` →
  ``const key = `search:${query}:${activeEngines.map((e) => e.name).join(">")}:raw```__ (chain-shaped:
  probe 5 is `…:duckduckgo:raw`, probe 4 is `…:google>duckduckgo:raw`) and `createCache()` is in-process
  only. Worth stating, or a reviewer discounts the matrix.
- **Gate, and it is a veto:** each row reaches google **and** the canonical row yields ≥1 organic result
  from our own parser, at n≥3, fresh-id included → U2 proceeds. Google not reached, or reached with 0
  organic at our parser too → **U2 does not ship**; stop, report, next artifact is a plan for cookie
  import.
- If U3b has not landed, run the matrix with `timeoutMs: 60000` and say so — the slice changes what a
  slow row costs, and the gate should not be measuring a configuration nobody ships.

**Dependencies** U3b preferred (see order). Blocks U2.

---

### U2 — Google builds its own url and navigates once

**Goal.** The google adapter looks like the duckduckgo one: one url, one tab, one navigation, no macro, no
seed tab. F1 closed. The `src/` change itself is ~10 lines — which is exactly why the inventory below is
the unit: the code is the small part.

**Files — code**
- `src/engines/google.ts` — build the url from **the literal U1 pasted**, not a reconstruction. Drop
  `MACRO`, `SEED_URL`, the seed tab, the `navigateMacro` call. Rewrite the header to what is now known,
  citing B.9 and the U1 run, deleting the retired sentence rather than softening it. **And the inner
  comment too** — "the macro takes only a query, and Google's page is ten wide" has no referent once the
  macro is gone.
- `src/tools/search.ts` — its comment says B.9 "is a google call whose page came back from DuckDuckGo";
  production can no longer produce that, since `CONTEXT.md` → **Substitution** records that it is decided
  by which macro was used. Say it is historical.

**Files — the inversions, all named (4 tests, 2 non-imported files, 2 glossary entries)**
- `tests/engines.test.mjs` → **`google goes open -> navigate(macro) -> snapshot and nothing else`** — the
  most directly-inverted case in the repo: asserts `deepEqual(sequence, [open, navigate, snapshot,
  delete])` and `navigate.body.macro === "@google_search"`. U2's scenario 1 is its successor: 3 calls,
  0 navigates, `open` body carrying the url.
- `tests/engines.test.mjs` → `an adapter hands back the whole page, unsliced` — asserts
  `callsFor(fake, "/navigate").length === 1`. Its *point* survives; re-express the assertion.
- `tests/engines.test.mjs` → `a SERP that answers on the first look costs exactly the requests it always
  cost` — asserts 4 calls for google, "open the seed tab, run the macro". Becomes 3.
- `tests/live.mjs` → `live: resolve turns wrappers into final urls` — asserts `wrapped.length === 0` and
  is **vacuous today**, because google never yields goto urls. U2 makes it load-bearing. Say so; it is a
  real assertion from this change on.
- `scripts/record-fixtures.py` — its only google target is `("macro", "camoufox anti-detect browser",
  "serp-google.txt")`, i.e. it re-records the page production will no longer read. Nothing imports it, so
  no test can see this. Add a hand-built-url target and re-tag the macro row's purpose.
- `CONTEXT.md` — **Engine adapter** ("Google via the `@google_search` macro") and **Seed tab** ("costs one
  extra tab and one extra navigation per search") both become false, in different ways: the first is
  wrong, the second describes a thing nothing creates. Keep each entry one line and do not restate the
  behaviour it names (`docs/plans/2026-10-23-external-review-reconciliation.md` sets that rule).
- `docs/improvements/2026-10-18-code.md` — **B.9's opening line is an anchored citation at the exact
  fragment this unit deletes.** Retarget it, in the same commit, at the literal
  ``src/gateway.ts` → `export interface NavigateResult``, which is text that survives. Then add the
  one-sentence state of play: no engine calls a macro as of this change.

**Patterns to follow** `src/engines/duckduckgo.ts` — a module-level url, `encodeURIComponent`, one
`openTab`, `settledSerpVerdict`, a `finally` calling `closeTabQuietly`, and a comment naming the rejected
alternative (`html.duckduckgo.com` returns a form, not results).

**Test scenarios** (`tests/engines.test.mjs`)
1. Zero requests to `/tabs/:tab/navigate`; the `POST /tabs/open` body carries the url U1 recorded.
2. Encoding: non-ASCII, spaces, and `a&b#c` each produce exactly one `q=` and no extra params.
3. One tab opened, one closed, on success and on each error path, at the server: `fake.liveTabs()` empty.
4. The address guard still applies to the destination the gateway reports — reachable with
   `redirects` / `redirectAfterOpen` and a `urlPolicy` carrying `blockedHosts`.
5. `tests/request-contract.test.mjs` unchanged and asserted unchanged.
6. `tests/live.mjs`: the existing `live: search returns real results` **already is** this plan's RED — it
   drives the default chain and is failing today; do not write a second one. Add only the missing one: a
   **forced** `engine: "google"` case asserting results *and* no wall. Without it the suite goes
   non-diagnostic the moment U3b lands, because a google that walls, empties, or crawls still returns
   *something* from duckduckgo — and probe 5 shows a duckduckgo "something" can be five promo links. There
   is no CI, so this is the alarm.

**Verification**
- `NODE_ENV=test node --test tests/engines.test.mjs` — RED, then GREEN.
- `NODE_ENV=test node --test tests/*.test.mjs`, `npm run typecheck`.
- `NODE_ENV=test node --test tests/improvement-refs.test.mjs` — same commit as the deletion.
- `CAMOUFOX_LIVE=1 node --test tests/live.mjs`.

**Dependencies** U3b, then U1's gate, green.

---

### U5 — One deadline argument at the resolve call site

**Goal.** `resolve: true` on a google page costs 1 deadline per wrapper round rather than 4, because
google returning goto-wrapped wrappers for the first time makes an opt-in path load-bearing.

**Why this is in scope when its neighbours are not.** Round 1 put `resolveUrls` out of scope on a reason
round 2 disproved: `src/resolve.ts` already has `ResolveContext.timeoutMs` ("Per-url deadline. Defaults to
the client's own timeout"), `tests/resolve.test.mjs` already exercises it
(`{ client, userId: "u1", timeoutMs: 40 }` against a hanging url), and `withDeadline` is called only by
`resolveUrls` — so the reconciliation path is a *caller* of the knob, not a precondition for using it.
The change is one argument at one call site, in a file U2 already edits.

**Numbers, so the bound is a statement rather than a hope.** `DEFAULT_CONCURRENCY = 3`, one `openTab` per
wrapper, no per-url deadline today. Ten real goto wrappers ≈ 12 KB of url text ≈ 11 923 chars, under
`read.defaultMaxChars = 12_000`, so they are not width-refused; 10 urls / 3 workers ≈ 4 serial rounds; a
gateway that stops resolving costs ~4 × 20 000 ms (`perform`'s retry is gated on `!options.signal?.aborted`,
so 20 s is not doubled). Whole-call worst case as planned: **chain 30 000 + resolve ≈ 4 × 20 000**, inside
pi's 120 s default. With the argument, 10 wrappers cost 1 × instead of 4 ×.

**Files** `src/tools/search.ts` (the `resolveUrls(visible, …` call), `src/tools/search.ts`'s comment if it
states a bound, `tests/search-tool.test.mjs`.

**Test scenarios**
1. **RED first:** with `resolve: true` and a hanging wrapper url, the search settles within
   `timeoutMs`-plus-slack rather than after four rounds.
2. Shape over duration: the resolve call carries a `timeoutMs`, and a wrapper that respects it is the one
   that reports `resolved: false`.
3. `resolve` off → nothing changes. Existing resolve tests stay green.

**Verification** `NODE_ENV=test node --test tests/search-tool.test.mjs tests/resolve.test.mjs`, then the
whole suite and `npm run typecheck`.

**Dependencies** U2 (it is the unit that makes this path live). Small enough to ride along with it.

---

### U4 — Decide, by measurement, whether chrome can be told from results

**Goal.** Not "add a discriminator". A *measured answer* to whether one exists, and a fix only if the
measurement supports one.

**Why this unit is open rather than specified.** B.6 already ran this and wrote the result down: *"Three
predicates measured against it first, all rejected"*, and at `classifySerp`: *"Nothing structural
separates the two."* And `linkBlocks` is indent-flat — it records `currentIndent` only to terminate a
block, so no ancestor or landmark is reachable from a block at all. So "promotional links sit in a
nav/footer landmark" is unavailable to a parser that cannot see landmarks, and wrong anyway: on
`serp-duckduckgo.txt` the organic results are themselves `listitem` nodes inside a landmark.

**The constraint that rules out the easy fixes.** `tests/snapshot.test.mjs` → `B.9 as filed:` commits both
directions of the host rule, one of them this: a `play.google.com` link **must remain a result** under
`"duckduckgo"` (`assert.ok(playStore, "B.9: the recording carries a play.google.com result")`). Probe 5's
five results include a `play.google.com` link that **must not be**. Same host, same engine label, opposite
required verdicts — so **no host rule and no url-vocabulary rule can satisfy both** (matching
`ct=serp-atb-serp` would be vocabulary, which the wall-detection solution refuses on principle). The only
axis left is a block's internal shape, on evidence.

**Files**
- `tests/fixtures/` — **record the probe-5 page first.** It is not in the repo, and nothing is written
  about a discriminator before it exists.
- `src/snapshot.ts` — `linkBlocks`, `organicResults`, `isChrome`, `classifySerp`.
- `tests/snapshot.test.mjs` — the measurement, then the verdict.
- `docs/improvements/2026-10-18-code.md` — B.6/B.8's status, **written inside those items**. Do not delete
  or re-head them: `tests/snapshot.test.mjs` carries anchored citations at
  `### B.8 A page that says we were blocked` and `### B.9 The gateway reports which engine answered`, and
  the ref gate reads this file.

**Protocol, in order**
1. Record probe 5. Read it against `serp-duckduckgo.txt` (the good case) and
   `serp-google-answered-by-duckduckgo.txt` (B.9's mixed case).
2. Baseline the counts first, as numbers, for the whole recorded set — `serp-duckduckgo.txt` is 19 parsed
   as `"duckduckgo"`, but that number is asserted only at
   `tests/engines.test.mjs` → `duckduckgo waits the same way google does, on the same shape of page` and
   nowhere in `tests/snapshot.test.mjs`. Print the table before changing anything; a candidate is judged
   against a measured baseline, not a remembered one.
3. State candidates as numbers: blocks carrying a destination *and* a description; a `cite`/snippet
   sibling; distinct destination hosts vs block count; depth/sibling structure `linkBlocks` would have to
   be extended to see.
4. Run every candidate over the **whole recorded set** and assert it the way
   `exactly one fixture in the recorded set has the browser-error structure` does: *"exactly these pages
   change, and this is the list."* The change list **is** the review artifact.
5. A candidate is rejected if it moves any of: `serp-duckduckgo.txt` off 19; `serp-google.txt`'s
   chrome-only prefix off 0; `serp-no-results.txt` off `empty_results`; either direction of
   `B.9 as filed:`.
6. **If nothing separates them: say so, ship nothing, and file it** — B.6's existing sentence is the
   place. Then say plainly what the user keeps seeing: probe 5's page still returns 5 confident results
   for 30 minutes, and the reported symptom stays open. The non-classifier remedy then on the table is
   telling the model what the engine's own verdict was — which is B.9's territory, and its own plan.

**Test scenarios**
1. **RED first:** the new recording, classified as `"duckduckgo"`, no longer returns 5 results — noting
   that a 0-organic recording makes this RED for a reason that is not the bug, so print the baseline
   count before trusting it.
2. The fixture-set budget assertion — the real gate, and the one that catches overreach on pages nobody
   was thinking about.
3. False-positive guard, not synthetic-only: a real recorded page whose organic results sit in the region
   the candidate distrusts still returns all of them. `serp-duckduckgo.txt` is that page for the landmark
   hypothesis; extend whatever survives rather than writing a fixture to match it.
4. What caching actually still bites, stated correctly: a *zero*-result verdict is already safe —
   `src/cache.ts` → `Failures are never stored.` The live cached-refusal risk is **B.8's**, and U4 does not
   close it: `classifySerp(serp-reddit-blocked, …)` returns 1 result with `polled: false`, so
   `src/tools/search.ts` → `shouldStore: () => !pagePolled` stores a refusal under a key that excludes
   `n`. Do not let this unit claim that risk is retired.

**Verification**
- `NODE_ENV=test node --test tests/snapshot.test.mjs` — RED, then GREEN.
- `NODE_ENV=test node --test tests/engines.test.mjs tests/search-tool.test.mjs` — `serpWorthAnotherLook`
  reads `classifySerp`, so an engine-visible change is possible.
- `NODE_ENV=test node --test tests/*.test.mjs`, `npm run typecheck`,
  `NODE_ENV=test node --test tests/improvement-refs.test.mjs`.

**Dependencies** none. Independent, and the highest-risk unit — its honest outcome may be "no fix".

## Deviations from the Plan

Recorded during 03-work, against commits `b50e1ee`, `88c4d47`, `4561517`, `e86d6c7`; items 4-6 against
`ca40c4a`..`e5ca73b`, the U2 tranche and its review fixes; item 7 against the calibration runs below.

1. **U5 as specified is a no-op.** `ResolveContext.timeoutMs` already defaults to the client's own
   `timeoutMs`, so passing `config.timeoutMs` at the call site changes nothing — U5's own "non-negotiable
   check" (`git diff` shows the argument passed) would have been satisfied by a change with no effect.
   The residual gap is different: the *resolve phase* has no slice of the search's deadline, so N wrapper
   urls at concurrency 3 can still cost `ceil(N/3) × timeoutMs` after the chain already spent part of it.
   That needs a remaining-budget deadline plus a deadline-derived signal for the phase, which is a
   different unit than the one-liner described here. Left open rather than shipped as a no-op.
2. ~~**U1's gate has not returned a verdict.**~~ **Superseded by the section below — the gate ran and
   passed.** This line predated the run and said "U2 stays unstarted", which the next section contradicts.
   Kept struck rather than deleted, because the two statements sat 30 lines apart in this file and that is
   the reason U2's start was mis-sequenced twice. See item 4.
3. **A bug outside this plan was found and fixed while building U3a's harness.** `firstToSettle()` could
   discard an already-issued `fetch` when the signal was already aborted, leaving an orphaned `AbortError`
   as an unowned `unhandledRejection` — the same class this repo already documents for `openTab`, at the
   race instead of the sequential path. Reproduced by a test, then fixed (`b50e1ee`).

4. **U2 was split in two, and the half that landed is not the half this plan describes.** The unit below is
   written *as* the flip — "one url, one tab, one navigation, no macro, no seed tab. F1 closed." What
   `ca40c4a`..`6ee2e98` shipped is everything except the flip, and `bed8f76`/`27c0962` shipped the harness
   that decides it. `src/engines/google.ts` is untouched and google still opens a seed tab and navigates
   `@google_search`.

   The split is not a hedge on the gate below. **U1's gate is green, and this plan's U2 lists exactly one
   gate as its dependency — "U3b, then U1's gate, green" — so on the strength of this document alone the
   flip was already unblocked.** It was held for a second reason, which is a measurement made after this
   plan was written and is recorded under *U2 calibration* below: named unknown 2, the 76–134 char page
   that costs 7.2–7.9s and reports `empty_results` with no wall, **reproduced deterministically** on a
   query the 6-row matrix never tested. An unknown that reproduces is not a transient, and 6 rows are too
   few to size it.

   **Owed by the flip commit, none of it done here** — the four inversions this unit names, plus its
   invisible half:
   - `tests/engines.test.mjs` → `google goes open -> navigate(macro) -> snapshot and nothing else`.
   - `tests/engines.test.mjs` → `an adapter hands back the whole page, unsliced` (still asserts
     `callsFor(fake, "/navigate").length === 1`, at `:185`).
   - `tests/engines.test.mjs` → `a SERP that answers on the first look costs exactly the requests it always
     cost` (still asserts 4, at `:558`).
   - `tests/live.mjs` → `live: resolve turns wrappers into final urls`, which becomes load-bearing.
   - `scripts/record-fixtures.py` — its only google target is a macro navigation; needs a hand-built-url target.
   - `CONTEXT.md` → **Engine adapter** and **Seed tab**, which become wrong in different ways. Only the
     *Substitution* entry was touched here, and only to add "which no engine ships today".
   - `src/tools/search.ts` — its comment says B.9 "is a google call whose page came back from
     DuckDuckGo"; production can no longer produce one, so it has to be marked historical.
   - `docs/improvements/2026-10-18-code.md` → B.9's opening line, retargeted in the same commit.
   - `src/engines/google.ts`'s **own header** — it prints the retired consent premise in present tense
     ("navigating to a hand-built `google.com/search?...` url instead gets us dumped on
     `consent.google.com`"), the same defect the review tranche fixed one file over. Left as it is, because
     this unit froze that file; `src/engines/search-url.ts` now carries the corrected statement.
   - **`async navigateMacro` becomes unreferenced by production** once the flip lands. The brainstorm
     (line 152) says this repo has a dead-declaration gate; `tests/gateway.test.mjs` and
     `tests/request-contract.test.mjs` both call it, so no test can see it go dead and the disposition —
     delete, or keep with a stated reason — is an explicit call the flip commit owes rather than one the
     suite will force.

5. **The 12-query × both-engines bar, and the six `must first change` gates, are not in either source
   document.** They came from a rendering of the *brainstorm's* U2 (`docs/brainstorms/…` → line 152,
   "Google navigates like duckduckgo does") that carried text present in neither file. Grepped, both
   docs: `12 canonical queries`, `chainGate`, `must first change`, `redirectPage`, `googleUrl`,
   `syntheticPages` and `4 sites` — **zero hits each**. The plan's U2 is a different, later unit
   ("Google builds its own url and navigates once"), and its gate is one line: **"U3b, then U1's gate,
   green."**

   So the 144 run is a bar **this plan does not require**, added during 03-work and kept on the merits —
   not because 6 rows were the agreed bar, but because named unknown 2 reproduced. It cost a harness
   (`bed8f76`, `27c0962`, 16 tests) and it caught three things the 6-row run could not: the 605-vs-3,345
   cold/warm spread, a deterministic 0-organic query, and a duckduckgo page size that made the
   25,000-char clause unreachable as written (item 7 below). Say which bar is being claimed, whenever the gate
   is reported.

6. **Two more of the `must first change` gates were already true, and one was wrong about the code.**
   Checked before writing anything, because two were load-bearing for the design:
   - `redirectPage` is not a knob on `withFakeGateway` and appears nowhere in the repo; it has four, and
     a fifth (`syntheticPages`, `ca40c4a`) had to be added — which that gate's own condition authorizes.
   - There is no `googleUrl` at `google.ts:15` to add a required parameter to; `google.ts:14` is
     `const MACRO`. `src/engines/search-url.ts` is new, not modified.
   - `assertTabUrlAllowed` has **no `source` parameter**. `src/net-policy.ts:176` is
     `(url, policy = DEFAULT_URL_POLICY, stage = "request")` — the third parameter is `stage` and it
     carries a default, the opposite of the precedent it was cited as. The required-`caller` rule stands
     on its own argument and the comparison was deleted rather than softened.
   - `diagnose-wall.ts:52` is `scripts/diagnose-wall.mjs`, and it already reaches no engine at all — it
     calls `openTab` and `snapshot` directly. Nothing to fix; a `/navigate`-never-fires assertion was
     added (`359251c`) so it stays that way.
   - `isChrome`, `STABLE_ROUNDS` and the absence of `timeout` from `chain.ts` → `TERMINAL_CODES` were
     re-verified and are genuinely as claimed.

7. **The `U2 calibration` measurements above move a clause of the pass bar out of the duckduckgo group.**
   25,000 characters as a ceiling on a duckduckgo row is not reachable by any row: duckduckgo at
   `expressen` — its simplest query — is 38,674 characters with 23 clean results and no wall. The number is
   kept and the scope moved to the google rows, where it works as intended, as a detector rather than a
   quality bar: hand-built google pages measure 3.3–4.7k, while the 30-organic B.9 rows measured
   25,048–26,182. A google row above 25k is a page that is not a google page.

## U2 calibration — the 12-query set, measured before it was written as a gate

Same gateway (`http://192.168.8.110:9377`), 2026-10-26, immediately before the 12-query harness was
written. 8 loads in two runs, neither of which sent a `Content-Type` header; both released every tab and
deleted their session. **Not a gate run** — a calibration, to find out what the 12 rows would actually
return before fixing a pass bar around them. Two throwaway scripts, not committed.

| engine | query | chars | organic | max result chars | wall | ms |
| --- | --- | --- | --- | --- | --- | --- |
| google | `expressen` (cold browser) | **605** | **1** | 279 | none | 1436 |
| google | `expressen` (warm, 2 min later) | 3,345 | 8 | 352 | none | 1832 |
| google | `camoufox anti-detect browser` | 3,966 | 9 | 413 | none | 1624 |
| google | `då fråga ö` | 4,738 | 9 | 503 | none | 2176 |
| google | `+ - =` | **223–247** | **0** | — | none | **7926**, then 223c unchanged across 6 looks over 44s |
| duckduckgo | `expressen` | **38,674** | 23 | 214 | none | 1137 |
| duckduckgo | `+ - =` | 6,157 | 5 | 170 | none | 594 |

1. **Named unknown 2 reproduced, deterministically, on a query the 6-row matrix never tried.** 223 chars,
   0 organic, `empty_results`, no wall, ~7.2s per look — the same signature the section above calls "not
   reproduced", from a run whose 4 other rows all came back in 0.6–2.2s. That is the first time it has held
   still. It is not a load that failed to complete: it is query-dependent, and 6 of 6 looks agree. What it
   does *not* establish is that the `+` is why — google may simply have nothing for `+ - =`. The row is
   kept as a gate row precisely because it fails 3/3 and the bar is 10/12, which is the bar absorbing a
   known bad row rather than concluding anything about encoding.
2. **The probe would have vetoed a good page, and the fix is the engine's own loop.** The same url read
   605 chars / 1 organic on a cold browser and 3,345 / 8 two minutes later, warm. The probe took one
   snapshot; the engine it gates waits up to `SEARCH_SETTLE_MS` across four looks. A gate that reads less
   carefully than the code it gates rejects pages it should have passed, so the harness now calls
   `settledSerpVerdict` rather than re-implementing a second answer to "is this SERP finished".
3. **No wall, again.** 8 more loads, 3 of 4 google queries clearing on the first look. 44 loads across both
   this run and the gate, zero consent walls. The premise this plan opened with is not the live failure.
4. **A hand-built google page is ~5× narrower than a macro one** — 3,345–4,738 chars at 8–9 results, against
   the macro's 25,048–26,182 at 30. Consistent with `CONTEXT.md` → Substitution, and the first time the two
   sizes have been measured side by side.

**Still blocking the 144.** The bar needs two gateway arms, `--fwd 0` and `--fwd 1`. `--fwd` is not a
parameter of the gateway's API, is not in any script in this repo, and is a launch flag of the server
process — which is on another host. So one arm is not reachable from here, and a half-run gate is a veto.

## U1 results — the gate, run live

Gateway `http://192.168.8.110:9377`, 2026-10-26, `CAMOUFOX_GATEWAY_URL=... node scripts/probe-google-urls.mjs`.
36 loads: 6 url shapes × 3 iterations, each under a fresh `userId` (a new session namespace per iteration)
and again under one reused `userId` (the middle of one session). Every row reports the destination it
reached, the organic count *our own parser* found, and the page size.

Organic results per run — `fresh` is the production-representative column, because `gatewaySessionId()`
rotates on every pi session:

| row | fresh×3 | warm×3 | reached google | wall |
| --- | --- | --- | --- | --- |
| canonical `?q=expressen` | 8, 6, 1 | 6, 6, 6 | 6/6 | none |
| long query | 10, **0**, 7 | **0**, 8, 9 | 6/6 | none |
| non-ascii | 10, 8, 8 | **0**, 9, 9 | 6/6 | none |
| injection-shaped `a&b#c` | 9, 9, 9 | 9, 9, 9 | 6/6 | none |
| locale host `google.se` | 6, 8, 6 | 6, 6, 6 | 6/6 | none |
| params `hl&gl&num&start` | 10, 10, 10 | 10, 10, 10 | 6/6 | none |

**GATE: PASS.** Every canonical run — all six, fresh and warm — reached google and produced organic results
through `classifySerp`. The three rows that came up empty are not the canonical row, and a pass that needed
the whole matrix green would have been a different claim than the one this gate was built to make: the
canonical url is the one U2 would ship.

No consent wall was observed anywhere in 36 loads, from a fresh namespace or a warm one. That is the
cleanest evidence in this whole exercise that the premise this work started from — *google shows a consent
interstitial* — was not the live failure.

Three things worth keeping, none of which the pass lets me drop:

1. **`organic=1` at 539 chars, and 5–6 results at ~3.0k, against 9–10 at ~4.4k.** The page is a real SERP at
   every size; the count moves with how much google rendered, not with whether it answered. A threshold on
   organic count would have called the 539-char page a failure and the 3.0k pages borderline, which is why
   the gate is `>= 1` and not a number tuned to look strict.
2. **3 of 36 runs returned a 76–134 char page, `organic=0`, `empty_results`, no wall — and cost 7.2–7.9s**
   while every other run cost 0.5–2.3s. Not the reported bug, not a wall, and **not reproduced**: 8 further
   loads of the same long-query url came back 5331c and 5772c, all under a second. So the mechanism is not
   named. What can be said from the numbers is that the duration is the signature and the size is the
   outcome — a page that cost ten times the time of its neighbours and came back with no navigable links
   at all is a load that did not complete, not a query that found nothing. `classifySerp` reporting
   `empty_results` for a 134-char page with zero links on it is the verdict the frame supports.
   The failure is *survivable* rather than *understood*: `empty_results` is non-terminal, so the chain hops
   to the next engine, which is the behaviour U3b exists to make reliable. 8% of 36 is also too thin to size
   — 1 in 12 measured, 0 in 8 when aimed at directly, on one gateway, on one day, with no second engine in
   the loop. Recording it as open is the honest state, and `U2` ships on top of a named unknown rather
   than an unnamed one.
3. **`params` was the only row identical across every run** — 10 organic, ~4.4k, every time, fresh and warm.
   The one row carrying `num=10` was also the only deterministic one. Suggestive about why counts wobble,
   which is worth a probe of its own rather than a conclusion drawn from n=6.

## Verification strategy

**Per unit** — the RED command for its first scenario, run and *observed* failing before implementation.

**Broad**
- `NODE_ENV=test node --test tests/*.test.mjs` — green, no skipped additions.
- `npm run typecheck` — clean.
- `NODE_ENV=test node --test tests/improvement-refs.test.mjs` — after every edit to
  `docs/improvements/` or any `tests/*.test.mjs`. It is the only gate that can see a citation left
  pointing at a deleted item, and U2 deletes a fragment one of them names.
- `CAMOUFOX_LIVE=1 node --test tests/live.mjs` — the existing default-chain case (already this plan's RED),
  the now-load-bearing wrapper case, and U2's new forced-google case.
- Re-run the original five probes by hand. Expected: 2/3/4 return results instead of a 30 s fault; **5
  either returns no results or the 5 promo links persist and B.6/B.8 stay open with the symptom named.**
  Two of the five are the bug report, so they are re-run rather than reasoned about.

**Sequence:** U3a → U3b → U1 → gate → U2 → U5, U4 whenever. Branch first — never `main`.

## Review log

**Round 1** (42 tool uses, **BLOCK**) — 3 CRITICALs, all accepted after parent verification: U2 deleted a
fragment B.9 cites as an anchored ref (U2 now carries the retarget); U1's gate passed on "no wall", which
waves through google-answering-zero-results (gate now requires ≥1 organic, n≥3, a volume row, destination
column); "bounded by the shared deadline" was false for three paths (ADR-0001 states the real scope,
U5 covers the third). Also accepted: the settle-`delay` cancellation-message trap, the cached-verdict
scenario asserted in the wrong direction, the single-flight note, the 19-not-18 code count, and — the one
that changed the story rather than the plan — that the macro is neither a stale shield nor the cause but
the switch that arms upstream's fallback.

**Round 2** (62 tool uses, **BLOCK**) — accepted: U3's RED could not be written, so **U3 split into
U3a/U3b** and the order became U3-first; the settle budget is per-*request* and so needed clamping to the
slice, with the 15 000 ms first slice named as a production-number scenario; the 1-argument resolve
deadline came back **into** scope as U5, because the out-of-scope reason was contradicted by an existing
tested knob; U2's inversion inventory gained the biggest case in the repo, the vacuous live wrapper case,
`scripts/record-fixtures.py` and two stale comments; the chain and caller aborts must be composed, not
conflated; the 404-with-`Try again` silent-pass trap; the probe fake's `snapshotReportsUrl` default;
`supersedes_framing` deleted from the requirements frontmatter as a dead pointer; the cache key is
chain-shaped, which is what makes the gate reproducible.

**Two round-2 claims the parent did not accept as written:**
- *CRITICAL 1, "a caller-supplied `AbortSignal.timeout()` now ends the whole chain, silently dropping the
  second engine."* Not as stated — `src/gateway.ts` → `onAbort` already separates `"caller"` from
  `"timeout"`, so nothing is dropped silently. What is real: a **third** source of a timeout reason makes
  the two ambiguous at the chain boundary, which is an attribution defect. The fix and the new scenario 3
  both stand; the label does not.
- *"U1's rotating userIds make its rows colder than production, flattering U2."* Backwards. 2.1 plus
  `gatewaySessionId()`'s per-pi-session rotation mean a fresh `userId` is the first-contact case *and*
  what a new pi session is, so a rotating probe id is production-representative; the warm case is a
  **reused** id. U1 now runs every row both ways, because a consent interstitial is a first-contact event
  and the fresh column is the load-bearing one.

## The macro is the fault — measured, and it reverses the premise of this plan

Same gateway, 2026-10-26, immediately after the 72-row pre-flight below vetoed. 24 loads plus one
confirmation row, 12 queries × 2 navigation paths, same arm, one path per `userId`, both sessions
deleted. Two throwaway scripts, not committed.

**Every macro navigation timed out. Every one. 12 of 12.** The one confirmation row attributes it:

```
open(example.com)=271ms ok  |  navigate(@google_search)=60024ms THREW timeout
```

Against a `timeoutMs` of 30000. The 60s is this repo's own documented single retry: `timeout` is built
`retryable: true` (`src/gateway.ts:797`), and the retry loop at `:707` retries it whenever
`retry !== "never"` and no caller signal has aborted — which is the case for every script that calls the
client directly. So a timed-out request costs **2 × its own deadline** and then reports
`gateway did not respond within 30000ms` — a number that is half the truth. Not reachable through
`chain.ts`, which passes a signal that the slice aborts, so the retry is blocked there: production's
bound is the engine's slice, not 60s.

The hand-built url, on the same 12 queries, minutes apart, one gateway:

| query | organic | chars | total | snapshot ms |
| --- | --- | --- | --- | --- |
| single-word | 6 | 2,742 | 716ms | 14 |
| space-encoding | 10 | 4,609 | 1,089ms | 19 |
| long-value | 9 | 5,269 | 576ms | 17 |
| non-ascii-latin | 8 | 3,915 | 756ms | 11 |
| request-syntax | 9 | 4,357 | 634ms | 17 |
| **plus-discriminator** | **0** | **247** | **22,026ms** | **7019, 7028, 7017** |
| quote-chars | 7 | 4,375 | 950ms | 9 |
| bare-percent | 8 | 3,162 | 902ms | 15 |
| non-latin-script | 10 | 4,176 | 915ms | 18 |
| dot-in-value | 7 | 3,246 | 601ms | 14 |
| backslash | 9 | 4,465 | 497ms | 12 |
| hostname-as-query | 7 | 2,927 | 616ms | 14 |

1. **The macro does not answer.** This is the first time production's own path has been measured in this
   whole exercise. The 6-row gate, the 72-row matrix and both calibration runs all open a tab at a url
   and read it — none of them navigates, by design, because a macro navigation is what arms the
   gateway's fallback. So the one request production actually depends on is the one nothing had
   measured. **F1 is confirmed at the seam, not inferred**: the macro is the thing that fails.
2. **Which is the reported bug.** "google search returns 20-25 second delays before falling back to
   duckduckgo" is a macro navigation that does not complete, ending at the engine's slice, and then a
   duckduckgo that answers at ~0.6s — measured here, not modelled.
3. **Named unknown 2 is neither a flake nor a shared cost, and it is one query.** 13 of the 14 snapshot
   requests on the hand-built path took **9–19ms**. The 14th — the only 0-organic row — took
   **7,019 / 7,028 / 7,017ms**, three times, ±6ms. That is not network variance, it is a ~7.0s timer.
   It is `plus-discriminator` (`?q=%2B%20-%20%3D`) and nothing else, on this run.
4. **So the 72-row veto's failing clause was measuring the wrong thing in two ways at once.** Its 4
   slow rows at ~14.5s were 2 looks × the 7.0s timer, and the clause compared them against 2,500ms —
   while the 12 macro rows, at 60,000ms each, were not in the matrix at all, because the matrix
   deliberately never navigates. A gate that cannot see the shipped path cannot clear it or condemn it.

**What this does to U2.** The plan's premise is that the macro survives consent and a hand-built url
risks it. Measured on the live gateway: the macro does not return at all, and the hand-built url answers
in half a second with 6–10 results and no wall. U2 stops being a latency-risk trade and becomes the fix.
**But this is one arm, one day, one gateway, n=12 — and it is a reversal of the premise, so it is not a
reason to merge on the spot.** It is a reason to re-run the macro on the second arm, and to ask whether
the 7.0s timer is the gateway's own timeout on a page it decides has nothing on it.

### It is persistent, and it is not the gateway being down — 5½ hours later, same minute, one control

The 12/12 above was ~5½ hours after the 6-row gate passed at 20:23, which leaves open whether F1 was
found or a healthy gateway was caught mid-degradation. Two loads at 02:02–02:03, then one control in the
same minute as the failure:

```
02:02:58  open(example.com)=977ms ok  |  navigate(@google_search)=60009ms THREW timeout
02:03:1x  open(url)=282ms  |  snapshot=365ms  →  2,374c, 6 organic, destination = the url asked for
```

13 of 13 macro navigations have now timed out, at 60,024ms and 60,009ms — and the retry's signature is
reproducing to within 15ms, so this is a deterministic 2 × 30s and not a drifting socket. The hand-built
url answered **647ms later, in the same minute, on the same gateway, from a fresh namespace**: 2,374
chars, 6 organic, destination exactly the url requested, no wall.

So the two candidate explanations separate. A gateway too sick to answer a macro would also be too sick
to return a google SERP in 647ms. Two rows one request apart, one hanging for a minute and one finishing
in a third of a second, is a property of the request, not of the server.

**What is now established, and what is not.** The macro navigation does not return within 30s on this
gateway, 13 times out of 13, across 5½ hours, while a hand-built url at the same queries answers
reliably — that is F1 confirmed at the seam, and it is the reported bug's mechanism. Still not
established: whether it is consent, a gateway-side macro implementation, or this gateway's exit — one
arm, one host, and no second arm has ever been run.
