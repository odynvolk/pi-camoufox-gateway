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
  extra page load per result, so it is off by default.

### `camoufox_read(url, maxChars?, offset?, schema?)`

Loads a page in the browser and returns its text.

- Reports the **final** url after redirects.
- Defaults to 12,000 characters (~3K tokens) and tells you the `offset` to continue from. A full
  page from the gateway runs 20K+ tokens, which is the difference between reading a page and losing
  your context window.
- `schema` accepts a JSON Schema whose properties carry `x-ref` hints; the tool snapshots the page
  first (refs only exist after a snapshot), then calls the gateway's extractor.

## Install

Load it directly for development:

```bash
pi --extension ./src/index.ts
```

Or point `pi.extensions` in `package.json` at `./src/index.ts` and install the package.

## Configuration

Config resolves **defaults → JSON file → environment variables**.

File location: `$CAMOUFOX_CONFIG_PATH`, or `$PI_CODING_AGENT_DIR/camoufox.json`
(default `~/.pi/agent/camoufox.json`). See [`config.example.json`](./config.example.json).

Environment: `CAMOUFOX_GATEWAY_URL`, `CAMOUFOX_API_KEY`, `CAMOUFOX_CONFIG_PATH`.

| Setting | Default | Notes |
|---|---|---|
| `gatewayUrl` | `http://192.168.8.110:9377` | must be absolute `http(s)` |
| `apiKey` | unset | sent as `Bearer` only if set |
| `engines` | google, duckduckgo | ordered fallback chain |
| `cache.serpMs` / `cache.pageMs` | 30 min / 10 min | failures are never cached |
| `read.defaultMaxChars` | 12000 | per-read text budget |
| `search.maxResults` | 10 | hard ceiling, engine page size |
| `blockedHosts` | `[]` | client-side guard; the gateway enforces none |
| `timeoutMs` | 30000 | per gateway request |

Unknown keys are a hard error on purpose — a silently typo'd setting is worse than a loud one. A
config file that exists but fails to load is not replaced with defaults either: every tool call
returns `config_error` naming the file and the key, so a typo cannot quietly point the extension at
the wrong gateway.

## Error codes

The tool output starts with the code so the model can react instead of guessing.

| Code | Meaning |
|---|---|
| `gateway_unreachable` | cannot reach `gatewayUrl` (one cheap liveness probe per 60s window, not one timeout per call) |
| `gateway_unauthorized` | gateway rejected `apiKey` |
| `consent_wall` | Google served consent/CAPTCHA, not results |
| `empty_results` | clean page, zero organic results |
| `empty_page` / `navigation_failed` | nothing rendered / browser error page |
| `parse_error` | the accessibility tree changed shape |
| `extraction_empty` | schema refs matched nothing on this page |
| `host_blocked` | url matched `blockedHosts` |
| `blocked_url` | not an http(s) url |
| `timeout` / `aborted` | deadline hit / tool call cancelled |

## What this does not do

- No browser or gateway code — that lives in `camofox-browser`.
- No clicking, typing or scrolling. Refs (`[e12]`) are only valid until the next navigation, which
  makes an interaction API hard to promise.
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
