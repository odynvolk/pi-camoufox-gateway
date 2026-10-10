# Plan

> Status: done

> Archived evidence: `gatewayUrl` later moved from the LAN address recorded here to
> `http://localhost:9377` as the shipped default. Everything below describes what was probed on
> 2026-10-09 and should not be edited to match today's default.

## Problem summary

pi has no web access: no built-in `web_search`/`web_fetch`, and the ecosystem option
(`pi-web-search`) is entirely provider-native, so it costs money and needs keys. The user runs
`camofox-browser` v1.14.0 on their LAN (`http://192.168.8.110:9377`) which provides real
anti-detection browser execution for free, but nothing talks to it from pi.

Requirements (`docs/brainstorms/2026-10-09-pi-camoufox-gateway.md`) ask for a local-first
TypeScript pi extension exposing two tools — `camoufox_search` and `camoufox_read` — with no LLM in
the tool path, actionable error codes, one retry then engine fallback, raw `goto` URLs by default
with an optional `resolve`, an in-process TTL cache, and per-pi-session gateway hygiene.

## Relevant learnings

No prior artifacts in `docs/solutions/` or `~/.pi/agent/docs/solutions/`, and no
`docs/out-of-scope/` rejections. Closest prior art is `ttttmr/pi-web-search`, which we mirror for
packaging conventions but not for search mechanics.

## Scope boundaries

**In:** the extension only — tool registration, gateway HTTP client, snapshot parsing, engine
adapters, cache, URL resolver, config loading, session hygiene, tests, README.

**Out:** gateway code or deployment, cookie/proxy/trace features, page interaction
(`click`/`type`/`scroll`), npm publishing, any `.env`/`.data/`/`public/` change.

## Architecture decisions

No ADR-worthy decisions — every load-bearing choice is already recorded with live probe evidence in
the requirements document: extension-only boundary, `@google_search` macro as the Google path (hand
-built URLs got caught by `consent.google.com`), raw `goto` + opt-in parallel-tab resolution (the
tokens are not locally decodable), in-process cache, JSON-file-plus-env config.

