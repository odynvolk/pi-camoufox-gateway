# A timeout from an engine is not a fault in the gateway

**Status:** accepted (2026-10-26), implemented on `main` by PR #22 (2026-10-27)

> **Recovered 2026-11-01** from `fix/search-engine-path-and-chain-timeout` (`ab4ed28`), which was never merged —
> so `main` carried this decision in `src/engines/chain.ts` for five days without the document that records it.
> Provenance and the artifacts deliberately left behind: `docs/brainstorms/2026-10-26-google-search-reliability.md`.

## Context

`src/engines/chain.ts` → `const TERMINAL_CODES` lists `timeout` alongside `gateway_unreachable`, on the
reasoning recorded beside it: *"transport failures are not an engine problem"*. Measured on a live
gateway with the shipped default config (`engines: [google, duckduckgo]`, `timeoutMs: 30000`), that
reasoning was true of the code and false of the situation: the google adapter's macro navigation
exceeded the 30 s request deadline, the chain treated that as the service being down, and the
duckduckgo adapter — which answers the same query in seconds — was never tried. Every default-configured
search returned one fault and no results.

Where the 30 s goes is recorded at `docs/improvements/2026-10-18-code.md` → B.9: upstream's
google-SERP predicate counts a `google.com/goto?url=`-wrapped title as **no** organic results, so a
google page that rendered perfectly answers `googleResultsAvailable: false`, and the gateway re-navigates
the same tab to duckduckgo and then bing — three navigations, one client request, one deadline.

## Decision

`timeout` stops being terminal inside the chain: an engine that runs out of time records a step in
`tried` and the chain walks to the next engine. To keep total wall clock bounded rather than multiplied,
the chain is given one deadline for the whole search (`config.timeoutMs`, read at the top of
`searchWithFallback`) and divides what is left by the engines left, so the budget is split across
engines instead of paid once per engine. Each attempt is bounded by a deadline that aborts **its own**
controller and relays the caller's signal, per
`docs/solutions/integration/cleanup-must-not-inherit-the-aborted-signal.md` — a deadline that abandons a
request mid-flight leaves a tab on the server that no leak assertion can see.

`gateway_unreachable`, `host_blocked` and `private_network` stay terminal, and the per-request deadline
inside `GatewayClient` is untouched: this changes only what the *chain* concludes from a timeout.

## Considered options

- **Do nothing to the chain, fix only the adapter.** Rejected: the same door stays open behind it. Any
  first engine that gets slow — not just a broken one — kills search with a message that blames the
  service.
- **Give each engine its own full `timeoutMs`.** Rejected: worst case becomes N × 30 s, paid by a model
  that asked one question.
- **Add a distinct code (`engine_timeout`).** Rejected as scope: `src/errors.ts` → `GatewayErrorCode`
  already carries 19 codes and `src/extension.ts` → `formatError` wires per-code advice for 9 of them —
  a new code is a new advice branch, not a rename. And the distinction the chain needs is *position in
  the chain*, which `tried` already says.

## Consequences

A dead gateway now costs two timeouts instead of one, bounded by the shared deadline — a longer wait for
a worse answer, in exchange for not mistaking one slow engine for an outage. `tried` becomes the record
that matters on the failure path, and `src/extension.ts` already prints it.

**What the bound actually bounds — read this before promising a latency.** It is a deadline over the
engine chain, and only over requests that read their signal. Three paths inside one search sit outside
it, each bounded per-request by `this.timeoutMs` instead:

- `src/gateway.ts` → `reconcileStrayTabs`, which `openTab` awaits with no signal after an ambiguous
  failure (`isAmbiguousTabOpen` covers `timeout` and `aborted`, so an engine-slice abort *triggers* it).
  A deadline wrapper cannot return before `run` settles, so a slice that fires mid-`openTab` is followed
  by a `GET /tabs` and a close per stray.
- `closeTabQuietly`, which by design takes no signal — correct teardown, un-teardown-bounded time.
- `resolveUrls`, called from `src/tools/search.ts` → `? await resolveUrls(visible,` **without** a
  `timeoutMs`, so a `resolve: true` search is bounded only by the caller's signal, after the chain
  deadline has already expired.

Threading the deadline into the first and third would widen this unit into the resource-reconciliation
path, which is the path `docs/solutions/integration/cleanup-must-not-inherit-the-aborted-signal.md`
exists to warn about. Out of scope, named here, and recorded in the plan's boundaries.
