/**
 * In-process TTL cache with single-flight, for tool results only.
 *
 * Two rules that matter: concurrent identical calls share one upstream attempt (pi can issue
 * parallel tool calls, and a cold cache would otherwise multiply the gateway's work), and only
 * successes are stored — caching a consent wall would make a transient problem look permanent.
 */

export interface CacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface Cache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T, ttlMs?: number): void;
  /** One in-flight producer per key. Failures are never stored. */
  run(key: string, produce: () => Promise<T>, ttlMs?: number): Promise<T>;
  get size(): number;
  clear(): void;
}

export function createCache<T = unknown>(options: CacheOptions = {}): Cache<T> {
  const defaultTtl = options.ttlMs ?? 5 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 128;
  const entries = new Map<string, Entry<T>>();
  const inflight = new Map<string, Promise<T>>();

  function prune(now: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size > maxEntries) {
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
      entries.set(key, { value, expiresAt: Date.now() + (ttlMs ?? defaultTtl) });
      prune(Date.now());
    },

    async run(key: string, produce: () => Promise<T>, ttlMs?: number): Promise<T> {
      const hit = this.get(key);
      if (hit !== undefined) return hit;

      const existing = inflight.get(key);
      if (existing) return await existing;

      const work = produce().then(
        (value) => {
          inflight.delete(key);
          this.set(key, value, ttlMs);
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
      entries.clear();
      inflight.clear();
    },
  };
}
