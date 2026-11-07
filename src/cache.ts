/**
 * In-process TTL cache with single-flight, for tool results only.
 *
 * Three rules that matter: concurrent identical calls share one upstream attempt (pi can issue
 * parallel tool calls, and a cold cache would otherwise multiply the gateway's work), only successes
 * are stored — caching a consent wall would make a transient problem look permanent — and a caller may
 * bound a read by age. Age is a bound, not an eviction: an expired entry is deleted, an over-tolerance
 * one is skipped and left in place, because one caller's tight ask may not take away a page a looser one
 * can still use (`docs/adr/0002-staleness-is-a-read-bound-not-an-eviction.md`).
 */

interface Entry<T> {
  value: T;
  /** When this value was fetched, which is the only thing that can answer "how old is it?". */
  storedAt: number;
  expiresAt: number;
}

export interface RunOptions<T> {
  /**
   * Whether a produced value is worth keeping. "The call succeeded" and "this answer is stable" are
   * different questions: a page that has not finished rendering is worth returning to the caller and
   * not worth serving for the rest of the TTL. Defaults to storing every success, which is what the
   * rule about successes means by "only successes are stored".
   */
  shouldStore?: (value: T) => boolean;
}

export interface ReadBound {
  /** Serve an entry at most this old. Absent = today's behaviour: unexpired is enough. */
  maxAgeMs?: number;
}

export interface CachedEntry<T> {
  value: T;
  ageMs: number;
}

export interface Cache<T> {
  get(key: string, bound?: ReadBound): T | undefined;
  /** The only reader that reports how old what it returned is. Never deletes a within-TTL entry. */
  peek(key: string, bound?: ReadBound): CachedEntry<T> | undefined;
  set(key: string, value: T, ttlMs?: number): void;
  /** One in-flight producer per key. Failures are never stored. */
  run(key: string, produce: () => Promise<T>, ttlMs?: number, options?: RunOptions<T> & ReadBound): Promise<T>;
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
    get(key: string, bound?: ReadBound): T | undefined {
      return this.peek(key, bound)?.value;
    },

    peek(key: string, bound?: ReadBound): CachedEntry<T> | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      const now = Date.now();
      if (entry.expiresAt <= now) {
        entries.delete(key);
        return undefined;
      }
      // A clock that stepped backwards would otherwise hand back a negative age, which passes every
      // bound and gets reported as a fact about a page nobody can place.
      const ageMs = Math.max(0, now - entry.storedAt);
      // Skip, never evict: the entry outlives this caller's tolerance, so a looser read can still have it.
      if (bound?.maxAgeMs !== undefined && !(ageMs < bound.maxAgeMs)) return undefined;
      return { value: entry.value, ageMs };
    },

    set(key: string, value: T, ttlMs?: number): void {
      const now = Date.now();
      entries.set(key, { value, storedAt: now, expiresAt: now + (ttlMs ?? DEFAULT_TTL_MS) });
      prune(now);
    },

    async run(key: string, produce: () => Promise<T>, ttlMs?: number, options?: RunOptions<T> & ReadBound): Promise<T> {
      const hit = this.peek(key, options);
      if (hit !== undefined) return hit.value;

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
