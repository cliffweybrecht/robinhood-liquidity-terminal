import type {
  ComparisonCandidateStatus,
  DepthThresholdOutcome,
  QuoteAnalyticsStatus,
  UpperRangeClassification,
  VerifiedPoolDepthResult,
  VerifiedPoolDepthThresholdsResult,
} from "@/domain/pool-quote";
import type { AssetExecutionDepthThresholds } from "./compareDepthThresholds";
import type { PreconditionFailureDto, RationalDto } from "./dto";
import type { ExecutionMatrixGroupDto } from "./matrixDto";
import { NATIVE_ETH, type TokenOutIdentifier } from "./types";

/**
 * The EXPLICIT, hand-written browser-facing response contract for the
 * Executable-Depth Thresholds API route — mirrors `matrixDto.ts`'s own
 * discipline exactly (every field named/mapped individually, every
 * `bigint` explicitly `.toString()`'d at the mapping boundary, never a
 * generic/recursive serializer that could leak an internal-only field
 * by default). Kept in its own file, sibling to `dto.ts`/`matrixDto.ts`,
 * rather than added to either — same "each response shape owns its own
 * mapper file" precedent `matrixDto.ts` itself already established
 * relative to `dto.ts`.
 */

export interface DepthThresholdCellDto {
  readonly amountIn: string;
  readonly status: ComparisonCandidateStatus;
  readonly amountOut?: string;
  readonly priceImpactBps?: RationalDto;
  readonly analyticsStatus: QuoteAnalyticsStatus;
  readonly gasEstimate?: string;
  readonly preconditionFailure?: PreconditionFailureDto;
}

export interface UpperRangeDto {
  readonly kind: UpperRangeClassification["kind"];
  /** Present only for `"CLEAN_CEILING"`/`"GAPPED_CEILING"`. */
  readonly nextMeasuredAmountIn?: string;
}

export interface DepthThresholdOutcomeDto {
  readonly thresholdBps: number;
  readonly kind: DepthThresholdOutcome["kind"];
  /** Present only for `"WITHIN_THRESHOLD"`. */
  readonly qualifyingAmountIn?: string;
  /** Present only for `"WITHIN_THRESHOLD"`. */
  readonly monotonicityObserved?: boolean;
  /** Present only for `"WITHIN_THRESHOLD"`. */
  readonly upperRange?: UpperRangeDto;
  /** Present only for `"EXCEEDED_AT_SMALLEST_SAMPLE"`. */
  readonly smallestMeasuredAmountIn?: string;
}

export interface DepthThresholdPoolResultDto {
  readonly pairAddress: string;
  readonly dexId: string;
  readonly family: "UNISWAP_V3" | "UNISWAP_V4";
  readonly hookDataCallerSupplied?: boolean;
  readonly status: "EXECUTABLE" | "PRECONDITION_FAILED";
  /** Present only when `status === "PRECONDITION_FAILED"` — sourced from this row's own first cell (every cell in a precondition-failed row carries the identical row-wide precondition). */
  readonly preconditionFailure?: PreconditionFailureDto;
  /** Exactly 12 entries, ladder order preserved — present for both executable AND precondition-failed rows (a precondition-failed row's cells are all `PRECONDITION_FAILED`, mirroring the matrix's own row shape). */
  readonly ladder: readonly DepthThresholdCellDto[];
  /** Empty when `status === "PRECONDITION_FAILED"` — a row-wide precondition is never expressed as four repeated per-threshold outcomes. */
  readonly outcomesByThreshold: readonly DepthThresholdOutcomeDto[];
}

export interface BestVenueAtThresholdDto {
  readonly thresholdBps: number;
  readonly poolAddresses: readonly string[];
}

export interface DepthThresholdsResultSnapshotDto {
  readonly status: "OK";
  readonly blockNumber: string;
  readonly fetchedAt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly tokenInDecimals?: number;
  readonly tokenOutDecimals?: number;
  readonly sharedAnalyticsStatus: QuoteAnalyticsStatus;
  readonly ladderAmountsIn: readonly string[];
  readonly thresholdsBps: readonly number[];
  readonly pools: readonly DepthThresholdPoolResultDto[];
  readonly bestVenueByThreshold: readonly BestVenueAtThresholdDto[];
}

