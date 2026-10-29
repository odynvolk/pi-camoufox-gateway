/**
 * Snapshot reading: the one place that knows what the gateway's accessibility tree looks like.
 *
 * Everything here is driven by recorded fixtures (`tests/fixtures/*.txt`), because the tree is the
 * part of this integration most likely to drift. When Google changes the shape, a test fails — the
 * alternative is silently handing the model garbage.
 */

import type { EngineName } from "./config.ts";
import { matchesHostRule, normalizeHost } from "./net-policy.ts";
import type { GatewayErrorCode } from "./errors.ts";

export interface SnapshotLike {
  url: string;
  text: string;
  refsCount?: number;
  truncated?: boolean;
  totalChars?: number;
  hasMore?: boolean;
  nextOffset?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  host: string;
  snippet: string;
  /** True when the url is a redirect wrapper that only resolves by navigating to it. */
  resolvable: boolean;
  engine: string;
  /** Snapshot ref, valid only until the next navigation. */
  ref?: string;
  cite?: string;
}

interface LinkBlock {
  title: string;
  ref?: string;
  url?: string;
  cite?: string;
  texts: string[];
}

/**
 * Above this size a page is content rather than an interstitial, whatever it mentions — unless its host
 * already says otherwise, which is size-independent (`detectWall`'s first branch).
 */
const INTERSTITIAL_MAX_CHARS = 3_000;

/**
 * Past this size, a page with no link blocks at all has outgrown "thin query": a real results list of
 * that width would have had some. Below it, link-less text is a query that matched nothing.
 *
 * Two thresholds decide what a page with no results means, and only one of them is this one: a wall or
 * an empty page is `detectWall`'s answer, and it is always taken first, because `classifySerp` is the
 * only caller of *this threshold* and runs both checks in one place. So it reaches exactly the pages
 * the wall check declined, and only together with the structure axis — how many link blocks the page
 * has.
 *
 * What this threshold's position controls is a page nothing catches by shape: a link-less one. At any
 * value, a page carrying a wall phrase under `INTERSTITIAL_MAX_CHARS` is still `blocked` — `detectWall`
 * runs first and width is never consulted. But between the two constants, a wide page we could not read
 * would come back as "the engine returned nothing", and keeping this below that is what closes the
 * band. `tests/snapshot.test.mjs` has the page that would otherwise fall through it; the matrix in that
 * file pins each constant's value at its own boundary.
 */
const PARSEABLE_MIN_CHARS = 2_000;

/** Snippets are model-facing, so the cap is explicit rather than an inline slice. */
const SNIPPET_MAX_CHARS = 400;

/** Same reason for excerpts, which is all `excerpt` has to say about why it is not inline. */
const EXCERPT_MAX_CHARS = 200;

const LINK_LINE = /^(\s*)-\s+link\s+"(.*)"\s*(?:\[(e\d+)\])?\s*:?\s*$/u;
const URL_LINE = /^\s*-\s*\/url:\s*(\S+)\s*$/u;
const CITE_LINE = /^\s*-\s*cite:\s*(.+?)\s*$/u;
const TEXT_LINE = /^\s*-\s*text:\s*(.+?)\s*$/u;

