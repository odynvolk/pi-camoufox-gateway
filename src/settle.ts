/**
 * Re-snapshotting a page that has not finished arriving.
 *
 * "The tab opened" and "the page rendered" are different events on a client-rendered site, and only the
 * second one is worth handing back. Two callers need that: `tools/read.ts`, and both search engines.
 *
 * What differs between them is the *judgement*, and it is injected rather than shared on purpose. Read
 * counts characters, because for a document there is no better signal; an engine has a semantic one —
 * whether its own parser can find an organic result yet. Porting read's char threshold into search would
 * put a magic number next to a classifier that already disagrees with it.
 *
 * What is shared is the machine: a deadline, a sleep that never outlasts it, and a stop after N identical
 * looks. Written twice, the second copy is the one that drifts — a search loop with no stability stop, for
 * instance, is a search that polls a finished page until its budget runs out.
 */

import { GatewayError } from "./errors.ts";
import type { GatewayClient, SnapshotResult } from "./gateway.ts";

/**
 * How many identical snapshots in a row count as "the page is finished".
 *
 * Exported so the cost of the loop is pinned by a test instead of re-hardcoded in it.
 */
export const STABLE_ROUNDS = 2;

/** Two consecutive snapshots are the same page, not merely two strings of the same length. */
function samePage(left: SnapshotResult, right: SnapshotResult): boolean {
  // `totalChars` and `refsCount` are cheap and catch the two shapes text alone cannot see: a slice the
  // gateway capped, where the returned text stops growing while the page keeps going, and a skeleton
  // that swaps content at a constant width.
  return left.text === right.text && left.totalChars === right.totalChars && left.refsCount === right.refsCount;
}

function delay(ms: number, signal: AbortSignal | undefined, cancelledMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GatewayError("aborted", cancelledMessage));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new GatewayError("aborted", cancelledMessage));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface SettleOptions {
  /** Total extra time this may spend re-looking. `0` means one look and no waiting. */
  budgetMs: number;
  /** Gap between looks, clamped to what is left of `budgetMs` so it can never outlast it. */
  pollMs: number;
  /**
   * Whether another look could still change the answer. Called on every snapshot, the first included,
   * and it is what each caller decides for itself.
   */
  worthLookingAgain(snapshot: SnapshotResult): boolean;
  /** Just before each poll, with the snapshot that prompted it — for a caller with a UI to feed. */
  onPoll?: (snapshot: SnapshotResult) => void;
  /** The window to keep asking for, so a continuation read never re-looks at a different page. */
  offset?: number;
  signal?: AbortSignal;
  /** What a cancel during a wait is called, in the words this caller's caller reads. */
  cancelledMessage: string;
}

export interface SettledSnapshot {
  snapshot: SnapshotResult;
  settledInMs: number;
  /** False when the first look was enough, which is also when `settledInMs` means nothing. */
  polled: boolean;
  /** The budget ran out while another look was still wanted, so a bigger one could have helped. */
  stalledAtDeadline: boolean;
}

export async function snapshotSettled(
  client: GatewayClient,
  userId: string,
  tabId: string,
  options: SettleOptions,
): Promise<SettledSnapshot> {
  const first = await client.snapshot({ userId, tabId, offset: options.offset, signal: options.signal });
  if (!options.worthLookingAgain(first)) return { snapshot: first, settledInMs: 0, polled: false, stalledAtDeadline: false };

  const startedAt = Date.now();
  const deadline = startedAt + options.budgetMs;
  let latest = first;
  let unchanged = 0;
  let polled = false;
  // Whether the budget ran out while the page was still worth re-looking at. That is the only case where
  // "raise the budget" is honest advice: a page that stopped changing on its own will not change because
  // we asked again.
  let stalledAtDeadline = true;
  // One repeat is a slow script, two is a finished page: that is the stop signal available without
  // knowing the app's selectors. The deadline bounds how long it can take, and each poll is its own
  // gateway request, so the worst case is the deadline plus one request.
  while (Date.now() < deadline) {
    // The wait this note exists for: without it the call looks hung exactly where it is knowingly slow.
    options.onPoll?.(latest);
    // Never sleep past the budget. Sleep the interval instead and a poll configured near the deadline
    // sleeps through it and still issues its request, which is a longer call and a slower refusal than
    // the comment above promises. Config validation keeps the configured pair sane, so the clamp is
    // here for a budget assembled some other way.
    await delay(Math.max(0, Math.min(options.pollMs, deadline - Date.now())), options.signal, options.cancelledMessage);
    const next = await client.snapshot({ userId, tabId, offset: options.offset, signal: options.signal });
    unchanged = samePage(next, latest) ? unchanged + 1 : 0;
    latest = next;
    polled = true;
    if (unchanged >= STABLE_ROUNDS || !options.worthLookingAgain(next)) {
      stalledAtDeadline = false;
      break;
    }
  }
  return { snapshot: latest, settledInMs: Date.now() - startedAt, polled, stalledAtDeadline };
}
