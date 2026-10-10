import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { detectWall, extractText, parseSerp } from "../src/snapshot.ts";

function fixture(name, url = "https://example.test/") {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
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
    nextOffset: 20_000,
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
  const longConsent = `- heading "Before you continue to Google" [level=1]\n${"- paragraph:\n  - text: cookie notice\n".repeat(300)}`;
  assert.equal(longConsent.length > 3_000, true);

  assert.equal(
    detectWall({ url: "https://consent.google.com/ml?continue=x", text: longConsent }),
    "consent_wall",
  );
});
