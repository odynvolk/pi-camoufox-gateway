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

const CHROME_TITLES =
  /^(all|images|videos|news|maps|webb|short videos|more|next|page \d+|sign in|privacy|terms|settings|search domain .+)$/iu;

/** Above this size a page is content, not an interstitial, whatever it happens to mention. */
const INTERSTITIAL_MAX_CHARS = 3_000;

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

/**
 * True when a snapshot is too long to be a wall or an empty page yet contains no link blocks. That
 * means the accessibility tree changed shape — a different failure from "the engine served a clean
 * page with no organic results", and the difference matters when deciding whether to retry.
 */
export function looksUnparseable(snapshot: SnapshotLike): boolean {
  const text = snapshot.text ?? "";
  if (text.length <= 2_000) return false;
  return linkBlocks(text).length === 0;
}

/** Leading slice of a snapshot as one line, for a diagnostic excerpt. */
export function excerpt(snapshot: SnapshotLike, limit = 200): string {
  return (snapshot.text ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
}

export function parseSerp(snapshot: SnapshotLike, engine: string): { results: SearchResult[] } {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const block of linkBlocks(snapshot.text)) {
    const url = block.url?.trim();
    if (!url || !/^https?:\/\//iu.test(url)) continue;
    if (isChrome(engine, url)) continue;
    if (CHROME_TITLES.test(block.title)) continue;
    if (seen.has(url)) continue;

    seen.add(url);
    const snippet = block.texts
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 400);

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

  return { results };
}

/**
 * Classifies a snapshot that should not be read as content.
 *
 * Detection is structural on purpose. Prose alone cannot be the evidence: GitHub's README mentions a
 * captcha, so phrase-only matching refused to read any page that *discussed* bot countermeasures.
 * A wall is an interstitial, so either the host says so or the page is tiny.
 */
export function detectWall(snapshot: SnapshotLike): GatewayErrorCode | null {
  const text = snapshot.text ?? "";
  const url = snapshot.url ?? "";

  if (/consent\.google\.com/u.test(url)) return "consent_wall";

  if (text.trim().length === 0) return "empty_page";

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
  /** Echoed back so the caller can tell what the gateway was asked for. */
  requestedOffset?: number;
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

  const result: ExtractedText = {
    text: sliced,
    truncated: weTruncated,
    hasMore: gatewayMore,
    totalChars,
    nextOffset,
  };
  if (options.offset !== undefined) result.requestedOffset = options.offset;
  return result;
}
