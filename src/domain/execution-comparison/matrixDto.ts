import type {
  ComparisonCandidateStatus,
  CrossPoolExecutionMatrixResult,
  MatrixCandidateRow,
  MatrixCell,
  MatrixRanking,
  QuoteAnalyticsStatus,
} from "@/domain/pool-quote";
import type { AssetExecutionMatrix } from "./compareMatrix";
import type { PreconditionFailureDto, RationalDto } from "./dto";
import { NATIVE_ETH, type TokenOutIdentifier } from "./types";

/**
 * The EXPLICIT, hand-written browser-facing response contract for the
 * execution matrix API route — mirrors `dto.ts`'s own discipline
 * exactly (every field named/mapped individually, every `bigint`
 * explicitly `.toString()`'d at the mapping boundary, never a generic/
 * recursive serializer that could leak an internal-only field by
 * default). Kept in its own file, sibling to `dto.ts`, rather than
 * added to it — `dto.ts`'s own header comment already scopes it to the
 * single-comparison response shape specifically.
 */

export interface MatrixCellDto {
  readonly amountIn: string;
  readonly status: ComparisonCandidateStatus;
  readonly amountOut?: string;
  readonly executionPrice?: RationalDto;
  readonly priceImpactBps?: RationalDto;
  readonly analyticsStatus: QuoteAnalyticsStatus;
  readonly gasEstimate?: string;
  readonly preconditionFailure?: PreconditionFailureDto;
}

export interface MatrixRowDto {
  readonly pairAddress: string;
  readonly dexId: string;
  readonly family: "UNISWAP_V3" | "UNISWAP_V4";
  readonly hookDataCallerSupplied?: boolean;
  readonly cells: readonly MatrixCellDto[];
}

export interface MatrixRankingDto {
  readonly amountIn: string;
  readonly rankedQuotedPoolAddresses: readonly string[];
  readonly bestCandidatePoolAddresses: readonly string[];
}

export interface MatrixResultSnapshotDto {
  readonly status: "OK";
  readonly blockNumber: string;
  readonly fetchedAt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountsIn: readonly string[];
  readonly tokenInDecimals?: number;
  readonly tokenOutDecimals?: number;
  readonly sharedAnalyticsStatus: QuoteAnalyticsStatus;
  readonly rows: readonly MatrixRowDto[];
  readonly rankingsByAmount: readonly MatrixRankingDto[];
}

export interface MatrixResultBlockPinFailureDto {
  readonly status: "BLOCK_PIN_FAILURE";
  readonly fetchedAt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountsIn: readonly string[];
}

export type MatrixResultDto = MatrixResultSnapshotDto | MatrixResultBlockPinFailureDto;

export interface ExecutionMatrixGroupDto {
  readonly tokenOut: string;
  readonly tokenOutSymbol?: string;
  readonly candidateCount: number;
  readonly v3Count: number;
  readonly v4Count: number;
}

export interface AssetExecutionMatrixDto {
  readonly groups: readonly ExecutionMatrixGroupDto[];
  readonly selectedTokenOut: string;
  readonly matrix: MatrixResultDto;
}

function tokenOutToString(tokenOut: TokenOutIdentifier): string {
  return tokenOut === NATIVE_ETH ? NATIVE_ETH : tokenOut;
}

function toRationalDto(value: { readonly numerator: bigint; readonly denominator: bigint } | undefined): RationalDto | undefined {
  if (value === undefined) return undefined;
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}

function toCellDto(cell: MatrixCell): MatrixCellDto {
  return {
    amountIn: cell.amountIn.toString(),
    status: cell.status,
    amountOut: cell.amountOut?.toString(),
    executionPrice: toRationalDto(cell.executionPrice),
    priceImpactBps: toRationalDto(cell.priceImpactBps),
    analyticsStatus: cell.analyticsStatus,
    gasEstimate: cell.gasEstimate?.toString(),
    preconditionFailure: cell.preconditionFailure ? { code: cell.preconditionFailure.code, detail: cell.preconditionFailure.detail } : undefined,
  };
}

function toRowDto(row: MatrixCandidateRow): MatrixRowDto {
  return {
    pairAddress: row.pool.pairAddress,
    dexId: row.pool.dexId,
    family: row.family,
    hookDataCallerSupplied: row.family === "UNISWAP_V4" ? row.hookDataCallerSupplied : undefined,
    cells: row.cells.map(toCellDto),
  };
}

function toRankingDto(ranking: MatrixRanking): MatrixRankingDto {
  return {
    amountIn: ranking.amountIn.toString(),
    rankedQuotedPoolAddresses: [...ranking.rankedQuotedPoolAddresses],
    bestCandidatePoolAddresses: [...ranking.bestCandidatePoolAddresses],
  };
}

function toMatrixResultDto(matrix: CrossPoolExecutionMatrixResult, fetchedAt: string): MatrixResultDto {
  if (matrix.status === "BLOCK_PIN_FAILURE") {
    return {
      status: "BLOCK_PIN_FAILURE",
      fetchedAt,
      tokenIn: matrix.tokenIn,
      tokenOut: matrix.tokenOut,
      amountsIn: matrix.amountsIn.map((a) => a.toString()),
    };
  }
  return {
    status: "OK",
    blockNumber: matrix.blockNumber.toString(),
    fetchedAt,
    tokenIn: matrix.tokenIn,
    tokenOut: matrix.tokenOut,
    amountsIn: matrix.amountsIn.map((a) => a.toString()),
    tokenInDecimals: matrix.tokenInDecimals,
    tokenOutDecimals: matrix.tokenOutDecimals,
    sharedAnalyticsStatus: matrix.sharedAnalyticsStatus,
    rows: matrix.rows.map(toRowDto),
    rankingsByAmount: matrix.rankingsByAmount.map(toRankingDto),
  };
}

/** The ONLY function permitted to construct the browser-facing matrix response body — every field is explicit, named, and independently mapped; nothing from the domain result is ever forwarded by reference or via a generic/recursive pass-through. */
export function toAssetExecutionMatrixDto(result: AssetExecutionMatrix, fetchedAt: string = new Date().toISOString()): AssetExecutionMatrixDto {
  return {
    groups: result.groups.map((g) => ({
      tokenOut: tokenOutToString(g.tokenOut),
      tokenOutSymbol: g.tokenOutSymbol,
      candidateCount: g.candidateCount,
      v3Count: g.v3Count,
      v4Count: g.v4Count,
    })),
    selectedTokenOut: tokenOutToString(result.selectedTokenOut),
    matrix: toMatrixResultDto(result.matrix, fetchedAt),
  };
}
