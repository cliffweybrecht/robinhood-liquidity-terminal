import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyedTtlCache } from "../keyedTtlCache";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createKeyedTtlCache", () => {
  it("produces a value per key on first access", async () => {
    const produce = vi.fn(async (key: string) => `value-${key}`);
    const cache = createKeyedTtlCache({ ttlMs: 1000, produce });

    const a = await cache.get("A");
    const b = await cache.get("B");

    expect(a.value).toBe("value-A");
    expect(b.value).toBe("value-B");
    expect(produce).toHaveBeenCalledTimes(2);
    expect(produce).toHaveBeenCalledWith("A");
    expect(produce).toHaveBeenCalledWith("B");
  });

  it("returns the cached value for a key without re-producing while fresh", async () => {
    const produce = vi.fn(async (key: string) => `value-${key}`);
    const cache = createKeyedTtlCache({ ttlMs: 1000, produce });

    await cache.get("A");
    await vi.advanceTimersByTimeAsync(500);
    await cache.get("A");

    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("re-produces a key's value once its own TTL expires, independent of other keys", async () => {
    const produce = vi.fn(async (key: string) => `value-${key}-${produce.mock.calls.length}`);
    const cache = createKeyedTtlCache({ ttlMs: 1000, produce });

    await cache.get("A");
    await cache.get("B");
    await vi.advanceTimersByTimeAsync(1500);
    await cache.get("A");

    // B was never re-requested, so it must not have been re-produced —
    // one key's expiry never triggers another key's refresh.
    expect(produce).toHaveBeenCalledTimes(3);
    expect(produce).toHaveBeenNthCalledWith(1, "A");
    expect(produce).toHaveBeenNthCalledWith(2, "B");
    expect(produce).toHaveBeenNthCalledWith(3, "A");
  });

  it("single-flights concurrent requests for the SAME key", async () => {
    const d = deferred<string>();
    const produce = vi.fn(() => d.promise);
    const cache = createKeyedTtlCache({ ttlMs: 1000, produce });

    const p1 = cache.get("A");
    const p2 = cache.get("A");
    d.resolve("v1");
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(produce).toHaveBeenCalledTimes(1);
    expect(r1.value).toBe("v1");
    expect(r2.value).toBe("v1");
  });

  it("does not single-flight across DIFFERENT keys — each key gets its own in-flight produce call", async () => {
    const dA = deferred<string>();
    const dB = deferred<string>();
    const produce = vi.fn((key: string) => (key === "A" ? dA.promise : dB.promise));
    const cache = createKeyedTtlCache({ ttlMs: 1000, produce });

    const pA = cache.get("A");
    const pB = cache.get("B");
    dB.resolve("vB");
    dA.resolve("vA");
    const [a, b] = await Promise.all([pA, pB]);

    expect(produce).toHaveBeenCalledTimes(2);
    expect(a.value).toBe("vA");
    expect(b.value).toBe("vB");
  });

  it("a failed produce for one key does not affect another key's cached value", async () => {
    let callCount = 0;
    const produce = vi.fn(async (key: string) => {
      callCount++;
      if (key === "A" && callCount === 1) throw new Error("boom");
      return `value-${key}`;
    });
    const cache = createKeyedTtlCache({ ttlMs: 1000, produce });

    await expect(cache.get("A")).rejects.toThrow("boom");
    const b = await cache.get("B");
    expect(b.value).toBe("value-B");

    // A retries cleanly on next access (the failed attempt was not cached).
    const a = await cache.get("A");
    expect(a.value).toBe("value-A");
  });

  describe("invalidate", () => {
    it("forces the next get() for that key to re-produce, even though the TTL has not expired", async () => {
      const produce = vi.fn(async (key: string) => `value-${key}-${produce.mock.calls.length}`);
      const cache = createKeyedTtlCache({ ttlMs: 1000, produce });

      await cache.get("A");
      cache.invalidate("A");
      await vi.advanceTimersByTimeAsync(1);
      const second = await cache.get("A");

      expect(produce).toHaveBeenCalledTimes(2);
      expect(second.value).toBe("value-A-2");
    });

    it("never affects a different key's cached value", async () => {
      const produce = vi.fn(async (key: string) => `value-${key}`);
      const cache = createKeyedTtlCache({ ttlMs: 1000, produce });

      await cache.get("A");
      await cache.get("B");
      cache.invalidate("A");
      await cache.get("B");

      expect(produce).toHaveBeenCalledTimes(2);
    });

    it("is a no-op for a key that was never accessed", () => {
      const produce = vi.fn(async (key: string) => `value-${key}`);
      const cache = createKeyedTtlCache({ ttlMs: 1000, produce });

      expect(() => cache.invalidate("NEVER_SEEN")).not.toThrow();
    });
  });
});
