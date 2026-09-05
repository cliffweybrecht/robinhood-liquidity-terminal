import type { Hex } from "viem";
import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { DepthThresholdOutcome, MatrixCandidateRow, VerifiedPoolDepthResult, VerifiedPoolDepthThresholdsResult } from "@/domain/pool-quote";
import { NATIVE_ETH } from "../types";
import { synthesizeExecutionSummary, type ExecutionSummaryAvailable } from "../executionSummary";
import { NVDA, WETH } from "./fixtures";

const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const POOL_C = "0xcccccccccccccccccccccccccccccccccccccccc".slice(0, 42) as Hex;

const THRESHOLDS = [50, 100, 200, 500];

function pool(pairAddress: Hex): MatrixCandidateRow["pool"] {
  return { chainId: "robinhood", pairAddress, dexId: "uniswap", canonicalAssetAddress: NVDA, canonicalAssetSymbol: "NVDA", canonicalAssetSide: "base" };
}

function withinThreshold(qualifyingAmountIn: bigint, upperRangeKind: "OPEN" | "CLEAN_CEILING" = "OPEN"): DepthThresholdOutcome {
  return {
    kind: "WITHIN_THRESHOLD",
    qualifyingAmountIn,
    monotonicityObserved: true,
    upperRange: upperRangeKind === "OPEN" ? { kind: "OPEN" } : { kind: "CLEAN_CEILING", nextMeasuredAmountIn: qualifyingAmountIn * 2n },
  };
}

const exceeded: DepthThresholdOutcome = { kind: "EXCEEDED_AT_SMALLEST_SAMPLE", smallestMeasuredAmountIn: 1n };
const analyticsUnavailable: DepthThresholdOutcome = { kind: "ANALYTICS_UNAVAILABLE" };
const noQuotedSamples: DepthThresholdOutcome = { kind: "NO_QUOTED_SAMPLES" };

/** A "participated" pool row: every threshold gets the SAME outcome unless overridden per-threshold. */
function participatedPool(pairAddress: Hex, outcomesByThresholdBps: Partial<Record<number, DepthThresholdOutcome>> = {}): VerifiedPoolDepthResult {
  return {
    row: { pool: pool(pairAddress), family: "UNISWAP_V3", identityVerificationBlock: 1n, cells: [] },
    outcomesByThreshold: THRESHOLDS.map((thresholdBps) => ({ thresholdBps, outcome: outcomesByThresholdBps[thresholdBps] ?? exceeded })),
  };
}

function uniformPool(pairAddress: Hex, outcome: DepthThresholdOutcome): VerifiedPoolDepthResult {
  return {
    row: { pool: pool(pairAddress), family: "UNISWAP_V3", identityVerificationBlock: 1n, cells: [] },
    outcomesByThreshold: THRESHOLDS.map((thresholdBps) => ({ thresholdBps, outcome })),
  };
}

function preconditionFailedPool(pairAddress: Hex): VerifiedPoolDepthResult {
  return {
    row: {
      pool: pool(pairAddress),
      family: "UNISWAP_V4",
      identityVerificationBlock: 1n,
      cells: [{ amountIn: 1n, status: "PRECONDITION_FAILED", analyticsStatus: "INDETERMINATE", evidence: [], preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "x" } }],
    },
    outcomesByThreshold: [],
  };
}

function okResult(pools: readonly VerifiedPoolDepthResult[], bestVenueByThreshold?: readonly { thresholdBps: number; poolAddresses: readonly Hex[] }[], sharedAnalyticsStatus: "OK" | "RPC_ERROR" | "INDETERMINATE" = "OK"): VerifiedPoolDepthThresholdsResult {
  return {
    status: "OK",
    blockNumber: 999n,
    tokenIn: NVDA,
    tokenOut: WETH,
    tokenInDecimals: 18,
    tokenOutDecimals: 18,
    sharedAnalyticsStatus,
    sharedEvidence: [],
    ladderAmountsIn: [1n],
    thresholdsBps: THRESHOLDS,
    pools,
    bestVenueByThreshold: bestVenueByThreshold ?? THRESHOLDS.map((thresholdBps) => ({ thresholdBps, poolAddresses: [] })),
  };
}

