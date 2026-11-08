# Changelog

Notable changes to `pi-camoufox-gateway`. Each entry lists the PR that carried it; the improvement
items (`A.2`, `B.5`, `D.1`, `E.3`, …) are the open findings in
[`docs/improvements/2026-10-18-functionality.md`](./docs/improvements/2026-10-18-functionality.md) and
[`docs/improvements/2026-10-18-code.md`](./docs/improvements/2026-10-18-code.md).

## [0.3.0] - 2026-11-08

Everything merged after v0.2.2 — PRs #27 through #31 — cut as a minor release. The middle digit is earned by
one thing: `camoufox_read` gained a parameter. #29 puts `maxAgeMs` on the tool surface, which closes 2.6, and
it carries three new `ReadOutcome` fields a caller can read back — which is what a caller-facing capability is,
and why this is not a patch. The other code PR is a fix (#27, the result-host round); the remaining two are
docs and test infrastructure. The suite went from **393 passing tests at v0.2.2** — re-counted in a detached
worktree off the tag rather than inherited from a commit message — to **478 on this checkout**.

### Added

- **2.6 — `maxAgeMs`: say how old is acceptable, not whether to refresh** (#29). `camoufox_read` could already
  answer *now* (`fresh: true`) and nothing else: a stored page was served whenever the TTL had not run out, on
  a `cache.pageMs` the caller had no say in. `maxAgeMs` is the other half of the question — *this* old is
  acceptable, older is not. The comparison is strict, `!(ageMs < maxAgeMs)`, which is the form
  [ADR-0002](./docs/adr/0002-staleness-is-a-read-bound-not-an-eviction.md) pins and why **`0` always
  navigates** rather than accepting a page stored in the same millisecond. Two asks answer the same question and
  are refused together (`code: unsupported`), because `fresh` is strictly stronger and accepting both makes the
  tolerance a decoration; a tolerance the comparison cannot order — `"1,000"` with a thousands separator, `NaN`,
  `-1`, `1.5`, `Infinity` — is refused *before* the lookup it would have bounded, since an unordered value does
  not fail the comparison, it quietly passes it. An entry past the tolerance is **skipped, not evicted**: one
  caller's tight ask cannot take away a page a looser caller can still use. The bound rides into `cache.run`'s
  own internal hit as well as the caller's lookup — bounding one read path of a single-flight cache while the
  other ignores it is a bound that was never applied
  ([the lesson, written up](./docs/solutions/architecture/single-flight-cache-has-two-read-paths.md)).
  Supporting it, every cache entry now carries `storedAt` and `peek` reports `ageMs`, clamped at 0 so a clock
  that steps backwards cannot hand back an age that passes every bound.
- **Three fields, and the two confusions they separate** (#29). `details.maxAgeMs` echoes the caller's own ask
  the way `waitForRequested` echoes a wait; `details.pageAgeMs` is set only behind `fromCache`, because an age
  is a claim about a stored page and nothing else; `details.staleSkippedMs` names the entry the tolerance threw
  away, and travels with `refetched` and nowhere else. Between them they make *"nothing was stored"* and *"your
  tolerance spent a navigation on a page someone else had already fetched"* different outputs, which they were
  not before. A caller that rode someone else's in-flight navigation gets the rejection but not the re-fetch
  claim — it is per call, and a sharer did not pay for it. Ages print through `describeAge` (`900ms`, `240s`,
  rounded up so an age is never understated); the stored value stays milliseconds, as every duration here.
  README carries the parameter, including the limit a caller would otherwise discover by being surprised: the
  cache is an in-process map that lives and dies with the pi session, so **a tolerance longer than the session
  is inert**. No config key, and no `search` change — the SERP half is filed as 2.7.

### Fixed

- **C.4 / C.5 / C.6 — a result's host comes from its url, so nothing else can name one** (#27). There were two
  host readers in one file with opposite trust properties: `hostOf`, off the url, and `hostFrom`, which
  preferred the page's own `cite:` line — and three sites replaced `url` while leaving `host` behind, the cache
  hit among them. One reader now, under the rule that wherever `url` is written `host` is written in the same
  statement. `isWrapper` was one substring test over a whole url, so `mygoogle.com/goto?url=offer` was the
  engine's own redirect and a look-alike destination got its refusal pinned in the url cache for 30 seconds;
  it now parses once and asks the host rule, the pathname (`/goto` or `/url`, exactly), and `url` among the
  query's own parameters. `parseHttpUrl` called `https://./x` openable — `new URL()` hands it a `.` for the
  hostname and `%2e` survives — so a destination with no host was published `resolved: true, host: ""` and
  cached as a *resolved* answer for ten minutes; a host that normalises to nothing is now no host to open, and
  `resolveUrls` will not publish `resolved: true` over an empty host even when its client refused nothing. A
  result whose host attributes nobody is dropped, not printed as a blank column. And a cached refusal now
  replays the reason it was recorded with, instead of the same wrapper answering the same question twice,
  differently, depending on whether anything had asked in the last half minute.
  **The cost, stated rather than buried:** `search` keeps `resolve` opt-in and Google serves organics as
  `goto` wrappers, so the default path now reports `google.com` where the page's `cite:` used to say
  `github.com`. That is true, it is strictly less useful, and it is exactly why the laundered byte survived —
  the honest value was the less informative one.
- **G.6 — the page the fake invents can no longer pass as a result set** (#31). `defaultSnapshotFor` answered
  any url a test had not registered with an invented article carrying exactly one `- /url:` line, on a host no
  engine owns; the organic-versus-chrome judgement is structural, so one link was a result set and **11 cases
  were being handed results by a document nobody wrote**, under either engine's label. Each of those 11 now
  registers a recorded SERP at the url its own adapter asks for — derived through `engineResultPrefixes`, not
  pasted, so a fixture cannot keep serving a page to a url the engine no longer opens — and the link is gone
  from the invention, which keeps its bulk and its `[e1]` because `read.settleMinChars` and `/extract` need
  them. The instrument's proof-of-life had to be re-armed *first*: it was gated on one named case reading an
  invented page, and registering that page is precisely what the fix asks for, so the guard would have thrown
  on the run that proved the fix worked. It now grades the recorder instead of the suite, and **the published
  zero is something a run has to earn**
  ([ADR-0003](./docs/adr/0003-the-fakes-invented-page-cannot-pass-as-a-result-set.md)).

### Changed

- **Test infrastructure, from the same two rounds** (#29, #31). One clock stub in `tests/helpers/clock.mjs`
  instead of three copies (a leaked `Date.now` stub makes every TTL and age assertion in a file lie rather than
  fail), and `advance` is cumulative now — a second call used to rewind the clock, and one case passed only
  because a zero tolerance navigates whatever the age is. `stageClock` counts reads and throws past 50, so a
  spinning settle loop fails instead of hanging. One predicate for what a navigation costs (`openCalls`, with
  `opens` its length) replaced two definitions of the same idea, the looser one shadowing the helper's own name.
  34 engine fixture keys that pasted their results url now derive it by running the shipped adapter.
- **`Cache.get` delegates to `peek`, and `set` refuses `undefined`** (#29). `get(key, bound)` had no production
  caller and was the weaker way to ask the same question: the bound was honoured and the age discarded, so the
  caller's note lied about nothing. `undefined` could be stored and was a hit for `run` but a miss for `get` —
  latent, because `storable` kept it out, but `Cache<T>` did not forbid it, so the invariant is now established
  at the one write site rather than re-tested by readers that cannot enforce it.

### Notes

- The pinned install example in the README now reads `@v0.3.0`; the tag is cut on merge.
- **Nothing in `src/` changed in this commit.** This release ships what main already has, verified at `f53ebca`:
  478 pass / 0 fail, `tsc --noEmit` clean, `npm run test:measure` reporting *478 cases / 53 read the fake's
  invented page / 0 read it as an engine's results page* and "all 3 places state the reading above".
  `tests/release-metadata.test.mjs` is the gate that makes the four hand-edited files agree.
- **Live gate, measured against a real gateway** (`camofox-browser` 1.18.1): `tests/live.mjs` 6/6 — real
  results, wrappers resolved, a bounded read that says it is bounded, `n` clamped and disclosed, an internal
  address refused at zero tab cost, and teardown leaving `activeTabs: 0` / `activeSessions: 0`.
- **One thing that would have been missed by a routine live run.** On this machine's own config the same suite
  reports **5 pass / 1 skip, not 6/6**: `network.allowPrivateHosts: true` makes `live.mjs` skip the
  `169.254.169.254` refusal case rather than fire the request the guard exists to stop — a green-looking run with
  a hole in it, green because skipping is what the suite does on purpose. The 6/6 above was measured with
  `CAMOUFOX_ALLOW_PRIVATE_HOSTS=0` (an env override; no config file was touched). If you read one line from this
  release, read your own `allowPrivateHosts` before you quote a live pass count.
- `maxAgeMs` had **no live evidence in either suite** — `live.mjs` never passes the parameter — so it got its
  own ad-hoc probe against the same gateway before this cut, 9/9: cold read navigates and claims no tolerance
  fields; warm read served and dated (`pageAgeMs=1`, `fromCache: true`); a tolerance the page fits is echoed and
  still served; a tolerance the page misses re-navigates and names the age it discarded (`staleSkippedMs=1`,
  `refetched: true`); a tolerance with nothing behind it is distinguishable from a rejection; the `schema` path
  bypasses the cache; `fresh` + `maxAgeMs` refused; all five unordered shapes refused; no tab or session left
  behind. It is honest that the ages came out at **1 ms** — back-to-back calls, so the rejection was exercised
  at millisecond ages and the arithmetic at larger ones rests on `tests/cache.test.mjs` and
  `tests/read-tool.test.mjs`, not on that run. The probe lives in gitignored `.context/`, so this release ships
  no re-runnable version of it; promoting it to `scripts/` beside the other probes is the follow-up.
- G.6 closed in place with both measurements attributed to the mutation that produced each, and **G.7 filed**
  rather than implied: the invented page survives by decision — bulk because `read.settleMinChars`, the ref
  because `/extract` needs one — which is what leaves 53 cases comfortable with a fabricated document. That
  terminal shape is now an open item instead of something a closed entry hints was reached.

## [0.2.2] - 2026-11-02

Everything merged after v0.2.1 — PRs #24 and #25, and the suite went from 378 passing tests to 393. One of those
PRs is the reason this release exists: it closes the defect v0.2.1's own Notes section left open and named, the
`snapshotSettled` stall that let a query with results report that nobody knew whether it had any.

### Fixed

- **A page that stopped changing is no longer called "still rendering".** `camoufox_search` on a slow gateway
  returned `empty_results` with `details.stalledAtDeadline: true` over the sentence *"google's results page was
  still rendering when the 600ms wait ran out, so it is not known whether it had results"* — on a page whose two
  snapshots the loop's own `samePage` comparison had already found **byte-identical**. The adaptive stability
  stop existed and could never fire: `STABLE_ROUNDS = 2` compares each frame with its *predecessor*, so it needs
  **three** looks, while the deadline is tested *before* the sleep and before the request. A snapshot one slower
  than the whole budget left the loop holding a single identical pair and nothing else — and **a stop the budget
  cannot reach is not a wait**. The loop now commits to that pair once the budget can no longer afford the next
  look, so `stalledAtDeadline` means exactly one thing: the page was still changing when the budget ran out.
  That is the only case in which "raise the budget" is honest advice, and it is now the only case the flag can
  be set in — by structure, not by convention: reaching the loop exit with the flag set requires the stop clause
  to have been false, which forces one identical pair in hand. `STABLE_ROUNDS` stays at 2, so a fast gateway
  still earns its third look and behaves exactly as before. Measured on a live gateway (`camofox-browser`
  1.18.1): the ~10.9 s that ended in an unearned stall now ends at the first identical pair, and all 7 rows of
  `scripts/measure-stalled-at-deadline.mjs` are honest — `stalledAtDeadline` unset, `code=empty_results`,
  `framesIdentical=true`, `tabsLeftOpen=0`. `SEARCH_SETTLE_MS` goes 600 → 1500 so the budget can usually afford
  the looks the engine's own predicate wants: an engine can now spend 1.5 s **plus one request** before the
  chain hops, where 600 ms expired inside the first re-look on a gateway whose snapshots cost seconds. It stays
  hard-coded — putting a document's patience on the search critical path is a config key this repo has already
  decided against (#25).
- **A test that only passed on the machine that wrote it.** `tests/engines.test.mjs` cited
  `.context/measure-stalled-at-deadline.mjs`, and every test file is scanned by `tests/improvement-refs.test.mjs`
  — but `.context/` is gitignored, so the case *"a file named without an anchor still resolves"* was green only
  where it had been authored: 383 pass / 1 fail in a worktree with no `.context`. The three probes the settle
  plan tells a reader to run are tracked under `scripts/` now, at the same depth, so their `../src` and
  `../tests` imports are unchanged (#25).

### Changed

- **One clock reading, shared.** The settle loop's exit and its stop clause each called `Date.now()`
  independently and could disagree across the deadline — the flag claiming a stall while the loop had seen
  stability. Both consume a single `expired` boolean read once per look now, pinned by a mutation-proven
  regression test: reverting the loop top to a fresh reading turns that case red on the flag assertion alone,
  and the pre-fix file fails on that one assertion with its premise assertions passing. The second `Date.now()`
  in the stop clause stays (reads are monotone within an iteration, so a later one can only fire the stop
  sooner), which is why the wording is *one reading, shared* rather than a read count. The worst case remains
  deadline plus one request, deliberately: bounding the poll request by the remaining budget would abort the
  very request that proves the page is stable, and reintroduce the false "still rendering" claim as a cap.
  `src/engines/chain.ts` is untouched and `SEARCH_CHAIN_BUDGET_IN_DEADLINES` is still 2 (#25).

### Notes

- The pinned install example in the README now reads `@v0.2.2`; the tag is cut on merge.
- `snapshotSettled` is shared with `camoufox_read`, which is why v0.2.1 left this alone. It moves in the honest
  direction only: a page that answered one identical pair with no budget left for the next look is returned as
  what it is, rather than flagged as still arriving. `read`'s two protected pins — *"a page still growing when
  the budget runs out gets the budget named"* and *"…stopped growing there, so it is thin rather than
  unfinished"* — are untouched and green, and everything this branch added to `tests/session.test.mjs` is
  additive (#25).
- **The 2026-10-26 search round came back.** PR #22 landed that round's code and left its planning behind on a
  branch that was never merged: main had been implementing ADR 0001 for five days with no `docs/adr/` in the
  repo at all, while two handoffs and a checkpoint cited a plan main could not open. `docs/adr/0001`, the plan
  and the brainstorm are recovered verbatim with provenance headers. Not imported: `engines/search-url.ts`,
  `probe-google-urls.mjs` and its test — importing code nobody has run is how a stale premise gets written
  down. Three claims the recovery itself got wrong were caught in review and corrected in place: the ADR
  promised a budget divided by the engines left (`chain.ts` gives the first engine the whole budget), `B.10`
  called 2026-11-01 the first sighting of the bare-page shape (the recovered plan recorded it on 2026-10-26,
  6 of 6 looks), and the plan came back still ordering a `navigateMacro` that no longer exists (#24).
- **Three items filed in `docs/improvements/2026-10-18-code.md`, not fixed**: `B.10` (an engine that never
  answers was reported as one that was too slow — closed by deleting the request, not by fixing it), `B.11`
  (`extract` is the one client method still on the default retry budget, so a hung gateway costs a schema read
  two full deadlines) and `G.6`, re-measured rather than restored: the mechanism as filed (the macro and its
  placeholder url) was deleted by #22, while the claim under it survived — the fake gateway answers any url a
  test did not register with an invented article whose one `camoufox.com/docs` link the host rule calls
  organic (#24).
- **`G.6`'s counts have an instrument.** `scripts/measure-unregistered-pages.mjs` observes `globalThis.fetch`
  from a `--import` preload, adding nothing to the shared fake; its reading (47 of 387 cases read that invented
  page, 11 of them as an engine's results page) is committed to
  `tests/fixtures/measure/invented-page-count.txt` and cross-asserted against the improvement doc and the
  script's own header, which is the gate that was missing while the doc said 47 and the script said 48. The
  recorder originally read the case name *after* `await fetch`, so a request abandoned at its deadline was
  charged to whichever case ran next — every published count before it came from a misattributed ledger. It
  throws rather than printing zero, and `tests/measure-unregistered-pages.test.mjs` pins both the throw and the
  readings (#24).

## [0.2.1] - 2026-10-29

Everything merged after v0.2.0 — PR #22, 21 commits, and the suite went from 353 passing tests to 378. Every
entry below was measured against a real gateway (`camofox-browser` 1.18.1) before it was written; the ones that
came from reading alone say so.

### Fixed

- **Google answers for Google, in 268 ms instead of 31 s.** `camoufox_search` with `engine: google`
  returned DuckDuckGo links — or nothing at all, once the request timed out twice. The engine ran the
  gateway's `@google_search` macro, and `POST /tabs/{tabId}/navigate` behind it runs upstream's
  organic-results check, which accepts a heading link only when it is *not* on a `google.` host. Google
  serves organics as `google.com/goto?url=…`, so that check can never pass: upstream waits out its 5 s,
  declares "no organic results", and substitutes DuckDuckGo for `@google_search` alone. Measured live on
  2026-10-27: macro **31,285 ms** → `duckduckgo.com/?q=goa`; `POST /tabs/open` at the same SERP url
  **268 ms** → 9–10 Google results on every query tried, cold, warm, without `hl`/`gl`, and in CJK. The
  macro expanded to the url we now build ourselves, so it carried no capability — only that check
  (#22, `docs/plans/2026-10-27-google-direct-open-serp.md`).
- **A page is credited to the engine that hosts it.** A Google call whose page came back from DuckDuckGo
  printed `(via google)` over 30 links, 9 of them DuckDuckGo's own footer — because chrome is filtered by
  the host of the engine we *asked* for, and the chain credits from `Engine.name`. `classifySerp` now asks
  `engineOwnsUrl` before it parses anything: a page the asked engine does not host is `empty_results` with
  `details.substituted: true`, the chain runs the engine that does host it, and that engine credits
  itself. Closes `B.9`, and the half of `B.8` that reported a refusal as one successful result; the pin on
  the substituted page was converted into the regression that asserts the right answer, on the same
  recording (#22).
- **A slow engine costs a hop, not the search.** `timeout` was terminal for the engine chain, so one
  engine that was merely slow ended everything with
  `tried: [{"engine":"google","code":"timeout"}]` and duckduckgo never being asked. It is not on that list
  now — `gateway_unreachable`, `gateway_unauthorized`, `host_blocked` and `private_network` still are,
  because those are outcomes the next engine would meet too. And `snapshot` no longer retries a request
  that already spent its whole deadline: one hung snapshot cost 2 × `timeoutMs` before the chain was told
  anything had failed (#22).
- **The chain has one budget, not one per request.** Removing `timeout` from that list moved a cost from
  one module to none — the deadline lived only per request, so a gateway that is *up* and answering nothing
  owned no total: an open landing a millisecond inside its deadline plus a snapshot that never answers is
  two deadlines per engine, four across the chain, ~120 s against the shipped 30 s. The walk now carries
  one wall-clock budget of two request deadlines, derived from the client's own and handed to every engine,
  so a second engine cannot start a fresh full deadline after the first burned one — measured at 606 ms
  where the same gateway took 1 173 ms, with the first engine still getting its full deadline. The code and
  the message say which deadline ran out: `timeout` naming the search budget, where a cancelled call still
  reports `aborted` naming the cancellation (#22).
- **`www.google.com.evil.test` is not Google's page.** The rule that decides which engine a page belongs to
  was a suffix pattern, and `[a-z.]+$` admits dots — so a host whose registrable domain is `evil.test` was
  credited to google and chrome-filtered by google's host list, while `google.xn--p1ai` (google.рф) was
  refused as a stranger. It counts hostname labels now, and refuses on the **registrable domain** rather
  than on the shape of the labels: the engine's own label, then either one TLD label (alphabetic or
  punycode) or a registry label (`co`, `com`) followed by a two-letter country code. `google.co.uk`,
  `google.com.br` and `google.рф` are google; `google.evil.com`, `www.google.evil.com` and `google.net.au`
  are refused, on both engines, where only duckduckgo had been pinned. Counting labels was the first
  attempt and was still wrong in the way that matters — `google.evil.com` has two alphabetic labels after
  `google`, and whoever registered them owns `evil.com`, not Google. What no suffix rule can do is tell an
  apex squatter from Google: whoever registers `google` under some TLD owns that apex, so `google.xyz` is
  credited to google. Stated as a limit and pinned as one, because the alternative is an allowlist that
  costs a search every time Google geo-redirects to a ccTLD the list does not name (#22).
- **A page some other engine served says so, once.** A substituted page that was still changing when the
  settle budget ran out was reported as *"google's results page was still rendering … not known whether it
  had results"* — the wait's sentence about a page google never served, because `undecidedVerdict` rewrote
  every non-`results` message it was handed. Which page we got is decided from the address on the first
  look, so the loop may downgrade "no results yet" and may not downgrade that. And the loop no longer pays
  for the privilege: `serpWorthAnotherLook` stopped on a wall and on results but not on ownership, so a
  google tab that landed on duckduckgo spent 3 snapshots and 2 sleeps at a page no waiting can turn into
  google's — it costs 1, and the count is asserted rather than described (#22).
- **A Google page spelled the way DNS allows was handed to DuckDuckGo.** The rule above trusted
  `new URL().hostname`, which keeps the FQDN terminator and even decodes `%2e` into one — so
  `https://www.google.com./search` was refused as nobody's domain, a real Google SERP came back
  `empty_results` with `details.substituted: true`, and DuckDuckGo was asked to answer a query Google had
  already answered. The guard against misattribution had become a second way to misattribute, and both
  readers were already in this repo: `net-policy.ts` had been stripping the terminator in `parseHttpUrl`
  all along. Hosts go through one exported `normalizeHost` now, and emptiness is still judged on the **raw**
  value, so a tab mid-navigation stays a silence instead of being promoted into a verdict by the strip (#22).
- **Chrome and ownership were two rules, and each was wrong on its own.** `isChrome` decided an engine's own
  UI by peeling `www.` and asking `endsWith("google.com")`, disagreeing with the ownership rule in opposite
  directions: `evilgoogle.com` and `myduckduckgo.com` counted as the engine's own chrome, so every link on a
  page hosted there was dropped as UI without a word, while a `www.google.co.uk` results page's own `/imghp`
  tabs were *not* chrome and came back as organic results. Both questions read one `HOST_RULES` entry per
  engine now, keyed off `EngineName` with an exhaustiveness check — and a runtime test beside it, because
  `npm test` does not run `tsc` and a guard that only fires in a typecheck is a guard nobody sees fail.
  Measured across every recorded fixture, before and after: organic result counts identical, which is what
  makes this a defect found by reading rather than one that was hurting anyone (#22).
- **Searching for `consent.google.com` reported a consent wall.** That check was a substring test on the
  whole url, and the query is echoed into the search url — `encodeURIComponent` does not escape dots.
  Measured live on 2026-10-28: `camoufox_search("why does consent.google.com keep appearing")` came back
  `consent_wall` at `https://www.google.com/search?q=why%20does%20consent.google.com%20keep%20appearing&sei=…`,
  a page Google had served normally, with DuckDuckGo answering an ordinary question. No attacker required;
  an attacker's `?next=https://consent.google.com/` walked through the same door. It is a host match through
  `matchesHostRule` now, which also survives the terminator. The lesson is in
  `docs/solutions/integration/wall-detection-must-be-structural.md`, including that the first version of
  that solution had this hole in it (#22).

### Changed

- **One reader of a host, and no rule left behind a dead branch.** `isPrivateHost` carried `normalizeHost`'s
  body re-typed, in the file whose own docstring says hosts are read one way — and deleting that strip
  changed nothing anywhere in the suite, which is exactly how two copies got to disagree. It calls the shared
  one now, with terminated private hosts (`localhost.`, `169.254.169.254.`) pinned. `isChrome`'s
  unknown-engine fallback kept a third copy of the old string rule behind a branch no loadable config can
  reach, since `config.ts` validates every name against `ENGINE_NAMES`; asked directly it still called
  `evilgoogle.com` the engine's chrome. Deleted rather than pinned — an untested duplicate is the old code,
  waiting for a name nobody thought to test (#22).
- **No gateway macros, and one endpoint fewer.** `navigateMacro`, `NavigateResult` and `ENDPOINTS.navigate`
  are deleted rather than left unused: `POST /tabs/{tabId}/navigate` is the endpoint that runs the check
  and the substitution above, and it is only unreachable while nothing can call it. The client now
  consumes 9 of the gateway's 36 endpoints and none of its 14 search macros — recounted from `ENDPOINTS`
  and the recorded contract, not inherited from the last count (#22).

### Notes

- The pinned install example in the README now reads `@v0.2.1`; the tag is cut on merge.
- The known defect the live gate surfaced — `snapshotSettled` stalling at its deadline, so a query that has
  results can report `empty_results` with `details.stalledAtDeadline: true` — is **not** fixed here. It is
  written up in `docs/plans/2026-10-27-google-direct-open-serp.md`, and left alone because `snapshotSettled`
  is shared with `tools/read.ts`, so the fix moves read's behaviour too.

## [0.2.0] - 2026-10-26

Everything merged after v0.1.1 — PRs #4 through #20, 18 commits, and the suite went from 111 passing
tests to 348.

### Added

- **Every navigation is guarded, not just `camoufox_read`.** `blockedHosts` used to be checked inside
  the read tool only, so `resolve: true` opened whatever a search engine handed back with no policy at
  all, and a link-local or cloud-metadata address was reachable by url. The check now sits at
  `GatewayClient.openTab`, the one choke point every tab passes through, and refuses non-global
  addresses by default — `network.allowPrivateHosts: true` is the escape hatch (#4). New
  `private_network` error code, terminal for the engine chain.
- **`camoufox_read` waits for the page to render.** `openTab` returning is not "the content is there":
  a client-rendered site used to come back as its skeleton. A snapshot thinner than
  `read.settleMinChars` is re-taken until two consecutive snapshots match, bounded by
  `read.waitForSettleMs` / `read.settlePollMs`; a page that never settles says so instead of reading as
  an empty site. `waitFor` takes a CSS selector and asks the gateway to hold until it appears; a
  gateway with no `/wait` route costs the wait, not the page (#4).
- **Pages are now actually cached** under `cache.pageMs` (10 min) per pi session — the key existed and
  was documented, but the read tool never read it. Keyed on (url including fragment, offset);
  `maxChars` slices a stored window instead of splitting it; `waitFor` and `schema` always navigate.
  Stored pages are re-checked against the destination rule on the way out, so narrowing `blockedHosts`
  or turning off `allowPrivateHosts` takes effect on the next read, not when the entry expires. Thin
  pages are never stored (#7).
- **A schema that cannot address anything is refused before the navigation** — a top-level property
  with no `x-ref`, a partial one, an empty `properties`, a nested `properties`, or a `type` other than
  the recorded contract's `"object"` all come back as `unsupported`, naming the key, rather than
  costing a page load and arriving as a gateway answer (#9).
- **`internal_error`** distinguishes our own faults from the gateway's, raised at the source and at the
  two boundaries that used to guess. `code` now spreads last into `details`, so gateway-supplied
  details can no longer relabel a fault after the fact (#9).
- **One page width, and the output counts what it threw away.** The adapters hand back the whole page
  and `tools/search.ts` owns the single slice; the result text says how many results were dropped and
  which limit fired — your `n` or the ceiling (#11, G.1).
- **Chrome is filtered by host, not by title.** `CHROME_TITLES` matched literal `webb` and `all` —
  locale drift baked into a regex — and measured against the recorded SERPs it dropped nothing there
  while cutting GitHub's own footer on a read (#11, G.2).
- **`GET /health` is read as a status.** The documented 503 ("unhealthy or recovering") is the one
  response carrying `recovering`, so acceptance is per-request rather than a wider 5xx rule; reported
  state, answered with none, and did-not-answer stay three separate answers. The probe runs once,
  uncached, on its own deadline (#16).
- **A failed call now says what the gateway said about itself** — "the gateway failed" and "answering,
  no browser connected, 0 active tabs" are different instructions to a model (#16).
- **The engine is named on every success.** The `(via <engine>)` header used to appear only when
  something fell back, so the common case attributed results to nobody; the engine sat in
  `details.engine`, which is a field for a script. It says *selected*: the gateway can serve a
  `@google_search` call from another engine and report that in a response field nothing here reads
  (#14, A.5, and the still-open #20 / B.9).
- **A SERP that has not arrived is re-looked at** instead of being reported as "that engine has no
  results". The re-look machine came out of `read` and is shared, with the stop rule injected — read
  counts characters, search asks its own parser whether a result has appeared. A clean
  "no results" answer is itself a fallback trigger, so a premature one cost the hop and narrowed the
  chain for every later question (#18).
- **Both tools declare an `outputSchema`**, and pi's `_onUpdate` channel is plumbed through to the
  registration boundary instead of being dropped at the last layer (#11, G.4).
- **Request bodies are held to the recorded contract**, and a browser refusal is recognised by shape —
  one top-level heading, a retry affordance, and nothing on the page that is a document — rather than
  by page width. A wider `Network Protocol Error` used to skip the check entirely and be returned as
  page text (#15, B.5).
- **Config keys**: `read.maxCharsCeiling`, `read.waitForSettleMs`, `read.settlePollMs`,
  `read.settleMinChars`, `read.waitForTimeoutMs`, `network.allowPrivateHosts` (see
  [`config.example.json`](./config.example.json)).

### Changed

- **`maxChars` is capped at `read.maxCharsCeiling` (40,000) rather than unbounded**, and the output
  says which of the two limits cut the page short — `truncated` alone cannot tell "the page is long"
  from "policy stopped me" (#10, E.3).
- **Numeric arguments are refused, not coerced.** A ceiling enforced by comparing numbers cannot order
  `NaN`, which is what `"1,000"` becomes, so a malformed `maxChars` used to pass the guard and return
  the entire page silently. `offset` is checked the same way with 0 as its floor — a string offset used
  to concatenate into `nextOffset` (`"100100"`) and be rendered as the way to continue (#13).
- **`n` is a whole number 1–10 and `search.maxResults` above 10 is refused at load** rather than
  accepted and silently clamped on every call: the engine macro takes only a query, so a wider list is
  not reachable. `n: 2.5` used to slice to 2 rows and report nothing (#10, E.1).
- **`read.defaultMaxChars` above its own ceiling is refused**, naming both keys — the default would be
  capped on most reads otherwise (#10).
- **Parameter descriptions name config keys instead of quoting resolved defaults.** A quoted default
  was a promise that was false for anyone who configured a different one (#10, E.4).
- **`timeoutMs` is required on `GatewayClient`.** `client.ts` carried a second, undocumented default of
  its own; 27 of 28 construction sites already passed the value, so the fallback was never what
  anything used (#10, E.2).
- **An unknown engine name and a disabled one are refused differently.** "unknown engine" names the two
  we ship; "disabled in your config" points at your `engines` setting. One is a typo, the other is a
  setting (#14).
- **`sessionShutdown` releases only the session that is shutting down.** `extensions` is module-level
  while pi gives each session its own runtime, so one session ending deleted every other session's
  client, cache, and gateway-side tabs. The entry is removed before the round trip, so a call landing
  mid-teardown builds a fresh extension rather than reusing one under teardown (#12, D.1).
- **A gateway session id keeps its tail.** Two pi session ids agreeing on the first 125 sanitised
  characters collapsed to one gateway userId under the 128-char cap; an overflow now keeps a readable
  head plus a digest of the full id (#12, D.5).
- **A failed liveness probe is honoured** instead of every call re-dialling the gateway (#6), and one
  probe runs per failure window rather than one per failed call (#12).

### Fixed

- An unclassified throw no longer reaches the model as `gateway_error`; a failed session-id invariant
  read as "the gateway is down" (#9).
- The error path no longer re-reads config, so a failed call cannot name a gateway url the user never
  set — only the one the client was built with (#9, B.2).
- `empty_results` vs `parse_error` is decided by `classifySerp`, which reads both axes (page width, and
  whether anything had the shape of a link) in one place, with every branch asserted together — it used
  to depend on the order the two engine adapters happened to call their helpers (#9).
- `pi-diag` is no longer hardcoded in `scripts/diagnose-wall.mjs`, and the namespace it derives is
  always released (#12).
- Dead declarations removed, with what survived them pinned by assertions (#17).

### Notes

- The pinned install example in the README now reads `@v0.2.0`; the tag is cut on merge.
- `docs/improvements/` frontmatter still records `version: 0.1.1` — those are the findings as measured
  against that build, and 1.5 is closed while B.9 stays open.

## [0.1.1] - 2026-10-10

Made publishable: `./package.json` export, `pi-package` keyword, and install docs that describe
`pi install npm:…` / `pi -e npm:…` rather than a checkout (#3).

## [0.1.0]

`camoufox_search` and `camoufox_read` as a pi extension: a google → duckduckgo engine chain with wall
detection, gateway-side navigation and snapshots, structured extraction via `x-ref` schemas,
`blockedHosts`, and SERP caching.
