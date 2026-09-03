import type { ExecutionCandidateDto, MatrixCellDto, MatrixRankingDto, MatrixRowDto } from "@/domain/execution-comparison";
import {
  amountInLabel,
  bestExecutionLabel,
  formatAmountOut,
  formatAmountOutFull,
  formatExecutionPrice,
  formatExecutionPriceFull,
  formatGasEstimate,
  formatGroupLabel,
  formatImpactPercent,
  isBestCandidate,
  PRECONDITION_DETAIL_COPY,
  sharedAnalyticsUnavailableNote,
  statusCopy,
} from "./executionFormatting";

/**
 * Pure, framework-independent presentation helpers for the Execution
 * Matrix panel — mirrors `executionFormatting.ts`'s own discipline
 * exactly (kept out of the client component so table/winner-band/
 * status rules are unit-testable without React/DOM), and REUSES every
 * per-cell value formatter from that file verbatim (`formatAmountOut`/
 * `formatExecutionPrice`/`formatImpactPercent`/`formatGasEstimate`/
 * `formatGroupLabel`/`amountInLabel`/`isBestCandidate`/
 * `bestExecutionLabel`/`sharedAnalyticsUnavailableNote`/
 * `PRECONDITION_DETAIL_COPY`) — a matrix cell's own value formatting is
 * IDENTICAL to a single-comparison candidate's; only the row/column
 * orchestration around it is new.
 */

export {
  amountInLabel,
  bestExecutionLabel,
  formatAmountOut,
  formatAmountOutFull,
  formatExecutionPrice,
  formatExecutionPriceFull,
  formatGasEstimate,
  formatGroupLabel,
  formatImpactPercent,
  isBestCandidate,
  sharedAnalyticsUnavailableNote,
};

/**
 * `statusCopy` (executionFormatting.ts) is typed for a full
 * `ExecutionCandidateDto` (it needs `status`/`preconditionFailure`,
 * ignores everything else) — a matrix cell doesn't carry `pairAddress`/
 * `dexId`/`family` itself (those live once, on the row). This adapter
 * builds a real, honest `ExecutionCandidateDto`-shaped value from the
 * row's own identity fields plus the cell's own status fields, so the
 * EXACT SAME, already-tested `statusCopy` logic is reused verbatim —
 * never a second, independently-written status-copy table.
 */
export function matrixCellStatusCopy(row: Pick<MatrixRowDto, "pairAddress" | "dexId" | "family">, cell: MatrixCellDto): string {
  const asCandidate: ExecutionCandidateDto = {
    pairAddress: row.pairAddress,
    dexId: row.dexId,
    family: row.family,
    status: cell.status,
    analyticsStatus: cell.analyticsStatus,
    preconditionFailure: cell.preconditionFailure,
  };
  return statusCopy(asCandidate);
}

/** A row is PRECONDITION_FAILED when every one of its cells is — by construction (compareVerifiedPoolsAcrossExactInputs's own `classifyMatrixCandidates`), a row-wide precondition (missing hookData) always produces this shape: identical status on every column, never a mix. */
export function isRowPreconditionFailed(row: MatrixRowDto): boolean {
  return row.cells.length > 0 && row.cells.every((c) => c.status === "PRECONDITION_FAILED");
}

/** The row-level explanation for a `PRECONDITION_FAILED` row — reuses `PRECONDITION_DETAIL_COPY` verbatim, keyed off the first cell's own failure code (every cell in the row shares the identical code — see `isRowPreconditionFailed`). */
export function rowPreconditionDetail(row: MatrixRowDto): string | undefined {
  const code = row.cells[0]?.preconditionFailure?.code;
  return code ? PRECONDITION_DETAIL_COPY[code] : undefined;
}

/**
 * Compares two ADJACENT columns' own SERVER-authoritative
 * `bestCandidatePoolAddresses` sets (order-insensitive, case-
 * insensitive) — this is a comparison between two already-computed
 * server results, never a new ranking computation, so it does not
 * violate "browser never recomputes ranking." Returns `true` when the
 * winner set genuinely differs between the two columns.
 */
function bestSetChanged(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a.map((x) => x.toLowerCase()));
  const setB = new Set(b.map((x) => x.toLowerCase()));
  if (setA.size !== setB.size) return true;
  for (const addr of setA) {
    if (!setB.has(addr)) return true;
  }
  return false;
}

/**
 * Indices (into `rankingsByAmount`/`amountsIn`) of every ADJACENT pair
 * of sampled sizes where the authoritative best-venue set changed.
 * NEVER computes or implies an exact crossover amount — only "the
 * winner set at column i differs from the winner set at column i+1,"
 * derived purely from two already-authoritative server values. Empty
 * when there's zero or one column, or when the winner never changes.
 */
export function winnerTransitionIndices(rankingsByAmount: readonly MatrixRankingDto[]): readonly number[] {
  const indices: number[] = [];
  for (let i = 1; i < rankingsByAmount.length; i++) {
    if (bestSetChanged(rankingsByAmount[i - 1]!.bestCandidatePoolAddresses, rankingsByAmount[i]!.bestCandidatePoolAddresses)) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Human-readable, explicitly SAMPLED (never interpolated) statement of
 * a winner-set change between two adjacent sampled sizes — e.g. "Best
 * venue changed between 100 and 500 NVDA." `tokenInDecimals` formats
 * the LADDER's own sizes (amountsIn is denominated in `tokenIn`, the
 * asset being sold) — reuses `formatAmountOut` (generic bigint-string +
 * decimals formatting, despite its name) rather than a new formatter,
 * since the underlying formatting operation is identical regardless of
 * which side of the trade the amount belongs to.
 */
export function winnerTransitionText(amountsIn: readonly string[], tokenInDecimals: number | undefined, transitionIndex: number, symbol: string): string {
  const before = formatAmountOut(amountsIn[transitionIndex - 1], tokenInDecimals);
  const after = formatAmountOut(amountsIn[transitionIndex], tokenInDecimals);
  return `Best venue changed between sampled sizes ${before} and ${after} ${symbol}.`;
}
