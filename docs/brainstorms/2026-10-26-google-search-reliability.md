---
title: Make search work again — the google path, the terminal timeout, and results that were chrome
date: 2026-10-26
status: approved-for-plan
baseline_commit: 2197c7c
version: 0.2.0
tags: [search, google, engine-chain, serp-parsing, reliability, stale-premise]
---

> **Recovered 2026-11-01.** This round's *work* landed on `main` as PR #22; its *planning* did not. This file,
> `docs/plans/2026-10-26-google-search-reliability.md` and `docs/adr/0001-timeout-from-an-engine-is-not-terminal.md`
> existed only on `fix/search-engine-path-and-chain-timeout` (`ab4ed28`) while two handoffs and a checkpoint
> cited them by path — and `main` implements that ADR's decision (the terminal-code list in
> `src/engines/chain.ts` no longer carries `timeout`, with a comment saying that removal "was the fix") with
> no ADR in the repo to say why. Code claims below are as-of
> 2026-10-26; the macro path they describe was removed by PR #22 on 2026-10-27. Four artifacts from that
> branch are deliberately **not** here — `src/engines/search-url.ts`, `scripts/probe-google-urls.mjs`,
> `tests/probe-google-urls.test.mjs` (which would join the suite unverified) and upstream's
> `lib/google-serp.js` — because importing code nobody has run is how the stale-premise class in this file
> got written in the first place. `docs/plans/2026-10-23-external-review-reconciliation.md` is cited below
> and exists in no ref in this repository: it was already dangling on the branch.

<!-- Opened as "prepare a review of all open issues, prioritising the Google consent interstitial"; the
     consent framing did not survive five live probes, and is retired below rather than kept as a title. -->

# Make search work again

Opened as "prepare a review of all open issues, prioritising the Google consent interstitial". The
consent framing did not survive five live probes, so this document is about what was found instead.
It is written against the repo's own rule — a claim ships with the measurement that earned it.

## Problem

**`camoufox_search` with the shipped default config returns nothing but a fault.** Not degraded:
the query never reaches the engine that would have answered it. Measured on the live gateway at
`2197c7c`, config from `config.example.json` (`engines: [google, duckduckgo]`, `timeoutMs: 30000`):

| # | Probe | Result |
| --- | --- | --- |
| 1 | `read` of a hand-built `https://www.google.com/search?q=expressen` | **works** — a real google SERP, Swedish locale (`Sök på Google`, `Nyheter`), 7 organic results, returns in seconds |
| 2 | `search engine:google "expressen"` | `timeout` — 30 000 ms. Gateway state after: `ok=true, browserConnected=true, browserRunning=true, activeTabs=0` |
| 3 | `search engine:google "expressen nyheter"` | `timeout` — 30 000 ms |
| 4 | `search "expressen nyheter"` (default chain) | `timeout` — 30 000 ms |
| 5 | `search engine:duckduckgo "expressen nyheter"` | "5 result(s) (via duckduckgo)" — every one of them duckduckgo's own promo chrome |

Three separate defects sit under that, and only one of them is about google.

### F1 — the macro is now the thing that fails, not the thing that shielded us

`src/engines/google.ts` opens a tab at `https://example.com/` and navigates it to a gateway macro, on
the strength of a comment:

> `src/engines/google.ts` → `The macro is what survives Google's consent interstitial`

Probe 1 falsifies it on today's gateway: a hand-built google url — the exact thing that comment says
gets "dumped on consent.google.com" — answers a real SERP, fast, with no `consent.google.com` hop and
no `not a robot`. The macro's whole reason to exist is a premise that no longer holds.

What it costs instead is documented in `docs/improvements/2026-10-18-code.md` → `B.9 The gateway reports which engine answered`: one
`POST /tabs/{tabId}/navigate` is where the gateway runs its own fallback list (`lib/search-fallbacks.js`
— duckduckgo, then bing, for `@google_search` alone), so a single request of ours is up to **three
navigations** with a single 30 s client budget across them. That is probe 2/3.

The same item records what those extra navigations hand back: a duckduckgo page, answered under the
name google, read by a parser told it was google — measured there as 30 results where the same page
parsed as its own engine yields 22, the 9 extra being duckduckgo's footer. The mechanism is
`src/snapshot.ts` → `if (!host.endsWith("google.com")) return false;` — a duckduckgo link is, under that
rule, an unaffiliated organic result.

This is the reported symptom. The original report — 13 duckduckgo self-promo links returned for a
google query — is B.9's recorded signature, url for url.

### F2 — `timeout` is terminal, so one slow engine is a dead default

`src/engines/chain.ts` → `const TERMINAL_CODES` includes `timeout`, on the reasoning that "transport
failures are not an engine problem". That holds for `gateway_unreachable`, which is also in the list.
It does not hold here: the slow thing is one engine's navigation strategy, and probe 4 is the result —
google runs first, `timeout` ends the chain, and `duckduckgo`, which answers in probe 5, is never tried.