function asAvailable(summary: ReturnType<typeof synthesizeExecutionSummary>): ExecutionSummaryAvailable {
  if (summary.availability !== "AVAILABLE") throw new Error("expected AVAILABLE");
  return summary;
}

describe("synthesizeExecutionSummary — availability", () => {
  it("UNAVAILABLE for BLOCK_PIN_FAILURE", () => {
    const result: VerifiedPoolDepthThresholdsResult = { status: "BLOCK_PIN_FAILURE", tokenIn: NVDA, tokenOut: WETH, evidence: [] };
    const summary = synthesizeExecutionSummary(result, "HEALTHY");
    expect(summary.availability).toBe("UNAVAILABLE");
    if (summary.availability === "UNAVAILABLE") {
      expect(summary.tokenIn).toBe(NVDA);
      expect(summary.tokenOut).toBe(WETH);
    }
  });

  it("UNAVAILABLE when there are zero pools in the group", () => {
    const summary = synthesizeExecutionSummary(okResult([]), "HEALTHY");
    expect(summary.availability).toBe("UNAVAILABLE");
  });

  it("AVAILABLE when at least one pool exists, even if it never qualifies at any threshold", () => {
    const summary = synthesizeExecutionSummary(okResult([uniformPool(POOL_A, exceeded)]), "HEALTHY");
    expect(summary.availability).toBe("AVAILABLE");
  });

  it("translates the pool-quote layer's raw zero-address tokenOut to the NATIVE_ETH sentinel exactly once", () => {
    const result = okResult([uniformPool(POOL_A, exceeded)]);
    const summary = asAvailable(synthesizeExecutionSummary({ ...result, tokenOut: zeroAddress }, "HEALTHY"));
    expect(summary.tokenOut).toBe(NATIVE_ETH);
  });
});

describe("synthesizeExecutionSummary — candidateSetComplete / sharedAnalyticsAvailable are orthogonal", () => {
  it("candidateSetComplete reflects verificationHealth directly, independent of analytics", () => {
    const result = okResult([uniformPool(POOL_A, exceeded)], undefined, "RPC_ERROR");
    const healthy = asAvailable(synthesizeExecutionSummary(result, "HEALTHY"));
    expect(healthy.candidateSetComplete).toBe(true);
    expect(healthy.sharedAnalyticsAvailable).toBe(false);

    const degraded = asAvailable(synthesizeExecutionSummary(result, "DEGRADED"));
    expect(degraded.candidateSetComplete).toBe(false);
    expect(degraded.sharedAnalyticsAvailable).toBe(false);
  });

  it("sharedAnalyticsAvailable=false does NOT force candidateSetComplete=false, and vice versa — a failure of one dimension never implies the other is untrustworthy", () => {
    const okAnalytics = asAvailable(synthesizeExecutionSummary(okResult([uniformPool(POOL_A, exceeded)], undefined, "OK"), "DEGRADED"));
    expect(okAnalytics.sharedAnalyticsAvailable).toBe(true);
    expect(okAnalytics.candidateSetComplete).toBe(false);
  });
});