export interface DepthThresholdsResultBlockPinFailureDto {
  readonly status: "BLOCK_PIN_FAILURE";
  readonly fetchedAt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export type DepthThresholdsResultDto = DepthThresholdsResultSnapshotDto | DepthThresholdsResultBlockPinFailureDto;

export interface AssetExecutableDepthDto {
  readonly groups: readonly ExecutionMatrixGroupDto[];
  readonly selectedTokenOut: string;
  readonly result: DepthThresholdsResultDto;
}

/** Restated locally, not imported — `dto.ts`/`matrixDto.ts`'s own identical private helpers are not exported (`matrixDto.ts` restates its own copy of both rather than importing from `dto.ts`, the same established precedent this file follows). */
function tokenOutToString(tokenOut: TokenOutIdentifier): string {
  return tokenOut === NATIVE_ETH ? NATIVE_ETH : tokenOut;
}

function toRationalDto(value: { readonly numerator: bigint; readonly denominator: bigint } | undefined): RationalDto | undefined {
  if (value === undefined) return undefined;
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}

function toUpperRangeDto(upperRange: UpperRangeClassification): UpperRangeDto {
  return {
    kind: upperRange.kind,
    nextMeasuredAmountIn: upperRange.kind === "CLEAN_CEILING" || upperRange.kind === "GAPPED_CEILING" ? upperRange.nextMeasuredAmountIn.toString() : undefined,
  };
}

function toOutcomeDto(thresholdBps: number, outcome: DepthThresholdOutcome): DepthThresholdOutcomeDto {
  if (outcome.kind === "WITHIN_THRESHOLD") {
    return {
      thresholdBps,
      kind: outcome.kind,
      qualifyingAmountIn: outcome.qualifyingAmountIn.toString(),
      monotonicityObserved: outcome.monotonicityObserved,
      upperRange: toUpperRangeDto(outcome.upperRange),
    };
  }
  if (outcome.kind === "EXCEEDED_AT_SMALLEST_SAMPLE") {
    return { thresholdBps, kind: outcome.kind, smallestMeasuredAmountIn: outcome.smallestMeasuredAmountIn.toString() };
  }
  return { thresholdBps, kind: outcome.kind };
}

function toCellDto(cell: VerifiedPoolDepthResult["row"]["cells"][number]): DepthThresholdCellDto {
  return {
    amountIn: cell.amountIn.toString(),
    status: cell.status,
    amountOut: cell.amountOut?.toString(),
    priceImpactBps: toRationalDto(cell.priceImpactBps),
    analyticsStatus: cell.analyticsStatus,
    gasEstimate: cell.gasEstimate?.toString(),
    preconditionFailure: cell.preconditionFailure ? { code: cell.preconditionFailure.code, detail: cell.preconditionFailure.detail } : undefined,
  };
}

function toPoolResultDto(result: VerifiedPoolDepthResult): DepthThresholdPoolResultDto {
  const isPreconditionFailed = result.outcomesByThreshold.length === 0 && result.row.cells.some((c) => c.status === "PRECONDITION_FAILED");
  return {
    pairAddress: result.row.pool.pairAddress,
    dexId: result.row.pool.dexId,
    family: result.row.family,
    hookDataCallerSupplied: result.row.family === "UNISWAP_V4" ? result.row.hookDataCallerSupplied : undefined,
    status: isPreconditionFailed ? "PRECONDITION_FAILED" : "EXECUTABLE",
    preconditionFailure: isPreconditionFailed ? result.row.cells[0]?.preconditionFailure : undefined,
    ladder: result.row.cells.map(toCellDto),
    outcomesByThreshold: result.outcomesByThreshold.map(({ thresholdBps, outcome }) => toOutcomeDto(thresholdBps, outcome)),
  };
}

function toResultDto(result: VerifiedPoolDepthThresholdsResult, fetchedAt: string): DepthThresholdsResultDto {
  if (result.status === "BLOCK_PIN_FAILURE") {
    return { status: "BLOCK_PIN_FAILURE", fetchedAt, tokenIn: result.tokenIn, tokenOut: result.tokenOut };
  }
  return {
    status: "OK",
    blockNumber: result.blockNumber.toString(),
    fetchedAt,
    tokenIn: result.tokenIn,
    tokenOut: result.tokenOut,
    tokenInDecimals: result.tokenInDecimals,
    tokenOutDecimals: result.tokenOutDecimals,
    sharedAnalyticsStatus: result.sharedAnalyticsStatus,
    ladderAmountsIn: result.ladderAmountsIn.map((a) => a.toString()),
    thresholdsBps: result.thresholdsBps,
    pools: result.pools.map(toPoolResultDto),
    bestVenueByThreshold: result.bestVenueByThreshold.map((b) => ({ thresholdBps: b.thresholdBps, poolAddresses: [...b.poolAddresses] })),
  };
}

/** The ONLY function permitted to construct the browser-facing Executable-Depth Thresholds response body — every field is explicit, named, and independently mapped; nothing from the domain result is ever forwarded by reference or via a generic/recursive pass-through. */
export function toAssetExecutableDepthDto(result: AssetExecutionDepthThresholds, fetchedAt: string = new Date().toISOString()): AssetExecutableDepthDto {
  return {
    groups: result.groups.map((g) => ({
      tokenOut: tokenOutToString(g.tokenOut),
      tokenOutSymbol: g.tokenOutSymbol,
      candidateCount: g.candidateCount,
      v3Count: g.v3Count,
      v4Count: g.v4Count,
    })),
    selectedTokenOut: tokenOutToString(result.selectedTokenOut),
    result: toResultDto(result.result, fetchedAt),
  };
}
