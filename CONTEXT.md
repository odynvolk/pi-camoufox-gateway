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
- **Resolve** — opt-in follow-through that turns `goto` URLs into final URLs using concurrent tabs.
