/**
 * What a SERP has to be before an engine may stop looking at it.
 *
 * One place, because both engines decide the same question and a second copy of it would be a second
 * answer: two engines that disagree about when a page is finished are two engines that report the same
 * slow render differently.
 */

import type { EngineName } from "../config.ts";
import type { GatewayClient } from "../gateway.ts";
import { classifySerp, detectWall, type SerpVerdict, type SnapshotLike } from "../snapshot.ts";
import { snapshotSettled } from "../settle.ts";
import type { EngineContext } from "./types.ts";

/**
 * How long one engine may wait for its results page to arrive.
 *
 * Small, absolute, and deliberately not a config key: search runs a chain, and this is paid once per
 * engine *before* the hop — a knob here would be a way to put a document's patience (`read`'s budget is
 * several times this) on the critical path of every search.
 */
export const SEARCH_SETTLE_MS = 600;

/** Gap between re-looks. Same reasoning: this bounds how many times the budget can be spent. */
export const SEARCH_SETTLE_POLL_MS = 150;

/**
 * Whether another look at this SERP could still change the answer.
 *
 * Read's predicate counts characters, because a document offers nothing better. An engine has a semantic
 * signal already computed — `classifySerp` has decided whether any organic result is there — so a
 * character threshold here would only add a number that disagrees with the classifier below it.
 *
 * Two branches matter:
 *
 * - A wall ends the wait. A consent page or a browser refusal is a page that has *decided*, and the
 *   chain's answer to that is the next engine, not a longer pause. `empty_page` is the exception: it is
 *   what a blank snapshot is called, and a blank snapshot is the most obviously-still-rendering page
 *   there is.
 * - Everything else that is not results keeps looking, including the case nothing can distinguish from
 *   here. That is paid for knowingly rather than assumed away, and it is measured: the B.6 page
 *   (`tests/fixtures/serp-duckduckgo-html.txt`, 26 link blocks whose every `/url` is protocol-relative)
 *   is a real recorded page this parser cannot read, so this predicate does re-look at it — and stops
 *   after `STABLE_ROUNDS` identical looks, because a page that has stopped changing is something the
 *   loop can actually see. Measured cost of that page: 3 snapshots, 2 sleeps of `SEARCH_SETTLE_POLL_MS`.
 *
 * The narrower predicate — look again only while the page has no link blocks — would skip that cost by
 * never re-looking at a page whose chrome had already rendered. Measured against the recorded pages it
 * skips the case this is for: the chrome-only prefix of `serp-google.txt` is 5 link blocks with no
 * results, and so is the *finished* `serp-no-results.txt`. Stopping at "there are links" stops on both,
 * which is the wrong statement this whole path exists to avoid.
 */
export function serpWorthAnotherLook(snapshot: SnapshotLike, engine: EngineName): boolean {
  const verdict = classifySerp(snapshot, engine);
  if (verdict.kind === "results") return false;
  return verdict.code === "empty_page" || detectWall(snapshot) === null;
}

/**
 * What may be said about a page that was still arriving when the budget ran out.
 *
 * `classifySerp`'s error messages are claims about what the engine had. A frame taken while the page was
 * still growing is not evidence for one: the loop only reaches its deadline while another look is still
 * wanted, and a page that had answered stable and empty already stopped it. The *code* has to stay
 * whatever the last frame looked like, because `chain.ts` hops on `empty_results` and stops on `timeout`
 * — so the correction goes in the message, which is the line the model reads first and the one
 * `structuredTried` hands a script.
 */
function undecidedVerdict(verdict: SerpVerdict, engine: EngineName): SerpVerdict {
  if (verdict.kind === "results") return verdict;
  return {
    ...verdict,
    message: `${engine}'s results page was still rendering when the ${SEARCH_SETTLE_MS}ms wait ran out, so it is not known whether it had results`,
    // `read` reports the same fact under this name, and it is the one the advice depends on: a page that
    // stopped changing on its own will not change because the budget was bigger.
    details: { ...verdict.details, stalledAtDeadline: true },
  };
}

/**
 * The engine's one snapshot-or-more, the verdict on the last of them, and whether a re-look was needed.
 *
 * Takes the whole context rather than its parts because an engine has nothing else to decide: the
 * judgement above, the budget above, and the shared re-look machine are the same for both.
 */
export async function settledSerpVerdict(
  context: EngineContext,
  tabId: string,
  engine: EngineName,
): Promise<SerpVerdict & { polled: boolean }> {
  const client: GatewayClient = context.client;
  const { snapshot, polled, settledInMs, stalledAtDeadline } = await snapshotSettled(client, context.userId, tabId, {
    budgetMs: SEARCH_SETTLE_MS,
    pollMs: SEARCH_SETTLE_POLL_MS,
    worthLookingAgain: (looked) => serpWorthAnotherLook(looked, engine),
    signal: context.signal,
    cancelledMessage: "the search was cancelled while waiting for the results page to render",
  });
  // Reported before the verdict is decided, because an engine that waited and then found nothing leaves
  // by throwing — and the time is still gone.
  if (polled) context.onSettled?.(settledInMs);
  const verdict = classifySerp(snapshot, engine);
  return { ...(stalledAtDeadline ? undecidedVerdict(verdict, engine) : verdict), polled };
}
