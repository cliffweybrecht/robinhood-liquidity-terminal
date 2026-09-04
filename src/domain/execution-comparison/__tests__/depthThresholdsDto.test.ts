import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { DepthThresholdOutcome, MatrixCandidateRow, VerifiedPoolDepthResult, VerifiedPoolDepthThresholdsResult } from "@/domain/pool-quote";
import type { AssetExecutionDepthThresholds } from "../compareDepthThresholds";
import { toAssetExecutableDepthDto } from "../depthThresholdsDto";
import { NATIVE_ETH } from "../types";
import { NVDA, NVDA_ASSET, WETH } from "./fixtures";

const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;

function classifiedPoolIdentity(pairAddress: Hex) {
  return {
    chainId: "robinhood",
    pairAddress,
    dexId: "uniswap",
    canonicalAssetAddress: NVDA,
    canonicalAssetSymbol: "NVDA",
    canonicalAssetSide: "base" as const,
  };
}

function executableRow(pairAddress: Hex): MatrixCandidateRow {
  return {
    pool: classifiedPoolIdentity(pairAddress),
    family: "UNISWAP_V3",
    identityVerificationBlock: 90n,
    cells: [
      {
        amountIn: 1_000_000_000_000_000_000n,
        status: "QUOTED",
        amountOut: 216_922_828_056n,
        analyticsStatus: "OK",
        executionPrice: { numerator: 987n, denominator: 1000n },
        priceImpactBps: { numerator: -5n, denominator: 1n },
        gasEstimate: 132_533n,
        evidence: [],
      },
      {
        amountIn: 10_000_000_000_000_000_000n,
        status: "RPC_ERROR",
        analyticsStatus: "RPC_ERROR",
        evidence: [],
      },
    ],
  };
}

function preconditionFailedRow(pairAddress: Hex): MatrixCandidateRow {
  return {
    pool: classifiedPoolIdentity(pairAddress),
    family: "UNISWAP_V4",
    identityVerificationBlock: 90n,
    cells: [
      {
        amountIn: 1_000_000_000_000_000_000n,
        status: "PRECONDITION_FAILED",
        analyticsStatus: "INDETERMINATE",
        evidence: [],
        preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "this pool has an active hook" },
      },
    ],
  };
}

function outcome(kind: DepthThresholdOutcome["kind"]): DepthThresholdOutcome {
  if (kind === "WITHIN_THRESHOLD") {
    return {
      kind,
      qualifyingAmountIn: 1_000_000_000_000_000_000n,
      monotonicityObserved: true,
      upperRange: { kind: "GAPPED_CEILING", nextMeasuredAmountIn: 500_000_000_000_000_000_000n },
    };
  }
  if (kind === "EXCEEDED_AT_SMALLEST_SAMPLE") {
    return { kind, smallestMeasuredAmountIn: 2_000_000_000_000_000_000n };
  }
  return { kind } as DepthThresholdOutcome;
}

function snapshotResult(pools: readonly VerifiedPoolDepthResult[]): VerifiedPoolDepthThresholdsResult {
  return {
    status: "OK",
    blockNumber: 999n,
    tokenIn: NVDA,
    tokenOut: WETH,
    tokenInDecimals: 18,
    tokenOutDecimals: 18,
    sharedAnalyticsStatus: "OK",
    sharedEvidence: [],
    ladderAmountsIn: [1_000_000_000_000_000_000n, 10_000_000_000_000_000_000n],
    thresholdsBps: [50, 100],
    pools,
    bestVenueByThreshold: [
      { thresholdBps: 50, poolAddresses: [POOL_A] },
      { thresholdBps: 100, poolAddresses: [] },
    ],
  };
}

function assetResult(result: VerifiedPoolDepthThresholdsResult): AssetExecutionDepthThresholds {
  return {
    asset: NVDA_ASSET,
    groups: [{ tokenOut: WETH, tokenOutSymbol: "WETH", candidateCount: 2, v3Count: 1, v4Count: 1 }],
    selectedTokenOut: WETH,
    result,
  };
}

