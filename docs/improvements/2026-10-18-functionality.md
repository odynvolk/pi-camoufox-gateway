---
title: Functionality improvements — close the gateway-capability gap
date: 2026-10-18
status: proposed
baseline_commit: 68d1e14
version: 0.1.1
tags: [functionality, roadmap, gateway-capabilities, search, read, context-budget, security]
---

# Functionality improvements

Capability and user-visible behaviour only. Code-quality findings live in
[2026-10-18-code.md](./2026-10-18-code.md).

Evidence base: a full functional profile of `src/`, plus the gateway's own recorded OpenAPI
contract. "Reachable" below means *the gateway does this today and we simply don't call it* — a
stronger claim than "needs upstream work", and worth keeping the two separate.

## The finding that reframes the roadmap

**The gateway exposes 36 endpoints and 14 search macros. This client consumes 9 endpoints and 1
macro.**

Verified at `68d1e14`:

| Claim | Evidence |
| --- | --- |
| 9 of 36 endpoints | `ENDPOINTS` — `src/gateway.ts:103-113` |
| 1 of 14 macros | `const MACRO = "@google_search"` — `src/engines/google.ts:14` |
| `trace` / `sessionKey` / `listItemId` / `includeScreenshot` never sent | 0 occurrences anywhere in `src/` |
| Gateway surface is 36 paths, v1.14.0 | `tests/fixtures/openapi.json` (recorded from the live gateway) |

The recorded OpenAPI fixture is the authority here: it is not documentation that can drift, it is a
recording of the actual server. Our own fixture-conformance test already asserts against it.

**So the highest-leverage direction is not new capability. It is output-shape control** — let the
model ask for *less, and the right thing*, per call.

---

## Tier 1 — highest value, no gateway changes required

### 1.1 Search that returns content, not just pointers

**Outcome:** one search call returns ranked results *with* readable text, instead of 10 urls the
model must chase one at a time.

Each result today costs a full extra tool call **and** a fresh navigation, because every continuation
re-navigates (`read.ts:146`, `172-175`, `226-228`). Turn count is the dominant cost of a research
question, and this is where it's paid.

Jina's search endpoint exists precisely for this gap:

> s.jina.ai … searches the web, fetches the top 5 results, visits each URL, and applies r.jina.ai to
> it. This is different from many `web search function-calling` … which often return only the title,
> URL, and description provided by the search engine API.
> — https://github.com/jina-ai/reader

**Scope:** medium. `resolve.ts` already runs a bounded-concurrency tab pool; read already has the
snapshot loop. Add a per-result char budget and degrade to snippets on failure.
**Reachable:** yes — only `/tabs/open` + `/tabs/{id}/snapshot`, both already wired.

> ⚠️ **This is the prompt-injection amplifier.** Today, reading a page is an explicit act the model
> chose. This makes it implicit — content from pages nobody asked to read enters context in one
> shot. Accept only with: opt-in, per-result budget, per-result url header so provenance stays
> explicit, and the address guard unchanged.

### 1.2 Scope `read` to a content region

**Outcome:** `camoufox_read(url, { region: "article" })` returns the article, not the nav, footer,
and cookie banner.

On a 97 780-char page (measured in the v1 plan) the article may be ~20% of it. The 12 000-char
default is largely spent on chrome. Scoping is the only way to keep the default small *without*
losing the answer — and it is the honest answer to "the model will just ask for 500k".

Prior art: Jina's `x-target-selector` ("returns content within the matched element instead of the
full page. Useful when automatic content extraction misses what you want"), and Chrome DevTools MCP,
which scopes snapshots to elements by uid
([tool-reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)).

**Scope:** small–medium. Two routes: slice our existing snapshot between anchors (cheap, imprecise),
or scope at the gateway.
**Reachable:** mixed — reachable today only via `POST /tabs/{id}/evaluate`, which we should *not*
expose. This is the one Tier-1 item with a genuine design fork: **either** accept a fixed internal
expression template, **or** ask upstream for first-class region scoping.

