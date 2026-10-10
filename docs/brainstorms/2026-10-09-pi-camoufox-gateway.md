# Requirements: pi extension for Camoufox-backed web search

Date: 2026-10-09
Mode: CE Brainstorm
Status: Ready for `02-plan`

## Problem

pi has no web access of its own: it ships no built-in `web_search` or `web_fetch`, and the
existing ecosystem option (`pi-web-search@1.7.0`) is entirely **provider-native** — it routes
through paid Gemini / Grok / OpenAI / Anthropic / DeepSeek / Ollama / OpenCode APIs and needs
credentials. That leaves two gaps:

1. **Cost + keys.** Every search is metered, and searches stop working when quota or a key runs
   out.
2. **JS-rendered pages.** A plain HTTP fetch cannot read client-rendered pages, so anything beyond
   a static HTML body is out of reach.

The user already runs `camofox-browser` v1.14.0 — an anti-detection browser automation server —
on their LAN (`http://localhost:9377`). It gives real browser execution, session isolation,
cookie import, and proxy rotation for free. What is missing is the bridge: a way for pi's model to
call it.

## Goals

- Add two model-facing tools to pi, registered by a local TypeScript extension:
  - `camoufox_search(query, …)` — arbitrary keywords → ranked results (title, url, snippet, source).
  - `camoufox_read(url, …)` — any URL → readable page content, with optional structured extraction.
- Zero API keys and zero per-query cost.
- Read JS-rendered pages through the same browser, so the model can get real data from any site.
- Fail *legibly*: the model receives a code plus observed evidence, so it can change strategy.
- Survive Google's consent wall, which already broke a hand-built SERP URL in testing.

## Non-goals

- No gateway/server code in this repo. `camofox-browser` stays an external running service we only
  talk HTTP to.
- No LLM anywhere inside the tool path — tools return raw structured data, and pi's own model does
  the reading and summarizing.
- No page interaction (click / type / scroll / drag) in v1 — snapshot refs are too volatile to
  expose as an API yet.
- No npm publishing, Docker image, or hosted deployment. Distribution is local-first.
- No cookie import, proxy rotation, or trace download UI. Available on the gateway, deferred.
- No `.env`, `.data/`, or `public/` changes (project boundary rules).

## Approach options

### A. Single-file extension

One `index.ts` (~300 lines) loaded with `pi --extension ./index.ts`. Direct `fetch` calls, regex
parsing of the snapshot text, Google macro only.

- **Pros:** ships in an afternoon; almost nothing to maintain.
- **Cons:** the fallback chain, URL resolution, and snapshot parsing collapse into spaghetti the
  first time Google nudges the tree. Errors become opaque strings, so the model can't act on them.

### B. Modular extension (recommended)

`src/index.ts` (registration + tool schemas), `src/gateway.ts` (typed client, retry, teardown),
`src/engines/{google,duckduckgo,bing}.ts` behind one `Engine` interface, `src/snapshot.ts`
(accessibility-tree → results), `src/cache.ts`, `src/resolve.ts` (parallel-tab URL resolution),
`src/config.ts`. Unit tests against a fake gateway, opt-in live smoke tests.

- **Pros:** engine isolation keeps Google's quirks contained where they can be tested against
  recorded snapshots; typed error codes make the failure policy real; cache and resolver stay
  independently testable.
- **Cons:** one abstraction layer to keep honest; slightly more initial scaffolding.

### C. Full browser OS

B, plus `POST /sessions/{userId}/cookies` import, screenshot-on-failure evidence, a `/camoufox`
status command showing gateway health and open tabs, schema presets for `camoufox_read`, cache hit
stats, and packaging as a distributable npm pi package.

- **Pros:** most capable and most observable; best path to someone else installing it.
- **Cons:** builds the dashboard before anyone asked for it. Only worth it once B is used daily.

## Recommended direction

**Build B.** The genuinely hard parts here are not HTTP calls, they are (a) keeping a stable result
shape when the SERP tree shifts, and (b) making failure states distinguishable enough that the model
behaves differently. Both need one clear adapter interface and typed errors, which is exactly what A
lacks. C's additions are real, but they are v2 features riding on a shape that has not been
exercised yet.

Two specifics that fall out of live evidence rather than preference:

- **Use the gateway's `@google_search` macro for Google.** Hand-built URLs with `hl`/`gl`/`gbv=1`
  were intercepted by `consent.google.com`; the macro returned a clean result list twice. Engine
  fallback then covers macro failure and 0-result cases.