describe("toAssetExecutableDepthDto", () => {
  it("maps a full snapshot result — groups, selectedTokenOut, block, ladder, thresholds all present and stringified", () => {
    const result = snapshotResult([
      { row: executableRow(POOL_A), outcomesByThreshold: [{ thresholdBps: 50, outcome: outcome("WITHIN_THRESHOLD") }] },
      { row: preconditionFailedRow(POOL_B), outcomesByThreshold: [] },
    ]);
    const dto = toAssetExecutableDepthDto(assetResult(result), "2026-01-01T00:00:00.000Z");

    expect(dto.groups).toEqual([{ tokenOut: WETH, tokenOutSymbol: "WETH", candidateCount: 2, v3Count: 1, v4Count: 1 }]);
    expect(dto.selectedTokenOut).toBe(WETH);
    expect(dto.result.status).toBe("OK");
    if (dto.result.status !== "OK") throw new Error("expected OK");
    expect(dto.result.blockNumber).toBe("999");
    expect(dto.result.fetchedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(dto.result.tokenIn).toBe(NVDA);
    expect(dto.result.tokenOut).toBe(WETH);
    expect(dto.result.ladderAmountsIn).toEqual(["1000000000000000000", "10000000000000000000"]);
    expect(dto.result.thresholdsBps).toEqual([50, 100]);
  });

  it("maps the NATIVE_ETH sentinel for tokenOut/selectedTokenOut, never a raw zero address", () => {
    const result = snapshotResult([]);
    const dto = toAssetExecutableDepthDto(assetResult({ ...result, tokenOut: NATIVE_ETH as unknown as typeof WETH }));
    expect(dto.result.status === "OK" && dto.result.tokenOut).toBe(NATIVE_ETH);
  });

  it("maps BLOCK_PIN_FAILURE without a blockNumber/pools/ladder field", () => {
    const dto = toAssetExecutableDepthDto(
      assetResult({ status: "BLOCK_PIN_FAILURE", tokenIn: NVDA, tokenOut: WETH, evidence: [{ kind: "BLOCK_PIN_FAILURE", outcome: "rpc_error", source: "eth_blockNumber", detail: "boom" }] }),
    );
    expect(dto.result.status).toBe("BLOCK_PIN_FAILURE");
    expect(dto.result).not.toHaveProperty("blockNumber");
    expect(dto.result).not.toHaveProperty("pools");
    // No raw RPC evidence/detail ever leaks into the response.
    expect(JSON.stringify(dto.result)).not.toContain("boom");
  });

  it("maps an executable pool's ladder — every cell's amountIn/amountOut/gasEstimate is a string, priceImpactBps is a RationalDto", () => {
    const result = snapshotResult([{ row: executableRow(POOL_A), outcomesByThreshold: [{ thresholdBps: 50, outcome: outcome("WITHIN_THRESHOLD") }] }]);
    const dto = toAssetExecutableDepthDto(assetResult(result));
    if (dto.result.status !== "OK") throw new Error("expected OK");
    const poolDto = dto.result.pools[0]!;
    expect(poolDto.pairAddress).toBe(POOL_A);
    expect(poolDto.status).toBe("EXECUTABLE");
    expect(poolDto.preconditionFailure).toBeUndefined();
    expect(poolDto.ladder).toHaveLength(2);
    expect(poolDto.ladder[0]).toEqual({
      amountIn: "1000000000000000000",
      status: "QUOTED",
      amountOut: "216922828056",
      priceImpactBps: { numerator: "-5", denominator: "1" },
      analyticsStatus: "OK",
      gasEstimate: "132533",
      preconditionFailure: undefined,
    });
    expect(poolDto.ladder[1]!.status).toBe("RPC_ERROR");
    expect(poolDto.ladder[1]!.amountOut).toBeUndefined();
  });

  it("maps a precondition-failed pool row — PRECONDITION_FAILED status, its failure surfaced once at the row level, zero outcomesByThreshold", () => {
    const result = snapshotResult([{ row: preconditionFailedRow(POOL_B), outcomesByThreshold: [] }]);
    const dto = toAssetExecutableDepthDto(assetResult(result));
    if (dto.result.status !== "OK") throw new Error("expected OK");
    const poolDto = dto.result.pools[0]!;
    expect(poolDto.status).toBe("PRECONDITION_FAILED");
    expect(poolDto.preconditionFailure).toEqual({ code: "MISSING_HOOK_DATA", detail: "this pool has an active hook" });
    expect(poolDto.outcomesByThreshold).toEqual([]);
    expect(poolDto.ladder[0]!.status).toBe("PRECONDITION_FAILED");
  });

  it("maps WITHIN_THRESHOLD with a GAPPED_CEILING upperRange — never collapsing the gap distinction", () => {
    const result = snapshotResult([{ row: executableRow(POOL_A), outcomesByThreshold: [{ thresholdBps: 50, outcome: outcome("WITHIN_THRESHOLD") }] }]);
    const dto = toAssetExecutableDepthDto(assetResult(result));
    if (dto.result.status !== "OK") throw new Error("expected OK");
    const outcomeDto = dto.result.pools[0]!.outcomesByThreshold[0]!;
    expect(outcomeDto.kind).toBe("WITHIN_THRESHOLD");
    expect(outcomeDto.qualifyingAmountIn).toBe("1000000000000000000");
    expect(outcomeDto.monotonicityObserved).toBe(true);
    expect(outcomeDto.upperRange).toEqual({ kind: "GAPPED_CEILING", nextMeasuredAmountIn: "500000000000000000000" });
    expect(outcomeDto.smallestMeasuredAmountIn).toBeUndefined();
  });

  it("maps an OPEN upperRange without a nextMeasuredAmountIn field", () => {
    const withinOpen: DepthThresholdOutcome = { kind: "WITHIN_THRESHOLD", qualifyingAmountIn: 5000n, monotonicityObserved: true, upperRange: { kind: "OPEN" } };
    const result = snapshotResult([{ row: executableRow(POOL_A), outcomesByThreshold: [{ thresholdBps: 50, outcome: withinOpen }] }]);
    const dto = toAssetExecutableDepthDto(assetResult(result));
    if (dto.result.status !== "OK") throw new Error("expected OK");
    expect(dto.result.pools[0]!.outcomesByThreshold[0]!.upperRange).toEqual({ kind: "OPEN", nextMeasuredAmountIn: undefined });
  });

  it("maps EXCEEDED_AT_SMALLEST_SAMPLE — smallestMeasuredAmountIn present, qualifyingAmountIn/upperRange absent", () => {
    const result = snapshotResult([{ row: executableRow(POOL_A), outcomesByThreshold: [{ thresholdBps: 50, outcome: outcome("EXCEEDED_AT_SMALLEST_SAMPLE") }] }]);
    const dto = toAssetExecutableDepthDto(assetResult(result));
    if (dto.result.status !== "OK") throw new Error("expected OK");
    const outcomeDto = dto.result.pools[0]!.outcomesByThreshold[0]!;
    expect(outcomeDto).toEqual({ thresholdBps: 50, kind: "EXCEEDED_AT_SMALLEST_SAMPLE", smallestMeasuredAmountIn: "2000000000000000000" });
  });

  it("maps ANALYTICS_UNAVAILABLE and NO_QUOTED_SAMPLES as bare kind-only outcomes", () => {
    const result = snapshotResult([
      { row: executableRow(POOL_A), outcomesByThreshold: [{ thresholdBps: 50, outcome: outcome("ANALYTICS_UNAVAILABLE") }] },
    ]);
    const dto = toAssetExecutableDepthDto(assetResult(result));
    if (dto.result.status !== "OK") throw new Error("expected OK");
    expect(dto.result.pools[0]!.outcomesByThreshold[0]).toEqual({ thresholdBps: 50, kind: "ANALYTICS_UNAVAILABLE" });
  });

  it("maps the best-venue roll-up, including an empty poolAddresses array when nothing qualifies", () => {
    const result = snapshotResult([]);
    const dto = toAssetExecutableDepthDto(assetResult(result));
    if (dto.result.status !== "OK") throw new Error("expected OK");
    expect(dto.result.bestVenueByThreshold).toEqual([
      { thresholdBps: 50, poolAddresses: [POOL_A] },
      { thresholdBps: 100, poolAddresses: [] },
    ]);
  });

  it("never leaks internal evidence/RPC detail fields anywhere in the serialized DTO", () => {
    const row = executableRow(POOL_A);
    const result = snapshotResult([{ row, outcomesByThreshold: [{ thresholdBps: 50, outcome: outcome("WITHIN_THRESHOLD") }] }]);
    const dto = toAssetExecutableDepthDto(assetResult(result));
    const json = JSON.stringify(dto, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    expect(json).not.toContain("evidence");
    expect(json).not.toContain("identityVerificationBlock");
  });
});