describe("synthesizeExecutionSummary — venueDispositions (all VenueParticipationStatus cases)", () => {
  it("classifies PRECONDITION_FAILED, NO_QUOTED_SAMPLES, ANALYTICS_UNAVAILABLE, and PARTICIPATED correctly in one mixed group", () => {
    const summary = asAvailable(
      synthesizeExecutionSummary(
        okResult([uniformPool(POOL_A, exceeded), uniformPool(POOL_B, analyticsUnavailable), uniformPool(POOL_C, noQuotedSamples), preconditionFailedPool("0xdddddddddddddddddddddddddddddddddddddddd" as Hex)]),
        "HEALTHY",
      ),
    );
    const byAddress = new Map(summary.venueDispositions.map((d) => [d.pairAddress.toLowerCase(), d.status]));
    expect(byAddress.get(POOL_A.toLowerCase())).toBe("PARTICIPATED"); // EXCEEDED_AT_SMALLEST_SAMPLE is still a genuine, measured participation
    expect(byAddress.get(POOL_B.toLowerCase())).toBe("ANALYTICS_UNAVAILABLE");
    expect(byAddress.get(POOL_C.toLowerCase())).toBe("NO_QUOTED_SAMPLES");
    expect(byAddress.get("0xdddddddddddddddddddddddddddddddddddddddd")).toBe("PRECONDITION_FAILED");
  });

  it("a pool with a MIX of WITHIN_THRESHOLD and EXCEEDED_AT_SMALLEST_SAMPLE across its 4 thresholds is PARTICIPATED, never excluded", () => {
    const mixed = participatedPool(POOL_A, { 50: withinThreshold(100n), 500: exceeded });
    const summary = asAvailable(synthesizeExecutionSummary(okResult([mixed]), "HEALTHY"));
    expect(summary.venueDispositions[0]!.status).toBe("PARTICIPATED");
  });

  it("venueDispositions.length equals the total candidate count — no candidate is ever dropped", () => {
    const summary = asAvailable(
      synthesizeExecutionSummary(okResult([uniformPool(POOL_A, exceeded), preconditionFailedPool(POOL_B)]), "HEALTHY"),
    );
    expect(summary.venueDispositions).toHaveLength(2);
  });
});

