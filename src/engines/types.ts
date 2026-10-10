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
  engine: EngineName | string;
  results: SearchResult[];
  /** The count the caller asked for, kept so the tool can explain a clamp. */
  requestedCount?: number;
  /** Which engine actually served this outcome (differs from `name` after a fallback). */
  servedBy?: string;
}

export interface Engine {
  readonly name: string;
  search(query: string, context: EngineContext): Promise<EngineOutcome>;
}
