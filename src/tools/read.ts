/**
 * The read side: navigate, let the page finish rendering, report where we actually ended up, and
 * hand back a bounded slice of the page. The bound is the point — the gateway happily returns ~20K
 * tokens of accessibility tree for a single page, and the model asked for a page, not an eviction.
 *
 * The settle loop exists because `openTab` returning does not mean the page is there: a client
 * rendered site answers with its skeleton, and the old code snapshotted that and called it the page.
 */

import type { CamoufoxConfig } from "../config.ts";
import { GatewayError } from "../errors.ts";
import type { GatewayClient, SnapshotResult } from "../gateway.ts";
import { assertTabUrlAllowed, urlPolicyFromConfig } from "../net-policy.ts";
import { detectWall, extractText, type ExtractedText } from "../snapshot.ts";

export interface ReadToolDeps {
  client: GatewayClient;
  config: CamoufoxConfig;
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
}

/**
 * How many identical snapshots in a row count as "the page is finished".
 *
 * Exported so the cost of the settle loop is pinned by a test instead of re-hardcoded in it.
 */
export const STABLE_ROUNDS = 2;

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

  /**
   * How much of the page exists, as opposed to how much of it this call returned.
   *
   * `text` is the slice from `params.offset` onward, so judging thinness on it would call the last
   * screen of a 45 000-char article "not yet rendered" and poll it twice before saying so.
   */
  function pageChars(snapshot: SnapshotResult): number {
    return typeof snapshot.totalChars === "number" && snapshot.totalChars > 0 ? snapshot.totalChars : (snapshot.text ?? "").length;
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
      await delay(read.settlePollMs, signal);
      const next = await client.snapshot({ userId, tabId, offset, signal });
      unchanged = next.text.length === latest.text.length ? unchanged + 1 : 0;
      latest = next;
      polled = true;
      if (unchanged >= STABLE_ROUNDS || !worthPollingAgain(next)) {
        stalledAtDeadline = false;
        break;
      }
    }
    return { snapshot: latest, settledInMs: Date.now() - startedAt, polled, stalledAtDeadline };
  }

  async function run(params: ReadParams): Promise<ReadOutcome> {
    assertAllowed(params.url ?? "");

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

      const budget = params.maxChars ?? read.defaultMaxChars;
      const sliced: ExtractedText = extractText(snapshot, { maxChars: budget, offset: params.offset });
      const thin = pageChars(snapshot) < read.settleMinChars;

      return {
        url: snapshot.url || tab.url,
        text: sliced.text,
        truncated: sliced.truncated,
        hasMore: sliced.hasMore,
        totalChars: sliced.totalChars,
        nextOffset: sliced.nextOffset,
        ...(extracted ? { extracted } : {}),
        refsCount: snapshot.refsCount,
        ...(polled ? { settledInMs } : {}),
        ...(polled && stalledAtDeadline ? { stalledAtDeadline: true } : {}),
        ...(thin && (polled || params.waitFor) ? { thinAfterWait: true } : {}),
        ...(params.waitFor ? { waitForRequested: true } : {}),
        ...(waitNote ? { waitNote } : {}),
      };
    } finally {
      await client.closeTabQuietly({ userId, tabId: tab.tabId });
    }
  }

  return { name: "camoufox_read", read: run };
}
