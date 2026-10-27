# Changelog

Notable changes to `pi-camoufox-gateway`. Each entry lists the PR that carried it; the improvement
items (`A.2`, `B.5`, `D.1`, `E.3`, …) are the open findings in
[`docs/improvements/2026-10-18-functionality.md`](./docs/improvements/2026-10-18-functionality.md) and
[`docs/improvements/2026-10-18-code.md`](./docs/improvements/2026-10-18-code.md).

## [Unreleased]

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
  (`docs/plans/2026-10-27-google-direct-open-serp.md`).
- **A page is credited to the engine that hosts it.** A Google call whose page came back from DuckDuckGo
  printed `(via google)` over 30 links, 9 of them DuckDuckGo's own footer — because chrome is filtered by
  the host of the engine we *asked* for, and the chain credits from `Engine.name`. `classifySerp` now asks
  `engineOwnsUrl` before it parses anything: a page the asked engine does not host is `empty_results` with
  `details.substituted: true`, the chain runs the engine that does host it, and that engine credits
  itself. Closes `B.9`, and the half of `B.8` that reported a refusal as one successful result; the pin on
  the substituted page was converted into the regression that asserts the right answer, on the same
  recording.
- **A slow engine costs a hop, not the search.** `timeout` was terminal for the engine chain, so one
  engine that was merely slow ended everything with
  `tried: [{"engine":"google","code":"timeout"}]` and duckduckgo never being asked. It is not on that list
  now — `gateway_unreachable`, `gateway_unauthorized`, `host_blocked` and `private_network` still are,
  because those are outcomes the next engine would meet too. And `snapshot` no longer retries a request
  that already spent its whole deadline: one hung snapshot cost 2 × `timeoutMs` before the chain was told
  anything had failed.
- **The chain has one budget, not one per request.** Removing `timeout` from that list moved a cost from
  one module to none — the deadline lived only per request, so a gateway that is *up* and answering nothing
  owned no total: an open landing a millisecond inside its deadline plus a snapshot that never answers is
  two deadlines per engine, four across the chain, ~120 s against the shipped 30 s. The walk now carries
  one wall-clock budget of two request deadlines, derived from the client's own and handed to every engine,
  so a second engine cannot start a fresh full deadline after the first burned one — measured at 606 ms
  where the same gateway took 1 173 ms, with the first engine still getting its full deadline. The code and
  the message say which deadline ran out: `timeout` naming the search budget, where a cancelled call still
  reports `aborted` naming the cancellation.
- **`www.google.com.evil.test` is not Google's page.** The rule that decides which engine a page belongs to
  was a suffix pattern, and `[a-z.]+$` admits dots — so a host whose registrable domain is `evil.test` was
  credited to google and chrome-filtered by google's host list, while `google.xn--p1ai` (google.рф) was
  refused as a stranger. It counts hostname labels now: the engine's own label, one or two alphabetic or
  punycode labels after it. `google.co.uk`, `google.com.br` and `google.рф` are still google; the
  look-alikes are refused by label count, on both sides, where only duckduckgo had been pinned.
- **A page some other engine served says so, once.** A substituted page that was still changing when the
  settle budget ran out was reported as *"google's results page was still rendering … not known whether it
  had results"* — the wait's sentence about a page google never served, because `undecidedVerdict` rewrote
  every non-`results` message it was handed. Which page we got is decided from the address on the first
  look, so the loop may downgrade "no results yet" and may not downgrade that. And the loop no longer pays
  for the privilege: `serpWorthAnotherLook` stopped on a wall and on results but not on ownership, so a
  google tab that landed on duckduckgo spent 3 snapshots and 2 sleeps at a page no waiting can turn into
  google's — it costs 1, and the count is asserted rather than described.

### Changed

- **No gateway macros, and one endpoint fewer.** `navigateMacro`, `NavigateResult` and `ENDPOINTS.navigate`
  are deleted rather than left unused: `POST /tabs/{tabId}/navigate` is the endpoint that runs the check
  and the substitution above, and it is only unreachable while nothing can call it. The client now
  consumes 9 of the gateway's 36 endpoints and none of its 14 search macros — recounted from `ENDPOINTS`
  and the recorded contract, not inherited from the last count.

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