A code that means "this engine did not answer in time" is being reported as "the service is down".

### F3 — a SERP that is only chrome comes back as results

Probe 5 asked for duckduckgo directly, so no substitution is involved, and it still returned five
answers that are not answers: `apps.apple.com/…&ct=serp-atb-serp`, `play.google.com/…serp-atb-serp`,
`duck.ai`, `insideduckduckgo.substack.com`, `reddit.com/r/duckduckgo`. Organic results were absent;
the page's own promotional strip was parsed in their place, and — because `cache.serpMs` is 30 minutes
— that is a stored answer, not a one-off.

This is B.6's family (an engine that restructured its organic block is reported as having answered) and
B.8's mechanism (the host rule decides alone), one step further along: `isChrome` knows
`duckduckgo.com`'s own hosts (`src/snapshot.ts` → `return host.endsWith("duckduckgo.com");`) and nothing
on that page is on one.

**Also worth recording, because it is the shape of this whole bug:** both probe 1 and probe 5 are
*thin* pages. Probe 1's whole SERP is 2 742 snapshot characters, which is above
`read.settleMinChars` (1 500, `config.example.json`), so nothing re-looked at it. The settle threshold
that exists to catch "the tab opened but the page has not rendered" is set an order of magnitude below
what a SERP actually costs. Not in scope here; filed as a follow-up below.

## Goals

- G1. A default-configured `search` returns organic results from a named engine, today, against a real
  gateway — and stops depending on google being fast in order to return anything at all.
- G2. Google is fetched the way duckduckgo already is fetched: one tab, one navigation, one url we built.
- G3. An engine that runs out of time is a *step in the chain*, and the chain keeps walking.
- G4. A SERP with no organic block is never rendered as N confident results.
- G5. No claim about google's consent behaviour ships in this repo that is not backed by a recorded
  live probe. Two header comments are currently in breach of this.

## Non-goals

- **Cookie import** (`POST /sessions/{userId}/cookies`, the `SOCS`/`CONSENT` consent bypass). It is the
  correct remedy for a wall, it is in the recorded contract, we do not consume it, and no probe found a
  wall. It is named below as the veto-alternative and stops there.
- **Interaction.** `click` / `type` / `press` / `scroll` / `/act` and raw `evaluate` stay refused, per
  `docs/improvements/2026-10-18-functionality.md` → `Deliberately leave alone`. This work is adjacent to
  that decision and does not reopen it: statelessness, idempotence and `readOnlyHint: true` hold.
- **Locale and pagination params** (`hl`, `gl`, `num`, `start`), i.e. closing G.5 and the ~10-result
  ceiling. They become *possible* the moment U2 removes "the macro takes only a query" from
  `src/engines/google.ts` as the excuse, but shipping them here would put an unprobed url shape on the
  path the probe matrix exists to prove.
- **Reading `searchEngine` / `fallbackFrom`** (B.9 proper). Out because U2 removes the only macro call
  that can trigger a substitution, so the fields become unreachable for our own traffic. B.9 stays open
  as filed, for whoever calls a macro next.
- **The settle threshold for SERPs.** See F3's tail.
- Anything about `read`, the address guard, or the cache's eviction policy.

## Approach options

**A — Minimal.** Delete the macro from `src/engines/google.ts` and hand-build the url, copying
`src/engines/duckduckgo.ts` → `const SEARCH_URL = "https://duckduckgo.com/?q="` exactly: no seed tab, no
second navigation.
*Closes:* F1. *Leaves:* F2, so the next engine that gets slow kills default search again, through the
same door, with the same message. One file.

**B — Chosen.** A, plus an engine-scoped time budget so a slow engine records a step and the chain walks,
plus a structural rule that organic-absent is never reported as results.
*Closes:* F1, F2, F3. Four units, one of them a gate.

**C — Ideal.** Engines become declarative url templates plus a parser — `q`, `hl`, `gl`, `num`, `start` —
with the macro optional for every engine, `NavigateResult` reading the gateway's engine fields on every
navigate, and a per-engine deadline budget.
*Closes:* the class, not the instance, and G.5 and pagination with it. *Costs:* a config-surface change,
`src/engines/types.ts`, both engines, and 1.5's lesson absorbed: a macro is a url template — which is
precisely why making url templates first-class is the right destination, and why it is not this change.

## Recommended direction

**B**, in four units, with the first one allowed to destroy the second.

