# Plan: Google must answer for Google

Branch: `fix/google-serp-direct-open`
Date: 2026-10-27
Status: implemented and live-verified. U1–U5 plus nine review findings are on the branch; offline gates and
`test:live` are green against a real gateway (camofox-browser 1.18.1). One defect surfaced during the live
gate and is deliberately **not** fixed here — see *Known remaining defect*.

## Problem

`camoufox_search` returns no results at all against a real gateway (`camofox-browser` 1.18.1 at
`http://192.168.8.110:9377`), and when the timeout is raised it returns DuckDuckGo links credited to
Google. Verified live on 2026-10-27, all four numbers below measured, not reasoned:

| how we ask for a Google SERP | time | where the tab ended up | organics |
| --- | --- | --- | --- |
| seed `example.com` → `POST /tabs/:id/navigate` `@google_search` ← **what we do today** | 31,285 ms | `duckduckgo.com/?q=goa` | 0 (a DDG page) |
| seed `google.com` → macro | 31,083 ms | `duckduckgo.com/?q=goa` | 0 (a DDG page) |
| seed → `navigate` to the SERP url | 30,836 ms | Google SERP | 9, but the body says `ok:false` → we throw `gateway_error` |
| **`POST /tabs/open` at the SERP url** | **268 ms** | **Google SERP** | **9–10 on every query tried** |

## Why the macro path can never work (upstream source, fetched 2026-10-27)

`lib/google-serp.js` decides "did Google serve results" as:

```js
const link = heading.closest('a[href]');
return /^https?:$/.test(url.protocol) && !/(^|\.)google\./i.test(url.hostname);
```

Google now serves organic links as `https://www.google.com/goto?url=CAES…` — on a `google.` host, which
that predicate **rejects by name**. So `hasGoogleOrganicResults()` cannot return true on this layout: it
waits its full `GOOGLE_ORGANIC_RESULT_WAIT_MS` (5s) and returns false. `lib/search-fallbacks.js` gives
fallbacks to `@google_search` alone (duckduckgo, then bing), so the gateway's caller classifies "no
organic results" and substitutes DuckDuckGo — **every time**. `lib/macros.js` confirms
`'@google_search': (q) => \`https://www.google.com/search?q=${encodeURIComponent(q || '')}\``, i.e. the
macro is byte-identical to the url we can build ourselves, so it has no capability to preserve.

`POST /tabs/open` runs no fallback: it returns the Google page as Google served it. Measured across 5
queries cold, 3 warm, 3 without `hl`/`gl`, and CJK — 9–10 goto-wrapped organics each, no consent wall;
`google.com/goto?url=…` resolves to the real destination (`→ en.wikipedia.org/wiki/Goa`, 843 ms).

## Compounding defects, and what closes each

1. `src/engines/google.ts` — seed + macro is the substituted, 31s path. → open the tab at the SERP.
2. Every `navigate` dies at `timeoutMs` (30,000) < the gateway's 31s. `timeout` is `retryable`, so it
   burns 2 × 30s. Measured: `search("goa") THREW in 60202 ms -> timeout`. → delete `navigate` from the
   search path; stop a timeout being paid twice.
3. `timeout` is in `TERMINAL_CODES` (`src/engines/chain.ts`), so one slow engine aborts the whole
   search and duckduckgo never runs. This is the reported symptom: `tried: [{"engine":"google","code":"timeout"}]`.
4. Engine substitution is invisible: `asNavigateResult` keeps only `url`, so the tool printed
   `(via google)` over DuckDuckGo ads — `isChrome("google", url)` filters chrome by *google* hosts, so
   `duckduckgo.com/y.js?ad_domain=…` survives as an organic result. Measured. → decide the engine from
   where the page actually is, not from who asked.
5. `perform()` rejects every `{ok:false}` body, so the one path that reaches a healthy Google SERP
   (`navigate` to the url) dies on the gateway's own false negative. → mooted by 1, since we stop
   consuming that response.

## Units

### U1 — `google.ts` opens the SERP directly

`src/engines/google.ts`: drop `SEED_URL`, `MACRO`, `openTab(example.com)` and `navigateMacro`. Build
`https://www.google.com/search?q=${encodeURIComponent(query)}` and hand it to `client.openTab`. Keep the
`settledSerpVerdict` call, the `polled` pass-through, and the `finally { closeTabQuietly }` unchanged.

Do **not** add `hl`/`gl`: probes returned 10 organics geo-detected, and a hardcoded locale is a claim
about the user's geography.

Tests (`tests/engines.test.mjs`):
- rewrite "google goes open -> navigate(macro) -> snapshot and nothing else" to assert the call sequence
  is `/tabs/open` (body url is the search url, query encoded) → `/snapshot` → `DELETE /tabs/:id`, and
  that no `/navigate` call was made.
- the existing `pageContents`-keyed-on-search-url tests already key on
  `https://www.google.com/search?q=camoufox`, so they should pass once the engine asks for that url; any
  that keyed on the seed url must move.

### U2 — delete the macro/navigate transport that nothing calls anymore

