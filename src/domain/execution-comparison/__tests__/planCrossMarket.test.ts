import { zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { compareAssetExecutionCrossMarketFromSnapshot } from "../compareCrossMarket";
import { CrossMarketDepthTooLargeError } from "../errors";
import { planAssetExecutionCrossMarketFromSnapshot } from "../planCrossMarket";
import { NATIVE_ETH } from "../types";
import { NVDA, NVDA_ASSET, pool, snapshotFixture, verifiedV3Identity, verifiedV4Identity, USDG, WETH } from "./fixtures";
import type { ComparableExecutionGroup, VerifiedExecutionCandidate } from "../types";

function group(tokenOut: ComparableExecutionGroup["tokenOut"], candidateCount: number): ComparableExecutionGroup {
  return { tokenOut, candidateCount, v3Count: candidateCount, v4Count: 0 };
}

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function poolId(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function v3Candidate(pairAddress: `0x${string}`, tokenOut: `0x${string}` = WETH): VerifiedExecutionCandidate {
  return { pool: pool({ pairAddress, quoteToken: { address: tokenOut, name: "x", symbol: "X" } }), identity: verifiedV3Identity(pairAddress, NVDA, tokenOut), tokenOut };
}

function nativeEthCandidate(poolIdValue: `0x${string}`): VerifiedExecutionCandidate {
  return {
    pool: pool({ pairAddress: poolIdValue, quoteToken: { address: zeroAddress, name: "ETH", symbol: "ETH" } }),
    identity: verifiedV4Identity(poolIdValue, zeroAddress, NVDA, 500, 10, zeroAddress),
    tokenOut: NATIVE_ETH,
  };
}

function hookedV4Candidate(poolIdValue: `0x${string}`, tokenOut: `0x${string}` = WETH): VerifiedExecutionCandidate {
  const HOOK = "0xf869A735ec31e28f77A6f917157BE63729F60880" as `0x${string}`;
  return { pool: pool({ pairAddress: poolIdValue, quoteToken: { address: tokenOut, name: "x", symbol: "X" } }), identity: verifiedV4Identity(poolIdValue, tokenOut, NVDA, 8388608, 4, HOOK), tokenOut };
}

describe("planAssetExecutionCrossMarketFromSnapshot — purity / zero RPC", () => {
  it("is synchronous — its return value is not a Promise", () => {
    const snapshot = snapshotFixture({ groups: [group(WETH, 1), group(USDG, 1)], candidates: [v3Candidate(addr(1), WETH), v3Candidate(addr(2), USDG)] });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.status).toBeDefined();
  });

  async function importLines(): Promise<string[]> {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../planCrossMarket.ts", import.meta.url), "utf-8");
    // Only the actual `import ... from "..."` statements — doc-comment
    // PROSE in this file legitimately mentions "compareCrossMarket"/
    // "getBlockNumber" to EXPLAIN why they are absent, so a whole-file
    // substring check would false-positive on that explanatory text.
    // Checking only real import statements is the correct, precise
    // static-dependency assertion.
    return source.split("\n").filter((line) => /^\s*import\b/.test(line));
  }

  it("this module imports no RPC-provider code (static source inspection of actual import statements)", async () => {
    const lines = await importLines();
    expect(lines.some((line) => line.includes("robinhood-rpc"))).toBe(false);
  });

  it("this module never imports compareCrossMarket.ts (static source inspection of actual import statements)", async () => {
    const lines = await importLines();
    expect(lines.some((line) => line.includes("compareCrossMarket"))).toBe(false);
  });
});

describe("planAssetExecutionCrossMarketFromSnapshot — insufficient markets / unknown group / degraded", () => {
  it("HEALTHY + 0 groups -> INSUFFICIENT_MARKETS, availableMarketCount 0", () => {
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshotFixture({ groups: [], candidates: [] }));
    expect(result).toEqual({ status: "INSUFFICIENT_MARKETS", asset: NVDA_ASSET, requiredMarketCount: 2, availableMarketCount: 0 });
  });

  it("HEALTHY + 1 group -> INSUFFICIENT_MARKETS, availableMarketCount 1", () => {
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshotFixture({ groups: [group(WETH, 1)], candidates: [v3Candidate(addr(1), WETH)] }));
    expect(result).toEqual({ status: "INSUFFICIENT_MARKETS", asset: NVDA_ASSET, requiredMarketCount: 2, availableMarketCount: 1 });
  });

  it("DEGRADED + 0 or 1 apparent groups -> VERIFICATION_DEGRADED, never INSUFFICIENT_MARKETS", () => {
    expect(planAssetExecutionCrossMarketFromSnapshot(snapshotFixture({ groups: [], candidates: [], verificationHealth: "DEGRADED" }))).toEqual({
      status: "VERIFICATION_DEGRADED",
      asset: NVDA_ASSET,
    });
    expect(
      planAssetExecutionCrossMarketFromSnapshot(snapshotFixture({ groups: [group(WETH, 1)], candidates: [v3Candidate(addr(1), WETH)], verificationHealth: "DEGRADED" })),
    ).toEqual({ status: "VERIFICATION_DEGRADED", asset: NVDA_ASSET });
  });

  it("HEALTHY + explicit unknown group -> UNKNOWN_OUTPUT_GROUP", () => {
    const snapshot = snapshotFixture({ groups: [group(WETH, 1)], candidates: [v3Candidate(addr(1), WETH)] });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot, { tokenOuts: [WETH, USDG] });
    expect(result).toEqual({ status: "UNKNOWN_OUTPUT_GROUP", asset: NVDA_ASSET, tokenOut: USDG });
  });

  it("DEGRADED + explicit missing group -> VERIFICATION_DEGRADED, never UNKNOWN_OUTPUT_GROUP", () => {
    const snapshot = snapshotFixture({ groups: [group(WETH, 1)], candidates: [v3Candidate(addr(1), WETH)], verificationHealth: "DEGRADED" });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot, { tokenOuts: [WETH, USDG] });
    expect(result).toEqual({ status: "VERIFICATION_DEGRADED", asset: NVDA_ASSET });
  });
});

