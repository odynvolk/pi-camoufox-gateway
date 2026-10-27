/**
 * Engine ordering and the fallback rule.
 *
 * The chain tries engines in config order, but only for outcomes where another engine could
 * realistically help. Transport failures are not an engine problem, so walking the chain after
 * `gateway_unreachable` just multiplies the same timeout.
 */

import type { EngineConfig, EngineName } from "../config.ts";
import { GatewayError, type GatewayErrorCode } from "../errors.ts";
import type { SearchResult } from "../snapshot.ts";
import { duckduckgoEngine } from "./duckduckgo.ts";
import { googleEngine } from "./google.ts";
import type { Engine, EngineContext } from "./types.ts";

const BY_NAME: Record<string, () => Engine> = {
  google: googleEngine,
  duckduckgo: duckduckgoEngine,
};

/**
 * Outcomes where trying a different engine is pointless. `host_blocked`/`private_network` are
 * defensive: the url policy raises them at tab-open time, and no engine navigates anywhere those
 * apply — but a policy refusal must not walk the chain either.
 *
 * `timeout` is not here, and is not an oversight. Every code on this list is one the next engine would
 * meet too — the gateway is down, it refused our credentials, the guard refused the address. A timeout
 * says only that *this* engine was still working when our deadline ran out, which is the exact situation
 * the chain exists to survive: a gateway that is up and slow on google should cost us a hop, not a
 * search. A gateway that is actually down is still caught here, by `gateway_unreachable` — the distinction
 * is between a service that is slow and a service that is not there, and it is one the transport already
 * makes for us.
 */
const TERMINAL_CODES: GatewayErrorCode[] = [
  "gateway_unreachable",
  "gateway_unauthorized",
  "host_blocked",
  "private_network",
];

/**
 * How many gateway request deadlines the whole chain may spend, however many engines it walks.
 *
 * Taking `timeout` out of `TERMINAL_CODES` was the fix, and it moved a cost rather than removing one: that
 * list used to own "when does the search stop" implicitly, and the deadline now lives only per request
 * (`gateway.ts`'s `timeoutMs`), so nothing owned the total. Measured against the shipped 30s default, a
 * gateway that is up and answering nothing can spend one deadline per *request* — an open that lands a
 * millisecond inside its deadline and a snapshot that never answers is two per engine, and
 * `tests/engines.test.mjs` drives that shape. Four deadlines is ~120s before the model is told anything,
 * on top of the 2s `preflight` probe, where the terminal list used to stop the walk at the first one.
 *
 * Two of them keeps the promise the removal made and closes that hole: the first engine always gets a full
 * request deadline, the engine that hops still gets one, and two slow engines cost two deadlines rather
 * than four. Not a config key, for `SEARCH_SETTLE_MS`'s reason — it is a property of the chain, not a
 * caller's patience, and a knob here is a way to put a document's timeout on the critical path of every
 * search.
 */
export const SEARCH_CHAIN_BUDGET_IN_DEADLINES = 2;

/**
 * Why the chain stopped when its own clock ran out.
 *
 * `timeout` rather than a code of our own invention, for two reasons that are both load-bearing. It is the
 * truth: a deadline expired, which is the species of event `timeout` names, where `aborted` is a decision
 * somebody made and nobody decided anything here. And it is the code `gateway.ts` treats as an ambiguous
 * tab open, so the stray-tab sweep still runs on the request this aborts — a new code would have silently
 * reopened that leak.
 */
function chainBudgetError(budgetMs: number): GatewayError {
  return new GatewayError(
    "timeout",
    `the search spent its whole ${budgetMs}ms chain budget before any engine answered; the engines it asked are in tried`,
    { details: { chainBudgetMs: budgetMs } },
  );
}

export interface TriedStep {
  engine: string;
  /** "ok" when that engine served the answer, otherwise the code it failed with. */
  code: GatewayErrorCode | "ok";
  message: string;
}

export interface ChainOutcome {
  /** Credited by the chain, from `Engine.name` — never from the adapter's payload. */
  engine: EngineName;
  results: SearchResult[];
  tried: TriedStep[];
  /**
   * What the engines spent re-looking at pages that had not arrived, added up across every attempt.
   *
   * Absent when nothing waited. Only ever carried out on a success: a refusal has no place to print a
   * duration, and its per-engine record in `tried` already says where the attempt went.
   */
  settledInMs?: number;
  /**
   * Set when the engine that *answered* had re-looked at its own page — not the chain's total, and the
   * two are not interchangeable.
   *
   * A google that spent its budget and then failed says nothing about whether the duckduckgo page that
   * answered afterwards had finished rendering, and that page is what a caller would be keeping.
   */
  pagePolled?: true;
}

