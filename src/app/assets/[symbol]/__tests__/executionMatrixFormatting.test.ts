import { describe, expect, it } from "vitest";
import type { MatrixCellDto, MatrixRankingDto, MatrixRowDto } from "@/domain/execution-comparison";
import {
  isRowPreconditionFailed,
  matrixCellStatusCopy,
  rowPreconditionDetail,
  winnerTransitionIndices,
  winnerTransitionText,
} from "../executionMatrixFormatting";

const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function cell(overrides: Partial<MatrixCellDto> = {}): MatrixCellDto {
  return {
    amountIn: "1000000000000000000",
    status: "QUOTED",
    analyticsStatus: "OK",
    ...overrides,
  };
}

function row(overrides: Partial<MatrixRowDto> = {}): MatrixRowDto {
  return {
    pairAddress: POOL_A,
    dexId: "uniswap",
    family: "UNISWAP_V3",
    cells: [cell()],
    ...overrides,
  };
}

describe("matrixCellStatusCopy — reuses the real statusCopy via a real ExecutionCandidateDto-shaped adapter", () => {
  it("produces the exact same copy statusCopy already produces for a single comparison", () => {
    expect(matrixCellStatusCopy(row(), cell({ status: "QUOTED" }))).toBe("Quoted");
    expect(matrixCellStatusCopy(row(), cell({ status: "RPC_ERROR" }))).toBe("RPC error");
    expect(matrixCellStatusCopy(row(), cell({ status: "UNQUOTABLE" }))).toBe("Cannot execute");
  });

  it("produces the exact hooked-precondition copy, never a generic 'Error'", () => {
    const failed = cell({ status: "PRECONDITION_FAILED", preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "x" } });
    expect(matrixCellStatusCopy(row(), failed)).toBe("Hook parameters unsupported");
  });
});

describe("isRowPreconditionFailed / rowPreconditionDetail", () => {
  it("is true only when every cell in the row is PRECONDITION_FAILED", () => {
    const preconditionRow = row({
      cells: [
        cell({ status: "PRECONDITION_FAILED", preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "no hookData" } }),
        cell({ status: "PRECONDITION_FAILED", preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "no hookData" } }),
      ],
    });
    expect(isRowPreconditionFailed(preconditionRow)).toBe(true);
    expect(rowPreconditionDetail(preconditionRow)).toBe("This pool uses custom hook parameters that this app cannot safely construct yet.");
  });

  it("is false for a normal executable row, even if ONE cell happens to be PRECONDITION_FAILED (e.g. V4 uint128 overflow at one size only)", () => {
    const mixedRow = row({
      cells: [cell({ status: "QUOTED" }), cell({ status: "PRECONDITION_FAILED", preconditionFailure: { code: "AMOUNT_IN_EXCEEDS_V4_BOUND", detail: "x" } })],
    });
    expect(isRowPreconditionFailed(mixedRow)).toBe(false);
  });
});

describe("winnerTransitionIndices — sampled winner-set changes only, never a synthesized crossover", () => {
  it("returns no transitions when the winner never changes", () => {
    const rankings: MatrixRankingDto[] = [
      { amountIn: "1", rankedQuotedPoolAddresses: [POOL_A], bestCandidatePoolAddresses: [POOL_A] },
      { amountIn: "10", rankedQuotedPoolAddresses: [POOL_A], bestCandidatePoolAddresses: [POOL_A] },
    ];
    expect(winnerTransitionIndices(rankings)).toEqual([]);
  });

  it("detects a size-dependent winner change between adjacent columns", () => {
    const rankings: MatrixRankingDto[] = [
      { amountIn: "1", rankedQuotedPoolAddresses: [POOL_A, POOL_B], bestCandidatePoolAddresses: [POOL_A] },
      { amountIn: "10", rankedQuotedPoolAddresses: [POOL_A, POOL_B], bestCandidatePoolAddresses: [POOL_B] },
    ];
    expect(winnerTransitionIndices(rankings)).toEqual([1]);
  });

  it("does not report a change when a tie set is the same regardless of address array order", () => {
    const rankings: MatrixRankingDto[] = [
      { amountIn: "1", rankedQuotedPoolAddresses: [POOL_A, POOL_B], bestCandidatePoolAddresses: [POOL_A, POOL_B] },
      { amountIn: "10", rankedQuotedPoolAddresses: [POOL_A, POOL_B], bestCandidatePoolAddresses: [POOL_B, POOL_A] },
    ];
    expect(winnerTransitionIndices(rankings)).toEqual([]);
  });

  it("never returns anything resembling an interpolated numeric amount — indices only", () => {
    const rankings: MatrixRankingDto[] = [
      { amountIn: "1", rankedQuotedPoolAddresses: [POOL_A], bestCandidatePoolAddresses: [POOL_A] },
      { amountIn: "10", rankedQuotedPoolAddresses: [POOL_B], bestCandidatePoolAddresses: [POOL_B] },
    ];
    const result = winnerTransitionIndices(rankings);
    expect(result.every((i) => Number.isInteger(i))).toBe(true);
  });
});

describe("winnerTransitionText — sampled truth only, never a claimed exact crossover", () => {
  it("states the two adjacent SAMPLED sizes, never an interpolated value between them", () => {
    const amountsIn = ["50000000000000000000", "100000000000000000000"]; // 50, 100 (18dp)
    const text = winnerTransitionText(amountsIn, 18, 1, "NVDA");
    expect(text).toBe("Best venue changed between sampled sizes 50 and 100 NVDA.");
    expect(text).not.toMatch(/\b7[0-9](\.\d+)?\b/); // no fabricated midpoint like "72.4"
  });
});