describe("planAssetExecutionCrossMarketFromSnapshot — DESCRIBED: candidateSetComplete / tokenDecimalsKnown", () => {
  it("HEALTHY -> candidateSetComplete: true", () => {
    const snapshot = snapshotFixture({ groups: [group(WETH, 1), group(USDG, 1)], candidates: [v3Candidate(addr(1), WETH), v3Candidate(addr(2), USDG)] });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    if (result.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    expect(result.candidateSetComplete).toBe(true);
  });

  it("DEGRADED + resolvable selection (2+ groups present) -> DESCRIBED with candidateSetComplete: false", () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(USDG, 1)],
      candidates: [v3Candidate(addr(1), WETH), v3Candidate(addr(2), USDG)],
      verificationHealth: "DEGRADED",
    });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    expect(result.status).toBe("DESCRIBED");
    if (result.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    expect(result.candidateSetComplete).toBe(false);
    // Facts about candidates actually present are still fully reported.
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]!.verifiedCandidateCount).toBe(1);
  });

  it("tokenDecimals known -> tokenDecimalsKnown: true", () => {
    const snapshot = snapshotFixture({ groups: [group(WETH, 1), group(USDG, 1)], candidates: [v3Candidate(addr(1), WETH), v3Candidate(addr(2), USDG)] });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    if (result.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    expect(result.tokenDecimalsKnown).toBe(true);
  });

  it("tokenDecimals unknown -> tokenDecimalsKnown: false, independent of budget fit", () => {
    const snapshot = snapshotFixture({
      asset: { ...NVDA_ASSET, tokenDecimals: null },
      groups: [group(WETH, 1), group(USDG, 1)],
      candidates: [v3Candidate(addr(1), WETH), v3Candidate(addr(2), USDG)],
    });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    if (result.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    expect(result.tokenDecimalsKnown).toBe(false);
    // tokenDecimalsKnown: false + fitsExecutionBudget: true is a VALID, non-contradictory plan state.
    expect(result.budget.fitsExecutionBudget).toBe(true);
  });

  it("no canExecute/isExecutable/executionReady/requestWillSucceed field exists anywhere on a DESCRIBED plan", () => {
    const snapshot = snapshotFixture({ groups: [group(WETH, 1), group(USDG, 1)], candidates: [v3Candidate(addr(1), WETH), v3Candidate(addr(2), USDG)] });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    const keys = Object.keys(result);
    for (const forbidden of ["canExecute", "isExecutable", "executionReady", "requestWillSucceed"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("no block/economic fields exist anywhere on a DESCRIBED plan (no amountOut/blockNumber/priceImpact/bestVenue/valueComparison)", () => {
    const snapshot = snapshotFixture({ groups: [group(WETH, 1), group(USDG, 1)], candidates: [v3Candidate(addr(1), WETH), v3Candidate(addr(2), USDG)] });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    const serialized = JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    for (const forbidden of ["amountOut", "blockNumber", "priceImpact", "bestVenue", "valueComparison", "normalized"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("planAssetExecutionCrossMarketFromSnapshot — budget: no pruning, over-budget is a normal DESCRIBED fact", () => {
  function manyCandidates(count: number, tokenOut: `0x${string}`, offset: number): VerifiedExecutionCandidate[] {
    return Array.from({ length: count }, (_, i) => v3Candidate(addr(offset + i + 1), tokenOut));
  }

  it("under budget -> DESCRIBED, fitsExecutionBudget: true, all groups present", () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 2), group(USDG, 2)],
      candidates: [...manyCandidates(2, WETH, 0), ...manyCandidates(2, USDG, 100)],
    });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    if (result.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    expect(result.budget.fitsExecutionBudget).toBe(true);
    expect(result.budget.requestProjectedCells).toBe(48);
    expect(result.groups).toHaveLength(2);
  });

  it("over budget -> STILL DESCRIBED (never a different status), fitsExecutionBudget: false, groups NEVER pruned", () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 3), group(USDG, 3)],
      candidates: [...manyCandidates(3, WETH, 0), ...manyCandidates(3, USDG, 100)],
    });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    expect(result.status).toBe("DESCRIBED");
    if (result.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    expect(result.budget.requestProjectedCells).toBe(72);
    expect(result.budget.fitsExecutionBudget).toBe(false);
    // No pruning: both groups still fully present with their real counts.
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]!.executableCandidateCount).toBe(3);
    expect(result.groups[1]!.executableCandidateCount).toBe(3);
  });

  it("a group of only precondition-failed candidates contributes zero projected cells but is not dropped", () => {
    const hooked = [hookedV4Candidate(poolId(1), USDG), hookedV4Candidate(poolId(2), USDG)];
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(USDG, 2)],
      candidates: [v3Candidate(addr(1), WETH), ...hooked],
    });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    if (result.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    const usdgGroup = result.groups.find((g) => g.tokenOut === USDG);
    expect(usdgGroup).toBeDefined();
    expect(usdgGroup!.executableCandidateCount).toBe(0);
    expect(usdgGroup!.preconditionFailedCandidateCount).toBe(2);
    expect(usdgGroup!.projectedCells).toBe(0);
  });

  it("projectedCells === executableCandidateCount * budget.ladderLength for every group", () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 4), group(USDG, 1)],
      candidates: [...manyCandidates(4, WETH, 0), ...manyCandidates(1, USDG, 100)],
    });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    if (result.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    for (const g of result.groups) {
      expect(g.projectedCells).toBe(g.executableCandidateCount * result.budget.ladderLength);
    }
  });
});