`src/gateway.ts`: remove `navigateMacro`, `navigate`, `NavigateResult`, `ENDPOINTS.navigate`.
`tests/gateway.test.mjs`: remove the navigate cases; **keep** the assertion that survived them (the one
about `tolerateNotOk` not being needed on a call with no `{ok:false}` answer) by re-pointing it at a call
that still exists, or drop it with a line saying so if it has no surviving meaning.
`tests/request-contract.test.mjs`: drop the navigate body from the contract sweep.
`tests/helpers/fake_gateway.mjs`: drop the `/navigate` route and `MACROS`, **keeping `resolveTarget`**
(which `/tabs/open` uses) and the `state.consentWallOn` behaviour, re-hanging it on open-at-google — which
is where the fake already models it.

Grep gate: `grep -rn "navigateMacro\|NavigateResult\|ENDPOINTS.navigate" src tests` must be empty.

### U3 — the engine is decided by where the page is, not by who asked

`src/snapshot.ts`: add and export

```ts
export function engineOwnsUrl(engine: string, url: string): boolean
```

google → hostname matches `/\.google\.[a-z.]+$/i`; duckduckgo → `/\.duckduckgo\.com$/i`; an unknown
engine → `true` (do not invent a rule for an adapter we do not ship). Then in `classifySerp`, **after**
`detectWall` and **before** parsing, a page the asked engine does not own returns
`{ kind: "error", code: "empty_results", details: { url, engine, substituted: true } }` with a message
naming both. `empty_results` is deliberately chosen: it is not terminal, so the chain runs the engine that
actually served the page and credits it from its own `Engine.name` — no engine can credit itself from a
payload field, and no page can be chrome-filtered by the wrong engine's host list.

Tests (`tests/snapshot.test.mjs`, `tests/engines.test.mjs`):
- `classifySerp(duckduckgoPage, "google")` is an error, not 24 results (the recorded
  `serp-duckduckgo.txt` under the google engine is the regression that shipped as ads).
- `classifySerp(googlePage, "google")` still yields results (guards the rule from eating the happy path).
- a google engine whose tab ends up on `duckduckgo.com` → chain `tried` is
  `["google","duckduckgo"]` and `outcome.engine === "duckduckgo"`.

### U4 — one slow engine may not abort the search, and a timeout may not be paid twice

`src/engines/chain.ts`: remove `"timeout"` from `TERMINAL_CODES` with a comment saying why — a gateway
that is up and slow on one engine is the case the chain exists for, and a gateway that is *down* is still
terminal via `gateway_unreachable`. Keep `gateway_unreachable`, `host_blocked`, `private_network`.

`src/gateway.ts`: `snapshot` currently retries a timeout (`retry` defaults to `"always"`), so a hung
snapshot costs 2 × `timeoutMs`. Set `retry: "connect-only"` — it is a GET, so a retry is safe, and only a
request that never landed is worth repeating.

Tests (`tests/engines.test.mjs`, `tests/gateway.test.mjs`):
- first engine throws `timeout` → second engine runs and answers; `tried` names both.
- `gateway_unreachable` on the first engine still aborts without trying the second (the guard we keep).
- a snapshot that times out once is issued **once**, not twice.

### U5 — record what was measured

- `README.md`: the Google bullet (macro → direct-open), the latency claim, and the paragraph that today
  admits `(via google)` can be a DuckDuckGo page — that weakness is closed, so the text must say what now
  happens instead.
- `CONTEXT.md`: the "Engine adapter" bullet names the macro as Google's mechanism.
- `src/config.ts`: `MAX_SEARCH_RESULTS`'s rationale cites "the macro takes a query"; the page width is
  now just Google's page width.
- `CHANGELOG.md`: `### Fixed` entry under an Unreleased section.
- `docs/improvements/2026-10-18-functionality.md`: cite this plan; B.9 (engine substitution) is closed by U3.
- No new config keys, so `tests/config-example.test.mjs` stays green by construction.

## Gates

- `NODE_ENV=test npm test` — whole suite green, no skipped-on-purpose cases added.
- `npm run typecheck` — clean.
- `CAMOUFOX_LIVE=1 CAMOUFOX_ALLOW_PRIVATE_HOSTS=1 npm run test:live` against
  `http://192.168.8.110:9377` — `live: search returns real results` must now report organics whose hosts
  are not `duckduckgo.com` when `engine: google`.
- No tab leaks (the suite's own backstop).

## Known remaining defect (found by the live gate, not fixed here)

A query with genuinely no results costs ~10.9 s and reports `empty_results` as *"google's results page was
still rendering … so it is not known whether it had results"* — while the settle loop's own `samePage`
comparison had found its two frames byte-identical. `STABLE_ROUNDS = 2` needs three looks, and the 600 ms
budget only admits a third look when a `/snapshot` answers in under ~450 ms; the gateway's are ~5 s.
Measured, tabulated, and written up at
`.context/compound-engineering/findings/2026-10-28T00-10-00-000Z-finding-settle-stalled-at-deadline.md`.
Left alone because `snapshotSettled` is shared with `tools/read.ts`, so the fix moves read's behaviour too.

## Explicitly out of scope

- Clicking a consent wall's accept button. Needs a `click` call the client does not have, and locale-
  dependent matching on `Godkänn alla` / `Accept all` / `I agree`. A wall today hops to duckduckgo, which
  is honest; keeping Google through a wall is its own feature.
- Bing as a third engine — upstream offers it as a fallback we never reach.
