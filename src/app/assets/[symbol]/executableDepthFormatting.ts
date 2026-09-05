import type {
  DepthThresholdCellDto,
  DepthThresholdOutcomeDto,
  DepthThresholdPoolResultDto,
  ExecutionCandidateDto,
  ExecutionSummaryUnknownReason,
  VenueParticipationStatus,
  VenueTransitionDto,
  VenueTransitionKind,
} from "@/domain/execution-comparison";
import { amountInLabel, formatAmountOut, formatGasEstimate, formatGroupLabel, formatImpactPercent, PRECONDITION_DETAIL_COPY, statusCopy } from "./executionFormatting";

/**
 * Pure, framework-independent presentation helpers for the Executable
 * Depth panel — mirrors `executionMatrixFormatting.ts`'s own discipline
 * exactly (kept out of the client component so the threshold-copy /
 * gap-disclosure / status rules are unit-testable without React/DOM),
 * and REUSES every per-cell value formatter from `executionFormatting.ts`
 * verbatim where the underlying shape is identical — only the
 * upper-range/threshold-outcome copy below is new, since NOTHING in
 * this product has needed sampled-lower-bound / gap-disclosure language
 * before this feature.
 */

export { amountInLabel, formatAmountOut, formatGasEstimate, formatGroupLabel, formatImpactPercent };

const THRESHOLD_LABELS: Readonly<Record<number, string>> = { 50: "0.5%", 100: "1%", 200: "2%", 500: "5%" };

/** `50 -> "0.5%"`, `100 -> "1%"`, etc. — the four frozen thresholds only; falls back to a computed label for any other value rather than throwing, since this is presentation code and a server-driven `thresholdBps` should never be blindly trusted to match this exact frozen set forever. */
export function thresholdLabel(bps: number): string {
  const known = THRESHOLD_LABELS[bps];
  if (known) return known;
  return `${(bps / 100).toString()}%`;
}

/**
 * `statusCopy` (`executionFormatting.ts`) is typed for a full
 * `ExecutionCandidateDto` — a depth-ladder cell doesn't carry
 * `pairAddress`/`dexId`/`family` itself (those live once, on the pool
 * result). This adapter builds a real, honest `ExecutionCandidateDto`-
 * shaped value from the pool's own identity fields plus the cell's own
 * status fields, so the EXACT SAME, already-tested `statusCopy` logic
 * is reused verbatim — mirrors `executionMatrixFormatting.ts`'s own
 * `matrixCellStatusCopy` adapter exactly, against this feature's own
 * DTO shapes.
 */
export function depthCellStatusCopy(pool: Pick<DepthThresholdPoolResultDto, "pairAddress" | "dexId" | "family">, cell: DepthThresholdCellDto): string {
  const asCandidate: ExecutionCandidateDto = {
    pairAddress: pool.pairAddress,
    dexId: pool.dexId,
    family: pool.family,
    status: cell.status,
    analyticsStatus: cell.analyticsStatus,
    preconditionFailure: cell.preconditionFailure,
  };
  return statusCopy(asCandidate);
}

/** A pool is `PRECONDITION_FAILED` at the row level — set directly by the DTO mapper (`depthThresholdsDto.ts`'s `toPoolResultDto`), never re-derived from scanning `ladder` here. */
export function isPoolPreconditionFailed(pool: DepthThresholdPoolResultDto): boolean {
  return pool.status === "PRECONDITION_FAILED";
}

/** The row-level explanation for a `PRECONDITION_FAILED` pool — reuses `PRECONDITION_DETAIL_COPY` verbatim, keyed off the pool's own `preconditionFailure.code` (mirrors `executionMatrixFormatting.ts`'s own `rowPreconditionDetail`). */
export function poolPreconditionDetail(pool: DepthThresholdPoolResultDto): string | undefined {
  const code = pool.preconditionFailure?.code;
  return code ? PRECONDITION_DETAIL_COPY[code] : undefined;
}

/**
 * The frozen, exact product copy for one (pool, threshold) outcome —
 * see the Executable-Depth Thresholds frozen implementation plan
 * (Revision 2), section 18, for the six canonical strings this
 * function implements VERBATIM. Every claim states a TESTED lower
 * bound, at an explicit block, and NEVER implies continuous/exact
 * depth, monotonic behavior, or knowledge about an untested/unmeasured
 * amount. `symbol` is the canonical asset symbol (e.g. `"NVDA"`) —
 * matches `amountInLabel`'s own "authoritative for what the user
 * reads, not the raw contract address" discipline.
 */
export function thresholdOutcomeText(outcome: DepthThresholdOutcomeDto, tokenInDecimals: number | undefined, blockNumber: string, symbol: string): string {
  const pct = thresholdLabel(outcome.thresholdBps);
  const at = `at block ${blockNumber}`;

  if (outcome.kind === "NO_QUOTED_SAMPLES") {
    return `No executable quote could be obtained for this pool ${at}.`;
  }
  if (outcome.kind === "ANALYTICS_UNAVAILABLE") {
    return `Price-impact could not be computed for this pool ${at}.`;
  }
  if (outcome.kind === "EXCEEDED_AT_SMALLEST_SAMPLE") {
    const smallest = formatAmountOut(outcome.smallestMeasuredAmountIn, tokenInDecimals);
    return `The smallest tested size, ${smallest} ${symbol}, exceeded ${pct} impact ${at}.`;
  }

  // WITHIN_THRESHOLD
  const qualifying = formatAmountOut(outcome.qualifyingAmountIn, tokenInDecimals);
  const base = `At least ${qualifying} ${symbol} was executable within ${pct} impact ${at}.`;
  const upperRange = outcome.upperRange;
  if (!upperRange || upperRange.kind === "OPEN") {
    return `${base} No larger size was tested.`;
  }
  if (upperRange.kind === "CLEAN_CEILING") {
    const next = formatAmountOut(upperRange.nextMeasuredAmountIn, tokenInDecimals);
    return `${base} The next tested size, ${next} ${symbol}, exceeded ${pct} impact.`;
  }
  if (upperRange.kind === "GAPPED_CEILING") {
    const next = formatAmountOut(upperRange.nextMeasuredAmountIn, tokenInDecimals);
    return `${base} One or more larger tested sizes could not be determined; ${next} ${symbol} was measured above ${pct} impact.`;
  }
  // GAPPED_NO_CEILING
  return `${base} One or more larger tested sizes could not be determined; no larger size was successfully measured.`;
}

