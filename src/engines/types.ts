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
  /**
   * What this engine spent re-looking at a page that had not arrived, reported as it is spent.
   *
   * A callback rather than a field on `EngineOutcome`, because an engine that waited and then found no
   * results leaves by throwing — and the time is still gone. The chain adds these up: a hop is paid on
   * top of the wait that preceded it, so a search that reported only the answering engine's wait would
   * print a number shorter than the one the model experienced.
   */
  onSettled?: (ms: number) => void;
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
  /**
   * Set when this page took a re-look before it had a result in it.
   *
   * The stop rule is the first organic result, so a page that had to be waited for was, at the moment we
   * stopped, only partly known. That is fine to hand back and not fine to keep — hence a fact about the
   * page rather than a duration, which the caller cannot read as either.
   */
  polled?: true;
}

export interface Engine {
  readonly name: EngineName;
  search(query: string, context: EngineContext): Promise<EngineOutcome>;
}