describe("planAssetExecutionCrossMarketFromSnapshot — group ordering", () => {
  it("omitted tokenOuts preserves snapshot group order", () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(USDG, 1), group(NATIVE_ETH, 1)],
      candidates: [v3Candidate(addr(1), WETH), v3Candidate(addr(2), USDG), nativeEthCandidate(poolId(3))],
    });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    if (result.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    expect(result.groups.map((g) => g.tokenOut)).toEqual([WETH, USDG, NATIVE_ETH]);
  });

  it("explicit tokenOuts preserves CALLER order", () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(USDG, 1)],
      candidates: [v3Candidate(addr(1), WETH), v3Candidate(addr(2), USDG)],
    });
    const result = planAssetExecutionCrossMarketFromSnapshot(snapshot, { tokenOuts: [USDG, WETH] });
    if (result.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    expect(result.groups.map((g) => g.tokenOut)).toEqual([USDG, WETH]);
  });
});

describe("planAssetExecutionCrossMarketFromSnapshot — hookData affects classification, matching Phase 6H's own contract", () => {
  it("hookData supplied for a hooked V4 candidate makes it executable, not precondition-failed", () => {
    const hookedPool = poolId(7);
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(USDG, 1)],
      candidates: [hookedV4Candidate(hookedPool, WETH), v3Candidate(addr(1), USDG)],
    });
    const withoutHookData = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    if (withoutHookData.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    const wethGroupNoHook = withoutHookData.groups.find((g) => g.tokenOut === WETH)!;
    expect(wethGroupNoHook.executableCandidateCount).toBe(0);
    expect(wethGroupNoHook.preconditionFailedCandidateCount).toBe(1);

    const hex: Hex = "0xdead";
    const withHookData = planAssetExecutionCrossMarketFromSnapshot(snapshot, { hookData: new Map([[hookedPool.toLowerCase(), hex]]) });
    if (withHookData.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    const wethGroupWithHook = withHookData.groups.find((g) => g.tokenOut === WETH)!;
    expect(wethGroupWithHook.executableCandidateCount).toBe(1);
    expect(wethGroupWithHook.preconditionFailedCandidateCount).toBe(0);
  });
});

