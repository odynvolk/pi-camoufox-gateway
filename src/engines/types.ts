/**
 * Engine seam. An engine turns a query into results; everything above it (caching, the fallback
 * chain, tool rendering) stays engine-agnostic.
 */

import type { GatewayClient } from "../gateway.ts";
import type { SearchResult } from "../snapshot.ts";
import type { EngineName } from "../config.ts";

export interface EngineContext {
  client: GatewayClient;
  /** Gateway session namespace, derived from the pi session. */
  userId: string;
  signal?: AbortSignal;
  /** What this engine is about to do, for the tool UI. Optional because most callers have no UI. */
  onProgress?: (note: string) => void;
}

export interface EngineOutcome {
  /**
   * Adapters return results only. Which engine is credited is decided by the chain from `Engine.name`,
   * because that is the same value the tool's `engine?` filter matched on — a literal in the payload
   * could disagree with it and type-check.
   *
   * An adapter returns the *whole page* it read, unsliced. `n` and `search.maxResults` are what one
   * caller wants of a page several callers share — the cache holds this value, keyed without `n` — so
   * slicing here would make the cached page a function of the first call that filled it, and would put
   * a second, per-engine width next to the tool's one and let the two disagree in silence.
   */
  results: SearchResult[];
}

export interface Engine {
  readonly name: EngineName;
  search(query: string, context: EngineContext): Promise<EngineOutcome>;
}
