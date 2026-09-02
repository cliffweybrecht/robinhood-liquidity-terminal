import { createTtlCache, type TtlCacheEntry } from "./ttlCache";

export interface CreateKeyedTtlCacheOptions<T> {
  /** How long a produced value stays fresh, in milliseconds — shared by every key. */
  readonly ttlMs: number;
  readonly produce: (key: string) => Promise<T>;
}

export interface KeyedTtlCache<T> {
  /**
   * Same semantics as `TtlCache.get()` (see `ttlCache.ts`), scoped to
   * `key`: fresh -> immediate; stale/missing -> calls `produce(key)` and
   * awaits it; concurrent callers for the SAME key single-flight onto
   * one in-flight `produce(key)` call. Different keys are completely
   * independent — one key's refresh/failure never affects another's
   * cached value or in-flight state.
   */
  get(key: string): Promise<TtlCacheEntry<T>>;
  /** Discards `key`'s cached entry (if any) — see `TtlCache.invalidate()` for exact semantics. A no-op for a key that has never been seen. Never affects any other key. */
  invalidate(key: string): void;
}

/**
 * A per-key `TtlCache` — one independent `TtlCache<T>` instance per
 * distinct `key` seen so far, lazily created on first access, sharing
 * ONE `ttlMs`/`produce` configuration. Deliberately layered ON TOP OF
 * the existing single-value `createTtlCache` (never a second,
 * independently-reasoned TTL/single-flight implementation) — this
 * module owns only the per-key `Map` bookkeeping.
 *
 * Callers that need a process-wide singleton across Next.js's separate
 * server/route bundling entry points must store the RETURNED
 * `KeyedTtlCache` instance on `globalThis` themselves, exactly as
 * `src/domain/market/cache.ts` already does for the single-value case
 * — see that module's own doc comment for the empirically-verified
 * reason a plain module-level `const` is not reliably a true singleton
 * under Next.js. This module does not do that itself, so it stays
 * usable/testable independent of any Next.js-specific concern.
 */
export function createKeyedTtlCache<T>(options: CreateKeyedTtlCacheOptions<T>): KeyedTtlCache<T> {
  const caches = new Map<string, ReturnType<typeof createTtlCache<T>>>();

  function get(key: string): Promise<TtlCacheEntry<T>> {
    let cache = caches.get(key);
    if (!cache) {
      cache = createTtlCache<T>({ ttlMs: options.ttlMs, produce: () => options.produce(key) });
      caches.set(key, cache);
    }
    return cache.get();
  }

  function invalidate(key: string): void {
    caches.get(key)?.invalidate();
  }

  return { get, invalidate };
}