describe("Planner/executor budget parity — RELEASE-CRITICAL (candidate-array assembly is independently restated in both, per Phase 6I's frozen architecture, so this parity is the load-bearing regression proof)", () => {
  function manyCandidates(count: number, tokenOut: `0x${string}`, offset: number): VerifiedExecutionCandidate[] {
    return Array.from({ length: count }, (_, i) => v3Candidate(addr(offset + i + 1), tokenOut));
  }

  it("given the SAME snapshot, an OVER-BUDGET selection: the planner's budget total exactly equals the executor's own CrossMarketDepthTooLargeError totals, and both agree it does not fit", async () => {
    // 3 WETH executable + 3 USDG executable = 6 x 12 = 72 > 60 — over
    // budget for BOTH the planner and the executor, from ONE snapshot.
    const snapshot = snapshotFixture({
      groups: [group(WETH, 3), group(USDG, 3)],
      candidates: [...manyCandidates(3, WETH, 0), ...manyCandidates(3, USDG, 100)],
    });

    const plan = planAssetExecutionCrossMarketFromSnapshot(snapshot);
    if (plan.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    expect(plan.budget.fitsExecutionBudget).toBe(false);

    const executorError: unknown = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" }).catch((e: unknown) => e);
    expect(executorError).toBeInstanceOf(CrossMarketDepthTooLargeError);
    const typedError = executorError as CrossMarketDepthTooLargeError;

    // Identical projected cell total, identical accept/reject verdict —
    // computed independently (planner never calls the executor, and
    // vice versa) from the SAME snapshot, SAME default group selection.
    expect(typedError.totalExecutableCells).toBe(plan.budget.requestProjectedCells);
    expect(typedError.max).toBe(plan.budget.maxCells);
  });

  it("given the SAME snapshot, an explicit selection, and the SAME hookData: per-group executable counts and the aggregate projected-cell total match between planner and executor", async () => {
    // 5 WETH executable + 2 USDG executable = 7 x 12 = 84 > 60 — chosen
    // deliberately over budget so the executor's own thrown error
    // exposes its internally-computed total for direct comparison
    // (a successful executor run exposes no equivalent labeled count).
    const snapshot = snapshotFixture({
      groups: [group(WETH, 5), group(USDG, 2)],
      candidates: [...manyCandidates(5, WETH, 0), ...manyCandidates(2, USDG, 100)],
    });

    const plan = planAssetExecutionCrossMarketFromSnapshot(snapshot, { tokenOuts: [WETH, USDG] });
    if (plan.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    const wethPlanGroup = plan.groups.find((g) => g.tokenOut === WETH)!;
    const usdgPlanGroup = plan.groups.find((g) => g.tokenOut === USDG)!;
    expect(wethPlanGroup.executableCandidateCount).toBe(5);
    expect(usdgPlanGroup.executableCandidateCount).toBe(2);

    const executorError: unknown = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA", tokenOuts: [WETH, USDG] }).catch((e: unknown) => e);
    expect(executorError).toBeInstanceOf(CrossMarketDepthTooLargeError);
    const typedError = executorError as CrossMarketDepthTooLargeError;
    expect(typedError.totalExecutableCells).toBe(plan.budget.requestProjectedCells);
  });
});