**Source-driven checks required before implementing:**
- `pi.registerTool` shape, `execute` signature, `AgentToolResult` fields, and `session_shutdown`
  semantics — verify against `docs/extensions.md` and `dist/core/extensions/types.d.ts` in the
  installed pi 1.1.0 (not against pi-web-search's assumptions).
- `typebox` v1 `Type.Object`/`Type.Static` — verify against pi 1.1.0's bundled `typebox@1.3.27`.
- Every gateway endpoint, status code, and body key — verify against `GET /openapi.json` at runtime,
  not against this plan's paraphrase.

## Repository layout

```
package.json          type: module, pi.extensions: ["./src/index.ts"], peerDeps on pi + typebox
tsconfig.json         strict, noEmit, jiti-style .ts import specifiers
src/index.ts          registerTool x2, session wiring, renderers
src/config.ts         defaults ← JSON file ← env, validated
src/errors.ts         GatewayErrorCode taxonomy
src/gateway.ts        GatewayClient (tab/navigate/snapshot/extract/teardown, retry)
src/snapshot.ts       parseSerp, pageText, wall detection, truncation
src/cache.ts          TTL + single-flight cache
src/resolve.ts        parallel-tab goto resolution
src/engines/{types,google,duckduckgo}.ts
src/tools/{search,read}.ts
tests/*.test.mjs      node --test, fetch stubbed
tests/fixtures/*.txt  recorded snapshots
tests/live.mjs        opt-in live smoke against the real gateway
README.md             install, config, error codes, limitations
```

**Note:** the repo currently carries a stray `package.json` containing `{}` (npm byproduct from
discovery). Unit 1 overwrites it with a real manifest — that `{}` makes `npm test` resolve nothing.
`typebox` is a devDependency plus peerDependency (pi 1.1.0 bundles `typebox@1.3.27`), and import
specifiers must carry explicit `.ts` extensions because jiti does not resolve extensionless imports.

## Review record — Strict Review (2026-10-09)

Five premises challenged against evidence, four CRITICAL gaps found, four amendments approved and
folded into the units below.

| Gap | Severity | Resolution |
|---|---|---|
| `camoufox_read` had no output bound — a single page returned ~79K chars (≈20K tokens) | CRITICAL | U7 default `maxChars: 12000` + `nextOffset` continuation |
| `n > 10` is silently impossible (`@google_search` takes only `query`) | CRITICAL | U5 clamps to 10 and says so in the result |
| Failures could be cached for 30 min | CRITICAL | U5 caches successes only |
| A missing mock could quietly hit the LAN from the test suite | CRITICAL | Global fetch guard + tab-leak invariant after every test |

Evidence the review produced:

- Reading `github.com/daijro/camoufox`: `totalChars 97780`, gateway default snapshot `79830` chars
  with `truncated:true` / `hasMore:true` / `nextOffset:74800`, 287 refs. `document.body.innerText`
  is 29075 chars — 2.7× cheaper, but choosing between the two per page is deferred to v2 for lack
  of usage data.
- `format=json` returns the *same* string plus metadata — no href array. Text parsing is therefore
  the only option, and continuation must ride the gateway's `nextOffset` rather than our own slicing.
- The OpenAPI declares `BearerAuth`, which the running instance does not enforce. Auth enabled later
  would otherwise give us opaque 401s, so config carries an optional `apiKey`.
- No allow/deny semantics exist anywhere in the gateway, so `camoufox_read` reaches the LAN by
  default. Decided: do not block by default, expose `blockedHosts` in config (default empty).

Rejected during review: an MCP server bridge (extra process, no new capability), defaulting reads to
`innerText` (cheap but heuristic), and blocking private ranges (half the intended use is internal
pages).

## Implementation units

### U1 — Scaffold and config

**Goal:** a real, loadable extension package and a config layer that resolves
`defaults → JSON file → env`, defaulting `gatewayUrl` to `http://192.168.8.110:9377`.

**Files:** `package.json`, `tsconfig.json`, `src/config.ts`, `tests/config.test.mjs`

**Config surface:** `gatewayUrl` (default `http://192.168.8.110:9377`), `apiKey` (optional, sent as
`Bearer`; the gateway's OpenAPI declares `BearerAuth` though the running instance does not enforce
it), `engines` (ordered chain: google then duckduckgo, each with `enabled`), `cache.ttlSerpMs`/`ttlPageMs`,
`read.defaultMaxChars` (12000), `search.maxResults` (10), `blockedHosts` (default empty),
`timeoutMs`.

**Patterns:** mirror `pi-web-search` packaging (`type: module`, `pi.extensions`, peerDeps rather
than bundling pi and `typebox`); jiti loads TS directly so no build step.

**Test scenarios:** defaults when nothing is configured; JSON file overrides defaults; env overrides
both; malformed config reports the path and key that broke it; `gatewayUrl` without protocol is
rejected with a readable message.

**Verification:** `NODE_ENV=test node --test tests/config.test.mjs`

**Dependencies:** none

### U2 — Gateway client, preflight, and error taxonomy

**Goal:** one typed client that owns every HTTP call to the gateway and maps transport/status
failures onto codes the model can act on.

**Files:** `src/errors.ts`, `src/gateway.ts`, `tests/gateway.test.mjs`, `tests/fixtures/openapi.json`

**Patterns:** `fetch` with `AbortSignal` tied to the tool's `signal`; no retry inside individual
calls beyond the documented single retry; every request carries `userId`; optional `Authorization:
Bearer <apiKey>` only when configured.

**Preflight (review amendment):** cache the result of `GET /` for 60s per process. An unreachable
gateway produces one cheap "unreachable — check `GET /<url>/`" per window instead of one connect
timeout per tool call. A 401 maps to `gateway_unauthorized` naming the auth problem.

**Test scenarios:** correct method/path/body per operation (`/tabs/open`, `/tabs/{id}/navigate` with
`macro`+`query`, `/tabs/{id}/snapshot`, `/tabs/{id}/extract`, `DELETE /tabs/{id}`,
`DELETE /sessions/{userId}`); `ECONNREFUSED` → `gateway_unreachable` naming the configured URL;
404 "Tab not found" is distinguished from a transport failure; 5xx gets exactly one retry then
fails; a hanging request aborts on signal and cleans up; `ok:false` bodies surface the gateway's own
message; preflight is answered once for ten rapid calls; `apiKey` sends the header and its absence
does not.

**Verification:** `NODE_ENV=test node --test tests/gateway.test.mjs`

**Dependencies:** U1

### U3 — Snapshot parser

**Goal:** turn accessibility-tree text into the two shapes we need — a list of search results and
readable page text — plus wall detection.

**Files:** `src/snapshot.ts`, `tests/snapshot.test.mjs`, `tests/fixtures/{serp,page,consent-wall,empty,wide-page}.txt`

**Patterns:** recorded fixtures captured from the live gateway, so Google drift shows up as a test
failure rather than silent garbage.

**Test scenarios:** Google SERP → `[{title, url, snippet, source}]` with `google.com/goto?url=`
preserved; non-Google SERP with direct `href`s; result with missing snippet; `consent.google.com`
URL in the payload → `consent_wall`, not `empty_results`; zero links → `empty_results`; page text
carrying the gateway's `truncated`/`hasMore`/`nextOffset` through so the model can continue at the
right place; malformed/blank snapshot → `parse_error` carrying an excerpt for diagnosis.

**Continuation semantics (review decision):** the gateway returns `truncated`, `totalChars`,
`hasMore`, and `nextOffset` alongside the snapshot string, and continuation must use `nextOffset`.
Slicing the returned text ourselves and passing a different `offset` silently skips or duplicates
content, because our offsets and the gateway's are not the same scale. `format=json` is known to add
nothing (`snapshot` is the identical string), so only `text` is requested.

Found while building: when *we* cut the text below what the gateway handed us, the right resume
point is our own consumed offset (the remainder is already local); the gateway's `nextOffset` only
applies when we did not cut. Encoded in `extractText` with a test for each case.

**Verification:** `NODE_ENV=test node --test tests/snapshot.test.mjs`

**Dependencies:** none (pure functions — parallel-safe with U1/U2)

### U4 — Engine adapters and fallback chain

**Goal:** one `Engine` interface with Google (macro) and DuckDuckGo, plus the ordered fallback chain.

**Evidence-based change from the plan:** Bing is dropped from v1. Recording a real snapshot returned
378 chars of `Network Protocol Error` — Camoufox/Firefox fails Bing's protocol negotiation before
any result renders, which no client-side code can fix. The `Engine` interface keeps room for it, and
`scripts/record-fixtures.py` re-records all engine fixtures on demand.

**Files:** `src/engines/types.ts`, `src/engines/google.ts`, `src/engines/duckduckgo.ts`,
`src/engines/chain.ts`, `tests/engines.test.mjs`

**Test scenarios:** Google issues `open` → `navigate(macro)` → `snapshot` and nothing else; engines
without macros build a query URL and skip the macro path; `n` clamps to a sane range; a wall or
`empty_results` on Google falls through to the next engine and the result names the chain that was
tried; all engines failing returns the first meaningful code with the full chain in `details`; a
disabled engine in config is skipped.

**Verification:** `NODE_ENV=test node --test tests/engines.test.mjs`

**Dependencies:** U2, U3

### U5 — `camoufox_search` tool

**Goal:** the model-facing search tool: cache, single-flight, engine chain, optional `resolve`.

**Files:** `src/tools/search.ts`, `src/cache.ts`, `src/index.ts` (registration), `tests/search-tool.test.mjs`

**Patterns:** `Type.Object` params (`query`, `n`, `engine?`, `resolve?`); return `content` text for
the model plus `details` for state; `annotations: { readOnlyHint: true, openWorldHint: true }`;
throw to fail, or return `isError: true` when the failure still carries useful data.

**Cache rules (review amendment):** only successes enter the cache. A `consent_wall`,
`empty_results`, or `parse_error` must never be served again for 30 minutes — a transient wall would
otherwise look like permanent breakage. Key = normalized query + engine + `resolve`. `n` clamps to 10
and the result says so: `@google_search` accepts only `query` and Google's page is 10 wide, so
`n: 50` is not "not yet supported" but silently impossible, and returning 10 without saying so is the
lie this tool must not tell.

**Test scenarios:** cache hit makes zero gateway calls; concurrent identical calls issue one gateway
round trip (single-flight); a failed search is not cached and the next call retries the chain; `n`
clamps to 10 with a visible note; `resolve: true` fills `resolvedUrl` and leaves unresolvable
entries flagged rather than dropped; fallback chain is reported in the output; TTL expiry forces a
refetch; aborted signal propagates and closes the tab.

**Verification:** `NODE_ENV=test node --test tests/search-tool.test.mjs`

**Dependencies:** U4, U6

### U6 — Parallel goto resolver

**Goal:** resolve the top-N `goto` URLs in concurrent tabs without leaking any tab.

**Files:** `src/resolve.ts`, `tests/resolve.test.mjs`

**Test scenarios:** N URLs open N tabs concurrently and each returns its final URL; a tab that lands
somewhere unexpected keeps the original and marks `unresolved`; a timeout leaves the entry unresolved
and does not block the others; every tab is closed on both success and failure paths; resolution is
skipped entirely for direct (non-`goto`) URLs.

**Verification:** `NODE_ENV=test node --test tests/resolve.test.mjs`

**Dependencies:** U2

### U7 — `camoufox_read` tool

**Goal:** read any URL through the browser, report the final URL, and optionally extract a JSON
object — without letting one page eat the context window.

**Files:** `src/tools/read.ts`, `src/index.ts` (registration), `tests/read-tool.test.mjs`

**Output budget (review amendment, the CRITICAL gap):** measured on the live gateway, one page
returns ~79,800 chars by default (≈20K tokens) against `totalChars` 97,780. The tool defaults to
`maxChars: 12000` (≈3K tokens) and reports what remains plus the `nextOffset` to ask for it. An
explicit `maxChars` overrides the default; nothing may return an unbounded snapshot. `blockedHosts`
(default empty, per review decision) is enforced here, before the gateway is touched, since the
gateway itself has no host policy.

**Test scenarios:** navigate then snapshot returns page text plus the **final** URL after redirects;
client-rendered page returns content where a plain fetch would not; the default read of a large page
returns ≤12,000 chars with a usable continuation offset; an explicit `maxChars` override is honored;
`schema` path snapshots first then calls `/extract` with `x-ref` hints, since `/extract` requires
refs from a prior snapshot; extraction on a page with no matching refs returns `extraction_empty`;
non-http(s) URLs and `blockedHosts` matches are rejected before any gateway call; blocked/403 pages
produce a distinguishable error.

**Verification:** `NODE_ENV=test node --test tests/read-tool.test.mjs`

**Dependencies:** U2, U3

### U8 — Session hygiene, suite safety, and docs

**Goal:** make the extension safe to run daily and understandable to a stranger.

**Files:** `src/index.ts` (wiring), `src/session.ts`, `config.example.json`, `README.md`,
`tests/session.test.mjs`, `tests/live.mjs`

**Patterns:** `userId` from `ctx.sessionManager.getSessionId()` (stable per pi session, so two
sessions never share tabs); idempotent `session_shutdown` teardown; keep tool code free of UI so
JSON/print mode works.

**Suite safety (review amendment):** install a global fetch guard for every test run — any request
not explicitly stubbed throws instead of reaching the LAN, so a forgotten mock can never quietly
exercise `192.168.8.110:9377`. Assert the tab-leak invariant after **every** test (zero live tabs for
our `userId`), not only in the teardown test.

**Test scenarios:** `userId` is stable within a session and differs across sessions; teardown calls
`DELETE /sessions/{userId}` exactly once and is safe to call twice; a tool that throws mid-call
still leaves no live tab for the next call; an unstubbed fetch fails the suite; README's config
example is the actual accepted shape. Live smoke (`CAMOUFOX_LIVE=1 node tests/live.mjs`) asserts ≥1
result for a search, a bounded read with a final URL, a clamped `n: 20`, and a clean gateway session
count afterward.

**Verification:** `NODE_ENV=test node --test tests/*.test.mjs` then
`CAMOUFOX_LIVE=1 node tests/live.mjs`

**Dependencies:** U5, U7

## Verification strategy

**Targeted:** per-unit `node --test` runs, each written RED first — the unit is not done until the
test is observed failing, then passing with real implementation.

**Broader:** full `NODE_ENV=test node --test tests/*.test.mjs` must be green with the global fetch
guard installed so no test can reach the network by accident; `npx tsc --noEmit` clean under
`strict`; opt-in `CAMOUFOX_LIVE=1 node tests/live.mjs` against `http://192.168.8.110:9377` for the
four live claims unit tests cannot prove — real results, final URL after `goto`, bounded read output,
and no session/tab leak.

**Coverage:** aim ≥80% on `src/`, with the parser and error taxonomy carrying the most cases since
they decide what the model believes about the web.
