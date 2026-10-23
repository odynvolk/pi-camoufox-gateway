/**
 * Snapshot reading: the one place that knows what the gateway's accessibility tree looks like.
 *
 * Everything here is driven by recorded fixtures (`tests/fixtures/*.txt`), because the tree is the
 * part of this integration most likely to drift. When Google changes the shape, a test fails — the
 * alternative is silently handing the model garbage.
 */

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
      return parsed.hostname.replace(/^www\./u, "");
    } catch {
      // fall through to the url
    }
  }
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
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
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return true;
  }
  if (engine === "google") {
    if (!host.endsWith("google.com")) return false;
    return !isWrapper(url);
  }
  if (engine === "duckduckgo") {
    return host.endsWith("duckduckgo.com");
  }
  return host.endsWith("google.com") && !isWrapper(url);
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
 * Classifies a snapshot that should not be read as content.
 *
 * Detection is structural on purpose. Prose alone cannot be the evidence: GitHub's README mentions a
 * captcha, so phrase-only matching refused to read any page that *discussed* bot countermeasures.
 * A wall is an interstitial, so either the host says so or the page is tiny.
 */
/**
 * A browser's own refusal, from its shape rather than its wording.
 *
 * Measured against the recorded pages, not designed in the abstract: the one error page we have is
 * 378 chars, 6 blocks, 1 heading at level 1, 1 ref — a `Try Again` button — and zero `/url` lines, and
 * every other recorded page carries at least one `/url`. That last condition is the load-bearing one, so
 * it is worth being explicit about what it excludes: a refusal that renders a help article would carry
 * one and go undetected. No such page is recorded here, and loosening the rule to cover a hypothetical
 * one would trade a measured budget for an unmeasured one.
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

export function detectWall(snapshot: SnapshotLike): GatewayErrorCode | null {
  const text = snapshot.text ?? "";
  const url = snapshot.url ?? "";

  if (/consent\.google\.com/u.test(url)) return "consent_wall";

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
 * One SERP snapshot, one verdict: wall, results, or — with nothing organic to hand back — why not.
 *
 * The two axes of the last branch are read here, not inferred from call order: how wide the page is,
 * and whether anything in it had the shape of a link at all. Both engines used to repeat the sequence
 * themselves, which made the *meaning* of `PARSEABLE_MIN_CHARS` an emergent property of that order —
 * swap two calls and a wall-shaped page reports `empty_results`, or a thin one blames our parser. Now
 * one call site holds the order, and the branches are asserted together in `tests/snapshot.test.mjs`.
 */
export function classifySerp(snapshot: SnapshotLike, engine: string): SerpVerdict {
  const url = snapshot.url ?? "";
  const text = snapshot.text ?? "";

  // Host and phrase evidence first: an interstitial is a substituted page, and naming it is more
  // useful than reporting a page we could not parse.
  const wall = detectWall(snapshot);
  if (wall) {
    return {
      kind: "error",
      code: wall,
      message: `${engine} did not serve results (got ${url})`,
      details: { url, engine },
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
