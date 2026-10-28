import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { classifySerp, detectWall, engineOwnsUrl, extractText, parseSerp } from "../src/snapshot.ts";

/** Every recorded page, so a budget check picks up a fixture the moment one is added. */
const FIXTURES = readdirSync(new URL("./fixtures/", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
  .map((entry) => entry.name)
  .sort();

function readFixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function fixture(name, url = "https://example.test/") {
  const text = readFixture(name);
  return {
    url,
    text,
    refsCount: (text.match(/\[e\d+\]/gu) ?? []).length,
    truncated: false,
    totalChars: text.length,
    hasMore: false,
    nextOffset: text.length,
  };
}

/**
 * A consent interstitial wide enough to be past the interstitial threshold, so only the host can settle
 * it. One literal for both axes that assert that: `detectWall` on its own, and `classifySerp` against
 * the size rules. Two copies drift, and the second is the one that silently stops proving.
 */
const longConsent = `- heading "Before you continue to Google" [level=1]\n${"- paragraph:\n  - text: cookie notice\n".repeat(300)}`;
const CONSENT_HOST = "https://consent.google.com/ml?continue=x";

test("parses Google results from a real recorded SERP", () => {
  const { results } = parseSerp(fixture("serp-google.txt", "https://www.google.com/search?q=camoufox"), "google");

  assert.ok(results.length >= 3, `expected several results, got ${results.length}`);
  const first = results[0];
  assert.ok(first.title.length > 5, "title should come from the link text");
  assert.match(first.url, /^https:\/\/www\.google\.com\/goto\?url=/u, "google urls stay as wrappers");
  assert.equal(first.resolvable, true, "wrappers are resolvable by navigation");
  assert.ok(first.snippet.length > 10);
  assert.equal(first.host, "camoufox.com");
  for (const result of results) {
    assert.ok(result.url.startsWith("http"), `every result needs a url, got ${result.url}`);
  }
});

test("skips Google navigation chrome, which has no url child", () => {
  const { results } = parseSerp(fixture("serp-google.txt", "https://www.google.com/search?q=camoufox"), "google");
  const titles = results.map((r) => r.title);
  assert.equal(titles.some((t) => /AI-läge|Allt|Bilder|Nyheter/u.test(t)), false, "nav tabs must not be results");
});

test("does not invent results when the page has none", () => {
  const { results } = parseSerp(fixture("serp-no-results.txt", "https://www.google.com/search?q=x"), "google");
  assert.deepEqual(results, []);
});

test("parses DuckDuckGo results with direct urls", () => {
  const { results } = parseSerp(
    fixture("serp-duckduckgo.txt", "https://duckduckgo.com/?q=camoufox+anti-detect&ia=web"),
    "duckduckgo",
  );

  assert.ok(results.length >= 3, `expected several results, got ${results.length}`);
  assert.equal(results.some((r) => r.resolvable), false, "ddg urls need no resolution");
  assert.ok(
    results.some((r) => r.url.includes("github.com")),
    "an organic github result should survive parsing",
  );
  for (const result of results) {
    assert.ok(!/duckduckgo\.com\/(y\.js|meta)\/?/u.test(result.url), `ad/chrome url leaked: ${result.url}`);
    assert.ok(!/^Search domain /u.test(result.title), `chrome title leaked: ${result.title}`);
  }
});

test("deduplicates repeated urls across a page", () => {
  const snapshot = fixture("serp-duckduckgo.txt", "https://duckduckgo.com/?q=camoufox");
  const { results } = parseSerp(snapshot, "duckduckgo");
  const urls = results.map((r) => r.url);
  assert.equal(new Set(urls).size, urls.length, `duplicate urls: ${urls.filter((u, i) => urls.indexOf(u) !== i)}`);
});

test("chrome is decided by host alone, so a chrome-shaped title off-engine survives", () => {
  // The retired title list is pinned from the wrong side on purpose. Two links, same title, one host
  // the engine owns and one it does not: the first is a result, the second is chrome. Titles no longer
  // get a vote, which is the point — they are where a Swedish `webb` used to reach the code.
  const page = [
    '- link "Videos" [e1]:',
    "  - /url: https://cdn.videos.test/clip",
    "  - text: a clip",
    '- link "Videos" [e2]:',
    "  - /url: https://www.google.com/vid",
    "  - text: the tab",
  ].join("\n");

  const { results } = parseSerp({ url: "https://www.google.com/search?q=x", text: page }, "google");

  assert.deepEqual(
    results.map((result) => result.url),
    ["https://cdn.videos.test/clip"],
    "the off-engine link is a result and the engine's own tab is not",
  );
});

test("detects the google consent wall instead of reporting zero results", () => {
  const snapshot = fixture(
    "wall-consent.txt",
    "https://consent.google.com/ml?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dx&gl=SE&hl=en",
  );

  assert.equal(detectWall(snapshot), "consent_wall");
});

test("detects a browser error page as a wall", () => {
  const snapshot = fixture("page-network-error.txt", "https://www.bing.com/search?q=x");
  assert.equal(detectWall(snapshot), "navigation_failed");
});

/**
 * B.5 — the width was never the evidence.
 *
 * Detection used to ride on the page being under `INTERSTITIAL_MAX_CHARS`, which made it a promise about
 * the *size* of a browser's own error page: render the same refusal a little wider — a
 * help article expanded, a translated UI, a distro build with more boilerplate — and the check stops
 * being taken and the refusal comes back as page text. The read path has no fallback for that; the
 * search path answers `parse_error` because nothing on the page is link-shaped, which is why the two
 * thresholds are pinned together elsewhere in this file.
 *
 * The recorded page carries the structural signature instead: one heading at level 1, a retry
 * affordance, and not one `/url` line — nothing on it is a document. That evidence does not care how
 * wide the page is, which is what makes it worth taking at any width: the rule this repo already states
 * is that *keyword* evidence must be size-gated, precisely because a long page can mention anything.
 *
 * Built by widening the real fixture with filler paragraphs, so the only thing changed about it is the
 * thing the threshold is made of. No captured wide error page exists in `tests/fixtures/`, and this is
 * constructed evidence, labelled as such — the structural rule is what generalises, not this page.
 */
test("a browser error page past the interstitial threshold is still a network error", () => {
  const recorded = readFixture("page-network-error.txt");
  const wide = `${recorded}\n${"- paragraph:\n  - text: Filler sentence that adds width without adding a document.\n".repeat(90)}`;

  assert.ok(wide.length > 3_000, `widened error page is ${wide.length} chars — not past the threshold, so this asserts nothing`);
  assert.equal(detectWall({ url: "https://www.bing.com/search?q=x", text: wide }), "navigation_failed");
});

/**
 * The false positive, written first — because that is the failure this file's own solution doc says
 * killed the last attempt, and the asymmetry has not changed: a wrong `navigation_failed` denies a read
 * that worked, a missed one returns odd text.
 *
 * This is the page the structural rule must not touch: one heading, a retry button, and *content* — the
 * difference from a browser refusal being that a document is actually reachable from it. A reader who
 * landed here was looking for a "try again" button on purpose.
 */
test("a long page about retrying, with links, is content and not a network error", () => {
  const troubleshooting = [
    '- heading "Try again after a network error" [level=1]',
    "- paragraph:",
    "  - text: What to do when a fetch fails and you want to retry safely.",
    '  - link "Backoff and retries" [e1]:',
    "    - /url: https://example.test/docs/backoff",
    '  - link "Error taxonomy" [e2]:',
    "    - /url: https://example.test/docs/errors",
    '- button "Try Again" [e3]',
    "- paragraph:",
    "  - text: Retrying without a budget is how a transient becomes an outage.",
  ].join("\n");

  assert.equal(detectWall({ url: "https://example.test/docs/retries", text: troubleshooting }), null);
});

test("exactly one fixture in the recorded set has the browser-error structure", () => {
  // The budget, measured rather than asserted per-page. Every other recorded page carries a `/url` — a
  // document reachable from it — which is the one thing a browser's own refusal never has.
  const matching = FIXTURES.filter((name) => detectWall({ url: "https://example.test/", text: readFixture(name) }) === "navigation_failed");

  assert.deepEqual(matching, ["page-network-error.txt"]);
});

test("distinguishes an empty page from a wall", () => {
  assert.equal(detectWall(fixture("page-empty.txt")), "empty_page");
  assert.equal(detectWall(fixture("page-short.txt")), null);
});

test("extractText returns whole text when it fits the budget", () => {
  const snapshot = fixture("page-short.txt");
  const out = extractText(snapshot, { maxChars: 12_000 });

  assert.equal(out.truncated, false);
  assert.equal(out.text.includes("First paragraph"), true);
  assert.equal(out.nextOffset, null);
});

test("extractText bounds a big page and reports the gateway offset to continue from", () => {
  // Metadata recorded live from the gateway: it returned 79,830 of 97,164 chars and told us the
  // continuation starts at 74,800. Our own slicing would have said 12,000, which skips content.
  const snapshot = {
    ...fixture("page-github.txt", "https://github.com/daijro/camoufox"),
    truncated: true,
    totalChars: 97_164,
    hasMore: true,
    nextOffset: 74_800,
  };
  assert.ok(snapshot.text.length > 50_000, "fixture should be genuinely large");

  const out = extractText(snapshot, { maxChars: 12_000 });

  assert.equal(out.text.length <= 12_000, true, `got ${out.text.length} chars`);
  assert.equal(out.truncated, true);
  assert.equal(out.hasMore, true);
  assert.equal(out.totalChars, 97_164, "totalChars must come from the gateway, not our slice");
  assert.equal(out.nextOffset, 12_000, "we resume where we stopped showing text, not at the gateway chunk end");
});

test("extractText uses the gateway nextOffset when the gateway itself truncated", () => {
  const snapshot = {
    url: "https://example.test/",
    text: "x".repeat(2000),
    refsCount: 0,
    truncated: true,
    totalChars: 50_000,
    hasMore: true,
    nextOffset: 2000,
  };
  const out = extractText(snapshot, { maxChars: 12_000 });

  assert.equal(out.text.length, 2000);
  assert.equal(out.hasMore, true);
  assert.equal(out.nextOffset, 2000);
});

test("an explicit offset is counted into nextOffset when we do the cutting", () => {
  // Continuation is "where do I resume", so our own consumed point wins over the gateway's chunk
  // end. That only shows up when the caller passed an offset, which is what a second read does.
  const snapshot = {
    url: "https://example.test/",
    text: "x".repeat(30_000),
    refsCount: 0,
    truncated: true,
    totalChars: 50_000,
    hasMore: true,
    // The chunk end a gateway would actually report: asked at 18_000, it handed back 30_000 chars.
    nextOffset: 48_000,
  };
  const out = extractText(snapshot, { maxChars: 12_000, offset: 18_000 });

  assert.equal(out.truncated, true);
  assert.equal(out.nextOffset, 30_000, "resume at offset + what we showed, not the gateway's chunk");
});

test("a long page that merely mentions captchas is content, not a wall", () => {
  // Regression: GitHub's README contains "complete a captcha". Phrase-only detection refused to
  // read any page that discussed bot countermeasures, which made the read tool useless on docs.
  const long = `- heading "Long article" [level=1]\n${"- paragraph:\n  - text: filler sentence that goes on.\n".repeat(120)}- paragraph:\n  - text: They will require users to complete a captcha.\n`;
  assert.equal(long.length > 3_000, true, "fixture must be past the interstitial threshold");

  assert.equal(detectWall({ url: "https://github.com/daijro/camoufox", text: long }), null);
});

test("a tiny page made only of a captcha challenge is a wall", () => {
  const tiny = '- heading "Confirm you are not a robot" [level=1]\n- paragraph:\n  - text: Please complete the captcha to continue.\n';
  assert.equal(detectWall({ url: "https://example.test/challenge", text: tiny }), "consent_wall");
});

test("the consent host wins even when the interstitial is long", () => {
  // The width is the whole point, so it is pinned here: the `classifySerp` case reuses this page, and an
  // assertion in only one of the two leaves the other asserting a shape it never checked.
  assert.ok(longConsent.length > 3_000, `consent page is ${longConsent.length} chars, which is not past the threshold`);

  assert.equal(detectWall({ url: CONSENT_HOST, text: longConsent }), "consent_wall");
});

test("one call decides what a SERP was, and every branch is asserted together", () => {
  // The order used to live in two engine files: reorder `detectWall` / `parseSerp` /
  // `looksUnparseable` there and a wall-shaped page started reading as "no results", or a thin one
  // started blaming our parser. `classifySerp` owns the order now, so this is the seam.
  const line = "- paragraph:\n  - text: page text without links.\n"; // 48 chars
  const wideLinkless = `- heading "Google Results" [level=1]\n${line.repeat(50)}`; // 2,438 chars
  const thinLinkless = `- heading "Google Results" [level=1]\n${line.repeat(35)}`; // 1,718 chars
  // Chrome only, and past *both* thresholds: a clean engine page with nothing organic on it is this
  // shape and roughly this long. The structure axis has to win, or a normal no-results page gets
  // blamed on our parser. This is the case that keeps `PARSEABLE_MIN_CHARS` from being read as the
  // whole rule.
  const chromeOnly = `- heading "Google" [level=1]\n${'- link "Images" [e1]:\n  - /url: https://www.google.com/imghp\n'.repeat(60)}`;

  assert.ok(wideLinkless.length > 2_000 && wideLinkless.length <= 3_000, `wide link-less page is ${wideLinkless.length} chars`);
  assert.ok(thinLinkless.length <= 2_000, `thin link-less page is ${thinLinkless.length} chars`);
  assert.ok(chromeOnly.length > 3_000, `chrome-only page is ${chromeOnly.length} chars, past the interstitial threshold`);

  const code = (text, url = "https://www.google.com/search?q=camoufox") =>
    classifySerp({ url, text }, "google");

  const served = classifySerp(fixture("serp-google.txt", "https://www.google.com/search?q=camoufox"), "google");
  assert.equal(served.kind, "results");
  assert.ok(served.results.length >= 3);

  // The recorded consent page is 4 193 chars — past the interstitial threshold — and still a wall,
  // because the host says so. Nothing about the size thresholds may outrank that.
  assert.equal(
    classifySerp(fixture("wall-consent.txt", "https://consent.google.com/ml?continue=x"), "google").code,
    "consent_wall",
    "host evidence outranks every threshold",
  );
  assert.equal(code(longConsent, CONSENT_HOST).code, "consent_wall");
  assert.equal(code(wideLinkless).code, "parse_error", "wide enough to have been a page, so blame the parser");
  assert.equal(code(thinLinkless).code, "empty_results", "a page this thin says something about the query");
  assert.equal(code(chromeOnly).code, "empty_results", "links we recognised as chrome mean the page parsed fine");

  // And past the interstitial threshold as well, deliberately. Note what this case does *not* decide:
  // it has no link blocks either, so it cannot say which of the two axes wins. `chromeOnly` above is the
  // assertion that settles that, and it is the one that would break if the thresholds were collapsed.
  const oversizedLinkless = `- heading "Google Results" [level=1]\n${line.repeat(200)}`; // 9,618 chars
  assert.ok(oversizedLinkless.length > 3_000, `oversized link-less page is ${oversizedLinkless.length} chars`);
  assert.equal(code(oversizedLinkless).code, "parse_error", "main did this too, and for the same reason");

  // Both sides of the threshold itself, so its value cannot drift unnoticed: 2 000 chars is thin, 2 001
  // is a page we should have been able to read. The widths are literals on purpose. Deriving them from
  // `PARSEABLE_MIN_CHARS` would move the fixtures with the constant and keep the test passing, which is
  // the one outcome these cases exist to prevent; each fixture's branch is asserted again below, so a
  // page that grows for an unrelated reason fails there rather than silently changing branches.
  const linklessAt2000 = "x".repeat(2_000);
  const linklessPast2000 = `${"x".repeat(1_992)}${"y".repeat(9)}`; // 2,001, still no link line
  assert.equal(linklessAt2000.length, 2_000);
  assert.equal(linklessPast2000.length, 2_001);
  assert.equal(code(linklessAt2000).code, "empty_results", "at the threshold, still thin");
  assert.equal(code(linklessPast2000).code, "parse_error", "one past it, and the parser is on trial");

  // The threshold pairing, stated as behaviour rather than as a comment about two numbers: a wall page
  // with a link block on it, inside the band, is still a wall. Drop `INTERSTITIAL_MAX_CHARS` below
  // `PARSEABLE_MIN_CHARS` and this is the assertion that fails.
  const wallInBand = `- heading "Confirm you are not a robot" [level=1]\n- link "Sign in" [e1]:\n  - /url: https://accounts.google.com/ServiceLogin\n- paragraph:\n  - text: ${"complete the captcha to continue. ".repeat(60)}`;
  assert.ok(wallInBand.length > 2_000 && wallInBand.length <= 3_000, `wall inside the band is ${wallInBand.length} chars`);
  assert.equal(code(wallInBand).code, "consent_wall", "the wall check owns the band, not the parser");
});

test("a wide browser error page is a tree we could not read, not an empty query", () => {
  // The pairing between the two thresholds, as the case that can fail it. The page is deliberately
  // just past 3 000: these words are `detectWall`'s, so thin they answer `navigation_failed`, and this
  // is the width where phrase evidence stops being taken. Lift `PARSEABLE_MIN_CHARS` above
  // `INTERSTITIAL_MAX_CHARS` and a page this wide falls through both checks and starts reporting
  // `empty_results` — a query blamed for a tree we could not read.
  const errorLine = "- paragraph:\n  - text: A network protocol error occurred and the page cannot be repaired.\n";
  const thinBrowserError = `- heading "Problem loading page" [level=1]\n${errorLine}`;
  const wideBrowserError = `- heading "Problem loading page" [level=1]\n${errorLine.repeat(33)}`;

  assert.ok(wideBrowserError.length > 3_000 && wideBrowserError.length < 3_100, `wide browser error is ${wideBrowserError.length} chars`);

  const code = (text) => classifySerp({ url: "https://www.google.com/search?q=camoufox", text }, "google").code;
  assert.equal(code(thinBrowserError), "navigation_failed", "thin, the same words are the browser's own refusal");
  assert.equal(code(wideBrowserError), "parse_error", "too wide for phrase evidence and nothing link-shaped, so the parser is on trial");
});

/**
 * B.8 — half closed, and the half that is not is the first assertion below.
 *
 * `tests/fixtures/serp-reddit-blocked.txt` is a refusal recorded from the live gateway: its text says we
 * were blocked, and its only link is Reddit's support-desk ticket form. What used to be reported was a
 * successful search with one organic result — the ticket form — because `isChrome` decides chrome by the
 * host of the engine we *asked* for, and a support desk is never that host. `engineOwnsUrl` now refuses
 * the page before any of that is asked, so the model is told no engine served it and the chain hops.
 *
 * What stays open, filed in
 * `docs/improvements/2026-10-18-code.md` → `### B.8 A page that says we were blocked`: this page is
 * **still not detected as a wall**. `detectWall` misses it on its first structural condition — no
 * `heading` line at all — and neither phrase list carries "blocked by network security". So the refusal
 * is reported as "the engine served nothing", which is honest, and not as "we were refused", which is
 * what the item is still asking for. That line below is the surviving defect, asserted so a fix has to
 * contradict it on purpose rather than discover it.
 */
test("B.8's open half: a recorded refusal is no longer anyone's results, and is still not called a wall", () => {
  const recording = fixture(
    "serp-reddit-blocked.txt",
    "https://www.reddit.com/search.json?q=camoufox%20anti-detect%20browser&limit=25",
  );

  // The still-open half. A foreign-host refusal with no heading and no retry affordance is not a wall as
  // far as this repo can tell, whatever its own text says about network security.
  assert.equal(detectWall(recording), null, "B.8 is still open: nothing here claims a wall, and the item is about that");

  // The half the ownership rule covers. There is no longer a result to name, which is why this case no
  // longer asserts the ticket form's url and title — behaviour moved under it, not an assertion relaxed.
  const verdict = classifySerp(recording, "google");
  assert.equal(verdict.kind, "error", "a page google does not host is not google's results, ticket form or no ticket form");
  assert.equal(verdict.code, "empty_results", "the code the chain hops on, so the next engine gets the query");
  assert.equal(verdict.details.substituted, true, "and a reader can tell this from a query that came up empty");
});

/**
 * The ownership rule, on the page that motivated it.
 *
 * `tests/fixtures/serp-google-answered-by-duckduckgo.txt` was recorded off the gateway's `@google_search`
 * macro — a path this client no longer calls, since `src/engines/google.ts` opens the results page
 * directly (see `docs/plans/2026-10-27-google-direct-open-serp.md`). Upstream's own probe put a
 * DuckDuckGo page there, inside the one call. The recording is kept because a page arriving from an
 * engine nobody asked for is exactly what the guard below exists for, and it is the only recording of one
 * this repo has.
 *
 * Both directions are asserted, because one of them is satisfiable by a rule that refuses every page: the
 * engine we asked for must not be able to claim it, and the engine that actually served it must still read
 * it whole — 22 results, the count it produced before the rule existed.
 */
test("a page the asked engine does not own is never credited as its results", () => {
  const recording = fixture("serp-google-answered-by-duckduckgo.txt", "https://duckduckgo.com/?q=expressen&ia=web");

  const asked = classifySerp(recording, "google");
  assert.equal(asked.kind, "error", "google may not credit a page it did not serve");
  assert.equal(
    asked.code,
    "empty_results",
    "deliberately not terminal: the chain runs the engine that did serve it and credits itself from Engine.name",
  );
  assert.equal(asked.details.substituted, true, "a substituted page has to be tellable apart from an empty query");
  assert.match(asked.message, /^google /u, "names the engine we asked for");
  assert.match(asked.message, /duckduckgo\.com/u, "and the destination the page is actually at");

  const answered = classifySerp(recording, "duckduckgo");
  assert.equal(answered.kind, "results", "the engine that served the page still reads it");
  assert.equal(answered.results.length, 22, "the whole page — the count it gave before the rule existed");

  // And the happy path is not collateral: a page the engine does host is untouched by any of this.
  const owned = classifySerp(fixture("serp-google.txt", "https://www.google.com/search?q=camoufox"), "google");
  assert.equal(owned.kind, "results", "google still reads google's own page");
});

test("engineOwnsUrl answers where a page is, and invents nothing when it cannot", () => {
  // The rule the classifier asks before it parses. Both apex forms are pinned because a subdomain-only
  // pattern silently disowns the url we actually open: `https://duckduckgo.com/?q=…` is DuckDuckGo.
  assert.equal(engineOwnsUrl("google", "https://www.google.com/search?q=camoufox"), true);
  assert.equal(engineOwnsUrl("google", "https://www.google.com/goto?url=CAES"), true);
  assert.equal(engineOwnsUrl("google", "https://consent.google.com/ml?continue=x"), true);
  assert.equal(engineOwnsUrl("google", "https://www.google.co.uk/search?q=camoufox"), true, "a google TLD is still google");
  assert.equal(engineOwnsUrl("google", "https://www.google.com.br/search?q=camoufox"), true, "and a two-label one is too");
  assert.equal(engineOwnsUrl("google", "https://google.xn--p1ai/search"), true, "google.рф is google, punycode and all");
  assert.equal(engineOwnsUrl("google", "https://evil.google.com/"), true, "a genuine subdomain is still google's own page");
  assert.equal(engineOwnsUrl("duckduckgo", "https://duckduckgo.com/?q=camoufox"), true, "the apex host is the one we open at");
  assert.equal(engineOwnsUrl("duckduckgo", "https://html.duckduckgo.com/html/?q=camoufox"), true);

  // The refusals, one per direction, plus the near-miss host that a `includes` would have accepted.
  assert.equal(engineOwnsUrl("google", "https://duckduckgo.com/?q=camoufox"), false);
  assert.equal(engineOwnsUrl("duckduckgo", "https://www.google.com/search?q=camoufox"), false);
  assert.equal(engineOwnsUrl("google", "https://notgoogle.com/search"), false);
  assert.equal(engineOwnsUrl("duckduckgo", "https://duckduckgo.com.evil.test/?q=camoufox"), false);

  // The same near-miss on the google side, which is the direction the duckduckgo row above does not
  // cover: a suffix pattern that admits dots accepts a host whose registrable domain is `evil.test`, and
  // the credit and the chrome filter below it both follow the answer. Pinned in both spellings because
  // the subdomain form is the one a look-alike registration actually uses.
  assert.equal(engineOwnsUrl("google", "https://www.google.com.evil.test/search"), false, "three labels after google is not google's domain");
  assert.equal(engineOwnsUrl("google", "https://google.com.evil.test/search"), false, "and the apex spelling is the same host");
  assert.equal(engineOwnsUrl("google", "https://www.google/search"), false, "a host with no TLD is somebody's LAN name, not google's domain");

  // The registrable-domain case, which is the one that actually costs something. `google.evil.com` has
  // two labels after `google` — inside the count that keeps `google.co.uk` — and the first of them is a
  // word, not a suffix any registry hands out. Requiring alphabetic tails let it through, and the host
  // is the gateway's *reported* destination, which a redirect can arrange: whoever owns `evil.com` would
  // get `(via google)`, `Engine.name` credit, and google's chrome list applied to their own page. That is
  // the exact failure this rule was added to close, so the shape is pinned rather than the count.
  assert.equal(engineOwnsUrl("google", "https://google.evil.com/search"), false, "the registrable domain here is evil.com, not google's");
  assert.equal(engineOwnsUrl("google", "https://www.google.evil.com/search"), false, "and a subdomain of that host is no better");
  assert.equal(engineOwnsUrl("google", "https://google.evil.de/search"), false, "a two-letter tail does not make the middle label a suffix");
  assert.equal(engineOwnsUrl("google", "https://google.net.au/search"), false, "google registers under co/com, so net.au is not its shape");
  assert.equal(engineOwnsUrl("duckduckgo", "https://duckduckgo.evil.com/?q=camoufox"), false, "one label of slack is still enough for this attack");

  // The suffixes that are real, so the tightening above cannot be a blanket refusal. `google.dev` and
  // `google.app` are Google's own gTLDs; `co`/`com` + ccTLD is how it registers where it does not own the TLD.
  assert.equal(engineOwnsUrl("google", "https://google.co.in/search"), true);
  assert.equal(engineOwnsUrl("google", "https://google.com.au/search"), true);
  assert.equal(engineOwnsUrl("google", "https://google.dev/search"), true, "google runs its own TLDs");
  assert.equal(engineOwnsUrl("google", "https://google.app/search"), true);

  // The residual, pinned rather than hidden: whoever registers the second-level label `google` under some
  // TLD *is* the owner of that apex, and no suffix rule can tell them from Google. Closing this needs an
  // allowlist of the suffixes we serve, and that costs a search every time Google geo-redirects to a ccTLD
  // the list does not name — a silent quality loss for a class of spoof Google defensively registers
  // against and a registrar trademark-blocks. Refusing to pretend the rule is stronger than it is.
  assert.equal(engineOwnsUrl("google", "https://google.xyz/search"), true, "known limit: an apex squat on a real TLD is indistinguishable");

  // Two silences, both answered by not inventing a rule: an engine we do not ship, and a url we cannot
  // place. Refusing either would be an engine blaming a page it has no opinion about.
  assert.equal(engineOwnsUrl("bing", "https://www.bing.com/search?q=camoufox"), true);
  assert.equal(engineOwnsUrl("google", ""), true, "a gateway that will not say is not evidence the page is foreign");
  assert.equal(engineOwnsUrl("google", "not a url"), true);
  // A host with no scheme in front of it is not a place: `new URL` refuses the string, so the rule never
  // sees a host to judge. `duckduckgo.com` *as a host* is DuckDuckGo's own — asserted above — and this row
  // is here to keep the two apart, because a caller that handed us the one without its scheme gets the
  // silence answer, which is `true` and not a verdict about the host.
  assert.equal(engineOwnsUrl("duckduckgo", "duckduckgo.com/"), true, "unparseable, so unjudged — the fail-open the docstring promises");
  assert.equal(engineOwnsUrl("google", "about:blank"), true, "a tab between two addresses has taken neither, which is a silence and not a foreign host");
});
