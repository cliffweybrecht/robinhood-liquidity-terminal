import { zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { classifyMatrixCandidates, type ComparisonCandidateInput } from "@/domain/pool-quote";
import {
  classifyCrossMarketGroup,
  computeCrossMarketBudget,
  MAX_CROSS_MARKET_DEPTH_CELLS,
  MIN_CROSS_MARKET_OUTPUT_MARKETS,
  resolveCrossMarketGroupSelection,
} from "../crossMarketPolicy";
import { NATIVE_ETH } from "../types";
import { NVDA, pool, USDG, verifiedV3Identity, verifiedV4Identity, WETH } from "./fixtures";
import type { ComparableExecutionGroup } from "../types";

function group(tokenOut: ComparableExecutionGroup["tokenOut"], candidateCount: number): ComparableExecutionGroup {
  return { tokenOut, candidateCount, v3Count: candidateCount, v4Count: 0 };
}

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function poolId(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function v3CandidateInput(pairAddress: `0x${string}`, tokenOut: `0x${string}` = WETH): ComparisonCandidateInput {
  return { pool: pool({ pairAddress, quoteToken: { address: tokenOut, name: "x", symbol: "X" } }), identity: verifiedV3Identity(pairAddress, NVDA, tokenOut) };
}

function hookedV4CandidateInput(poolIdValue: `0x${string}`, tokenOut: `0x${string}` = WETH, hookData?: Hex): ComparisonCandidateInput {
  const HOOK = "0xf869A735ec31e28f77A6f917157BE63729F60880" as `0x${string}`;
  return { pool: pool({ pairAddress: poolIdValue, quoteToken: { address: tokenOut, name: "x", symbol: "X" } }), identity: verifiedV4Identity(poolIdValue, tokenOut, NVDA, 8388608, 4, HOOK), hookData };
}

describe("MIN_CROSS_MARKET_OUTPUT_MARKETS / MAX_CROSS_MARKET_DEPTH_CELLS — frozen values", () => {
  it("MIN_CROSS_MARKET_OUTPUT_MARKETS is 2", () => {
    expect(MIN_CROSS_MARKET_OUTPUT_MARKETS).toBe(2);
  });

  it("MAX_CROSS_MARKET_DEPTH_CELLS is 60", () => {
    expect(MAX_CROSS_MARKET_DEPTH_CELLS).toBe(60);
  });
});

describe("resolveCrossMarketGroupSelection — omitted selection (default), HEALTHY", () => {
  it("0 groups -> INSUFFICIENT_MARKETS, availableMarketCount 0", () => {
    expect(resolveCrossMarketGroupSelection([], undefined, "HEALTHY")).toEqual({ kind: "INSUFFICIENT_MARKETS", availableMarketCount: 0 });
  });

  it("1 group -> INSUFFICIENT_MARKETS, availableMarketCount 1", () => {
    expect(resolveCrossMarketGroupSelection([group(WETH, 3)], undefined, "HEALTHY")).toEqual({ kind: "INSUFFICIENT_MARKETS", availableMarketCount: 1 });
  });

  it("2+ groups -> RESOLVED, preserving snapshot order", () => {
    const groups = [group(WETH, 5), group(USDG, 3), group(NATIVE_ETH, 1)];
    expect(resolveCrossMarketGroupSelection(groups, undefined, "HEALTHY")).toEqual({ kind: "RESOLVED", tokenOuts: [WETH, USDG, NATIVE_ETH] });
  });
});

describe("resolveCrossMarketGroupSelection — omitted selection (default), DEGRADED", () => {
  it("0 groups -> DEGRADED_INDETERMINATE, never INSUFFICIENT_MARKETS", () => {
    expect(resolveCrossMarketGroupSelection([], undefined, "DEGRADED")).toEqual({ kind: "DEGRADED_INDETERMINATE" });
  });

  it("1 group -> DEGRADED_INDETERMINATE, never INSUFFICIENT_MARKETS", () => {
    expect(resolveCrossMarketGroupSelection([group(WETH, 1)], undefined, "DEGRADED")).toEqual({ kind: "DEGRADED_INDETERMINATE" });
  });

  it("2+ groups -> RESOLVED, preserving snapshot order — DEGRADED with enough groups proceeds normally", () => {
    const groups = [group(WETH, 5), group(USDG, 3)];
    expect(resolveCrossMarketGroupSelection(groups, undefined, "DEGRADED")).toEqual({ kind: "RESOLVED", tokenOuts: [WETH, USDG] });
  });
});

describe("resolveCrossMarketGroupSelection — explicit selection", () => {
  it("every entry found -> RESOLVED, CALLER order preserved (not snapshot order)", () => {
    const groups = [group(WETH, 5), group(USDG, 3)];
    expect(resolveCrossMarketGroupSelection(groups, [USDG, WETH], "HEALTHY")).toEqual({ kind: "RESOLVED", tokenOuts: [USDG, WETH] });
  });

  it("match is case-insensitive but resolves to the snapshot's own canonical form", () => {
    const groups = [group(WETH, 5), group(USDG, 3)];
    const lowercased = WETH.toLowerCase() as typeof WETH;
    expect(resolveCrossMarketGroupSelection(groups, [lowercased, USDG], "HEALTHY")).toEqual({ kind: "RESOLVED", tokenOuts: [WETH, USDG] });
  });

  it("one entry not found, HEALTHY -> UNKNOWN_GROUP for that entry", () => {
    const groups = [group(WETH, 5)];
    expect(resolveCrossMarketGroupSelection(groups, [WETH, USDG], "HEALTHY")).toEqual({ kind: "UNKNOWN_GROUP", tokenOut: USDG });
  });

  it("one entry not found, DEGRADED -> DEGRADED_INDETERMINATE, never UNKNOWN_GROUP", () => {
    const groups = [group(WETH, 5)];
    expect(resolveCrossMarketGroupSelection(groups, [WETH, USDG], "DEGRADED")).toEqual({ kind: "DEGRADED_INDETERMINATE" });
  });

  it("no silent fallback: an unknown entry never causes the OTHER, valid entries to be silently returned as a partial RESOLVED list", () => {
    const groups = [group(WETH, 5)];
    const result = resolveCrossMarketGroupSelection(groups, [WETH, USDG], "HEALTHY");
    expect(result.kind).not.toBe("RESOLVED");
  });

  it("first missing entry (in caller order) is reported, not the last", () => {
    const groups = [group(WETH, 5)];
    const result = resolveCrossMarketGroupSelection(groups, [USDG, WETH], "HEALTHY");
    expect(result).toEqual({ kind: "UNKNOWN_GROUP", tokenOut: USDG });
  });
});

describe("classifyCrossMarketGroup — thin wrapper parity with direct classifyMatrixCandidates", () => {
  it("matches classifyMatrixCandidates exactly for an all-executable V3 group", () => {
    const candidates = [v3CandidateInput(addr(1)), v3CandidateInput(addr(2))];
    const direct = classifyMatrixCandidates(candidates, NVDA, 4663);
    const wrapped = classifyCrossMarketGroup(candidates, WETH, NVDA, 4663);
    expect(wrapped.executableCandidateCount).toBe(direct.executable.length);
    expect(wrapped.preconditionFailedCandidateCount).toBe(direct.preconditionFailed.length);
    expect(wrapped.verifiedCandidateCount).toBe(candidates.length);
    expect(wrapped.tokenOut).toBe(WETH);
  });

  it("matches classifyMatrixCandidates exactly for a mixed executable/precondition-failed group", () => {
    const candidates = [v3CandidateInput(addr(1)), hookedV4CandidateInput(poolId(1)), hookedV4CandidateInput(poolId(2), WETH, "0xdead")];
    const direct = classifyMatrixCandidates(candidates, NVDA, 4663);
    const wrapped = classifyCrossMarketGroup(candidates, WETH, NVDA, 4663);
    expect(wrapped.executableCandidateCount).toBe(direct.executable.length);
    expect(wrapped.preconditionFailedCandidateCount).toBe(direct.preconditionFailed.length);
    expect(direct.executable.length).toBe(2); // v3 + the ONE hooked V4 WITH hookData supplied
    expect(direct.preconditionFailed.length).toBe(1); // the hooked V4 WITHOUT hookData
  });

  it("candidate counts are exhaustive: verifiedCandidateCount === executableCandidateCount + preconditionFailedCandidateCount", () => {
    const candidates = [v3CandidateInput(addr(1)), hookedV4CandidateInput(poolId(1)), hookedV4CandidateInput(poolId(2)), hookedV4CandidateInput(poolId(3), WETH, "0xdead")];
    const wrapped = classifyCrossMarketGroup(candidates, WETH, NVDA, 4663);
    expect(wrapped.verifiedCandidateCount).toBe(wrapped.executableCandidateCount + wrapped.preconditionFailedCandidateCount);
  });

  it("an all-precondition-failed group has verifiedCandidateCount === preconditionFailedCandidateCount and zero executable", () => {
    const candidates = [hookedV4CandidateInput(poolId(1)), hookedV4CandidateInput(poolId(2))];
    const wrapped = classifyCrossMarketGroup(candidates, WETH, NVDA, 4663);
    expect(wrapped.executableCandidateCount).toBe(0);
    expect(wrapped.preconditionFailedCandidateCount).toBe(2);
    expect(wrapped.verifiedCandidateCount).toBe(2);
  });

  it("an empty candidate array classifies as zero/zero/zero", () => {
    const wrapped = classifyCrossMarketGroup([], WETH, NVDA, 4663);
    expect(wrapped).toEqual({ tokenOut: WETH, verifiedCandidateCount: 0, executableCandidateCount: 0, preconditionFailedCandidateCount: 0 });
  });

  it("preserves the NATIVE_ETH sentinel as the echoed tokenOut", () => {
    const nativeCandidate: ComparisonCandidateInput = {
      pool: pool({ pairAddress: poolId(9), quoteToken: { address: zeroAddress, name: "ETH", symbol: "ETH" } }),
      identity: verifiedV4Identity(poolId(9), zeroAddress, NVDA, 500, 10, zeroAddress),
    };
    const wrapped = classifyCrossMarketGroup([nativeCandidate], NATIVE_ETH, NVDA, 4663);
    expect(wrapped.tokenOut).toBe(NATIVE_ETH);
    expect(wrapped.executableCandidateCount).toBe(1);
  });
});

describe("computeCrossMarketBudget — exact arithmetic", () => {
  it("0 executable candidates -> 0 projected cells, fits", () => {
    const budget = computeCrossMarketBudget([0]);
    expect(budget.ladderLength).toBe(12);
    expect(budget.requestProjectedCells).toBe(0);
    expect(budget.maxCells).toBe(60);
    expect(budget.fitsExecutionBudget).toBe(true);
  });

  it("1 executable candidate -> 12 projected cells, fits", () => {
    expect(computeCrossMarketBudget([1]).requestProjectedCells).toBe(12);
    expect(computeCrossMarketBudget([1]).fitsExecutionBudget).toBe(true);
  });

  it("2 executable candidates -> 24 projected cells, fits", () => {
    expect(computeCrossMarketBudget([2]).requestProjectedCells).toBe(24);
    expect(computeCrossMarketBudget([2]).fitsExecutionBudget).toBe(true);
  });

  it("5 executable candidates (split across groups) -> exactly 60, fits", () => {
    expect(computeCrossMarketBudget([5]).requestProjectedCells).toBe(60);
    expect(computeCrossMarketBudget([5]).fitsExecutionBudget).toBe(true);
    expect(computeCrossMarketBudget([2, 3]).requestProjectedCells).toBe(60);
    expect(computeCrossMarketBudget([2, 3]).fitsExecutionBudget).toBe(true);
    expect(computeCrossMarketBudget([1, 1, 1, 1, 1]).fitsExecutionBudget).toBe(true);
  });

  it("6 executable candidates -> 72, does not fit", () => {
    const budget = computeCrossMarketBudget([6]);
    expect(budget.requestProjectedCells).toBe(72);
    expect(budget.fitsExecutionBudget).toBe(false);
  });

  it("combined groups may exceed the cap even though EACH group individually would not", () => {
    const budget = computeCrossMarketBudget([3, 3]); // 3*12=36 each, alone fine; combined 72
    expect(budget.requestProjectedCells).toBe(72);
    expect(budget.fitsExecutionBudget).toBe(false);
  });

  it("a group with zero executable candidates (all precondition-failed) contributes zero cells", () => {
    const budget = computeCrossMarketBudget([0, 5]); // one all-precondition-failed group + one 5-executable group
    expect(budget.requestProjectedCells).toBe(60);
    expect(budget.fitsExecutionBudget).toBe(true);
  });

  it("never prunes/truncates its own input — pure function of the array given", () => {
    const counts = [1, 1, 1, 1, 1, 1];
    const budget = computeCrossMarketBudget(counts);
    expect(counts).toHaveLength(6); // input untouched
    expect(budget.requestProjectedCells).toBe(72);
  });
});
