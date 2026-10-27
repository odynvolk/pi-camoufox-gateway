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
- **Engine adapter** — the module that turns a query into results for one engine. Both open a tab at
  their own results url (`POST /tabs/open`); neither uses a gateway macro. An adapter is credited with a
  page only when that page's host is its own — `engineOwnsUrl` in `snapshot.ts` — because chrome is
  filtered by the engine's host list and the credit is taken from `Engine.name`.
- **Wall** — a consent or CAPTCHA interstitial. Distinct from "no results" and from a timeout; the
  model is told which one it hit.
- **Settle** — re-snapshotting a page that came back thinner than `read.settleMinChars` until it
  stops growing. "The tab opened" and "the page rendered" are different events on a client-rendered
  site, and only the second one is worth returning.
- **Address guard** — the rule in `net-policy.ts` that refuses tabs at non-http urls, `blockedHosts`
  matches, and internal addresses. Enforced inside `GatewayClient`, at both ends of a navigation: on the
  url handed to `openTab`, and on the destination any response reports — the one `/tabs/open` returns and
  the one every `/snapshot` returns, so `read`, both search engines and `resolve` inherit it without
  writing it. The snapshot half is the load-bearing one: a gateway that reports no url at open leaves the
  open-time check comparing a string with itself, and a page that moves after the tab opened only ever
  shows up in a snapshot. It fails closed: a snapshot that reports no destination is checked against the
  tab list, and if nothing will say where the tab is, the read refuses with `destination_unreported`
  rather than return content that cannot be placed under the url we asked for.
- **Resolve** — opt-in follow-through that turns `goto` URLs into final URLs using concurrent tabs.