**U1 — The consent probe matrix. A gate, with a veto.**
U2 deletes a documented mitigation, and that mitigation was written against a real observation. One
successful read (probe 1) is not enough to retire it — it is one url, one query shape, one warm session,
one host. So U1 records, live, before any code changes: several query shapes (short/long, non-ASCII,
branded), `google.com` and a locale host, a bare url and one carrying `hl`/`gl`/`num`/`start` (so the
*shape U2's successor will want* is proven now, for free), cold versus warm session. Each probe
recorded with its destination url and its verdict.

The gate is binary and it is real: **clear → U2 ships. Any wall → U2 does not ship**, and the named
alternative is cookie import on `POST /sessions/{userId}/cookies` — a plan written then, not now. A
veto is not a delay: U3 and U4 stand on their own and ship either way, because F2 and F3 are not about
google.

**U2 — Google navigates like duckduckgo does.**
Build the SERP url, open a tab at it, settle, classify. Drops `MACRO`, the `navigateMacro` call,
`SEED_URL`, the seed tab and the second navigation. Side effects we are obliged to handle, not
accident-avoid: `src/gateway.ts` → `async navigateMacro` becomes unreferenced (this repo has a
dead-declaration gate, so it is deleted or kept with a stated reason), and `NavigateResult` loses its
only caller's dependence on gateway-side behaviour.

**U3 — A slow engine is a step, not a fault.**
`timeout` stops being terminal *as produced by an engine*, while the per-request guard stays — the
distinction the unit has to get right is between "this engine did not answer" and "the service is not
answering", which is exactly what `gateway_unreachable` already encodes. Total wall clock stays bounded:
a chain that walks must not cost N × 30 s, so the budget is split across engines, not multiplied by
them. `tried` records the engine that ran out of time, and `src/extension.ts` already prints the chain
on the failure path — so a google that times out and a duckduckgo that then answers becomes visible
text rather than a half-truth.

**U4 — Chrome is not a result.**
The rule is structural, and the recorded asymmetry from `docs/solutions/integration/wall-detection-must-be-structural.md`
applies with more force here than it did there: for a *read*, a missed wall merely returns weird text;
for a *SERP*, a wrong verdict is terminal **and cached** for `cache.serpMs`. So organic-absent must be
decided on structure — the shape of the block, how many of them carry a destination the engine does not
own and nothing else has claimed — and stated with its evidence, never on a host list alone, which is
the rule F3 walks straight through. Both directions get fixtures, including the one that must stay
true: a page-shaped-for-results with 20 organics still returns 20.

## Success criteria

1. `camoufox_search` with default config, live, returns organic results and names the engine that
   served them. This is the reported bug, so it is the criterion that has to be checked by measurement
   and not by a suite.
2. The U1 matrix is recorded — url, destination, verdict, per probe — and the decision it took is
   written where U2 was made, not only in a commit message.
3. No `src/engines/*.ts` header comment asserts a google consent behaviour that the matrix did not
   establish. Both current ones go.
4. A first engine that exceeds its budget appears in `tried`, and the second engine's answer is
   returned. Measured wall clock for that case is bounded, and the bound is stated.
5. The probe-5 page, recorded as a fixture, returns no results and a verdict that says why — and is
   not cached as five.
6. `NODE_ENV=test node --test tests/*.test.mjs` green, `tsc --noEmit` clean, and
   `tests/improvement-refs.test.mjs` still green *after* the improvement docs are edited — that gate is
   what breaks when a fixed item is deleted and a citation is left pointing at a gap.

## Failure modes named in advance

- **U1 is the risk, and it is where the veto lives.** If hand-built urls wall on a locale host or a cold
  session, U2 is a regression, not a fix.
- **U4's false-positive direction is expensive.** A rule that calls a real SERP "no organic results"
  denies a search and stores the denial. Extend the existing long-page-mentions-captchas discipline.
- **U3 could double the time to a bad answer** if the budget is per-engine instead of shared.
- **`timeout` staying reachable from transport** must not be lost by U3: `gateway_unreachable` is a
  different code and the two must not be merged on the way.

## Domain vocabulary

`CONTEXT.md` defines **Engine adapter** as *"Google via the `@google_search` macro; DuckDuckGo via
direct navigation"*. U2 makes that sentence wrong, and this repo's glossary is where a sentence like
that is supposed to die. Proposed, two additions and one edit:

- **Substitution** — a gateway-side engine swap inside a single `POST /tabs/{tabId}/navigate`, reported
  as `searchEngine` and `fallbackFrom`. Not our fallback: it happens inside one call of ours, with
  nothing of ours in the room, and it is decided by which macro was used.
- **Seed tab** — a throwaway tab opened at a neutral url because a macro needs an existing tab to
  navigate. Retired with U2.
- **Engine adapter** (edit) — *"each engine builds its own search url and navigates a tab to it once."*

**Macro** stays undefined on purpose: after U2 this client calls none, and a glossary entry for a thing
we no longer do reads like an invitation.
