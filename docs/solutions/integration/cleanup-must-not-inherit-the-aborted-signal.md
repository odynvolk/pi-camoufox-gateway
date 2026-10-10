---
title: Cleanup paths must not inherit the caller's aborted signal, and creates must not be retried after an answered request
category: integration
severity: high
tags: [abort, abortsignal, resource-leak, teardown, retry, tabs, http-client, idempotency]
applies_when:
  - closing/releasing a remote resource in a `finally` block
  - retrying non-idempotent POSTs on timeout
  - a leak that a leak-detection assertion cannot see
---

# Problem

Two ways to leak resources that both looked correct and both passed their tests.

1. **The teardown close reused the signal that had just aborted.** Tool calls closed their remote tab
   with `client.closeTab({ ..., signal: params.signal })` and `.catch(() => undefined)`. When the call
   was cancelled, `perform` threw `aborted` *before sending the DELETE*, the catch swallowed it, and the
   tracker's `liveTabs.delete` line never ran. The resource was open on the server and invisible to us.
   The existing test passed only because it aborted *before* the resource was created.
2. **`POST /tabs/open` was retried on timeout.** A timeout on a create is the worst retryable outcome:
   the server usually created the resource before the response was lost, so the retry creates a second
   one whose id we never receive. It also poisoned the leak invariant that everyone asserts on:
   `openTabCount()` stayed `0` while the server held two tabs.

# Context

`src/gateway.ts` + four teardown sites (`src/tools/{read,search}.ts`, `src/engines/{google,duckduckgo}.ts`,
`src/resolve.ts`). Found only by running a real read against a live gateway and probing an aborted
call — a fake that records "tabs it opened" cannot see a tab it never got an id for.

# Solution

- **Quiet teardown.** Give the client one method for cleanup that never takes the caller's signal:

  ```ts
  async closeTabQuietly({ userId, tabId }) {
    try { await this.closeTab({ userId, tabId }); } catch { /* session teardown still reclaims it */ }
  }
  ```

  Every `finally` path uses it. A deadline that must own the abort should abort *its own* controller
  (and relay the caller's), so the underlying request is cancelled and can reconcile, instead of
  abandoning a request that is still running.
- **Retry policy per operation, not per error.** `retry: "connect-only"` for creates: retry
  `gateway_unreachable` (nothing was sent), never `timeout`.
- **Reconcile after ambiguity.** On an ambiguous create failure, list what the server holds and close
  what we never learned about — guarded so a concurrent sibling's legitimately-open resource is not
  swept away.
- Tests: abort **mid-call** (the fake needs latency/hang knobs), and assert the **server side**
  (`fake.liveTabs()`), not the client's own bookkeeping.

# Why this works

An aborted `AbortSignal` is not a hint; it short-circuits the request before it leaves the process.
Reusing it for cleanup means "cancel the work" also means "cancel the apology". Similarly, retry is
safe only for operations whose *effect* cannot be duplicated by the retry — which is a property of the
endpoint, not of the error we happened to see.

# Prevention

- Treat `finally { close(x, signal) }` as a smell. Cleanup either has no signal or a dedicated one.
- Say explicitly which operations are idempotent, in the request helper's options.
- Make the leak assertion check the authoritative side (the server/fake's live set) per test, and give
  the fake latency controls so cancellation-during-work is reachable. This repo does:
  `tests/helpers/fake_gateway.mjs` (`openLatencyMs`, `hangUrls`, `liveTabs()`) and
  `tests/helpers/tab_leaks.mjs`.
- For future runs: a leak assertion that passes when the code is broken is worse than none, because it
  is trusted. `04-review` should ask "which failure would this assertion not catch?".
