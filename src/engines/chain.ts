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
 */
const TERMINAL_CODES: GatewayErrorCode[] = [
  "gateway_unreachable",
  "gateway_unauthorized",
  "timeout",
  "host_blocked",
  "private_network",
];

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

  for (const engine of engines) {
    // Before the attempt, not after it: an engine costs a tab, a navigation, and a snapshot, and the
    // second one only runs because the first failed. Saying which is running is the whole point.
    context.onProgress?.(`searching "${query}" with ${engine.name}`);
    try {
      const outcome = await engine.search(query, context);
      if (outcome.results.length === 0) {
        // A guard on the `Engine` type, not a state either adapter reaches: `classifySerp` answers a
        // clean page with nothing organic as an error verdict, which both adapters throw rather than
        // return. A hand-made engine is the only way in, and `tests/engines.test.mjs` drives it.
        tried.push({ engine: engine.name, code: "empty_results", message: "no results" });
        firstError ??= new GatewayError("empty_results", `no engine returned results for "${query}"`);
        continue;
      }
      tried.push({ engine: engine.name, code: "ok", message: "served" });
      return { engine: engine.name, results: outcome.results, tried };
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

  throw withTried(firstError ?? new GatewayError("empty_results", "no engine returned results"), tried);
}

function withTried(error: GatewayError, tried: TriedStep[]): GatewayError {
  if (error.details?.tried) return error;
  return new GatewayError(error.code, error.message, { details: { ...(error.details ?? {}), tried }, retryable: error.retryable });
}
