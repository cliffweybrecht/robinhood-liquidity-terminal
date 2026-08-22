import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLimiter } from "../limiter";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A task that resolves after `delayMs` of (fake) time, recording its start timestamp. */
function makeDelayedTask<T>(delayMs: number, value: T, starts: number[]) {
  return () =>
    new Promise<T>((resolve) => {
      starts.push(Date.now());
      setTimeout(() => resolve(value), delayMs);
    });
}

describe("createLimiter", () => {
  it("never runs more than the configured concurrency at once", async () => {
    const limiter = createLimiter({ concurrency: 2, intervalMs: 0 });
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 6 }, () =>
      limiter.schedule(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active--;
        return "ok";
      }),
    );

    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(tasks);

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("spaces task starts by at least intervalMs", async () => {
    const starts: number[] = [];
    const limiter = createLimiter({ concurrency: 5, intervalMs: 100 });

    const tasks = Array.from({ length: 4 }, () =>
      limiter.schedule(makeDelayedTask(1, "ok", starts)),
    );

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(tasks);

    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(100);
    }
  });

  it("completes all scheduled work", async () => {
    const limiter = createLimiter({ concurrency: 3, intervalMs: 10 });

    const tasks = Array.from({ length: 20 }, (_, i) =>
      limiter.schedule(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return i;
      }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    const results = await Promise.all(tasks);

    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("does not let one task's failure stop unrelated queued work", async () => {
    const limiter = createLimiter({ concurrency: 2, intervalMs: 10 });

    const failing = limiter.schedule(async () => {
      throw new Error("task A failed");
    });
    const okA = limiter.schedule(async () => "B");
    const okB = limiter.schedule(async () => "C");

    // Attach rejection/resolution handlers before advancing timers, so
    // nothing settles before a handler exists to observe it.
    const failingAssertion = expect(failing).rejects.toThrow("task A failed");
    const okAAssertion = expect(okA).resolves.toBe("B");
    const okBAssertion = expect(okB).resolves.toBe("C");

    await vi.advanceTimersByTimeAsync(100);

    await failingAssertion;
    await okAAssertion;
    await okBAssertion;
  });

  it("throws explicitly for non-positive concurrency", () => {
    expect(() => createLimiter({ concurrency: 0, intervalMs: 100 })).toThrow();
    expect(() => createLimiter({ concurrency: -1, intervalMs: 100 })).toThrow();
  });

  it("throws explicitly for a non-integer concurrency", () => {
    expect(() => createLimiter({ concurrency: 1.5, intervalMs: 100 })).toThrow();
  });

  it("throws explicitly for a negative intervalMs", () => {
    expect(() => createLimiter({ concurrency: 2, intervalMs: -5 })).toThrow();
  });

  it("allows intervalMs of 0 (concurrency-only limiting)", () => {
    expect(() => createLimiter({ concurrency: 2, intervalMs: 0 })).not.toThrow();
  });
});
