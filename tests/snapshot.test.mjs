import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { classifySerp, detectWall, extractText, parseSerp } from "../src/snapshot.ts";

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
 * B.8 — this one pins a wrong answer, on purpose, and is expected to pass today.
 *
 * `tests/fixtures/serp-reddit-blocked.txt` is a refusal recorded from the live gateway: its text says we
 * were blocked, and its only link is Reddit's support-desk ticket form. That link is off-engine, and
 * `isChrome` decides chrome by host alone, so the block page classifies as a successful search with one
 * organic result — the ticket form. Filed in
 * `docs/improvements/2026-10-18-code.md` → `### B.8 A page that says we were blocked`, which also records
 * why it is worse than B.6: `results` is terminal for the chain, and a result on the first look leaves
 * `polled` false, so the search cache keeps the refusal for `serpMs`.
 *
 * Asserted as behaviour, not as intent. Nothing here says this is right — an unasserted fixture is dead
 * weight, and the point of pinning the current answer is that a fix has to change it deliberately rather
 * than discover it. If a red line here is the first you have heard of it, read the item before touching
 * this case: the verdict is the thing under test, and every assertion below is a claim a fix must
 * contradict on purpose.
 */
test("B.8 as filed: a recorded refusal is classified as one organic result, the ticket form", () => {
  const recording = fixture(
    "serp-reddit-blocked.txt",
    "https://www.reddit.com/search.json?q=camoufox%20anti-detect%20browser&limit=25",
  );
  const ticket = "https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=21879292693140";

  // The other half of the mechanism. The `/url` guard is not what misses this page: measured with it
  // deleted, the page is still no wall, because it has neither a heading nor a retry affordance.
  assert.equal(detectWall(recording), null, "B.8 depends on this: nothing claims a wall, so the parser is the thing that answers");

  // `"google"` is the engine that served this page, not a claim about the host: no reddit adapter exists,
  // and an engine name nothing knows falls through to google's rule anyway. Two of the item's three
  // measurements are committed here — this verdict and the `detectWall` above. Its third, the same call as
  // `"duckduckgo"`, is measured in the item and not asserted.
  const verdict = classifySerp(recording, "google");
  assert.equal(verdict.kind, "results", "B.8 is open, not fixed: a page refusing us is `results`. Red here means a classifier changed the verdict — retire it with the item, not to make the suite green.");
  assert.equal(verdict.results.length, 1, "B.8: the block page's one link is the only 'result' — 0 would mean it is no longer counted");
  assert.equal(verdict.results[0].url, ticket, "B.8: the result is the support-desk ticket form, and naming it is what makes a fix say so out loud");
  assert.equal(verdict.results[0].title, "File a ticket", "B.8: the title is the refusal's own affordance, kept because it is the evidence");
});

/**
 * B.9 — a wrong answer pinned on purpose, expected to pass today, retired with the item.
 *
 * `tests/fixtures/serp-google-answered-by-duckduckgo.txt` is a DuckDuckGo results page we asked Google
 * for. The gateway re-navigates to DuckDuckGo inside one `@google_search` call when its own probe finds
 * no organic google result, and reports which engine answered in `searchEngine`/`fallbackFrom` — two
 * fields `NavigateResult` does not carry. So the page reaches `classifySerp` under the name we asked for,
 * and the only question `isChrome` can ask — is this the engine's own host — is asked of the wrong engine.
 * Filed in `docs/improvements/2026-10-18-code.md` →
 * `### B.9 The gateway reports which engine answered`, with the gateway-side mechanism and the live
 * response quoted there.
 *
 * This pins `classifySerp`, which is the seam the two engine names reach; the missing `searchEngine` read
 * is one call site earlier and no assertion here can see it, because reading it is production code and
 * this branch writes none.
 *
 * Divergence is the assertion, not either count, so both directions are committed: DuckDuckGo's own footer
 * becomes results under `"google"`, and one `play.google.com` link stops being a result under
 * `"duckduckgo"`. Excluding `duckduckgo.com` from the google branch is the mutation that reddens this and
 * leaves `serp-google.txt`, `serp-duckduckgo.txt` and the B.8 case green — measured.
 */
test('B.9 as filed: one recorded page, 30 results as "google" and 22 as "duckduckgo"', () => {
  const recording = fixture("serp-google-answered-by-duckduckgo.txt", "https://duckduckgo.com/?q=expressen&ia=web");

  // DuckDuckGo's footer, verbatim from the recording. Under the engine we asked for, every one of them is
  // an unaffiliated organic result, because none of them is on a google host.
  const footer = [
    "https://start.duckduckgo.com/",
    "https://duckduckgo.com/updates",
    "https://duckduckgo.com/compare-privacy",
    "https://duckduckgo.com/bangs",
    "https://duckduckgo.com/duckduckgo-help-pages/",
    "https://duckduckgo.com/pro",
    "https://duckduckgo.com/email",
    "https://duckduckgo.com/newsletter",
    "https://duckduckgo.com/collaborations",
  ];

  const asked = classifySerp(recording, "google");
  const answered = classifySerp(recording, "duckduckgo");

  // Both are `results`, which is the half a11y-tree reading cannot see: a verdict of `results` is terminal
  // for `src/engines/chain.ts`, so neither of these falls through to a second engine.
  assert.equal(asked.kind, "results", "B.9: the substituted page is not an error, it is a page of results");
  assert.equal(answered.kind, "results", "B.9: and the same page read as the engine that served it");

  if (asked.kind !== "results" || answered.kind !== "results") return;
  const askedUrls = new Set(asked.results.map((result) => result.url));
  const answeredUrls = new Set(answered.results.map((result) => result.url));

  assert.equal(asked.results.length, 30, 'B.9: 30 as "google". Red with the 9 below means chrome stopped being results — retire this case with the item, do not retune the number.');
  assert.equal(answered.results.length, 22, 'B.9: 22 as "duckduckgo", 8 fewer. Red here means the two engines stopped disagreeing, which is the fix.');

  for (const url of footer) {
    assert.ok(askedUrls.has(url), `B.9: ${url} is served as a result by the engine name we asked for`);
    assert.ok(!answeredUrls.has(url), `B.9: and the same url is chrome under the engine that answered`);
  }

  // The other direction, which is what makes this a rule and not one host name: `play.google.com` is a
  // google host, so the google branch's host rule calls it chrome and the duckduckgo branch does not.
  const playStore = [...answered.results].find((result) => result.url.startsWith("https://play.google.com/"));
  assert.ok(playStore, "B.9: the recording carries a play.google.com result");
  assert.equal(askedUrls.has(playStore.url), false, 'B.9: and it is dropped as chrome under "google" — the two rules disagree in both directions');
});