describe("synthesizeExecutionSummary — venue transitions (exact stress-test table from the freeze report)", () => {
  function transitionsFor(bestVenueByThreshold: readonly { thresholdBps: number; poolAddresses: readonly Hex[] }[]) {
    const summary = asAvailable(synthesizeExecutionSummary(okResult([uniformPool(POOL_A, exceeded)], bestVenueByThreshold), "HEALTHY"));
    return summary.venueTransitions;
  }

  it("always produces exactly 3 entries, in ascending threshold order, regardless of content", () => {
    const transitions = transitionsFor(THRESHOLDS.map((thresholdBps) => ({ thresholdBps, poolAddresses: [] })));
    expect(transitions).toHaveLength(3);
    expect(transitions.map((t) => [t.fromThresholdBps, t.toThresholdBps])).toEqual([
      [50, 100],
      [100, 200],
      [200, 500],
    ]);
  });

  it("tie at either adjacent sample: [A,B] -> [A] is WINNER_SET_DIFFERS, never claims A 'won'", () => {
    const [t] = transitionsFor([
      { thresholdBps: 50, poolAddresses: [POOL_A, POOL_B] },
      { thresholdBps: 100, poolAddresses: [POOL_A] },
      { thresholdBps: 200, poolAddresses: [] },
      { thresholdBps: 500, poolAddresses: [] },
    ]);
    expect(t!.kind).toBe("WINNER_SET_DIFFERS");
  });

  it("A -> [A,B] is WINNER_SET_DIFFERS — A never stopped being a winner, so this is not a 'change'", () => {
    const [t] = transitionsFor([
      { thresholdBps: 50, poolAddresses: [POOL_A] },
      { thresholdBps: 100, poolAddresses: [POOL_A, POOL_B] },
      { thresholdBps: 200, poolAddresses: [] },
      { thresholdBps: 500, poolAddresses: [] },
    ]);
    expect(t!.kind).toBe("WINNER_SET_DIFFERS");
  });

  it("[A,B] -> B is WINNER_SET_DIFFERS — B was already tied, this is not a new win", () => {
    const [t] = transitionsFor([
      { thresholdBps: 50, poolAddresses: [POOL_A, POOL_B] },
      { thresholdBps: 100, poolAddresses: [POOL_B] },
      { thresholdBps: 200, poolAddresses: [] },
      { thresholdBps: 500, poolAddresses: [] },
    ]);
    expect(t!.kind).toBe("WINNER_SET_DIFFERS");
  });

  it("[A,B] -> [B,A] (identical tie, different order) is NO_DIFFERENCE — order-insensitive set comparison", () => {
    const [t] = transitionsFor([
      { thresholdBps: 50, poolAddresses: [POOL_A, POOL_B] },
      { thresholdBps: 100, poolAddresses: [POOL_B, POOL_A] },
      { thresholdBps: 200, poolAddresses: [] },
      { thresholdBps: 500, poolAddresses: [] },
    ]);
    expect(t!.kind).toBe("NO_DIFFERENCE");
  });

  it("[A,B] -> [B,A] with different address casing is still NO_DIFFERENCE — case-insensitive set comparison", () => {
    const [t] = transitionsFor([
      { thresholdBps: 50, poolAddresses: [POOL_A, POOL_B] },
      { thresholdBps: 100, poolAddresses: [POOL_B.toUpperCase() as Hex, POOL_A.toUpperCase() as Hex] },
      { thresholdBps: 200, poolAddresses: [] },
      { thresholdBps: 500, poolAddresses: [] },
    ]);
    expect(t!.kind).toBe("NO_DIFFERENCE");
  });

  it("no qualifying venue at one side: [] -> [A] is WINNER_SET_DIFFERS (well-defined, not 'incomparable')", () => {
    const [t] = transitionsFor([
      { thresholdBps: 50, poolAddresses: [] },
      { thresholdBps: 100, poolAddresses: [POOL_A] },
      { thresholdBps: 200, poolAddresses: [] },
      { thresholdBps: 500, poolAddresses: [] },
    ]);
    expect(t!.kind).toBe("WINNER_SET_DIFFERS");
  });

  it("both sides empty is NO_DIFFERENCE — nobody qualified at either threshold, a well-defined equal-sets fact", () => {
    const [t] = transitionsFor([
      { thresholdBps: 50, poolAddresses: [] },
      { thresholdBps: 100, poolAddresses: [] },
      { thresholdBps: 200, poolAddresses: [] },
      { thresholdBps: 500, poolAddresses: [] },
    ]);
    expect(t!.kind).toBe("NO_DIFFERENCE");
  });

  it("A -> B (unambiguous sole winner on both sides, and they differ) is the ONLY case classified SOLE_WINNER_CHANGED", () => {
    const [t] = transitionsFor([
      { thresholdBps: 50, poolAddresses: [POOL_A] },
      { thresholdBps: 100, poolAddresses: [POOL_B] },
      { thresholdBps: 200, poolAddresses: [] },
      { thresholdBps: 500, poolAddresses: [] },
    ]);
    expect(t!.kind).toBe("SOLE_WINNER_CHANGED");
  });

  it("A -> A (identical sole winner) is NO_DIFFERENCE", () => {
    const [t] = transitionsFor([
      { thresholdBps: 50, poolAddresses: [POOL_A] },
      { thresholdBps: 100, poolAddresses: [POOL_A] },
      { thresholdBps: 200, poolAddresses: [] },
      { thresholdBps: 500, poolAddresses: [] },
    ]);
    expect(t!.kind).toBe("NO_DIFFERENCE");
  });
});

describe("synthesizeExecutionSummary — venueDiversityAcrossThresholds (no scalar score)", () => {
  it("distinctVenueCount is the exact union size across all 4 thresholds, ties counted once", () => {
    const summary = asAvailable(
      synthesizeExecutionSummary(
        okResult([uniformPool(POOL_A, exceeded)], [
          { thresholdBps: 50, poolAddresses: [POOL_A, POOL_B] },
          { thresholdBps: 100, poolAddresses: [POOL_B] },
          { thresholdBps: 200, poolAddresses: [POOL_C] },
          { thresholdBps: 500, poolAddresses: [] },
        ]),
        "HEALTHY",
      ),
    );
    expect(summary.venueDiversityAcrossThresholds.distinctVenueCount).toBe(3); // A, B, C — each counted once
  });

  it("venueSetChangeCount equals the count of transitions with kind !== NO_DIFFERENCE, max 3", () => {
    const summary = asAvailable(
      synthesizeExecutionSummary(
        okResult([uniformPool(POOL_A, exceeded)], [
          { thresholdBps: 50, poolAddresses: [POOL_A] },
          { thresholdBps: 100, poolAddresses: [POOL_B] }, // SOLE_WINNER_CHANGED
          { thresholdBps: 200, poolAddresses: [POOL_B] }, // NO_DIFFERENCE
          { thresholdBps: 500, poolAddresses: [POOL_B, POOL_C] }, // WINNER_SET_DIFFERS
        ]),
        "HEALTHY",
      ),
    );
    expect(summary.venueDiversityAcrossThresholds.venueSetChangeCount).toBe(2);
  });

  it("remains honest (zero-valued, not fabricated) when every threshold is empty", () => {
    const summary = asAvailable(synthesizeExecutionSummary(okResult([uniformPool(POOL_A, exceeded)]), "HEALTHY"));
    expect(summary.venueDiversityAcrossThresholds).toEqual({ distinctVenueCount: 0, venueSetChangeCount: 0 });
  });
});

