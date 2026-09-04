import type { DepthThresholdCellDto, DepthThresholdOutcomeDto, DepthThresholdPoolResultDto, ExecutionCandidateDto } from "@/domain/execution-comparison";
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
