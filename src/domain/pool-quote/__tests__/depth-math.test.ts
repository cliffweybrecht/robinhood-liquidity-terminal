import { describe, expect, it } from "vitest";
import { classifyUpperRange, largestQuotedSample, mapWithBoundedConcurrency, monotonicityObservedAtOrBelow, sampledDepthAtBps } from "../depth-math";
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

describe("monotonicityObservedAtOrBelow", () => {
  it("returns true for an empty array", () => {
    expect(monotonicityObservedAtOrBelow([], 100, 50n)).toBe(true);
  });

  it("returns true when every QUOTED point at or below amountIn qualifies", () => {
    const points = [point(1n, "QUOTED", { numerator: 10n, denominator: 1n }), point(10n, "QUOTED", { numerator: 90n, denominator: 1n })];
    expect(monotonicityObservedAtOrBelow(points, 100, 10n)).toBe(true);
  });

  it("returns false when a smaller tested point exceeds the threshold while amountIn itself qualifies", () => {
    const points = [point(1n, "QUOTED", { numerator: 150n, denominator: 1n }), point(10n, "QUOTED", { numerator: 90n, denominator: 1n })];
    expect(monotonicityObservedAtOrBelow(points, 100, 10n)).toBe(false);
  });

  it("ignores points above amountIn entirely", () => {
    const points = [point(1n, "QUOTED", { numerator: 10n, denominator: 1n }), point(1000n, "QUOTED", { numerator: 99999n, denominator: 1n })];
    expect(monotonicityObservedAtOrBelow(points, 100, 1n)).toBe(true);
  });

  it("skips non-QUOTED points at or below amountIn — a gap is never a monotonicity violation", () => {
    const points = [point(1n, "RPC_ERROR"), point(10n, "QUOTED", { numerator: 90n, denominator: 1n })];
    expect(monotonicityObservedAtOrBelow(points, 100, 10n)).toBe(true);
  });

  it("does not assume sorted input", () => {
    const points = [point(10n, "QUOTED", { numerator: 90n, denominator: 1n }), point(1n, "QUOTED", { numerator: 150n, denominator: 1n })];
    expect(monotonicityObservedAtOrBelow(points, 100, 10n)).toBe(false);
  });

  it("exact rational comparison — a point exactly at the threshold does not violate", () => {
    const points = [point(1n, "QUOTED", { numerator: 100n, denominator: 1n }), point(10n, "QUOTED", { numerator: 100n, denominator: 1n })];
    expect(monotonicityObservedAtOrBelow(points, 100, 10n)).toBe(true);
  });
});

describe("classifyUpperRange", () => {
  it("OPEN — no point has a larger amountIn than the given value", () => {
    const points = [point(1n, "QUOTED"), point(10n, "QUOTED")];
    expect(classifyUpperRange(points, 10n)).toEqual({ kind: "OPEN" });
  });

  it("OPEN — empty points array", () => {
    expect(classifyUpperRange([], 10n)).toEqual({ kind: "OPEN" });
  });

  it("CLEAN_CEILING — every larger point is QUOTED AND has a measured impact, returns the smallest one", () => {
    const impact = { numerator: 10n, denominator: 1n };
    const points = [point(1n, "QUOTED", impact), point(500n, "QUOTED", impact), point(250n, "QUOTED", impact)];
    expect(classifyUpperRange(points, 1n)).toEqual({ kind: "CLEAN_CEILING", nextMeasuredAmountIn: 250n });
  });

  it("GAPPED_CEILING — the exact 100/250/500 scenario from the frozen correction: 250 RPC_ERROR, 500 QUOTED with measured impact", () => {
    const impact = { numerator: 10n, denominator: 1n };
    const points = [point(100n, "QUOTED", impact), point(250n, "RPC_ERROR"), point(500n, "QUOTED", impact)];
    expect(classifyUpperRange(points, 100n)).toEqual({ kind: "GAPPED_CEILING", nextMeasuredAmountIn: 500n });
  });

  it("GAPPED_NO_CEILING — every larger point is non-QUOTED", () => {
    const points = [point(100n, "QUOTED"), point(250n, "RPC_ERROR"), point(500n, "RPC_ERROR")];
    expect(classifyUpperRange(points, 100n)).toEqual({ kind: "GAPPED_NO_CEILING" });
  });

  it("GAPPED_NO_CEILING treats INDETERMINATE, UNQUOTABLE, and PRECONDITION_FAILED uniformly as non-QUOTED", () => {
    const points = [point(100n, "QUOTED"), point(200n, "INDETERMINATE"), point(300n, "UNQUOTABLE"), point(400n, "PRECONDITION_FAILED")];
    expect(classifyUpperRange(points, 100n)).toEqual({ kind: "GAPPED_NO_CEILING" });
  });

  it("does not assume sorted input", () => {
    const impact = { numerator: 10n, denominator: 1n };
    const points = [point(500n, "QUOTED", impact), point(100n, "QUOTED", impact), point(250n, "RPC_ERROR")];
    expect(classifyUpperRange(points, 100n)).toEqual({ kind: "GAPPED_CEILING", nextMeasuredAmountIn: 500n });
  });

  it("ignores points at or below the given value entirely — a gap below amountIn never affects the upper-range classification", () => {
    const impact = { numerator: 10n, denominator: 1n };
    const points = [point(1n, "RPC_ERROR"), point(100n, "QUOTED", impact), point(250n, "QUOTED", impact)];
    expect(classifyUpperRange(points, 100n)).toEqual({ kind: "CLEAN_CEILING", nextMeasuredAmountIn: 250n });
  });

  it("a point exactly equal to amountIn is excluded (strictly greater only)", () => {
    const points = [point(100n, "QUOTED"), point(100n, "RPC_ERROR")];
    expect(classifyUpperRange(points, 100n)).toEqual({ kind: "OPEN" });
  });

  it("QUOTED-but-impact-unavailable does NOT count as measured — a status===QUOTED point with priceImpactBps undefined is treated as a gap, never as a confirmed 'exceeded' ceiling", () => {
    // 100 qualifying; 250 QUOTED but priceImpactBps undefined (analytics unavailable for that point); 500 QUOTED with real impact.
    const points = [point(100n, "QUOTED", { numerator: 70n, denominator: 1n }), { amountIn: 250n, status: "QUOTED" as const, evidence: [] }, point(500n, "QUOTED", { numerator: 140n, denominator: 1n })];
    // Must NOT become CLEAN_CEILING (which would wrongly claim 250 was evaluated) —
    // must disclose the unresolved 250 point via GAPPED_CEILING, with 500 (the
    // smallest point that actually HAS a measured impact) as the ceiling.
    expect(classifyUpperRange(points, 100n)).toEqual({ kind: "GAPPED_CEILING", nextMeasuredAmountIn: 500n });
  });

  it("GAPPED_NO_CEILING when every larger point is QUOTED but none has a measured impact", () => {
    const points = [
      point(100n, "QUOTED", { numerator: 70n, denominator: 1n }),
      { amountIn: 250n, status: "QUOTED" as const, evidence: [] },
      { amountIn: 500n, status: "QUOTED" as const, evidence: [] },
    ];
    expect(classifyUpperRange(points, 100n)).toEqual({ kind: "GAPPED_NO_CEILING" });
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
