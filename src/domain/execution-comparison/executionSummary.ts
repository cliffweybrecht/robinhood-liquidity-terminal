import { zeroAddress, type Address, type Hex } from "viem";
import type { VerifiedPoolDepthResult, VerifiedPoolDepthThresholdsResult } from "@/domain/pool-quote";
import { NATIVE_ETH, type TokenOutIdentifier } from "./types";

/**
 * Phase 6G — Execution Intelligence Synthesis. A PURE, deterministic
 * derivation over an ALREADY-COMPUTED `VerifiedPoolDepthThresholdsResult`
 * (the exact same result the existing Executable-Depth Thresholds
 * feature already fetches) plus the snapshot's own `verificationHealth`.
 *
 * This module issues NO RPC calls, pins NO block, constructs NO
 * `VerifiedRobinhoodRpcClient`, and imports NOTHING from
 * `@/domain/pool-quote`'s own quote-dispatch surface — only the
 * already-computed RESULT TYPES. It never reads from the matrix or
 * single-comparison flows (different blocks, structurally excluded by
 * this file's own import list — see the adversarial review for the
 * static proof). See the Phase 6G schema-freeze report for the full
 * reasoning behind every type/field below — nothing here is
 * independently re-derived.
 */

// ---------------------------------------------------------------------------
// Frozen types
// ---------------------------------------------------------------------------

export type ExecutionSummaryAvailability = "AVAILABLE" | "UNAVAILABLE";

/**
 * Every candidate in the selected group falls into EXACTLY one of
 * these four — proven exhaustive against the existing depth-threshold
 * state machine (`DepthThresholdOutcome`'s own four kinds): a
 * `PRECONDITION_FAILED` row never reaches per-threshold derivation at
 * all (zero `outcomesByThreshold` entries, by construction); an
 * executable row's per-threshold outcomes are each one of
 * `NO_QUOTED_SAMPLES` / `ANALYTICS_UNAVAILABLE` / `EXCEEDED_AT_SMALLEST_SAMPLE`
 * / `WITHIN_THRESHOLD` — the last two both count as `PARTICIPATED`
 * (both are genuinely measured, one qualifying, one not — a pool that
 * was measured and lost is not "excluded," see the freeze report §8).
 */
export type VenueParticipationStatus = "PARTICIPATED" | "PRECONDITION_FAILED" | "NO_QUOTED_SAMPLES" | "ANALYTICS_UNAVAILABLE";

export interface VenueDisposition {
  readonly pairAddress: Hex;
  readonly status: VenueParticipationStatus;
}

/**
 * `NO_DIFFERENCE` is a first-class, expected, non-exceptional outcome
 * — never omitted, never implying anything went wrong. `SOLE_WINNER_CHANGED`
 * is used ONLY when both adjacent thresholds have an unambiguous,
 * untied sole winner and those winners differ — the one case sampled
 * evidence actually proves a "winner changed," as opposed to merely
 * "the winning SET differs" (`WINNER_SET_DIFFERS`, which covers every
 * other differing case, including any case involving a tie on either
 * side). See the freeze report §6's full stress-test table.
 */
export type VenueTransitionKind = "NO_DIFFERENCE" | "WINNER_SET_DIFFERS" | "SOLE_WINNER_CHANGED";

export interface VenueTransition {
  readonly fromThresholdBps: number;
  readonly toThresholdBps: number;
  readonly kind: VenueTransitionKind;
  readonly fromVenues: readonly Hex[];
  readonly toVenues: readonly Hex[];
}

/**
 * Typed, machine-readable non-claims — domain-authoritative CODES only.
 * Human disclosure copy belongs exclusively in presentation code (see
 * `executableDepthFormatting.ts`'s own copy table), never here.
 *
 *  - `CROSS_GROUP_COMPARISON_NOT_ATTEMPTED`: this synthesis NEVER
 *    compares across output-token groups — a permanent, structural
 *    scope limit of Phase 6G v1, always present.
 *  - `UNSAMPLED_TRADE_SIZES_UNKNOWN`: only the 12 fixed ladder points
 *    are known; nothing about any untested size, and nothing
 *    continuous/interpolated, is ever claimed — always present.
 *  - `FUTURE_BLOCK_EXECUTION_UNKNOWN`: every fact here is pinned to
 *    ONE historical block; nothing about any later block is known —
 *    always present.
 *  - `EXCLUDED_VENUES_NOT_COMPARED`: present if and only if at least
 *    one candidate's `VenueDisposition.status !== "PARTICIPATED"`.
 */
