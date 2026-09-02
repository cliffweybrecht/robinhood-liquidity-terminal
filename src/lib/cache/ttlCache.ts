export interface TtlCacheEntry<T> {
  readonly value: T;
  /** Epoch ms when `produce()` resolved to this value. */
  readonly generatedAt: number;
}

export interface CreateTtlCacheOptions<T> {
  /** How long a produced value stays fresh, in milliseconds. */
  readonly ttlMs: number;
  readonly produce: () => Promise<T>;
}

export interface TtlCache<T> {
  /**
   * Returns the current entry. Fresh (age <= ttlMs): returns
   * immediately, no call to `produce()`. Stale or missing: calls
   * `produce()` and awaits the result. Concurrent callers that arrive
   * while a refresh is already in flight join that same in-flight
   * promise rather than starting a second one (single-flight) — if 20
   * callers all see a stale/missing cache at once, `produce()` still
   * runs exactly once. A failed refresh clears the in-flight marker
   * (so the next call retries) without touching any previously-cached
   * value.
   */
  get(): Promise<TtlCacheEntry<T>>;
  /**
   * Discards the currently-cached entry (if any), without affecting an
   * in-flight `produce()` call. The NEXT `get()` will treat the cache as
   * missing and call `produce()` again. For a caller that already holds
   * the just-produced value (e.g. from the `Promise` `get()` returned)
   * and has determined AFTER THE FACT that this particular value must
   * not be allowed to survive for the rest of `ttlMs`, calling
   * `invalidate()` immediately — with no `await` in between — is the
   * supported way to prevent any other caller from ever observing that
   * value as cached: only synchronous code runs in between, so no other
   * caller can start a new `get()` and observe the not-yet-invalidated
   * entry before this call clears it.
   */
  invalidate(): void;
}

export function createTtlCache<T>(options: CreateTtlCacheOptions<T>): TtlCache<T> {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error(`TtlCache ttlMs must be a positive finite number, got ${options.ttlMs}`);
  }

  let entry: TtlCacheEntry<T> | null = null;
  let inFlight: Promise<TtlCacheEntry<T>> | null = null;

  function isFresh(e: TtlCacheEntry<T>): boolean {
    return Date.now() - e.generatedAt <= options.ttlMs;
  }

  function get(): Promise<TtlCacheEntry<T>> {
    if (entry && isFresh(entry)) {
      return Promise.resolve(entry);
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = options.produce().then(
      (value) => {
        const next: TtlCacheEntry<T> = { value, generatedAt: Date.now() };
        entry = next;
        inFlight = null;
        return next;
      },
      (err: unknown) => {
        inFlight = null;
        throw err;
      },
    );
    return inFlight;
  }

  function invalidate(): void {
    entry = null;
  }

  return { get, invalidate };
}