- **Return `goto` URLs as-is by default.** The `google.com/goto?url=CAES…` tokens are not locally
  decodable (base64 → signed protobuf, no plaintext), but navigating to them resolves to the real
  destination — confirmed: `github.com/daijro/camoufox`. Resolving all ~10 results upfront costs
  ~10 extra browser hops per search, so `resolve: true` becomes the opt-in, resolving the top N in
  parallel tabs.

## Verified facts about the gateway

Probe evidence gathered 2026-10-09 against `http://localhost:9377`:

- `GET /` → `{ok, enabled, running, engine:"camoufox", browserConnected, browserRunning}`.
  `GET /health` adds `activeTabs`, `activeSessions`, `consecutiveFailures`, `memory{rssMb,heapUsedMb}`.
- OpenAPI at `/openapi.json`, Swagger UI at `/docs/`. Title `camofox-browser`, version 1.14.0.
- Search flow that works:
  `POST /tabs/open {userId,url:"https://…"}` → `{tabId,targetId}` →
  `POST /tabs/{tabId}/navigate {userId, macro:"@google_search", query}` →
  `{ok, url:"…/search?q=…", refsAvailable, googleSerp:true}` →
  `GET /tabs/{tabId}/snapshot?userId&format=text` → accessibility tree where each result is
  `link "Title" [eN]` with `/url:`, `cite:`, `text:` children.
- Gotchas: `about:blank` is rejected by `/tabs/open` (http/https only); navigate does **not**
  auto-create a tab despite its OpenAPI description; snapshots paginate with `offset`; format enum
  is `text` | `json`; `POST /tabs/{tabId}/extract` needs refs from a prior snapshot;
  `DELETE /sessions/{userId}` tears down tabs; `GET /metrics` is disabled by default.
- Locale is not controllable from the URL: results arrive as `Sök på Google` (Swedish UI).
- Fallback engines reachable through the gateway with a plain navigate: `duckduckgo.com/?q=`,
  `html.duckduckgo.com/html/?q=`, `bing.com/search?q=`.

## Success criteria

- `camoufox_search("some exact phrase")` returns ≥ 1 result with non-empty title and URL, against
  the live gateway.
- `camoufox_read("https://…")` returns page text from a client-rendered page that `curl` cannot
  read.
- `camoufox_read` reports the **final** URL after navigation, so the model can tell it left Google.
- When the gateway is unreachable, the tool returns an actionable error naming the configured URL,
  and does not crash the session or leak a tab.
- A consent/CAPTCHA wall is reported as `consent_wall`, not as 0 results or a generic timeout.
- A search failure after one retry falls through to the next engine and the result says which
  engine served it.
- Repeat calls inside the TTL window touch the gateway zero times.
- Session teardown removes this extension's `userId` sessions; a test asserts no tab survives.
- Unit suite runs without network access; the live suite is opt-in.

## Failure modes to design for

| Failure | Required behavior |
|---|---|
| Gateway down / refused | `gateway_unreachable` with configured URL + hint to check `GET /` |
| Consent or CAPTCHA wall | `consent_wall`, no retry loop, note which engine hit it |
| 0 results | `empty_results`, then next engine, reporting the chain tried |
| Snapshot truncated | Return what was read, plus `truncated: true` and the `offset` to continue |
| `goto` never resolves | Keep the raw URL in output, note `unresolved`, never drop the result |
| Abort mid-navigation | `finally` cleanup closes the tab; no leak into the next call |
| Two concurrent pi sessions | Distinct `userId`; no shared tab state |
| Google tree change | Parse failure returns `parse_error` with a snapshot excerpt for diagnosis |

## Domain vocabulary

- **Gateway** — the external `camofox-browser` HTTP server; we only call it.
- **Session** — gateway-side tab namespace keyed by `userId`, which we derive per pi session.
- **Snapshot** — the accessibility-tree text returned by `/snapshot`, our primary source of truth.
- **Ref** — a `[eN]` handle in a snapshot, valid only until the next navigation.
- **SERP** — search engine results page.
- **goto URL** — a `google.com/goto?url=…` redirect wrapper that resolves only by navigation.
- **Engine adapter** — the module that turns a query into results for one search engine.

## Open questions

None blocking. Deferred knowingly to v2: interactions (`click`/`type`/`scroll`), cookie import,
proxy rotation, screenshot evidence, `/camoufox` status command, npm distribution.
