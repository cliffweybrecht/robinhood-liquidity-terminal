import { describe, expect, it } from "vitest";
import { largestQuotedSample, mapWithBoundedConcurrency, sampledDepthAtBps } from "../depth-math";
import type { DepthCurvePointLike } from "../types";

function point(amountIn: bigint, status: DepthCurvePointLike["status"], priceImpactBps?: { numerator: bigint; denominator: bigint }): DepthCurvePointLike {
  return { amountIn, status, priceImpactBps };
}

describe("largestQuotedSample", () => {
  it("returns null for an empty array", () => {
    expect(largestQuotedSample([])).toBeNull();
  });

  it("returns null when no point is QUOTED", () => {
    const points = [point(1n, "INDETERMINATE"), point(2n, "RPC_ERROR"), point(3n, "UNQUOTABLE")];
    expect(largestQuotedSample(points)).toBeNull();
  });

  it("returns the largest amountIn among QUOTED points, ignoring non-QUOTED points entirely", () => {
    const points = [point(1n, "QUOTED"), point(5n, "INDETERMINATE"), point(3n, "QUOTED")];
    expect(largestQuotedSample(points)).toBe(3n);
  });

  it("does not assume sorted input — finds the true largest by value even when the largest QUOTED point is NOT last positionally", () => {
    const points = [point(10n, "QUOTED"), point(2n, "QUOTED"), point(50n, "INDETERMINATE"), point(7n, "QUOTED")];
    expect(largestQuotedSample(points)).toBe(10n);
  });

  it("single QUOTED point", () => {
    expect(largestQuotedSample([point(42n, "QUOTED")])).toBe(42n);
  });
});

describe("sampledDepthAtBps", () => {
  it("returns null for an empty array", () => {
    expect(sampledDepthAtBps([], 50)).toBeNull();
  });

  it("returns null when no QUOTED point has priceImpactBps at all", () => {
    const points = [point(1n, "QUOTED"), point(2n, "QUOTED")];
    expect(sampledDepthAtBps(points, 50)).toBeNull();
  });

  it("returns null when every QUOTED point's impact exceeds the threshold", () => {
    const points = [point(1n, "QUOTED", { numerator: 100n, denominator: 1n }), point(2n, "QUOTED", { numerator: 200n, denominator: 1n })];
    expect(sampledDepthAtBps(points, 50)).toBeNull();
  });

  it("a point exactly AT the threshold qualifies (<=, not <)", () => {
    const points = [point(5n, "QUOTED", { numerator: 50n, denominator: 1n })];
    expect(sampledDepthAtBps(points, 50)).toBe(5n);
  });

  it("returns the largest sampled amountIn among qualifying QUOTED points", () => {
    const points = [
      point(1n, "QUOTED", { numerator: 5n, denominator: 1n }),
      point(10n, "QUOTED", { numerator: 8n, denominator: 1n }),
      point(100n, "QUOTED", { numerator: 500n, denominator: 1n }), // exceeds threshold
    ];
    expect(sampledDepthAtBps(points, 10)).toBe(10n);
  });

  it("ignores non-QUOTED points even if they happen to carry a priceImpactBps-shaped field", () => {
    const points = [point(1n, "QUOTED", { numerator: 5n, denominator: 1n }), point(100n, "INDETERMINATE", { numerator: 1n, denominator: 1n })];
    expect(sampledDepthAtBps(points, 1000)).toBe(1n);
  });

  it("does not assume sorted input", () => {
    const points = [
      point(100n, "QUOTED", { numerator: 5n, denominator: 1n }),
      point(10n, "QUOTED", { numerator: 5n, denominator: 1n }),
      point(50n, "QUOTED", { numerator: 5n, denominator: 1n }),
    ];
    expect(sampledDepthAtBps(points, 1000)).toBe(100n);
  });

  it("exact rational comparison — a fractional impact just under the threshold qualifies, just over does not, no floating point involved", () => {
    // 49/1 == 49 <= 50 -> qualifies. 501/10 == 50.1 > 50 -> does not.
    const points = [
      point(1n, "QUOTED", { numerator: 49n, denominator: 1n }),
      point(2n, "QUOTED", { numerator: 501n, denominator: 10n }),
    ];
    expect(sampledDepthAtBps(points, 50)).toBe(1n);
  });

  it("handles a negative threshold correctly (only negative/favorable impact points qualify)", () => {
    const points = [
      point(1n, "QUOTED", { numerator: -10n, denominator: 1n }), // -10 bps, better than spot
      point(2n, "QUOTED", { numerator: 5n, denominator: 1n }), // +5 bps
    ];
    expect(sampledDepthAtBps(points, -5)).toBe(1n);
  });
});

describe("mapWithBoundedConcurrency", () => {
  it("returns an empty array for an empty items array", async () => {
    const result = await mapWithBoundedConcurrency([], 5, async (x: number) => x * 2);
    expect(result).toEqual([]);
  });

  it("preserves output order matching input order, even when later items resolve before earlier ones", async () => {
    // Item 0 resolves LAST (longest delay), item 4 resolves FIRST — output must still be [0,10,20,30,40].
    const items = [0, 1, 2, 3, 4];
    const delays = [40, 30, 20, 10, 0];
    const result = await mapWithBoundedConcurrency(items, 5, async (item, index) => {
      await new Promise((resolve) => setTimeout(resolve, delays[index]));
      return item * 10;
    });
    expect(result).toEqual([0, 10, 20, 30, 40]);
  });

  it("never exceeds the concurrency cap in simultaneous in-flight calls", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapWithBoundedConcurrency(items, 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("processes every item exactly once when concurrency exceeds item count", async () => {
    const items = [1, 2, 3];
    const seen: number[] = [];
    const result = await mapWithBoundedConcurrency(items, 100, async (item) => {
      seen.push(item);
      return item;
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  it("processes every item exactly once when concurrency is 1 (fully sequential)", async () => {
    const items = [1, 2, 3, 4];
    const order: number[] = [];
    const result = await mapWithBoundedConcurrency(items, 1, async (item) => {
      order.push(item);
      return item * 100;
    });
    expect(order).toEqual([1, 2, 3, 4]);
    expect(result).toEqual([100, 200, 300, 400]);
  });
});