export type ExecutionSummaryUnknownReason =
  | "CROSS_GROUP_COMPARISON_NOT_ATTEMPTED"
  | "UNSAMPLED_TRADE_SIZES_UNKNOWN"
  | "FUTURE_BLOCK_EXECUTION_UNKNOWN"
  | "EXCLUDED_VENUES_NOT_COMPARED";

export interface ExecutionSummaryUnavailable {
  readonly availability: "UNAVAILABLE";
  readonly tokenIn: Address;
  readonly tokenOut: TokenOutIdentifier;
  readonly unknown: readonly ExecutionSummaryUnknownReason[];
}

export interface ExecutionSummaryAvailable {
  readonly availability: "AVAILABLE";
  readonly tokenIn: Address;
  readonly tokenOut: TokenOutIdentifier;
  readonly blockNumber: bigint;
  /** `verificationHealth === "HEALTHY"` — whether the DISCOVERED candidate set is proven complete. Orthogonal to how well any discovered candidate measured. */
  readonly candidateSetComplete: boolean;
  /** `sharedAnalyticsStatus === "OK"` — whether the ONE request-wide shared decimals read succeeded. A request-wide cause, never a per-venue fact. */
  readonly sharedAnalyticsAvailable: boolean;
  /** One entry per candidate in the selected group — exhaustive, mutually exclusive. No scalar count replaces this. */
  readonly venueDispositions: readonly VenueDisposition[];
  /** Copied VERBATIM from the underlying depth-thresholds result — never recomputed. */
  readonly bestVenueByThreshold: readonly { readonly thresholdBps: number; readonly poolAddresses: readonly Hex[] }[];
  /** Exactly 3 entries always, one per adjacent threshold pair, in ascending threshold order — never sparse. */
  readonly venueTransitions: readonly VenueTransition[];
  readonly venueDiversityAcrossThresholds: {
    /** Size of the set union of `poolAddresses` across all 4 threshold entries. */
    readonly distinctVenueCount: number;
    /** Count of `venueTransitions` entries with `kind !== "NO_DIFFERENCE"` — maximum value 3, by construction. Never a composite score. */
    readonly venueSetChangeCount: number;
  };
  readonly unknown: readonly ExecutionSummaryUnknownReason[];
}

export type ExecutionSummary = ExecutionSummaryAvailable | ExecutionSummaryUnavailable;

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

/**
 * Classifies one pool's disposition. Deliberately does NOT trust that
 * `NO_QUOTED_SAMPLES`/`ANALYTICS_UNAVAILABLE` are uniform across every
 * one of a pool's 4 threshold outcomes merely by inspecting the first
 * entry — it requires EVERY outcome to agree before classifying a pool
 * as excluded for either reason, so a future violation of that
 * upstream invariant would fail safe (falling through to
 * `PARTICIPATED`, which never hides that real per-threshold data
 * exists) rather than silently mis-excluding a pool that actually has
 * usable data.
 */
function classifyVenueDisposition(result: VerifiedPoolDepthResult): VenueParticipationStatus {
  if (result.outcomesByThreshold.length === 0) {
    return "PRECONDITION_FAILED";
  }
  if (result.outcomesByThreshold.every(({ outcome }) => outcome.kind === "NO_QUOTED_SAMPLES")) {
    return "NO_QUOTED_SAMPLES";
  }
  if (result.outcomesByThreshold.every(({ outcome }) => outcome.kind === "ANALYTICS_UNAVAILABLE")) {
    return "ANALYTICS_UNAVAILABLE";
  }
  return "PARTICIPATED";
}

/** Order-insensitive, case-insensitive set equality — mirrors `executionMatrixFormatting.ts`'s own `bestSetChanged` logic exactly, restated here (not imported) since that function lives in the UI layer and this is domain code; the DOMAIN never depends on the UI layer. */
function sameVenueSet(a: readonly Hex[], b: readonly Hex[]): boolean {
  const setA = new Set(a.map((x) => x.toLowerCase()));
  const setB = new Set(b.map((x) => x.toLowerCase()));
  if (setA.size !== setB.size) return false;
  for (const addr of setA) {
    if (!setB.has(addr)) return false;
  }
  return true;
}

function classifyTransition(fromVenues: readonly Hex[], toVenues: readonly Hex[]): VenueTransitionKind {
  if (sameVenueSet(fromVenues, toVenues)) return "NO_DIFFERENCE";
  if (fromVenues.length === 1 && toVenues.length === 1) return "SOLE_WINNER_CHANGED";
  return "WINNER_SET_DIFFERS";
}

