import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTtlCache } from "../ttlCache";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A deferred promise, so a test can control exactly when `produce()` resolves. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createTtlCache", () => {
  it("triggers a refresh when no cached value exists yet", async () => {
    const produce = vi.fn().mockResolvedValue("v1");
    const cache = createTtlCache({ ttlMs: 1000, produce });

    const entry = await cache.get();

    expect(entry.value).toBe("v1");
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("returns the cached value without refreshing while fresh", async () => {
    const produce = vi.fn().mockResolvedValue("v1");
    const cache = createTtlCache({ ttlMs: 1000, produce });

    await cache.get();
    await vi.advanceTimersByTimeAsync(500);
    const second = await cache.get();

    expect(second.value).toBe("v1");
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("refreshes once the cached value is stale, and the new value replaces the old", async () => {
    const produce = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");
    const cache = createTtlCache({ ttlMs: 1000, produce });

    await cache.get();
    await vi.advanceTimersByTimeAsync(1001);
    const second = await cache.get();

    expect(second.value).toBe("v2");
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("treats age exactly equal to ttlMs as still fresh (boundary)", async () => {
    const produce = vi.fn().mockResolvedValue("v1");
    const cache = createTtlCache({ ttlMs: 1000, produce });

    await cache.get();
    await vi.advanceTimersByTimeAsync(1000);
    await cache.get();

    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("refreshes once age exceeds ttlMs by even 1ms", async () => {
    const produce = vi.fn().mockResolvedValue("v1");
    const cache = createTtlCache({ ttlMs: 1000, produce });

    await cache.get();
    await vi.advanceTimersByTimeAsync(1001);
    await cache.get();

    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("runs produce() exactly once for many simultaneous callers on a missing/stale cache (single-flight)", async () => {
    const { promise, resolve } = deferred<string>();
    const produce = vi.fn().mockReturnValue(promise);
    const cache = createTtlCache({ ttlMs: 1000, produce });

    const callers = Array.from({ length: 20 }, () => cache.get());

    resolve("shared-value");
    const results = await Promise.all(callers);

    expect(produce).toHaveBeenCalledTimes(1);
    for (const entry of results) {
      expect(entry.value).toBe("shared-value");
    }
    // All callers should have joined the exact same in-flight refresh.
    expect(new Set(results.map((e) => e.generatedAt)).size).toBe(1);
  });

  it("propagates a failed refresh to callers without caching a value", async () => {
    const produce = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const cache = createTtlCache({ ttlMs: 1000, produce });

    await expect(cache.get()).rejects.toThrow("boom");
  });

  it("retries on the next call after a failed refresh (does not get stuck)", async () => {
    const produce = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("v1");
    const cache = createTtlCache({ ttlMs: 1000, produce });

    await expect(cache.get()).rejects.toThrow("boom");
    const entry = await cache.get();

    expect(entry.value).toBe("v1");
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to a previously-cached value after a later refresh fails — the failure propagates", async () => {
    const produce = vi
      .fn()
      .mockResolvedValueOnce("v1")
      .mockRejectedValueOnce(new Error("boom"));
    const cache = createTtlCache({ ttlMs: 1000, produce });

    await cache.get();
    await vi.advanceTimersByTimeAsync(1001);

    await expect(cache.get()).rejects.toThrow("boom");
  });

  it("records generatedAt as the time produce() actually resolved", async () => {
    const produce = vi.fn().mockResolvedValue("v1");
    const cache = createTtlCache({ ttlMs: 1000, produce });

    await vi.advanceTimersByTimeAsync(5000);
    const entry = await cache.get();

    expect(entry.generatedAt).toBe(Date.now());
  });

  it("throws explicitly for a non-positive ttlMs", () => {
    expect(() => createTtlCache({ ttlMs: 0, produce: async () => "x" })).toThrow();
    expect(() => createTtlCache({ ttlMs: -1, produce: async () => "x" })).toThrow();
  });

  describe("invalidate", () => {
    it("forces the next get() to re-produce even though the cached value is still within ttlMs", async () => {
      const produce = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");
      const cache = createTtlCache({ ttlMs: 1000, produce });

      await cache.get();
      cache.invalidate();
      await vi.advanceTimersByTimeAsync(1);
      const second = await cache.get();

      expect(second.value).toBe("v2");
      expect(produce).toHaveBeenCalledTimes(2);
    });

    it("is a no-op when nothing has ever been cached", async () => {
      const produce = vi.fn().mockResolvedValue("v1");
      const cache = createTtlCache({ ttlMs: 1000, produce });

      expect(() => cache.invalidate()).not.toThrow();
      await cache.get();
      expect(produce).toHaveBeenCalledTimes(1);
    });
  });
});
