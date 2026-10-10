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
  /** The engine that produced this outcome. A fallback shows up in `chain.ts`'s `tried`, not here. */
  engine: EngineName;
  results: SearchResult[];
}

export interface Engine {
  readonly name: EngineName;
  search(query: string, context: EngineContext): Promise<EngineOutcome>;
}