function unescapeTitle(raw: string): string {
  return raw.replace(/\\(["\\])/gu, "$1").trim();
}

/** Host a result belongs to, preferring Google's `cite:` line, which is already human-facing. */
function hostFrom(cite: string | undefined, url: string): string {
  const citeUrl = cite?.match(/^(https?:\/\/[^ >]+|www\.[^ >/]+)/iu)?.[1];
  if (citeUrl) {
    try {
      const parsed = new URL(citeUrl.includes("://") ? citeUrl : `https://${citeUrl}`);
      return normalizeHost(parsed.hostname).replace(/^www\./u, "");
    } catch {
      // fall through to the url
    }
  }
  try {
    return normalizeHost(new URL(url).hostname).replace(/^www\./u, "");
  } catch {
    return "";
  }
}

/** Split the tree into link blocks, keeping their url/cite/text children. */
function linkBlocks(text: string): LinkBlock[] {
  const lines = text.split("\n");
  const blocks: LinkBlock[] = [];
  let current: LinkBlock | undefined;
  let currentIndent = 0;

  for (const line of lines) {
    const link = line.match(LINK_LINE);
    if (link) {
      const indent = (link[1] ?? "").length;
      current = { title: unescapeTitle(link[2] ?? ""), ref: link[3], texts: [] };
      currentIndent = indent;
      blocks.push(current);
      continue;
    }
    if (!current) continue;

    const indent = (line.match(/^\s*/u)?.[0] ?? "").length;
    if (indent <= currentIndent) {
      current = undefined;
      continue;
    }
    const url = line.match(URL_LINE);
    if (url) {
      if (!current.url && url[1]) current.url = url[1];
      continue;
    }
    const cite = line.match(CITE_LINE);
    if (cite) {
      if (cite[1]) current.cite = cite[1];
      continue;
    }
    const body = line.match(TEXT_LINE);
    if (body?.[1]) current.texts.push(body[1]);
  }

  return blocks;
}

function isWrapper(url: string): boolean {
  return /google\.com\/(goto|url)\?url=/iu.test(url);
}

/**
 * Organic-vs-chrome per engine. Chrome is what the engine's own UI links to — its tabs, its ad
 * proxy, its settings — so it is filtered by host rather than by title heuristics, which drift.
 *
 * The filter used to be host *and* a hardcoded title list, and the list is what this function argues
 * against: it carried `webb` and `all` because a Swedish results page titled its tabs that, which is
 * locale drift sitting in a regex rather than in the engine. It is gone, on measurement rather than on
 * taste — measured over every recorded SERP, each parsed as the engine it was recorded from, it dropped
 * nothing that was not already dropped: the 2 title matches in `serp-google.txt`'s 18 blocks carry no
 * `/url` child, and all 15 of `serp-duckduckgo.txt`'s 78 carry a *relative* one (`/?q=…`, `/settings`),
 * so `organicResults` refuses every one at its scheme guard, before `isChrome` is reached. Of the rest,
 * `serp-duckduckgo-html.txt` matches no title at all, and the two that do — `serp-no-results.txt`,
 * `wall-consent.txt` — match only google-host chrome, which the host rule already covered. The only
 * recorded page whose title matches survive both guards is `page-github.txt` — its footer `Terms` and
 * `Privacy`, both on docs.github.com — which is a *read*, never parsed by this code, and is content the
 * list would have cut.
 *
 * What that costs is stated plainly: chrome on a host the engine does not own, under a title on the old
 * list, is now a result. Pinned by a case in `tests/snapshot.test.mjs` so the trade stays a decision
 * rather than a regression.
 */
function isChrome(engine: string, url: string): boolean {
  const host = rawHostOf(url);
  // A link whose host cannot be read is not a place, and a result has to be a place.
  if (!host) return true;
  // An engine we do not ship is judged as google, which is what the string test this replaced always meant
  // — but judged by the *same function*. The branch used to be `host.endsWith("google.com")`, kept "for
  // safety" behind an engine name no config can produce (`src/config.ts` validates every name against
  // `ENGINE_NAMES`), and it had inherited both defects the table deletes: `evilgoogle.com` was the engine's
  // own chrome, so its links were dropped, and `www.google.co.uk/imghp` was not, so it surfaced as organic.
  // A duplicate rule nobody tests is not a safety net; it is the old code, waiting.
  const rule = RULE_BY_ENGINE[engine] ?? HOST_RULES.google;
  // One host rule, asked two questions: ownership of the page here, and ownership of each link there.
  // It used to be two rules — `endsWith("google.com")` after peeling `www.` — which disagreed with the
  // first in both directions: it called `evilgoogle.com` and `myduckduckgo.com` the engine's own chrome,
  // and left a `www.google.co.uk` SERP's own `…/imghp` tabs unfiltered because they are not on `.com`.
  // The one place the questions legitimately differ: google's organic links *are* wrappers on google's
  // own host, so without the carve-out every result on the page we most want to read becomes chrome.
  return hostIsEngineDomain(host, rule) && !(rule.wrappers && isWrapper(url));
}

/** Leading slice of a snapshot as one line, for a diagnostic excerpt. Used in `classifySerp`'s details. */
function excerpt(snapshot: SnapshotLike): string {
  return (snapshot.text ?? "").replace(/\s+/gu, " ").trim().slice(0, EXCERPT_MAX_CHARS);
}

/**
 * The parsing seam: blocks in, filtered results out.
 *
 * Production classifies through `classifySerp`, which owns the order; this stays exported so the
 * recorded fixtures can be asserted against the parser alone, without a verdict in the way.
 */
export function parseSerp(snapshot: SnapshotLike, engine: string): { results: SearchResult[] } {
  return { results: organicResults(linkBlocks(snapshot.text ?? ""), engine) };
}

/** Blocks the engine links to as results, after chrome, dead urls, and duplicates are dropped. */
function organicResults(blocks: LinkBlock[], engine: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const url = block.url?.trim();
    if (!url || !/^https?:\/\//iu.test(url)) continue;
    if (isChrome(engine, url)) continue;
    if (seen.has(url)) continue;

    seen.add(url);
    const snippet = block.texts
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, SNIPPET_MAX_CHARS);

    results.push({
      title: block.title || url,
      url,
      host: hostFrom(block.cite, url),
      snippet,
      resolvable: isWrapper(url),
      engine,
      ref: block.ref,
      cite: block.cite,
    });
  }

  return results;
}

/**
 * A browser's own refusal, from its shape rather than its wording.
 *
 * Measured against the recorded pages, not designed in the abstract: the one error page we have is
 * 378 chars, 6 blocks, 1 heading at level 1, 1 ref — a `Try Again` button — and zero `/url` lines, and
 * every other recorded page that has anything on it carries at least one `/url`. That last condition is
 * the load-bearing one, so be explicit about what it excludes, and about how narrow it is: a `/url`
 * line, not a link — a page whose only links have no url child is still caught, measured. And a refusal
 * carrying one is recorded: `serp-reddit-blocked.txt` (B.8) says we were blocked, links to a support
 * desk, and is called no wall. Loosening the guard does not reach that page, which is measured too —
 * with this line deleted it is still no wall, having neither a heading nor a retry affordance. So the
 * guard stays, because it is what keeps a navigable page from being called a refusal.
 *
 * The thin end is the same trade, and it is louder: this rule is not width-gated, so it is what answers a
 * page still rendering, and a verdict here ends the settle wait rather than continuing it. Accepted on
 * measurement — every line-prefix of every recorded page checked against all three: only
 * `page-network-error.txt` ever reaches them, and at its own last line. No recorded content page carries a
 * retry-vocabulary button at all. Pinned in `tests/read-tool.test.mjs`, so reversing it is a decision and
 * not a regression.
 */
function isBrowserRefusal(text: string): boolean {
  const lines = text.split("\n");

  const headings = lines.filter((line) => /^\s*- heading /u.test(line));
  const [heading] = headings;
  if (headings.length !== 1 || !/\[level=1\]/u.test(heading ?? "")) return false;

  // A page you can navigate away from is not a refusal, however it is headed.
  if (lines.some((line) => /\/url:/u.test(line))) return false;

  return lines.some((line) => RETRY_AFFORDANCE.test(line));
}

/** The affordance a browser puts on its own error page, spelled the four ways browsers spell it. */
const RETRY_AFFORDANCE = /^\s*- button "(?:try again|reload|refresh|retry)/iu;

/**
 * Classifies a snapshot that should not be read as content.
 *
 * Three branches, and only one of them is width-bounded: the host says so, the shape of a browser's
 * refusal is taken at any size, or a phrase matches while the page is still under
 * `INTERSTITIAL_MAX_CHARS`.
 *
 * Phrases are the gated ones because prose alone cannot be the evidence: GitHub's README mentions a
 * captcha, so phrase-only matching refused to read any page that *discussed* bot countermeasures.
 */
export function detectWall(snapshot: SnapshotLike): GatewayErrorCode | null {
  const text = snapshot.text ?? "";
  const url = snapshot.url ?? "";

  // The host, not the url. The query is echoed into the search url and `encodeURIComponent` leaves dots
  // alone, so `camoufox_search("why does consent.google.com keep appearing")` produces a destination that
  // *contains* that string while Google served an ordinary results page — and a substring test called it a
  // consent wall, hopping to DuckDuckGo over a page that was fine. Same reason an attacker's
  // `?next=https://consent.google.com/` can no longer fabricate one. Kept total like the rest of this
  // function: an unreadable url is no match, and the branches below still get their turn.
  const host = hostOf(url);
  if (host && matchesHostRule(host, CONSENT_HOST)) return "consent_wall";

  if (text.trim().length === 0) return "empty_page";

  // Structural, and deliberately not size-gated. This repo's own rule is that *keyword* evidence over
  // fetched text must be size-gated, because a long page can mention anything — GitHub's README
  // contains "complete a captcha". A refusal is different: it is what a page looks like when there is
  // nothing on it, so the shape is evidence at any width, and taking it only under a threshold was what
  // made a slightly wider refusal read as content.
  //
  // Three things, all of them structure: one heading, a retry affordance, and no `/url` anywhere —
  // nothing on the page is a document. The button is what keeps the second test honest: a long article
  // about retrying has the heading and the width, and is saved from this rule by having links to read.
  if (isBrowserRefusal(text)) return "navigation_failed";

  if (text.length <= INTERSTITIAL_MAX_CHARS) {
    if (/before you continue to google|unusual traffic|not a robot|verify you are (a |an )?(robot|human)|\bcaptcha\b/iu.test(text)) {
      return "consent_wall";
    }
    if (/network protocol error|cannot be repaired|whitelisted|not allowed to connect|403 forbidden|bad gateway|err_.{3,30}\b/iu.test(text)) {
      return "navigation_failed";
    }
  }

  return null;
}

/**
 * Whether a wall is a page still arriving, rather than a page that has decided.
 *
 * One rule for both callers of the re-look machine, because the two differ on everything else — read
 * counts characters, an engine reads its own parser — and a second copy of *this* judgement is a second
 * answer waiting to drift.
 *
 * `empty_page` is the exception, and the narrow one: it is what a blank snapshot is called, and a blank
 * snapshot is the most obviously-still-rendering page there is. Any other wall is a page that has
 * answered, and waiting on an answer buys latency and nothing else.
 */
export function wallWorthWaitingOn(wall: GatewayErrorCode | null): boolean {
  return wall === null || wall === "empty_page";
}

/**
 * A SERP snapshot that is not results, and the code the model should be told.
 *
 * Every error branch carries `url` and `engine` in `details`, plus `excerpt` where it is the evidence:
 * the chain records `code` and `message` per step, so a step that reported no engine could not be
 * attributed after the fact.
 */
export type SerpVerdict =
  | { kind: "results"; results: SearchResult[] }
  | { kind: "error"; code: GatewayErrorCode; message: string; details: Record<string, unknown> };

/**
 * Did the engine we asked for serve this page?
 *
 * Two things downstream are per-engine and only true of a page that engine served: `isChrome`, which
 * filters an engine's own UI by host, and the credit `src/engines/chain.ts` hands out from `Engine.name`.
 * Measured on `tests/fixtures/serp-google-answered-by-duckduckgo.txt` — a DuckDuckGo results page, asked
 * for as google: **30** results as `"google"`, **22** as `"duckduckgo"`. Nine of them are DuckDuckGo's own
 * footer links, which google's host rule has no way to call chrome, and one `play.google.com` link moves
 * the other way — so eight of them reached the model as organic results under a header saying
 * `(via google)`.
 *
 * Answers `true` for anything it cannot judge: an engine we do not ship, an unparseable url, a host with
 * no labels in it, a gateway that reports no destination. Each of those is a silence, and reading a
 * silence as "not ours" fails a search closed on evidence nobody has.
 */
export function engineOwnsUrl(engine: string, url: string): boolean {
  const host = rawHostOf(url);
  // Two silences, both answered "not a verdict": an unparseable url and a host of nothing are missing
  // information, not evidence about where a page is. Asked of the **raw** hostname on purpose —
  // normalising first would let `"."`, which the strip turns into nothing, walk in here from being judged
  // foreign, and a tab mid-navigation would stop being a silence.
  if (!host) return true;
  const rule = RULE_BY_ENGINE[engine];
  // An engine we do not ship has no host rule, and inventing one would be a claim about a site we have
  // never measured. `HOST_RULES`' exhaustiveness check is what makes "no rule" mean "not ours to say".
  if (!rule) return true;
  return hostIsEngineDomain(host, rule);
}
/** What it takes for a host to be an engine's own: the label its registrations sit at, and how deep a suffix it registers under. */
interface HostRule {
  label: string;
  /** How many labels may follow it. Two covers `co.uk`/`com.br`; one is an engine that owns a single TLD. */
  maxTail: number;
  /** Does this engine wrap organic links in a redirect on its own host? Those are results, not chrome. */
  wrappers: boolean;
}

/**
 * One entry per engine we ship an adapter for, and `satisfies` is what makes that a compile error rather
 * than a silent hole. `engineOwnsUrl` answers `true` for an engine with no rule, so a third engine added
 * to `ENGINE_NAMES` without stating its host rule here would opt itself out of the misattribution guard
 * this file exists to enforce — no type error, no red test, and `(via bing)` printed over whatever page
 * arrived. `ENGINE_NAMES` is the source of truth, and `engines/serp.ts` writes the same literal for the
 * credit, so the name that owns a page and the name credited with it cannot drift apart.
 */
const HOST_RULES = {
  google: { label: "google", maxTail: 2, wrappers: true },
  duckduckgo: { label: "duckduckgo", maxTail: 1, wrappers: false },
} satisfies Record<EngineName, HostRule>;

/** The lookup form, widened so an engine outside `ENGINE_NAMES` yields no rule instead of a type error. */
const RULE_BY_ENGINE: Record<string, HostRule | undefined> = HOST_RULES;

/** The host `consent_wall` is named for, matched as a host rather than as a substring of the url. */
const CONSENT_HOST = "consent.google.com";

/**
 * The hostname a url points at, exactly as `new URL` spelled it. Empty means there is no host to judge —
 * an unparseable url, or a scheme with no authority — which every caller here treats as a silence.
 */
function rawHostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** The same host as `src/net-policy.ts` spells it: lower-cased, with one FQDN terminator removed. */
function hostOf(url: string): string {
  return normalizeHost(rawHostOf(url));
}

/** A single-label tail: a TLD, alphabetic or punycode. Nothing shaped `com1` or `c` is one. */
const TLD_LABEL = /^(?:[a-z]{2,24}|xn--[a-z0-9-]{2,})$/u;
/** The middle labels a registry, not a domain owner, puts between the name and the country code. */
const REGISTRY_SUFFIX = /^(?:co|com)$/u;
/** A country code is two letters, and is only ever the last label. */
const CC_TLD = /^[a-z]{2}$/u;

/**
 * Could these labels be the suffix of a domain the engine itself registered?
 *
 * One label has to be a TLD. Two have to be `<registry>.<cc>` — `co.uk`, `com.br` — which is the line
 * that refuses `google.evil.com`: it has two labels, and the first is a word the owner of `evil.com`
 * chose, not a suffix any registry issues. Requiring only that each label be alphabetic was the defect —
 * it checked the shape of the characters while the thing that carries the trust is *who controls the
 * registrable domain*, and in `google.evil.com` that is whoever owns `evil.com`.
 *
 * What this cannot do is tell an apex squatter from Google: whoever registers `google` under some TLD
 * owns that apex, and no suffix rule can see the difference. `https://google.xyz/` is therefore claimed,
 * pinned as a known limit in `tests/snapshot.test.mjs` rather than left a surprise. An allowlist of the
 * suffixes we serve would close it, and would cost a search every time Google geo-redirects to a ccTLD
 * the list does not name — a silent quality loss on the common path to police a class Google defensively
 * registers against and most registrars trademark-block.
 */
function isRegistrableSuffix(tail: string[]): boolean {
  if (tail.length === 1) return tail.every((part) => TLD_LABEL.test(part));
  if (tail.length !== 2) return false;
  const [registry, cc] = tail;
  // The two guards are for `noUncheckedIndexedAccess`; the length check above is what makes them hold.
  return registry !== undefined && cc !== undefined && REGISTRY_SUFFIX.test(registry) && CC_TLD.test(cc);
}

/**
 * Does this host sit under a domain the engine registered, at any subdomain depth?
 *
 * Labels, counted, rather than a suffix pattern: `[a-z.]+$` admits dots, so a character class cannot
 * count labels, and the pattern this replaced read `www.google.com.evil.test` — a host whose registrable
 * domain is `evil.test` — as Google's. Counting is also what keeps the domains that are real: `google.co.uk`
 * and `google.com.br` carry two labels after the engine's, and no country-code domain carries more.
 * Counting alone is not enough, which is what `isRegistrableSuffix` is for — see the attack it refuses.
 *
 * At least one tail label is required: `www.google` is a hostname on somebody's LAN, not Google's domain.
 * The last matching label wins, so the tail counted is the registrable one.
 */
function hostIsEngineDomain(host: string, rule: HostRule): boolean {
  // Normalised here rather than at each call site, so the page-ownership question and the per-link
  // chrome question cannot disagree about whether `www.google.com.` is Google's.
  const parts = normalizeHost(host).split(".");
  // No resolver can serve a name with an empty label. Until now the shapes carrying one were refused only
  // by accident — `["", "com"]` fails `REGISTRY_SUFFIX` rather than being told no.
  if (parts.some((part) => part === "")) return false;
  const at = parts.lastIndexOf(rule.label);
  if (at === -1) return false;
  const tail = parts.slice(at + 1);
  if (tail.length === 0 || tail.length > rule.maxTail) return false;
  return isRegistrableSuffix(tail);
}

/**
 * One SERP snapshot, one verdict: a wall, a page some other engine served, results, or — with nothing
 * organic to hand back — why not.
 *
 * The order is the answer, and it lives here rather than in call order: host and phrase evidence first,
 * then ownership, then the parse. The last branch reads two axes itself — how wide the page is, and
 * whether anything in it had the shape of a link at all. Both engines used to repeat the sequence
 * themselves, which made the *meaning* of `PARSEABLE_MIN_CHARS` an emergent property of that order —
 * swap two calls and a wall-shaped page reports `empty_results`, or a thin one blames our parser. Now
 * one call site holds the order, and the branches are asserted together in `tests/snapshot.test.mjs`.
 */
export function classifySerp(snapshot: SnapshotLike, engine: string): SerpVerdict {
  const url = snapshot.url ?? "";
  const text = snapshot.text ?? "";
  // The message a model reads gets the parsed host; `details.url` keeps the raw string for diagnostics.
  // Both are printed from a destination the gateway reported, which a redirect — or a query the engine
  // echoed — can put words in, and a verdict that is right about a page should not launder an attacker's
  // bytes into model-facing prose while doing it.
  const host = hostOf(url) || "a page with no destination";

  // Host and phrase evidence first: an interstitial is a substituted page, and naming it is more
  // useful than reporting a page we could not parse.
  const wall = detectWall(snapshot);
  if (wall) {
    return {
      kind: "error",
      code: wall,
      message: `${engine} did not serve results (got ${host})`,
      details: { url, engine },
    };
  }

  // Where the page is, asked before what is on it. `empty_results` is the code deliberately: it is not in
  // `chain.ts`'s `TERMINAL_CODES`, so the chain runs the engine that does host this page and is credited
  // by its own `Engine.name` — which is the only way a substituted page can be attributed without letting
  // a field in the payload pick who gets the credit, and the only way it is never chrome-filtered by the
  // wrong engine's host list. Runs after `detectWall` because a consent interstitial is a named event, and
  // naming it beats reporting a page we declined to read.
  if (!engineOwnsUrl(engine, url)) {
    return {
      kind: "error",
      code: "empty_results",
      message: `${engine} did not serve this page — the tab is at ${host}`,
      details: { url, engine, substituted: true },
    };
  }

  // Split once, because the block count is evidence in its own right: a page whose only links are the
  // engine's own tabs answered cleanly, with nothing organic in it. That is a different emptiness from
  // a page where nothing matched `link` at all, and only the second one is a changed tree.
  //
  // The middle case is not decidable from here, and is recorded as B.6: an engine that moved organic
  // results to a node type we do not read, while its chrome links survive, has the shape of an engine
  // that answered with nothing. `empty_results` is not terminal, so the chain still falls through to the
  // next engine and one blind adapter is recovered; two would be a wrong answer. Nothing structural
  // separates the two — the recorded `serp-no-results.txt` *is* chrome-with-urls and zero organics.
  const blocks = linkBlocks(text);
  const results = organicResults(blocks, engine);
  if (results.length > 0) return { kind: "results", results };

  if (blocks.length === 0 && text.length > PARSEABLE_MIN_CHARS) {
    return {
      kind: "error",
      code: "parse_error",
      message: `${engine} served a page we could not read as a results list`,
      // The excerpt is the only way to tell a tree change from a strange-but-readable page.
      details: { url, engine, excerpt: excerpt(snapshot) },
    };
  }

  return {
    kind: "error",
    code: "empty_results",
    message: `${engine} returned no organic results for that query`,
    details: { url, engine },
  };
}

export interface ExtractTextOptions {
  maxChars: number;
  offset?: number;
}

export interface ExtractedText {
  text: string;
  truncated: boolean;
  hasMore: boolean;
  totalChars: number;
  /** Offset to pass on the next call, or null when there is nothing left. */
  nextOffset: number | null;
}

export function extractText(snapshot: SnapshotLike, options: ExtractTextOptions): ExtractedText {
  const maxChars = Math.max(1, options.maxChars);
  const available = snapshot.text ?? "";
  const totalChars = typeof snapshot.totalChars === "number" ? snapshot.totalChars : available.length;
  const gatewayMore = snapshot.hasMore === true;

  const sliced = available.length > maxChars ? available.slice(0, maxChars) : available;
  const weTruncated = sliced.length < available.length;

  // Continuation is "where do I resume", so our own consumed point wins when we cut: the rest of
  // the text is already in hand and asking for the gateway's offset would re-show what we skipped.
  // When we did not cut anything, the gateway's nextOffset is the only thing that is true.
  let nextOffset: number | null = null;
  if (weTruncated) {
    nextOffset = (options.offset ?? 0) + sliced.length;
  } else if (gatewayMore && typeof snapshot.nextOffset === "number") {
    nextOffset = snapshot.nextOffset;
  }

  return {
    text: sliced,
    truncated: weTruncated,
    hasMore: gatewayMore,
    totalChars,
    nextOffset,
  };
}
