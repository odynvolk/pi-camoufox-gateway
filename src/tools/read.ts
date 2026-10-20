/**
 * The read side: navigate, let the page finish rendering, report where we actually ended up, and
 * hand back a bounded slice of the page. The bound is the point — the gateway happily returns ~20K
 * tokens of accessibility tree for a single page, and the model asked for a page, not an eviction.
 *
 * The settle loop exists because `openTab` returning does not mean the page is there: a client
 * rendered site answers with its skeleton, and the old code snapshotted that and called it the page.
 */

import type { CamoufoxConfig } from "../config.ts";
import type { Cache } from "../cache.ts";
import { GatewayError } from "../errors.ts";
import type { GatewayClient, SnapshotResult } from "../gateway.ts";
import { assertTabUrlAllowed, urlPolicyFromConfig } from "../net-policy.ts";
import { detectWall, extractText, type ExtractedText } from "../snapshot.ts";

export interface ReadToolDeps {
  client: GatewayClient;
  config: CamoufoxConfig;
  /** Shared per-session cache. Holds heterogeneous values behind prefixed keys, as search's does. */
  cache: Cache<unknown>;
  userId: string;
}

export interface ReadParams {
  url: string;
  maxChars?: number;
  offset?: number;
  /** CSS selector to hold for before reading — for content the settle heuristic cannot see coming. */
  waitFor?: string;
  /** JSON Schema with `x-ref` hints; requires a snapshot first, which this tool does for you. */
  schema?: Record<string, unknown>;
  /** Ignore the page cache and navigate. Otherwise a page is served from it for `cache.pageMs`. */
  fresh?: boolean;
  signal?: AbortSignal;
}

export interface ReadOutcome {
  url: string;
  text: string;
  truncated: boolean;
  hasMore: boolean;
  totalChars: number;
  nextOffset: number | null;
  extracted?: Record<string, unknown>;
  refsCount: number;
  /** Extra time spent re-snapshotting a thin page. Absent when no polling was needed. */
  settledInMs?: number;
  /** The settle budget ran out while the page was still growing, so a bigger one could help. */
  stalledAtDeadline?: boolean;
  /** Set when the page was still thin after every wait: probably client-rendered. */
  thinAfterWait?: boolean;
  /** True when the caller asked for a selector wait, so the notes can stop recommending it. */
  waitForRequested?: boolean;
  /** What a `waitFor` did not achieve, in words the model can act on. Absent when it worked. */
  waitNote?: string;
  /** Served from the page cache: no tab was opened, so nothing about this page was re-fetched. */
  fromCache?: boolean;
}

/**
 * How many identical snapshots in a row count as "the page is finished".
 *
 * Exported so the cost of the settle loop is pinned by a test instead of re-hardcoded in it.
 */
export const STABLE_ROUNDS = 2;

/** Two consecutive snapshots are the same page, not merely two strings of the same length. */
function samePage(left: SnapshotResult, right: SnapshotResult): boolean {
  // `totalChars` and `refsCount` are cheap and catch the two shapes text alone cannot see: a slice the
  // gateway capped, where the returned text stops growing while the page keeps going, and a skeleton
  // that swaps content at a constant width.
  return left.text === right.text && left.totalChars === right.totalChars && left.refsCount === right.refsCount;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuse a schema that cannot be answered as asked, before spending a navigation on it.
 *
 * The recorded contract for `/extract` (`tests/fixtures/openapi.json`) names one way to reach page
 * content: a top-level property carrying `x-ref`. A schema without a single one is a typo, and left
 * unchecked it cost a whole page load and came back as `extraction_empty` — a message about refs on the
 * page, one step from "the gateway found nothing", sending the reader to the service rather than to
 * their schema.
 *
 * Stricter than that contract, deliberately, and the strictness is the rule: every top-level property
 * has to carry an `x-ref`, so a partly-annotated schema is refused rather than answered with the subset
 * it does address. Refs are read at the top level only, which is why a nested `properties` is refused
 * as well.
 */
function assertSchemaUsable(schema: Record<string, unknown>): void {
  const properties = schema.properties;
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    throw new GatewayError(
      "unsupported",
      'that schema has no "properties" to extract — each property needs an "x-ref" naming a ref from the page',
    );
  }

  for (const [key, spec] of Object.entries(properties)) {
    if (!isRecord(spec) || typeof spec["x-ref"] !== "string" || spec["x-ref"].trim() === "") {
      throw new GatewayError(
        "unsupported",
        `schema property "${key}" has no "x-ref" — refs come from an earlier read, e.g. { "x-ref": "e12" }`,
      );
    }
  }
}

