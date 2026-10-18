# CONTEXT

Canonical vocabulary for this repo. Not a spec — see `docs/brainstorms/` and `docs/plans/`.

- **Gateway** — the external `camofox-browser` HTTP server (`http://localhost:9377`, configurable).
  We only call it; this repo runs no browser and owns no server code.
- **Session** — gateway-side tab namespace keyed by `userId`, derived from the pi session id.
  Distinct sessions must never share tabs.
- **Tab** — one browser page inside a session. Created by `POST /tabs/open` (http/https only,
  `about:blank` is refused). Always closed on our side.
- **Snapshot** — the accessibility-tree text returned by `/snapshot`. Our only source of truth about
  a page; paginated with `offset`, formats `text` | `json`.
- **Ref** — an `[eN]` handle inside a snapshot. Valid only until the next navigation; a stale ref is
  a normal condition, not a bug.
- **SERP** — search engine results page.
- **goto URL** — a `google.com/goto?url=CAES…` wrapper. Not locally decodable; it becomes the real
  URL only when we navigate to it.
- **Engine adapter** — the module that turns a query into results for one engine
  (Google via the `@google_search` macro; DuckDuckGo via direct navigation).
- **Wall** — a consent or CAPTCHA interstitial. Distinct from "no results" and from a timeout; the
  model is told which one it hit.
- **Settle** — re-snapshotting a page that came back thinner than `read.settleMinChars` until it
  stops growing. "The tab opened" and "the page rendered" are different events on a client-rendered
  site, and only the second one is worth returning.
- **Address guard** — the rule in `net-policy.ts` that refuses tabs at non-http urls, `blockedHosts`
  matches, and internal addresses. Enforced inside `GatewayClient.openTab` on the url we were given
  *and* on the destination the gateway reports, so every navigation inherits it — including `resolve`
  opening urls a search engine handed us.
- **Resolve** — opt-in follow-through that turns `goto` URLs into final URLs using concurrent tabs.
