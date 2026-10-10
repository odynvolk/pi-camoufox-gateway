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
  maxResults: number;
}

export interface EngineOutcome {
  /**
   * Adapters return results only. Which engine is credited is decided by the chain from `Engine.name`,
   * because that is the same value the tool's `engine?` filter matched on — a literal in the payload
   * could disagree with it and type-check.
   */
  results: SearchResult[];
}

export interface Engine {
  readonly name: EngineName;
  search(query: string, context: EngineContext): Promise<EngineOutcome>;
}