function computeVenueTransitions(
  bestVenueByThreshold: readonly { readonly thresholdBps: number; readonly poolAddresses: readonly Hex[] }[],
): readonly VenueTransition[] {
  const transitions: VenueTransition[] = [];
  for (let i = 1; i < bestVenueByThreshold.length; i++) {
    const from = bestVenueByThreshold[i - 1]!;
    const to = bestVenueByThreshold[i]!;
    transitions.push({
      fromThresholdBps: from.thresholdBps,
      toThresholdBps: to.thresholdBps,
      kind: classifyTransition(from.poolAddresses, to.poolAddresses),
      fromVenues: from.poolAddresses,
      toVenues: to.poolAddresses,
    });
  }
  return transitions;
}

function computeDistinctVenueCount(bestVenueByThreshold: readonly { readonly poolAddresses: readonly Hex[] }[]): number {
  const union = new Set<string>();
  for (const entry of bestVenueByThreshold) {
    for (const addr of entry.poolAddresses) union.add(addr.toLowerCase());
  }
  return union.size;
}

/**
 * The ONLY entry point. Pure, synchronous, zero I/O — takes an
 * ALREADY-COMPUTED `VerifiedPoolDepthThresholdsResult` (never fetches
 * or recomputes one) plus the snapshot's own `verificationHealth`
 * (already-computed, threaded through by the caller — see
 * `compareDepthThresholds.ts`'s own `AssetExecutionDepthThresholds
 * .verificationHealth`), and derives the complete `ExecutionSummary`.
 */
export function synthesizeExecutionSummary(
  result: VerifiedPoolDepthThresholdsResult,
  verificationHealth: "HEALTHY" | "DEGRADED",
): ExecutionSummary {
  if (result.status === "BLOCK_PIN_FAILURE") {
    return {
      availability: "UNAVAILABLE",
      tokenIn: result.tokenIn,
      tokenOut: resolveTokenOut(result.tokenOut),
      unknown: ["CROSS_GROUP_COMPARISON_NOT_ATTEMPTED", "UNSAMPLED_TRADE_SIZES_UNKNOWN", "FUTURE_BLOCK_EXECUTION_UNKNOWN"],
    };
  }

  if (result.pools.length === 0) {
    return {
      availability: "UNAVAILABLE",
      tokenIn: result.tokenIn,
      tokenOut: resolveTokenOut(result.tokenOut),
      unknown: ["CROSS_GROUP_COMPARISON_NOT_ATTEMPTED", "UNSAMPLED_TRADE_SIZES_UNKNOWN", "FUTURE_BLOCK_EXECUTION_UNKNOWN"],
    };
  }

  const venueDispositions: VenueDisposition[] = result.pools.map((pool) => ({
    pairAddress: pool.row.pool.pairAddress,
    status: classifyVenueDisposition(pool),
  }));

  const venueTransitions = computeVenueTransitions(result.bestVenueByThreshold);

  const unknown: ExecutionSummaryUnknownReason[] = ["CROSS_GROUP_COMPARISON_NOT_ATTEMPTED", "UNSAMPLED_TRADE_SIZES_UNKNOWN", "FUTURE_BLOCK_EXECUTION_UNKNOWN"];
  if (venueDispositions.some((v) => v.status !== "PARTICIPATED")) {
    unknown.push("EXCLUDED_VENUES_NOT_COMPARED");
  }

  return {
    availability: "AVAILABLE",
    tokenIn: result.tokenIn,
    tokenOut: resolveTokenOut(result.tokenOut),
    blockNumber: result.blockNumber,
    candidateSetComplete: verificationHealth === "HEALTHY",
    sharedAnalyticsAvailable: result.sharedAnalyticsStatus === "OK",
    venueDispositions,
    bestVenueByThreshold: result.bestVenueByThreshold,
    venueTransitions,
    venueDiversityAcrossThresholds: {
      distinctVenueCount: computeDistinctVenueCount(result.bestVenueByThreshold),
      venueSetChangeCount: venueTransitions.filter((t) => t.kind !== "NO_DIFFERENCE").length,
    },
    unknown,
  };
}

/**
 * `VerifiedPoolDepthThresholdsResult.tokenOut` is a plain `Address` at
 * the pool-quote layer (that domain has no `NATIVE_ETH` sentinel
 * concept of its own — see `compute-verified-pool-depth-thresholds.ts`'s
 * own doc comment) — the zero-address-to-`NATIVE_ETH` translation
 * happens exactly once, here, at the execution-comparison boundary,
 * mirroring `snapshot.ts`'s own `deriveVerifiedTokenOut` translation
 * point exactly (never a second, independently-reasoned check).
 */
function resolveTokenOut(tokenOut: Address): TokenOutIdentifier {
  return tokenOut.toLowerCase() === zeroAddress ? NATIVE_ETH : tokenOut;
}