export function enginesFromConfig(engines: EngineConfig[]): Engine[] {
  return engines
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const factory = BY_NAME[entry.name];
      if (!factory) {
        throw new GatewayError("unsupported", `no adapter for engine "${entry.name}" (known: ${Object.keys(BY_NAME).join(", ")})`);
      }
      return factory();
    });
}

export async function searchWithFallback(
  query: string,
  engines: Engine[],
  context: EngineContext,
): Promise<ChainOutcome> {
  if (engines.length === 0) {
    throw new GatewayError("unsupported", "no search engines are enabled in the camoufox config");
  }

  const tried: TriedStep[] = [];
  let firstError: GatewayError | undefined;
  // Summed across attempts, including the ones that ended in a throw: a hop is paid on top of the wait
  // that preceded it, so an answer that named only the serving engine would print less time than the
  // model waited for it.
  let settledInMs = 0;

  const budgetMs = SEARCH_CHAIN_BUDGET_IN_DEADLINES * context.client.requestDeadlineMs;
  const startedAt = Date.now();
  // One deadline for the walk, derived from the caller's rather than replacing it: every engine is handed
  // *this* signal, so a second engine cannot start a fresh full deadline after the first burned one, while
  // a cancel still reaches both. The abort carries its own error as its reason — as `resolve.ts` already
  // does for its own deadline — because `gateway.ts`'s `abortError` and the settle sleep both surface a
  // `GatewayError` reason verbatim, which is what stops our budget being reported as a search somebody
  // cancelled.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(context.signal?.reason);
  // A signal that is already aborted will never fire its own event, so the walk would otherwise run a whole
  // search for a caller who has already left — the same reason `gateway.ts`'s `perform` checks before it
  // listens.
  if (context.signal?.aborted) onCallerAbort();
  else context.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const budgetTimer = setTimeout(() => controller.abort(chainBudgetError(budgetMs)), budgetMs);
  let budgetSpent = false;

  try {
    for (const engine of engines) {
      // The bound on the chain, enforced before the attempt rather than inside it: an engine costs a tab, a
      // navigation and a snapshot, and none of that is worth starting with nothing left to wait for. The
      // first engine always sees the whole budget, so this never shortens the attempt the hop depends on.
      if (budgetMs - (Date.now() - startedAt) <= 0) {
        // No step is recorded for an engine nobody asked. `tried` reports what ran, and a step for an engine
        // that never started would print a code nothing produced.
        budgetSpent = true;
        break;
      }
      // Before the attempt, not after it: an engine costs a tab, a navigation, and a snapshot, and the
      // second one only runs because the first failed. Saying which is running is the whole point.
      context.onProgress?.(`searching "${query}" with ${engine.name}`);
      try {
        const outcome = await engine.search(query, {
          ...context,
          signal: controller.signal,
          onSettled: (ms) => {
            settledInMs += ms;
          },
        });
        if (outcome.results.length === 0) {
          // A guard on the `Engine` type, not a state either adapter reaches: `classifySerp` answers a
          // clean page with nothing organic as an error verdict, which both adapters throw rather than
          // return. A hand-made engine is the only way in, and `tests/engines.test.mjs` drives it.
          tried.push({ engine: engine.name, code: "empty_results", message: "no results" });
          firstError ??= new GatewayError("empty_results", `no engine returned results for "${query}"`);
          continue;
        }
        tried.push({ engine: engine.name, code: "ok", message: "served" });
        return {
          engine: engine.name,
          results: outcome.results,
          tried,
          ...(settledInMs > 0 ? { settledInMs } : {}),
          ...(outcome.polled ? { pagePolled: true } : {}),
        };
      } catch (error) {
        // A code here says nothing about where it came from: the transport codes its own failures, but
        // `classifySerp`, the address guard and the post-response checks code theirs too. What makes the
        // fallback label honest is the other case — the client leaves no bare throw behind, so an
        // unclassified error here is an adapter failing on its own.
        const gatewayError = error instanceof GatewayError ? error : new GatewayError("internal_error", String(error));
        tried.push({ engine: engine.name, code: gatewayError.code, message: gatewayError.message });
        firstError ??= gatewayError;

        if (TERMINAL_CODES.includes(gatewayError.code)) {
          throw withTried(gatewayError, tried);
        }
      }
    }

    // When the budget is what stopped the walk, it is the reason the search failed, and it is the line the
    // model is given: "the first engine timed out" would send a reader to a deadline that is not the one
    // that ended this. What each attempt said on its own is still in `tried`.
    throw withTried(
      budgetSpent ? chainBudgetError(budgetMs) : firstError ?? new GatewayError("empty_results", "no engine returned results"),
      tried,
    );
  } finally {
    clearTimeout(budgetTimer);
    context.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function withTried(error: GatewayError, tried: TriedStep[]): GatewayError {
  if (error.details?.tried) return error;
  return new GatewayError(error.code, error.message, { details: { ...(error.details ?? {}), tried }, retryable: error.retryable });
}
