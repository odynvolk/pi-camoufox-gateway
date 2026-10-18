# pi-camoufox-gateway

Give pi web search and page reading through a self-hosted [Camoufox](https://camoufox.com) browser
gateway. No API keys, no per-query cost, and JavaScript-rendered pages come back readable.

This repo is the **pi extension**. The gateway (`camofox-browser`) runs separately; this code just
talks to it over HTTP.

## Tools

### `camoufox_search(query, n?, engine?, resolve?)`

Searches through the browser and returns ranked titles, urls and snippets.

- Google goes through the gateway's `@google_search` macro, which is what survives Google's consent
  interstitial. If Google walls us, DuckDuckGo answers and the output says which engines were tried.
- Bing is not offered: through this gateway it returns a `Network Protocol Error` before results
  render, so it would only ever waste a page load.
- `n` is clamped to 10. The macro takes only a query, so a longer list is not reachable.
- `resolve: true` turns Google's `google.com/goto?url=…` wrappers into final urls. It costs one
  extra page load per result and runs at most three tabs at a time, so it is off by default.

### `camoufox_read(url, maxChars?, offset?, waitFor?, schema?)`

Loads a page in the browser and returns its text.

- Reports the **final** url after redirects.
- Defaults to 12,000 characters (~3K tokens) and tells you the `offset` to continue from. A full
  page from the gateway runs 20K+ tokens, which is the difference between reading a page and losing
  your context window.
- **Waits for the page to render.** `openTab` returning does not mean the content is there: a
  client-rendered site answers with its skeleton. A snapshot thinner than `read.settleMinChars` is
  re-taken until it stops growing, up to `read.waitForSettleMs`. If it never fills in, the output
  says so instead of letting the model conclude the site is empty.
- `waitFor` takes a CSS selector and asks the gateway to hold until it appears — use it when the
  settle heuristic cannot guess the content (`waitFor: "#article"`). A wait that cannot complete — no
  `/wait` route, or a gateway that ignores its own deadline until the client cuts it off at
  `timeoutMs` — costs the wait, not the page: the read continues and says which it was.
- `schema` accepts a JSON Schema whose properties carry `x-ref` hints; the tool snapshots the page
  first (refs only exist after a snapshot), then calls the gateway's extractor.
- Refuses internal addresses, and keeps refusing after the browser moves. `blockedHosts` is applied,
  and so is a block on loopback, RFC1918, link-local (including the cloud metadata IP) and other
  non-global addresses — see `network.allowPrivateHosts`. Every destination gets checked, at tab open
  and on every snapshot, so a public url that redirects to `169.254.169.254` does not get read back —
  including by a gateway that reports no destination at open, which is the case a check at open alone
  would have missed.
- Refuses to return a page it cannot place. A snapshot that reports no url is checked against the tab
  list, and if nothing will say where the tab is, the read fails with `destination_unreported` rather
  than hand back unverified content under the url we asked for. Switching the guard off entirely
  (`allowPrivateHosts: true`, empty `blockedHosts`) drops this requirement too.

## Install

Install it as a pi package and pi wires it into your settings:

```bash
pi install npm:pi-camoufox-gateway        # every session (~/.pi/agent/settings.json)
pi install -l npm:pi-camoufox-gateway     # this project only (.pi/settings.json)
```

The `camoufox_search` and `camoufox_read` tools are then available the next time pi starts. Try it
for a single run without writing to settings:

```bash
pi -e npm:pi-camoufox-gateway
```

Manage it with `pi list`, `pi remove npm:pi-camoufox-gateway` (`pi uninstall` is an alias) and
`pi update`.

Without npm, or straight from this checkout:

```bash
pi install git:github.com/odynvolk/pi-camoufox-gateway@v0.1.1   # pinned to a tag
pi install ./pi-camoufox-gateway                                 # a local checkout
pi -e ./src/camoufox-gateway.ts                                  # from this repo, nothing installed
```

You do not need to declare `pi.extensions` anywhere yourself — `package.json` points pi at
`src/camoufox-gateway.ts`. Pointing the extension at your gateway is described below.

Requires Node 23+ and a running `camofox-browser`; the extension is shipped as TypeScript and pi
loads it directly.

## Configuration

Config resolves **defaults → JSON file → environment variables**.

File location: `$CAMOUFOX_CONFIG_PATH`, or `$PI_CODING_AGENT_DIR/camoufox.json`
(default `~/.pi/agent/camoufox.json`). See [`config.example.json`](./config.example.json).

Environment: `CAMOUFOX_GATEWAY_URL`, `CAMOUFOX_API_KEY`, `CAMOUFOX_CONFIG_PATH`,
`CAMOUFOX_ALLOW_PRIVATE_HOSTS`.

| Setting | Default | Notes |
|---|---|---|
| `gatewayUrl` | `http://localhost:9377` | must be absolute `http(s)` |
| `apiKey` | unset | sent as `Bearer` only if set |
| `engines` | google, duckduckgo | ordered fallback chain |
| `cache.serpMs` / `cache.pageMs` | 30 min / 10 min | failures are never cached |
| `read.defaultMaxChars` | 12000 | per-read text budget |
| `read.waitForSettleMs` | 2500 | extra time a read may spend re-snapshotting a thin page; `0` disables |
| `read.settlePollMs` | 300 | gap between those polls |
| `read.settleMinChars` | 1500 | below this the page is treated as not yet rendered |
| `read.waitForTimeoutMs` | 5000 | deadline handed to the gateway for an explicit `waitFor`, capped at `timeoutMs` |
| `search.maxResults` | 10 | hard ceiling, engine page size |
| `blockedHosts` | `[]` | applied to every destination we open or read back, incl. `resolve: true` and redirects; the gateway enforces none |
| `network.allowPrivateHosts` | `false` | let tabs open loopback/RFC1918/link-local addresses |
| `timeoutMs` | 30000 | per gateway request |

Unknown keys are a hard error on purpose — a silently typo'd setting is worse than a loud one. A
config file that exists but fails to load is not replaced with defaults either: every tool call
returns `config_error` naming the file and the key, so a typo cannot quietly point the extension at
the wrong gateway.

Values that are individually valid but cannot both be true are refused too, naming both keys:
`read.settlePollMs` has to be below `read.waitForSettleMs` (at or above it the page is polled exactly
once, and the budget stops meaning anything), and `read.waitForTimeoutMs` below `timeoutMs` (the
client aborts any request at `timeoutMs`, so a longer selector deadline could never be reached).

## Error codes

The tool output starts with the code so the model can react instead of guessing.

| Code | Meaning |
|---|---|
| `config_error` | the config file is unreadable or invalid, so nothing was attempted |
| `gateway_unreachable` | cannot reach `gatewayUrl` (one cheap liveness probe per 60s window, not one timeout per call) |
| `gateway_unauthorized` | gateway rejected `apiKey` |
| `gateway_error` | the gateway answered with a failure, or something threw without a code |
| `consent_wall` | Google served consent/CAPTCHA, not results |
| `empty_results` | clean page, zero organic results |
| `empty_page` / `navigation_failed` | nothing rendered / browser error page |
| `parse_error` | the accessibility tree changed shape |
| `extraction_empty` | schema refs matched nothing on this page |
| `host_blocked` | url matched `blockedHosts` |
| `private_network` | url — or a redirect it landed on — is an internal address and `network.allowPrivateHosts` is off |
| `destination_unreported` | nothing would say where the tab ended up, so the page was not returned |
| `blocked_url` | not an http(s) url |
| `tab_not_found` | the tab was closed under us (session teardown or a stray sweep) |
| `unsupported` | bad input or an engine we have no adapter for — nothing was fetched |
| `timeout` / `aborted` | deadline hit / tool call cancelled |

## What this does not do

- No browser or gateway code — that lives in `camofox-browser`.
- No clicking, typing or scrolling. Refs (`[e12]`) are only valid until the next navigation, which
  makes an interaction API hard to promise. The one exception is `waitFor`, which asks the gateway to
  hold for a selector rather than acting on the page.
- No defence against a *hostname* that resolves to an internal address (DNS rebinding, a `localhost`
  alias). The address guard reads the url and the redirect chain, not the DNS answer; egress policy
  belongs on the gateway.
- No LLM in the tool path. The tools return raw data; your model does the reading.
- Sessions: tabs live in a gateway session named after your pi session id and are torn down on
  `session_shutdown`. A lost `POST /tabs/open` response also triggers a sweep: the gateway may hold a
  tab we were never given an id for, so it is listed and closed rather than left behind.

## Development

```bash
npm install
npm test          # unit + fixture tests, no network access
npm run typecheck
npm run test:live # live smoke test against the configured gateway
python3 scripts/record-fixtures.py  # re-record snapshots after a gateway or Google change
```

Requires **Node ≥ 23**: the tests import `src/*.ts` directly, which depends on Node's native type
stripping. On 20 or 21 you get `ERR_UNKNOWN_FILE_EXTENSION` instead of a test failure.

The snapshot fixtures under `tests/fixtures/` are real captures. If a parser test fails, re-record
them before concluding the parser broke.