/**
 * The additive non-monotonic caution line — layered ONTO a
 * `WITHIN_THRESHOLD` outcome's own base copy above, NEVER replacing
 * it. `undefined` when nothing was observed (the common case).
 */
export function monotonicityCautionText(outcome: DepthThresholdOutcomeDto): string | undefined {
  if (outcome.kind !== "WITHIN_THRESHOLD" || outcome.monotonicityObserved !== false) return undefined;
  return "One or more smaller tested sizes for this pool showed HIGHER impact than this result — behavior was not consistently improving with smaller size at this block.";
}

/** `[]` -> "No tested venue qualifies at this threshold." (never a blank/omitted line); one or more addresses -> a short, comma-joined, shortened-address list — presentation-only ordering (the underlying tie itself is never broken by this function, which receives the server's own already-final `poolAddresses` array as-is). */
export function bestVenueText(poolAddresses: readonly string[]): string {
  if (poolAddresses.length === 0) return "No tested venue qualifies at this threshold.";
  return poolAddresses.map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`).join(", ");
}

// ---------------------------------------------------------------------------
// Phase 6G — Execution Intelligence Synthesis presentation copy. Every
// table below is a `Record<Union, string>` DELIBERATELY (not a
// `switch`/partial map) — TypeScript itself refuses to compile if a
// union member is ever added without a corresponding copy entry here,
// an exhaustiveness guarantee enforced at compile time, backed by a
// runtime test asserting the same. The domain/DTO layers carry ONLY
// the typed codes above; this is the ONE place their prose lives.
// ---------------------------------------------------------------------------

const VENUE_PARTICIPATION_COPY: Record<VenueParticipationStatus, string> = {
  PARTICIPATED: "This pool was measured against every threshold.",
  PRECONDITION_FAILED: "This pool could not be quoted at all — see the precondition detail below.",
  NO_QUOTED_SAMPLES: "Every tested sample failed to quote for this pool at this block.",
  ANALYTICS_UNAVAILABLE: "This pool's quotes succeeded, but price-impact could not be computed at this block.",
};

/** Reuses `VENUE_PARTICIPATION_COPY` verbatim — never a second, independently-written copy table. */
export function venueDispositionText(status: VenueParticipationStatus): string {
  return VENUE_PARTICIPATION_COPY[status];
}

/**
 * Deliberately says "sampled depth leader(s)," never "best-priced" —
 * `bestVenueByThreshold` (the field this copy describes) names the
 * pool(s) with the greatest sampled QUALIFYING TRADE SIZE at a given
 * impact threshold (`qualifyingAmountIn`, tie-preserved), which is NOT
 * the same claim as "best execution price" or "best quote at a given
 * trade size" — this copy must never imply either. See the
 * Executable-Depth Thresholds frozen plan's own `sampledDepthAtBps`
 * semantics for the underlying metric this describes.
 */
const VENUE_TRANSITION_COPY: Record<VenueTransitionKind, string> = {
  NO_DIFFERENCE: "The set of sampled depth leaders is the same at both thresholds.",
  WINNER_SET_DIFFERS: "The set of sampled depth leaders differs between these two thresholds — at least one side involved a tie, so this is not a proven single-venue change.",
  SOLE_WINNER_CHANGED: "The sole sampled depth leader changed between these two thresholds.",
};

/** Never uses the word "changed" for `WINNER_SET_DIFFERS` — only `SOLE_WINNER_CHANGED` (an untied leader on both sides) earns that word, per the frozen schema's own stress-tested semantics. */
export function venueTransitionText(transition: Pick<VenueTransitionDto, "kind" | "fromThresholdBps" | "toThresholdBps">): string {
  return `${thresholdLabel(transition.fromThresholdBps)} → ${thresholdLabel(transition.toThresholdBps)}: ${VENUE_TRANSITION_COPY[transition.kind]}`;
}

const UNKNOWN_REASON_COPY: Record<ExecutionSummaryUnknownReason, string> = {
  CROSS_GROUP_COMPARISON_NOT_ATTEMPTED: "This summary never compares across different output tokens (e.g. WETH vs. USDG) — only the currently selected group.",
  UNSAMPLED_TRADE_SIZES_UNKNOWN: "Only the 12 tested trade sizes are known — nothing about any other size, or continuous depth, is claimed.",
  FUTURE_BLOCK_EXECUTION_UNKNOWN: "Every fact here reflects one specific historical block — nothing about any later block is known.",
  EXCLUDED_VENUES_NOT_COMPARED: "One or more verified pools could not be included in this comparison — see per-pool detail below.",
};

/** Reuses `UNKNOWN_REASON_COPY` verbatim. */
export function unknownReasonText(reason: ExecutionSummaryUnknownReason): string {
  return UNKNOWN_REASON_COPY[reason];
}