/**
 * Cache key for one window of one page.
 *
 * `maxChars` stays out of the key, exactly as search keeps `n` out of its own: it is our slice of a
 * page we already hold, so a cheap first call must not cap a later one. The offset stays *in*, because
 * the gateway returns a window rather than the page — a different offset is different content.
 *
 * The fragment is deliberately preserved. Dropping it would collapse `#/list` and `#/detail` on a
 * hash-routed SPA into one entry, and then serve one in place of the other.
 */
function pageCacheKey(url: string, offset: number | undefined): string {
  // Parsed rather than used raw, which folds host case, the default port, and a bare host's trailing
  // slash. It does not fold the FQDN terminator — `http://Host./` and `http://Host/` stay two entries
  // — and that only costs a missed hit, because the guard re-checks the stored destination, never the
  // key.
  return `read:${new URL(url).href}:${offset ?? 0}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GatewayError("aborted", "the read was cancelled while waiting for the page to render"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new GatewayError("aborted", "the read was cancelled while waiting for the page to render"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function readTool(deps: ReadToolDeps) {
  const { client, config, userId } = deps;
  const read = config.read;

  /**
   * Same rules `GatewayClient.openTab` applies, called here on purpose: a client constructed without
   * a policy must not silently turn the read tool into the unguarded path.
   */
  function assertAllowed(url: string): void {
    assertTabUrlAllowed(url, urlPolicyFromConfig(config));
  }

  /** The check `GatewayClient.snapshot` applies to a reported destination, applied again on a cache hit. */
  function assertDestinationAllowed(url: string): void {
    assertTabUrlAllowed(url, urlPolicyFromConfig(config), "destination");
  }

  /**
   * How much of the page exists, as opposed to how much of it this call returned.
   *
   * `text` is the slice from `params.offset` onward, so judging thinness on it would call the last
   * screen of a 45 000-char article "not yet rendered" and poll it twice before saying so.
   */
  function pageChars(snapshot: SnapshotResult): number {
    return typeof snapshot.totalChars === "number" && snapshot.totalChars > 0 ? snapshot.totalChars : (snapshot.text ?? "").length;
  }

  /** Thin enough that storing it would freeze an unfinished render. */
  function thin(snapshot: SnapshotResult): boolean {
    return pageChars(snapshot) < read.settleMinChars;
  }

  /**
   * A page worth re-snapshotting: too thin to be the real content, and not already classified.
   *
   * `empty_page` is deliberately still poll-worthy — "nothing rendered yet" is exactly the state a
   * client-rendered site passes through. Any other wall is a stable answer, so waiting on it is
   * wasted time the model pays for.
   */
  function worthPollingAgain(snapshot: SnapshotResult): boolean {
    if (read.waitForSettleMs <= 0) return false;
    if (pageChars(snapshot) >= read.settleMinChars) return false;
    const wall = detectWall(snapshot);
    return wall === null || wall === "empty_page";
  }

  async function snapshotSettled(
    tabId: string,
    offset: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ snapshot: SnapshotResult; settledInMs: number; polled: boolean; stalledAtDeadline: boolean }> {
    const first = await client.snapshot({ userId, tabId, offset, signal });
    if (!worthPollingAgain(first)) return { snapshot: first, settledInMs: 0, polled: false, stalledAtDeadline: false };

    const startedAt = Date.now();
    const deadline = startedAt + read.waitForSettleMs;
    let latest = first;
    let unchanged = 0;
    let polled = false;
    // Whether the budget ran out while the page was still growing. That is the only case where
    // "raise the budget" is honest advice: a page that stopped growing on its own will not grow
    // because we asked again.
    let stalledAtDeadline = true;
    // One repeat is a slow script, two is a finished page: that is the stop signal available without
    // knowing the app's selectors. The deadline bounds how long it can take, and each poll is its own
    // gateway request, so the worst case is the deadline plus one request.
    while (Date.now() < deadline) {
      // Never sleep past the budget. Sleep the interval instead and a poll configured near the deadline
      // sleeps through it and still issues its request, which is a longer read and a slower refusal than
      // the comment above promises. Config validation keeps the configured pair sane, so the clamp is
      // here for a budget assembled some other way.
      await delay(Math.max(0, Math.min(read.settlePollMs, deadline - Date.now())), signal);
      const next = await client.snapshot({ userId, tabId, offset, signal });
      unchanged = samePage(next, latest) ? unchanged + 1 : 0;
      latest = next;
      polled = true;
      if (unchanged >= STABLE_ROUNDS || !worthPollingAgain(next)) {
        stalledAtDeadline = false;
        break;
      }
    }
    return { snapshot: latest, settledInMs: Date.now() - startedAt, polled, stalledAtDeadline };
  }

  /**
   * Shape a snapshot into the outcome. One place on purpose: a page served from cache and a page
   * freshly navigated to must not disagree about what they report.
   */
  function outcomeFrom(
    snapshot: SnapshotResult,
    params: ReadParams,
    meta: {
      /** Used only when the snapshot reports no destination of its own. */
      fallbackUrl: string;
      polled: boolean;
      settledInMs: number;
      stalledAtDeadline: boolean;
      waitNote?: string;
      extracted?: Record<string, unknown>;
      fromCache: boolean;
    },
  ): ReadOutcome {
    const budget = params.maxChars ?? read.defaultMaxChars;
    const sliced: ExtractedText = extractText(snapshot, { maxChars: budget, offset: params.offset });
    const isThin = thin(snapshot);

    return {
      url: snapshot.url || meta.fallbackUrl,
      text: sliced.text,
      truncated: sliced.truncated,
      hasMore: sliced.hasMore,
      totalChars: sliced.totalChars,
      nextOffset: sliced.nextOffset,
      ...(meta.extracted ? { extracted: meta.extracted } : {}),
      refsCount: snapshot.refsCount,
      ...(meta.polled ? { settledInMs: meta.settledInMs } : {}),
      ...(meta.polled && meta.stalledAtDeadline ? { stalledAtDeadline: true } : {}),
      ...(isThin && (meta.polled || params.waitFor) ? { thinAfterWait: true } : {}),
      ...(params.waitFor ? { waitForRequested: true } : {}),
      ...(meta.waitNote ? { waitNote: meta.waitNote } : {}),
      ...(meta.fromCache ? { fromCache: true } : {}),
    };
  }

  /** What a fresh navigation cost. Absent from a cache hit, because on that path nothing was waited for. */
  type FetchMeta = { polled: boolean; settledInMs: number; stalledAtDeadline: boolean; waitNote?: string };

  /**
   * Everything a page costs to fetch: open, the optional selector wait, the settle loop, wall
   * classification, and the extraction that only a live tab can serve. The tab is always closed.
   */
  async function navigate(
    params: ReadParams,
  ): Promise<{ snapshot: SnapshotResult; fallbackUrl: string; extracted?: Record<string, unknown>; meta: FetchMeta }> {
    const tab = await client.openTab({ userId, url: params.url, signal: params.signal });
    let waitNote: string | undefined;
    try {
      if (params.waitFor) {
        const wait = await client.waitFor({
          userId,
          tabId: tab.tabId,
          selector: params.waitFor,
          timeoutMs: read.waitForTimeoutMs,
          signal: params.signal,
        });
        if (wait.skipped) waitNote = `waitFor "${params.waitFor}" was not performed: ${wait.skipped}`;
        else if (!wait.ok)
          waitNote = wait.error
            ? `waitFor "${params.waitFor}" was refused: ${wait.error}`
            : `waitFor "${params.waitFor}" did not appear within ${read.waitForTimeoutMs}ms`;
      }

      const { snapshot, settledInMs, polled, stalledAtDeadline } = await snapshotSettled(tab.tabId, params.offset, params.signal);

      // One classifier, and it is size-bounded: past `INTERSTITIAL_MAX_CHARS` a page is content whatever
      // it mentions. `blockedHosts` is the branch that is not — an internal error page is refused at any
      // width — which is why a *public* error page past that stays invisible to this tool: B.5.
      const wall = detectWall(snapshot);
      if (wall) {
        throw new GatewayError(wall, `the page did not load as content (${wall}): ${snapshot.url}`, {
          details: { url: snapshot.url, refsCount: snapshot.refsCount },
        });
      }

      // No destination check here: `client.snapshot` refuses a page from a host the policy would not
      // have opened, which is the same rule with one fewer place to remember it. It runs while we poll,
      // so a page that redirected somewhere internal is refused even when it never rendered — the
      // refusal is the truer answer of the two.

      let extracted: Record<string, unknown> | undefined;
      if (params.schema) {
        extracted = await client.extract({ userId, tabId: tab.tabId, schema: params.schema, signal: params.signal });
        if (Object.keys(extracted).length === 0) {
          throw new GatewayError("extraction_empty", "no element matched that schema's refs — re-read the page and use current refs", {
            details: { url: snapshot.url, refsCount: snapshot.refsCount },
          });
        }
      }

      return {
        snapshot,
        fallbackUrl: tab.url,
        ...(extracted ? { extracted } : {}),
        meta: { polled, settledInMs, stalledAtDeadline, ...(waitNote ? { waitNote } : {}) },
      };
    } finally {
      await client.closeTabQuietly({ userId, tabId: tab.tabId });
    }
  }

  /**
   * Whether a page may be kept. Two things have to hold, and the second is the subtle one.
   *
   * - Not thin. An unfinished render must not become the answer for `cache.pageMs`. This also covers a
   *   page whose settle budget ran out while it was still growing: `worthPollingAgain` is what keeps
   *   polling, and it only polls thin pages, so a stalled page is thin by construction.
   * - It reports a destination. A page that cannot is still readable once — under the explicit opt-out
   *   that let it be read at all — but it cannot be *re*-checked on a later read, and re-checking is
   *   the only reason the cache-hit guard exists. Storing one would also poison the entry: the guard
   *   has nothing to parse, so every later read fails on an empty url instead of navigating again.
   */
  function storable(snapshot: SnapshotResult): boolean {
    return Boolean(snapshot.url) && !thin(snapshot);
  }

  async function run(params: ReadParams): Promise<ReadOutcome> {
    assertAllowed(params.url ?? "");
    // Before anything is fetched or cached: a schema with no refs to fill is not a question a page —
    // fresh or stored — could answer.
    if (params.schema) assertSchemaUsable(params.schema);

    // A stored snapshot can only answer a plain read. Extraction needs refs, which die at the next
    // navigation, and a `waitFor` is a question a page fetched earlier cannot answer. Neither reads
    // nor writes: a stored page must not claim a wait it never performed, or refs it never had.
    const key = !params.schema && !params.waitFor ? pageCacheKey(params.url, params.offset) : undefined;

    // `fresh` skips the lookup, not the write-back. The page it fetches is strictly more current than
    // the one stored, and leaving the older entry behind would make the next plain read serve a body
    // that a call a moment ago had already superseded. One limit: a plain read already in flight has
    // no ordering token against this one, so if it fetched earlier and finishes later it writes its
    // older page back. The common late finisher is a page still growing at its deadline, and that one
    // is thin by construction, so it writes nothing.
    if (key && !params.fresh) {
      const stored = deps.cache.get(key) as SnapshotResult | undefined;
      if (stored) {
        // Re-checked, not trusted. `blockedHosts` and `allowPrivateHosts` are config the user can
        // change between two calls; the stored page cannot have changed with them, so it is measured
        // against them again rather than served on the strength of an older decision.
        assertDestinationAllowed(stored.url);
        return outcomeFrom(stored, params, {
          // The requested url, not the stored one: this field exists to stand in when a snapshot
          // reports no destination, and the url we asked for is the one piece of location that the
          // cache guarantees is present.
          fallbackUrl: params.url,
          polled: false,
          settledInMs: 0,
          stalledAtDeadline: false,
          fromCache: true,
        });
      }

      // `run`, not a second get/set pair, so two concurrent identical reads share one navigation: pi
      // issues parallel tool calls, and on this gateway a duplicated `/tabs/open` whose response is
      // lost leaks a tab until session shutdown. Sharers ride the first caller's signal, which is what
      // sharing one navigation means.
      //
      // What the navigation cost is carried out through this closure rather than the return value,
      // because a cache cannot return two shapes. It is per call, so the caller who produced the page
      // reports its settle and a caller who merely rode along reports none — correct for cost, which
      // is the thing a sharer did not spend.
      //
      // The part a sharer loses is not cost but page state: `stalledAtDeadline` and `thinAfterWait`
      // are both keyed off whether *this* call polled, so two callers riding one navigation can
      // receive the same incomplete page and be told different things about it. Not stored, and not
      // reachable a second time: a thin page fails `storable`, so only concurrent sharers see it.
      // Carrying page state through the shared value, separate from per-call cost, is the fix if this
      // ever stops being acceptable.
      let meta: FetchMeta = { polled: false, settledInMs: 0, stalledAtDeadline: false };
      let fallbackUrl = params.url;
      // The cache is heterogeneous by design, so both directions cast — the same convention
      // `resolve.ts` uses on it.
      const snapshot = (await deps.cache.run(
        key,
        async () => {
          const page = await navigate(params);
          meta = page.meta;
          fallbackUrl = page.fallbackUrl;
          return page.snapshot;
        },
        config.cache.pageMs,
        { shouldStore: (value) => storable(value as SnapshotResult) },
      )) as SnapshotResult;
      return outcomeFrom(snapshot, params, { fallbackUrl, ...meta, fromCache: false });
    }

    const page = await navigate(params);
    if (key && storable(page.snapshot)) {
      deps.cache.set(key, page.snapshot, config.cache.pageMs);
    }

    return outcomeFrom(page.snapshot, params, {
      fallbackUrl: page.fallbackUrl,
      ...page.meta,
      ...(page.extracted ? { extracted: page.extracted } : {}),
      fromCache: false,
    });
  }

  return { name: "camoufox_read", read: run };
}
