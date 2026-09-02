import type {
  ComparisonCandidate,
  ComparisonCandidateStatus,
  ComparisonPreconditionFailure,
  CrossPoolComparisonResult,
  QuoteAnalyticsStatus,
} from "@/domain/pool-quote";
import { NATIVE_ETH, type ComparableExecutionGroup, type TokenOutIdentifier } from "./types";
import type { AssetExecutionComparison } from "./compare";

/**
 * The EXPLICIT, hand-written browser-facing response contract for the
 * execution comparison API route. Deliberately NOT a generic recursive
 * bigint-to-string serializer applied to the raw domain result —
 * mapping every field BY NAME here is what guarantees internal-only
 * fields (`QuoteEvidence`/`sharedEvidence` arrays, `identityVerificationBlock`,
 * full `ClassifiedPoolIdentity`, etc.) can never leak to the browser
 * merely because they exist on the domain type; a recursive serializer
 * would expose them by default and require a separate allowlist to
 * exclude them. Every `bigint` field crossing this boundary becomes a
 * decimal STRING here, explicitly, at the point it is mapped — never
 * relying on `JSON.stringify` (which throws on a raw `bigint`).
 */

export interface RationalDto {
  readonly numerator: string;
  readonly denominator: string;
}

export interface PreconditionFailureDto {
  readonly code: ComparisonPreconditionFailure["code"];
  readonly detail: string;
}

export interface ExecutionCandidateDto {
  readonly pairAddress: string;
  readonly dexId: string;
  readonly family: "UNISWAP_V3" | "UNISWAP_V4";
  readonly status: ComparisonCandidateStatus;
  readonly amountOut?: string;
  readonly executionPrice?: RationalDto;
  readonly priceImpactBps?: RationalDto;
  readonly analyticsStatus: QuoteAnalyticsStatus;
  readonly gasEstimate?: string;
  readonly hookDataCallerSupplied?: boolean;
  readonly preconditionFailure?: PreconditionFailureDto;
}

export interface ExecutionComparisonSnapshotDto {
  readonly status: "OK";
  readonly blockNumber: string;
  readonly fetchedAt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: string;
  readonly tokenInDecimals?: number;
  readonly tokenOutDecimals?: number;
  readonly sharedAnalyticsStatus: QuoteAnalyticsStatus;
  readonly candidates: readonly ExecutionCandidateDto[];
  readonly ranking: {
    readonly rankedQuotedPoolAddresses: readonly string[];
    readonly bestCandidatePoolAddresses: readonly string[];
  };
}

export interface ExecutionComparisonBlockPinFailureDto {
  readonly status: "BLOCK_PIN_FAILURE";
  readonly fetchedAt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: string;
}

export type ExecutionComparisonResultDto = ExecutionComparisonSnapshotDto | ExecutionComparisonBlockPinFailureDto;

export interface ExecutionGroupDto {
  readonly tokenOut: string;
  readonly tokenOutSymbol?: string;
  readonly candidateCount: number;
  readonly v3Count: number;
  readonly v4Count: number;
}

export interface AssetExecutionComparisonDto {
  readonly groups: readonly ExecutionGroupDto[];
  readonly selectedTokenOut: string;
  readonly comparison: ExecutionComparisonResultDto;
}

function tokenOutToString(tokenOut: TokenOutIdentifier): string {
  return tokenOut === NATIVE_ETH ? NATIVE_ETH : tokenOut;
}

function toRationalDto(value: { readonly numerator: bigint; readonly denominator: bigint } | undefined): RationalDto | undefined {
  if (value === undefined) return undefined;
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}

function toCandidateDto(candidate: ComparisonCandidate): ExecutionCandidateDto {
  return {
    pairAddress: candidate.pool.pairAddress,
    dexId: candidate.pool.dexId,
    family: candidate.family,
    status: candidate.status,
    amountOut: candidate.amountOut?.toString(),
    executionPrice: toRationalDto(candidate.executionPrice),
    priceImpactBps: toRationalDto(candidate.priceImpactBps),
    analyticsStatus: candidate.analyticsStatus,
    gasEstimate: candidate.metadata?.gasEstimate?.toString(),
    hookDataCallerSupplied: candidate.family === "UNISWAP_V4" ? candidate.hookDataCallerSupplied : undefined,
    preconditionFailure: candidate.preconditionFailure
      ? { code: candidate.preconditionFailure.code, detail: candidate.preconditionFailure.detail }
      : undefined,
  };
}

function toComparisonResultDto(comparison: CrossPoolComparisonResult, fetchedAt: string): ExecutionComparisonResultDto {
  if (comparison.status === "BLOCK_PIN_FAILURE") {
    return {
      status: "BLOCK_PIN_FAILURE",
      fetchedAt,
      tokenIn: comparison.tokenIn,
      tokenOut: comparison.tokenOut,
      amountIn: comparison.amountIn.toString(),
    };
  }
  return {
    status: "OK",
    blockNumber: comparison.blockNumber.toString(),
    fetchedAt,
    tokenIn: comparison.tokenIn,
    tokenOut: comparison.tokenOut,
    amountIn: comparison.amountIn.toString(),
    tokenInDecimals: comparison.tokenInDecimals,
    tokenOutDecimals: comparison.tokenOutDecimals,
    sharedAnalyticsStatus: comparison.sharedAnalyticsStatus,
    candidates: comparison.candidates.map(toCandidateDto),
    ranking: {
      rankedQuotedPoolAddresses: [...comparison.ranking.rankedQuotedPoolAddresses],
      bestCandidatePoolAddresses: [...comparison.ranking.bestCandidatePoolAddresses],
    },
  };
}

function toGroupDto(group: ComparableExecutionGroup): ExecutionGroupDto {
  return {
    tokenOut: tokenOutToString(group.tokenOut),
    tokenOutSymbol: group.tokenOutSymbol,
    candidateCount: group.candidateCount,
    v3Count: group.v3Count,
    v4Count: group.v4Count,
  };
}

/** The ONLY function permitted to construct the browser-facing response body — every field is explicit, named, and independently mapped; nothing from the domain result is ever forwarded by reference or via a generic/recursive pass-through. */
export function toAssetExecutionComparisonDto(result: AssetExecutionComparison, fetchedAt: string = new Date().toISOString()): AssetExecutionComparisonDto {
  return {
    groups: result.groups.map(toGroupDto),
    selectedTokenOut: tokenOutToString(result.selectedTokenOut),
    comparison: toComparisonResultDto(result.comparison, fetchedAt),
  };
}