describe("synthesizeExecutionSummary — typed UNKNOWN reasons", () => {
  it("always includes the three structural reasons when AVAILABLE", () => {
    const summary = asAvailable(synthesizeExecutionSummary(okResult([uniformPool(POOL_A, exceeded)]), "HEALTHY"));
    expect(summary.unknown).toEqual(expect.arrayContaining(["CROSS_GROUP_COMPARISON_NOT_ATTEMPTED", "UNSAMPLED_TRADE_SIZES_UNKNOWN", "FUTURE_BLOCK_EXECUTION_UNKNOWN"]));
  });

  it("includes EXCLUDED_VENUES_NOT_COMPARED if and only if at least one venue is not PARTICIPATED", () => {
    const withExclusion = asAvailable(synthesizeExecutionSummary(okResult([uniformPool(POOL_A, exceeded), preconditionFailedPool(POOL_B)]), "HEALTHY"));
    expect(withExclusion.unknown).toContain("EXCLUDED_VENUES_NOT_COMPARED");

    const withoutExclusion = asAvailable(synthesizeExecutionSummary(okResult([uniformPool(POOL_A, exceeded)]), "HEALTHY"));
    expect(withoutExclusion.unknown).not.toContain("EXCLUDED_VENUES_NOT_COMPARED");
  });

  it("includes the structural reasons even when UNAVAILABLE — cross-group/sampled/future-block limits remain true regardless of data availability", () => {
    const summary = synthesizeExecutionSummary({ status: "BLOCK_PIN_FAILURE", tokenIn: NVDA, tokenOut: WETH, evidence: [] }, "HEALTHY");
    if (summary.availability !== "UNAVAILABLE") throw new Error("expected UNAVAILABLE");
    expect(summary.unknown).toEqual(["CROSS_GROUP_COMPARISON_NOT_ATTEMPTED", "UNSAMPLED_TRADE_SIZES_UNKNOWN", "FUTURE_BLOCK_EXECUTION_UNKNOWN"]);
  });
});

describe("synthesizeExecutionSummary — bestVenueByThreshold is a verbatim passthrough", () => {
  it("is copied by reference/value, never recomputed or re-ranked", () => {
    const bestVenueByThreshold = [
      { thresholdBps: 50, poolAddresses: [POOL_A, POOL_B] },
      { thresholdBps: 100, poolAddresses: [POOL_A] },
      { thresholdBps: 200, poolAddresses: [] },
      { thresholdBps: 500, poolAddresses: [] },
    ];
    const summary = asAvailable(synthesizeExecutionSummary(okResult([uniformPool(POOL_A, exceeded)], bestVenueByThreshold), "HEALTHY"));
    expect(summary.bestVenueByThreshold).toEqual(bestVenueByThreshold);
  });
});

describe("synthesizeExecutionSummary — zero new RPC / block-pin / quote work (structural)", () => {
  it("is a synchronous, pure function — no Promise, no RPC client parameter exists in its signature", () => {
    const result = synthesizeExecutionSummary(okResult([uniformPool(POOL_A, exceeded)]), "HEALTHY");
    // If this were async, `result` would be a Promise, not a resolved ExecutionSummary.
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.availability).toBe("string");
  });
});
