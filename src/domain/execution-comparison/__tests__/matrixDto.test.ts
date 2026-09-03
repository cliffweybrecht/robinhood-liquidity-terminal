import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { CrossPoolExecutionMatrixResult, MatrixCandidateRow } from "@/domain/pool-quote";
import type { AssetExecutionMatrix } from "../compareMatrix";
import { toAssetExecutionMatrixDto } from "../matrixDto";
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

function executableRow(): MatrixCandidateRow {
  return {
    pool: classifiedPoolIdentity(POOL_A),
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

function preconditionFailedRow(): MatrixCandidateRow {
  return {
    pool: classifiedPoolIdentity(POOL_B),
    family: "UNISWAP_V4",
    identityVerificationBlock: 90n,
    cells: [
      { amountIn: 1_000_000_000_000_000_000n, status: "PRECONDITION_FAILED", analyticsStatus: "INDETERMINATE", evidence: [], preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "no hookData" } },
      { amountIn: 10_000_000_000_000_000_000n, status: "PRECONDITION_FAILED", analyticsStatus: "INDETERMINATE", evidence: [], preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "no hookData" } },
    ],
  };
}

function matrixResult(rows: readonly MatrixCandidateRow[]): CrossPoolExecutionMatrixResult {
  return {
    status: "OK",
    blockNumber: 12345n,
    tokenIn: NVDA,
    tokenOut: WETH,
    amountsIn: [1_000_000_000_000_000_000n, 10_000_000_000_000_000_000n],
    tokenInDecimals: 18,
    tokenOutDecimals: 18,
    sharedAnalyticsStatus: "OK",
    sharedEvidence: [],
    rows,
    rankingsByAmount: [
      { amountIn: 1_000_000_000_000_000_000n, rankedQuotedPoolAddresses: [POOL_A], bestCandidatePoolAddresses: [POOL_A] },
      { amountIn: 10_000_000_000_000_000_000n, rankedQuotedPoolAddresses: [], bestCandidatePoolAddresses: [] },
    ],
  };
}

function assetExecutionMatrix(matrix: CrossPoolExecutionMatrixResult): AssetExecutionMatrix {
  return {
    asset: NVDA_ASSET,
    groups: [{ tokenOut: WETH, tokenOutSymbol: "WETH", candidateCount: 2, v3Count: 1, v4Count: 1 }],
    selectedTokenOut: WETH,
    matrix,
  };
}

describe("toAssetExecutionMatrixDto", () => {
  it("maps every bigint field to a decimal string explicitly", () => {
    const dto = toAssetExecutionMatrixDto(assetExecutionMatrix(matrixResult([executableRow()])), "2026-01-01T00:00:00.000Z");
    expect(dto.matrix.status).toBe("OK");
    if (dto.matrix.status !== "OK") throw new Error("expected OK");
    expect(dto.matrix.blockNumber).toBe("12345");
    expect(dto.matrix.amountsIn).toEqual(["1000000000000000000", "10000000000000000000"]);
    const row = dto.matrix.rows[0]!;
    expect(row.cells[0]!.amountIn).toBe("1000000000000000000");
    expect(row.cells[0]!.amountOut).toBe("216922828056");
    expect(row.cells[0]!.gasEstimate).toBe("132533");
    expect(row.cells[0]!.executionPrice).toEqual({ numerator: "987", denominator: "1000" });
  });

  it("includes a PRECONDITION_FAILED row's cells, one per amountsIn entry, never filtered out of the response", () => {
    const dto = toAssetExecutionMatrixDto(assetExecutionMatrix(matrixResult([executableRow(), preconditionFailedRow()])));
    if (dto.matrix.status !== "OK") throw new Error("expected OK");
    expect(dto.matrix.rows).toHaveLength(2);
    const hookedRow = dto.matrix.rows[1]!;
    expect(hookedRow.cells).toHaveLength(2);
    expect(hookedRow.cells.every((c) => c.status === "PRECONDITION_FAILED" && c.preconditionFailure?.code === "MISSING_HOOK_DATA")).toBe(true);
  });

  it("preserves per-cell independent status — an RPC_ERROR cell never becomes a fabricated value", () => {
    const dto = toAssetExecutionMatrixDto(assetExecutionMatrix(matrixResult([executableRow()])));
    if (dto.matrix.status !== "OK") throw new Error("expected OK");
    const errCell = dto.matrix.rows[0]!.cells[1]!;
    expect(errCell.status).toBe("RPC_ERROR");
    expect(errCell.amountOut).toBeUndefined();
  });

  it("maps rankingsByAmount with string amountIn and address arrays, per size independently", () => {
    const dto = toAssetExecutionMatrixDto(assetExecutionMatrix(matrixResult([executableRow()])));
    if (dto.matrix.status !== "OK") throw new Error("expected OK");
    expect(dto.matrix.rankingsByAmount).toEqual([
      { amountIn: "1000000000000000000", rankedQuotedPoolAddresses: [POOL_A], bestCandidatePoolAddresses: [POOL_A] },
      { amountIn: "10000000000000000000", rankedQuotedPoolAddresses: [], bestCandidatePoolAddresses: [] },
    ]);
  });

  it("maps a BLOCK_PIN_FAILURE result without any row/ranking fields", () => {
    const failure: CrossPoolExecutionMatrixResult = {
      status: "BLOCK_PIN_FAILURE",
      tokenIn: NVDA,
      tokenOut: WETH,
      amountsIn: [1_000_000_000_000_000_000n],
      evidence: [],
    };
    const dto = toAssetExecutionMatrixDto(assetExecutionMatrix(failure));
    expect(dto.matrix).toEqual({
      status: "BLOCK_PIN_FAILURE",
      fetchedAt: dto.matrix.status === "BLOCK_PIN_FAILURE" ? dto.matrix.fetchedAt : "",
      tokenIn: NVDA,
      tokenOut: WETH,
      amountsIn: ["1000000000000000000"],
    });
  });

  it("maps groups and selectedTokenOut, including the NATIVE_ETH sentinel as a plain string", () => {
    const nativeMatrix = assetExecutionMatrix(matrixResult([executableRow()]));
    const dto = toAssetExecutionMatrixDto({ ...nativeMatrix, selectedTokenOut: NATIVE_ETH });
    expect(dto.selectedTokenOut).toBe(NATIVE_ETH);
    expect(dto.groups).toEqual([{ tokenOut: WETH, tokenOutSymbol: "WETH", candidateCount: 2, v3Count: 1, v4Count: 1 }]);
  });

  it("never leaks internal-only fields (e.g. identityVerificationBlock, raw evidence detail is fine but internal identity objects are not) beyond the explicitly mapped shape", () => {
    const dto = toAssetExecutionMatrixDto(assetExecutionMatrix(matrixResult([executableRow()])));
    if (dto.matrix.status !== "OK") throw new Error("expected OK");
    const row = dto.matrix.rows[0]!;
    expect(Object.keys(row).sort()).toEqual(["cells", "dexId", "family", "hookDataCallerSupplied", "pairAddress"].sort());
  });
});