> ⚠️ Never expose raw `expression`. A validated CSS `region` only, and **refuse selectors matching
> form controls** — a selector can reach `input[value]` and `document.cookie`, which turns a read
> tool into a credential reader.

### 1.3 Put a real ceiling on `maxChars`

**Outcome:** a request beyond policy comes back capped-with-a-note, not 500 000 chars into the
context window.

Only `>= 1` is enforced (`snapshot.ts:248`); the config-level guard applies to the *default*, not the
per-call param (`read.ts:206`). The 12 000 default exists to protect the context window, and the
caller it protects against is exactly the one this tool is designed for — a model that guesses "more
is better".

Prior art worth copying: Jina separates `x-max-tokens` (**trim**) from `x-token-budget` (**reject if
over**) — both directions of the same guardrail, chosen per request. OWASP lists Unbounded
Consumption as LLM10:2025 ([top-10](https://genai.owasp.org/llm-top-10/)).

**Scope:** tiny — one config key, one clamp, one disclosure line. Disclose it the way the `n` clamp
already is. **Reachable:** purely client-side. **Risk:** none.

### 1.4 Name the engine that answered, on the happy path

The `(via <engine>; tried …)` suffix only appears when `tried.length > 1` (`search.ts:60`), so a
first-try Google success never names the engine in the text a model reads — only in `details.engine`.

A model cannot calibrate trust in a result set it cannot attribute. "Google served this" and
"DuckDuckGo served this after Google walled" are different claims. Same fix covers the free-form
`engine?` param (`camoufox-gateway.ts:23`): requesting `bing` says *that* it isn't available, never
*why* — that reasoning exists only in prose.

**Scope:** trivial — the string is already computed. **Risk:** none.
*(Honest labelling: this one is internal-justification-strong, external-evidence-weak.)*

### 1.5 Add a second engine that returns JSON: `@reddit_search`

Per the gateway README's "Search Macros" section:

> Reddit macros return JSON directly (no HTML parsing needed): `@reddit_search` — search all of
> Reddit, returns JSON with 25 results.
> — https://github.com/jo-inc/camofox-browser

This is worth more than it looks, for two independent reasons:

1. **The parser is the fragile part of this system.** Every Google/DuckDuckGo markup drift costs a
   fixture re-record (`scripts/record-fixtures.py`, an out-of-band Python step). A JSON engine
   deletes an entire failure class.
2. **It breaks a ceiling we currently treat as structural.** `@google_search` takes only a `query`
   and Google's page is 10 wide, so `n > 10` is unreachable, not merely unimplemented
   (`google.ts:15-16`, `search.ts:46`). 25 results, no pagination work.

Also gives the fallback chain a second engine actually worth falling back to — DuckDuckGo's stated
reason for existing is Google-wall fallback (`duckduckgo.ts:1-4`), yet nothing verifies it as a
first choice.

**Scope:** small — one adapter plus a JSON branch; needs a "macro returns JSON" convention.
**Reachable:** yes — `/tabs/{id}/navigate` already accepts `{macro, query}` and we already call it.
Two caveats: no endpoint lists the macros, so engine names stay compile-time constants (consistent
with `ENGINE_NAMES`); and it needs the same seed-tab dance Google does.

### 1.6 Hydration tolerance on the search path

Both engines call `client.snapshot` exactly once, immediately after open/navigate
(`google.ts:25-26`, `duckduckgo.ts:21-22`). Only `camoufox_read` re-snapshots.

The consequence is a wrong statement about the world: a slow-rendering SERP is reported as **that
engine has no results**, then costs an engine hop on top of being wrong. And since a clean
zero-result answer is itself a fallback trigger, a wrong zero is worse than a timeout.

Jina exposes this exact trade-off as a per-request knob (`x-respond-timing`: `visible-content` /
`mutation-idle` / `resource-idle` — "trade off latency against completeness"). Our read path already
proves the mechanism works in this codebase.

**Scope:** small — reuse `snapshotSettled` with its own smaller budget so search doesn't inherit
read's cost. Report the time spent, as read already does.

---

## Tier 2 — clear value, a real cost or caveat

### 2.1 Stable session identity → authenticated reading *(the structural one)*

The gateway already does the hard part:

> By default, camofox persists each user's cookies and localStorage to
> `~/.camofox/profiles/<hashed-userId>/storage_state.json`. Sessions survive browser restarts — log
> in once (via cookies or VNC), and subsequent sessions restore the authenticated state
> automatically.
> — https://github.com/jo-inc/camofox-browser, README §Session Persistence

**The blocker is entirely ours.** `gatewaySessionId()` returns `"pi-" + <pi session id>`
(`src/session.ts:11-16`), so the gateway's persistence namespace rotates on every pi session and is
never reused. We are throwing away a feature the gateway is already providing.

This matters because a large share of research surface sits behind a login — and because the escape
hatch we already ship, `allowPrivateHosts`, implies intranet use, which is almost always
authenticated. Today that combination is half-built.

Prior art: Stagehand's headline demo is exactly this ("Cookies persist in ./browser-data, so the next
run starts already signed in" — https://github.com/browserbase/stagehand).

**Scope:** medium — one identity key, a naming rule, docs. The gateway does everything else. **The
policy work is the real cost, not the code.**

> ⚠️ **Highest-risk item in this document.** Persistent identity + a model that reads arbitrary urls
> is the textbook prompt-injection → credential-exfiltration chain: an authenticated read of an
> attacker-influenced page, with the gateway's identity carrying session cookies to that origin.
> (OWASP LLM01 / LLM02 / LLM06 — https://genai.owasp.org/llm-top-10/.)
>
> Require all three before shipping:
> - identity **opt-in per project**, never global;
> - `blockedHosts` becomes load-bearing for *credential* scoping, not just content scoping;
> - the guard must govern **which identity is used**, not only the destination url.
>
> And do not expose cookie import as a tool — keep it gateway-side and human-driven.

### 2.2 Traces, not screenshots, as failure evidence

On `empty_page` / `parse_error`, a *human* should be able to see what the tab was looking at. Our
failure modes — wall misclassification, parse drift, client-rendered thinness — are exactly what a
Playwright trace answers (network + DOM + console + screenshots).

The gateway supports opt-in `trace: true` plus list/download/delete, and explains the choice:
"Why traces instead of video: Camoufox is Firefox-based, and Playwright's recordVideo is
Chromium-only."

**A real design consequence surfaces here.** `trace` and `sessionKey` exist only on `POST /tabs`,
while we use `POST /tabs/open`. **Choosing `/tabs/open` is what locks out `trace` and
`sessionKey`.** (`listItemId` *is* accepted by `/tabs/open`, so tab grouping is not lost — verified
against the fixture.)

On screenshots: keep them **out of the tool path**. Playwright MCP ships them only behind an
opt-in `--caps vision` — the deliberate signal that vision is not a default path for a text agent. A
base64 PNG in model-facing text is a context-window incident. Put screenshots in
`scripts/diagnose-wall.mjs`, where the audience is a human.

**Risk:** a trace contains page content *and* network traffic — everything the address guard tries to
control, now unbounded on disk. Needs a TTL story (gateway default: `CAMOFOX_TRACES_TTL_HOURS=24`).

### 2.3 Content-type awareness — PDFs first

Reading a PDF currently yields `empty_page` or `parse_error`. A research agent hits PDFs constantly,
and the tool has no concept of "this is not a document-shaped page".

**Split the work — the cheap half is available now:**
- **Classify** (client-side, today): recognise `.pdf` and non-HTML content types, and say so.
  Valuable on its own; stops the misleading error.
- **Extract** (needs a newer gateway): the gateway's answer is
  `GET /tabs/:id/downloads` ("captured downloads and saved current-resource PDFs") and
  `POST /tabs/:tabId/fetch-current-resource`, which saves an inline PDF "with its browser-session
  authentication as a download artifact".

> **Version caveat, verified:** `/youtube/transcript`, `/tabs/:tabId/fetch-current-resource`, and
> `GET|DELETE /sessions/:userId/storage_state` appear in the upstream README but are **absent from
> our recorded 1.14.0 fixture** (36 paths, none of these). This is the only Tier-2 item that is a
> genuine gateway-version dependency. Our fixture-conformance test is the right gate.

Note the posture change: a download means a file lands on the gateway host — a different risk
profile from returning text.

### 2.4 Per-call cache bypass, and fix what `cache.pageMs` means

30 minutes of SERP staleness is right for research and wrong for "what's the latest", and nothing
today lets the model say otherwise.

Separately: **`cache.pageMs` does not cache pages.** Its only consumer is goto-wrapper resolution
(`search.ts:133` → `resolve.ts:74-92`); `camoufox_read` has no cache dependency at all
(`read.ts:16-20`). That name is model-facing in the README config table, so it is not just an
internal misnomer. See the code doc, §A.2.

Prior art: Jina expresses freshness as `x-cache-tolerance: <seconds>` — **staleness tolerance rather
than a boolean**, which is the better shape, with `x-no-cache` for the hard override.

**Scope:** small. **Reachable:** purely client-side.

### 2.5 Multi-result reads — one call, several urls

`urls: [...]` returning N bounded pages under one shared budget. Turn count again, plus a *fairer*
budget: N pages sharing one ceiling is more predictable than N calls each taking 12 000 chars.

Batch-per-call is the direction the ecosystem is moving — Chrome DevTools MCP's `fill_form` says
"ALWAYS prefer this tool over multiple individual calls … significantly faster, more reliable, and
reduces turn count."

**Reachable:** yes — `resolve.ts` already does bounded concurrent tabs.

> ⚠️ **This is where a url allowlist stops being optional.** One prompt-influenced call carrying 8
> urls, one of them `http://169.254.169.254`, is exactly what the address guard exists for. The
> danger is specifically partial-failure semantics: "return what worked, note what didn't" is how a
> guard silently becomes advisory. A guard refusal inside a batch must either abort the batch or be
> reported with the weight of a whole-call refusal. *(This is a design opinion, not a finding.)*

---

## Tier 3 — record it, don't build it soon

| Capability | Reachable? | Why not now |
| --- | --- | --- |
| `/health` as preflight + real status in errors | yes | **Best promotion candidate.** Returns `browserConnected`, `browserRunning`, `activeTabs`, `activeSessions`, `consecutiveFailures`. "Browser not connected, 0 active tabs" is a *different instruction to a model* than "gateway failed". Small, zero risk. |
| `GET /tabs/{id}/links` | yes | Returns `{text, href, ref}` — a cleaner "what's on this page" than re-parsing the tree. We have no "give me the links" affordance today. |
| Tab-group teardown `DELETE /tabs/group/{listItemId}` | yes | Solves a leak class the per-tab `finally` close already covers. Marginal. |
| `viewport` / mobile as a token lever | yes | Playwright MCP: "Mobile pages are usually lighter, which saves tokens." Genuinely clever, but it changes *what renders* → silently invalidates fixture-based parsing. |
| `back` / `forward` / `refresh` | yes | History navigation makes "which page am I reading?" a question with a moving answer, in a tool whose entire contract is "this text came from this url". Expose `refresh` only as a session-scoped retry, if at all. |
| `POST /pressure/cleanup` as a reset | yes | A destructive action reachable by the model is OWASP LLM06 (Excessive Agency). Script-only at most, `dryRun: true` first. |
| `/youtube/transcript` | **needs newer gateway** | Cleanest new-content-type candidate otherwise — output is trivially text-shaped. |

---

## Deliberately leave alone

Guarding stated non-goals, with external evidence for why each refusal is correct rather than
timid.

- **`click` / `type` / `press` / `scroll` / `/act`.** The recorded reason — refs valid only until the
  next navigation — is a *correct* reason, and the ecosystem shows the true cost: Chrome DevTools MCP
  needs uid-from-snapshot discipline across 10 input tools, and Stagehand needs an LLM in the loop
  just to make refs reliable. Interaction turns a two-tool, stateless, idempotent extension into a
  stateful session API — and breaks `readOnlyHint: true`.
- **Raw `evaluate`.** The one reachable endpoint to actively refuse. It converts a read tool into
  arbitrary code execution in an arbitrary origin.
- **`upload`.** Writes to the gateway host from a model-facing call; needs a filesystem trust
  boundary this repo has no business owning.
- **Defaulting `read` to `innerText`.** Rejected in review already, and nothing found here reopens
  it. Every comparable agent-facing default is the accessibility tree, and the gateway claims ~90%
  smaller than raw HTML for it.
- **An LLM inside the tool path** (Stagehand-style `act`/`extract`). The gateway already provides the
  tree and the pi caller already has the model. A second model inside the tool makes failures
  unattributable and turns output into interpretation rather than transcript.
- **An MCP server bridge.** Rejected already, and upstream ships an OpenClaw plugin
  (`@askjo/camofox-browser`), so the bridge exists where it matters.
- **An `allowedHosts` allowlist.** Tempting next to `blockedHosts`, but `allowPrivateHosts` exists
  precisely for "I want to read internal things" — an allowlist turns a working tool into a
  silently-empty one in the common case. Honest counter-argument: playwright-mcp ships both and
  documents that neither is a security boundary.

---

## Open questions for the author

1. **Which identity model is intended** — per-pi-session isolation (current) or a durable per-user
   browser identity? Everything in 2.1 hangs on this and it is decided nowhere in the repo.
2. **Is `resolve: true` used in practice**, or is it an escape hatch nobody reaches? That answer
   decides whether 1.1 *replaces* it or sits behind it.
3. **What is the observed real-world rate of each failure code?** `formatError` carries 18 codes and
   the v1 plan records that the read-thin decision was deferred to v2 "for lack of usage data" — and
   nothing collects it. Without it, the 1.2-vs-1.3 choice (scope vs budget) is a guess.
4. **Is the gateway trusted-local or a network service?** `CAMOFOX_ACCESS_KEY` and
   `CAMOFOX_BIND_HOST` exist upstream; our only auth is a Bearer key. Every SSRF and exfiltration
   judgement above changes if the gateway is reachable off-box.
5. **Should the client move `POST /tabs/open` → `POST /tabs`?** Costs nothing today, but it is what
   currently locks out `sessionKey` and `trace`.
6. **Should the README warn about upstream telemetry?** `CAMOFOX_CRASH_REPORT_ENABLED` is **on by
   default** and reports target urls (well-known public domains verbatim, unknown ones HMAC-hashed)
   to a third-party endpoint. Our docs say nothing, and the gateway — not this client — is the thing
   that talks to the internet. Given this repo's zero-API-key / privacy posture, that silence looks
   like an omission rather than a decision.

---

## Sources

- `tests/fixtures/openapi.json` — recorded gateway OpenAPI (camofox-browser **1.14.0**, 36 paths);
  primary authority for endpoint reachability
- https://github.com/jo-inc/camofox-browser — search macros (14), session persistence, traces,
  downloads, telemetry defaults
- https://github.com/jina-ai/reader — `x-target-selector`, `x-max-tokens` / `x-token-budget`,
  `x-respond-timing`, `x-no-cache` / `x-cache-tolerance`, s.jina.ai search-then-read, PDF.js
- https://github.com/microsoft/playwright-mcp — `--caps vision` opt-in, `--mobile` token savings
- https://github.com/ChromeDevTools/chrome-devtools-mcp (+ `docs/design-principles.md`,
  `docs/tool-reference.md`) — element-scoped snapshots, `fill_form` batch-per-call guidance
- https://github.com/browserbase/stagehand — persistent-cookie authenticated-session demo
- https://genai.owasp.org/llm-top-10/ — LLM01 prompt injection, LLM02, LLM06 excessive agency,
  LLM10:2025 unbounded consumption

## Read this alongside

- [2026-10-18-code.md](./2026-10-18-code.md) — correctness, error attribution, lifecycle
- `docs/brainstorms/2026-10-09-pi-camoufox-gateway.md` — original requirements and Option C
- `docs/plans/archive/2026-10-09-camoufox-search-extension.md` — v1 decisions, incl. what was
  deliberately deferred to v2
- `docs/solutions/` — wall detection and cleanup-signal lessons already learned
