---
title: Classify an interstitial wall by structure, never by keywords in page text
category: integration
severity: high
tags: [wall-detection, scraping, camoufox, consent, false-positive, page-text, snapshot, gateway]
applies_when:
  - deciding whether a fetched page is blocked, consent-walled, or a network error
  - writing heuristics that run over untrusted page text
  - a page that loads fine is reported as blocked
---

# Problem

`detectWall` asked *"does this text contain a scary word?"*. GitHub's README contains the phrase
`complete a captcha`, so **every page that discussed bot countermeasures was reported as
`consent_wall` and refused to load**. Live evidence: `github.com/daijro/camoufox` rendered perfectly
(79,914 chars, 191 refs) and still came back as a wall.

# Context

In `src/snapshot.ts`, wall detection sat before the empty-page check and matched patterns anywhere in
the snapshot. The bug is invisible in fixture tests, because a fixture that only *mentions* a wall
word is indistinguishable from a wall. It surfaced on the first live read, not in the suite.

# Solution

Make the evidence structural, and keep prose out of the decision:

```ts
if (/consent\.google\.com/u.test(url)) return "consent_wall";   // host evidence: size irrelevant
if (text.trim().length === 0) return "empty_page";
if (text.length <= INTERSTITIAL_MAX_CHARS) {                    // 3000 chars
  if (/<consent phrases>/iu.test(text)) return "consent_wall";
  if (/<network error phrases>/iu.test(text)) return "navigation_failed";
}
return null;
```

The rule: **an interstitial is small**. A page above the threshold is content, whatever it happens to
mention. A wall whose host we already recognise is exempt from the size test, because real consent
interstitials run long (the recorded Google consent fixture is 4,193 chars).

# Why this works

A wall is a *substitution*, not a *topic*. The engine replaced the intended document, so the thing we
got has almost no content and a recognizable host or heading. Searching for vocabulary inside a
document that rendered fine can only produce false positives, and the failure is asymmetric: a false
wall denies the user a successful read, while a missed wall merely returns weird text.

That asymmetry is a fact about a *read*, and it does not carry to a SERP. There a missed wall is a
terminal verdict and a stored one: a refusal served as one organic result, then kept for the whole
`cache.serpMs`. The item records it as
`docs/improvements/2026-10-18-code.md` → `This one answers confidently and ends the search`. Weigh a
classifier change against that, not against this sentence.

# Prevention

- Any keyword classifier over fetched text must be gated on size or position, and must state its
  evidence in the error (`url`, `refsCount`).
- Regression test with the phrase buried in a *long* body, not just in a tiny wall fixture. This repo
  has one: `a long page that merely mentions captchas is content, not a wall` (
  `tests/snapshot.test.mjs`). If you widen the patterns, extend that test.
- For future runs: `02-plan` should treat any "detect blocked/empty" requirement as a structural rule
  with an explicit threshold, and `04-review` should ask what the *false positive* case is — the
  common failure here was detection tuned only against the true-positive fixture.
