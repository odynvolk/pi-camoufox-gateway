/**
 * In-process TTL cache with single-flight, for tool results only.
 *
 * Two rules that matter: concurrent identical calls share one upstream attempt (pi can issue
 * parallel tool calls, and a cold cache would otherwise multiply the gateway's work), and only
 * successes are stored — caching a consent wall would make a transient problem look permanent.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface RunOptions<T> {
  /**
   * Whether a produced value is worth keeping. "The call succeeded" and "this answer is stable" are
   * different questions: a page that has not finished rendering is worth returning to the caller and
   * not worth serving for the rest of the TTL. Defaults to storing every success, which is what the
   * two-rule contract means by "only successes are stored".
   */
  shouldStore?: (value: T) => boolean;
}

export interface Cache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T, ttlMs?: number): void;
  /** One in-flight producer per key. Failures are never stored. */
  run(key: string, produce: () => Promise<T>, ttlMs?: number, options?: RunOptions<T>): Promise<T>;
  get size(): number;
  clear(): void;
}

/** Fallback for a `set` with no explicit ttl. Every real call site passes one. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Ceiling per session. Eviction is insertion order, not LRU: a re-read key keeps its slot. */
export const MAX_ENTRIES = 128;

export function createCache<T = unknown>(): Cache<T> {
  const entries = new Map<string, Entry<T>>();
  const inflight = new Map<string, Promise<T>>();
  /** Bumped by clear() so a producer that finishes afterwards cannot resurrect a dropped value. */
  let generation = 0;

  function prune(now: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },

    set(key: string, value: T, ttlMs?: number): void {
      entries.set(key, { value, expiresAt: Date.now() + (ttlMs ?? DEFAULT_TTL_MS) });
      prune(Date.now());
    },

    async run(key: string, produce: () => Promise<T>, ttlMs?: number, options?: RunOptions<T>): Promise<T> {
      const hit = this.get(key);
      if (hit !== undefined) return hit;

      const existing = inflight.get(key);
      if (existing) return await existing;

      const epoch = generation;
      const work = produce().then(
        (value) => {
          inflight.delete(key);
          // A clear() while this was in flight means "drop everything", so the result is returned to
          // the caller but not stored — a later call must be free to produce a fresh value.
          if (epoch === generation && (options?.shouldStore?.(value) ?? true)) this.set(key, value, ttlMs);
          return value;
        },
        (error) => {
          inflight.delete(key);
          throw error;
        },
      );
      inflight.set(key, work);
      return await work;
    },

    get size(): number {
      prune(Date.now());
      return entries.size;
    },

    clear(): void {
      generation += 1;
      entries.clear();
      inflight.clear();
    },
  };
}
