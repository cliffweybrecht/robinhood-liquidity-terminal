import type { Hex } from "viem";
import type { DepthThresholdOutcome, UpperRangeClassification, VerifiedPoolDepthResult } from "@/domain/pool-quote";
import type {
  AssetCrossMarketExecution,
  CrossMarketExecutionGroup,
} from "./compareCrossMarket";
import type {
  DepthThresholdCellDto,
  DepthThresholdOutcomeDto,
  DepthThresholdPoolResultDto,
  DepthThresholdsResultSnapshotDto,
  ExecutionSummaryDto,
  UpperRangeDto,
} from "./depthThresholdsDto";
import type { RationalDto } from "./dto";
import type { ExecutionSummary } from "./executionSummary";
import { NATIVE_ETH, type TokenOutIdentifier } from "./types";

/**
 * Phase 6H — Cross-Market Execution Synthesis DTO. A dedicated mapper,
 * sibling to `dto.ts`/`matrixDto.ts`/`depthThresholdsDto.ts` — this
 * phase's response shape is deliberately NOT forced into Phase 6G's
 * `AssetExecutableDepthDto` contract (that DTO is single-group; this one
 * is multi-group with an outer shared block). Reuses those files'
 * exported DTO TYPES directly (`DepthThresholdsResultSnapshotDto`,
 * `ExecutionSummaryDto`, and their own sub-types) — the SAME
 * cross-DTO-file type-reuse precedent `depthThresholdsDto.ts` itself
 * already established by importing `ExecutionMatrixGroupDto` from
 * `matrixDto.ts`. The MAPPING FUNCTIONS themselves are restated here,
 * not imported (those files' own equivalents are private, and every
 * sibling DTO file already restates this exact small, stable glue
 * independently rather than coupling to one another's internals — see
 * `depthThresholdsDto.ts`'s own header comment on this precedent).
 *
 * Same discipline throughout: every field named/mapped individually,
 * every `bigint` explicitly `.toString()`'d, never a generic/recursive
 * serializer. No normalization/ranking/winner field of any kind is ever
 * emitted — `valueComparison` is always the single frozen `UNAVAILABLE`
 * shape.
 */

export interface CrossMarketExecutionGroupDto {
  readonly tokenOut: string;
  readonly result: DepthThresholdsResultSnapshotDto;
  readonly summary: ExecutionSummaryDto;
}

export interface CrossMarketExecutionOkDto {
  readonly status: "OK";
  readonly blockNumber: string;
  readonly fetchedAt: string;
  readonly groups: readonly CrossMarketExecutionGroupDto[];
  readonly valueComparison: {
    readonly availability: "UNAVAILABLE";
    readonly reason: "NO_TRUSTED_NORMALIZATION_SOURCE";
  };
}

export interface CrossMarketExecutionInsufficientMarketsDto {
  readonly status: "INSUFFICIENT_MARKETS";
  readonly fetchedAt: string;
  readonly requiredMarketCount: 2;
  readonly availableMarketCount: 0 | 1;
}

export interface CrossMarketExecutionBlockPinFailureDto {
  readonly status: "BLOCK_PIN_FAILURE";
  readonly fetchedAt: string;
}

export type AssetCrossMarketExecutionDto = CrossMarketExecutionOkDto | CrossMarketExecutionInsufficientMarketsDto | CrossMarketExecutionBlockPinFailureDto;

function tokenOutToString(tokenOut: TokenOutIdentifier): string {
  return tokenOut === NATIVE_ETH ? NATIVE_ETH : tokenOut;
}

function toVenueAddresses(addresses: readonly Hex[]): readonly string[] {
  return [...addresses];
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

function toDepthThresholdsResultSnapshotDto(result: CrossMarketExecutionGroup["result"], fetchedAt: string): DepthThresholdsResultSnapshotDto {
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

/** Restated verbatim from `depthThresholdsDto.ts`'s own private `toExecutionSummaryDto` — Phase 6G's `ExecutionSummary` -> DTO mapping is NOT altered in any way; this is the identical mapping, applied here to each group's own summary. */
function toExecutionSummaryDto(summary: ExecutionSummary): ExecutionSummaryDto {
  if (summary.availability === "UNAVAILABLE") {
    return { availability: "UNAVAILABLE", tokenIn: summary.tokenIn, tokenOut: tokenOutToString(summary.tokenOut), unknown: [...summary.unknown] };
  }
  return {
    availability: "AVAILABLE",
    tokenIn: summary.tokenIn,
    tokenOut: tokenOutToString(summary.tokenOut),
    blockNumber: summary.blockNumber.toString(),
    candidateSetComplete: summary.candidateSetComplete,
    sharedAnalyticsAvailable: summary.sharedAnalyticsAvailable,
    venueDispositions: summary.venueDispositions.map((d) => ({ pairAddress: d.pairAddress, status: d.status })),
    bestVenueByThreshold: summary.bestVenueByThreshold.map((b) => ({ thresholdBps: b.thresholdBps, poolAddresses: toVenueAddresses(b.poolAddresses) })),
    venueTransitions: summary.venueTransitions.map((t) => ({
      fromThresholdBps: t.fromThresholdBps,
      toThresholdBps: t.toThresholdBps,
      kind: t.kind,
      fromVenues: toVenueAddresses(t.fromVenues),
      toVenues: toVenueAddresses(t.toVenues),
    })),
    venueDiversityAcrossThresholds: { ...summary.venueDiversityAcrossThresholds },
    unknown: [...summary.unknown],
  };
}

/**
 * The ONLY function permitted to construct the browser-facing
 * cross-market response body. `fetchedAt` is captured ONCE by the
 * caller (or defaulted here) and applied identically to the top-level
 * envelope and every group's own nested result — there is exactly one
 * fetch time for the whole request, mirroring there being exactly one
 * shared block.
 */
export function toAssetCrossMarketExecutionDto(result: AssetCrossMarketExecution, fetchedAt: string = new Date().toISOString()): AssetCrossMarketExecutionDto {
  if (result.status === "BLOCK_PIN_FAILURE") {
    return { status: "BLOCK_PIN_FAILURE", fetchedAt };
  }
  if (result.status === "INSUFFICIENT_MARKETS") {
    return {
      status: "INSUFFICIENT_MARKETS",
      fetchedAt,
      requiredMarketCount: result.requiredMarketCount,
      availableMarketCount: result.availableMarketCount,
    };
  }
  return {
    status: "OK",
    blockNumber: result.blockNumber.toString(),
    fetchedAt,
    groups: result.groups.map((group) => ({
      tokenOut: tokenOutToString(group.tokenOut),
      result: toDepthThresholdsResultSnapshotDto(group.result, fetchedAt),
      summary: toExecutionSummaryDto(group.summary),
    })),
    valueComparison: { availability: result.valueComparison.availability, reason: result.valueComparison.reason },
  };
}
