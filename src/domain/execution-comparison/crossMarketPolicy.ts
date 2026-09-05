import type { Address } from "viem";
import { classifyMatrixCandidates, type ComparisonCandidateInput } from "@/domain/pool-quote";
import { sameTokenOut } from "./compare";
import { DEPTH_THRESHOLD_LADDER_MULTIPLIERS } from "./compareDepthThresholds";
import type { ComparableExecutionGroup, TokenOutIdentifier, VerifiedExecutionSnapshot } from "./types";

/**
 * Phase 6I — Cross-Market Execution Planning. The ONE authoritative,
 * pure, RPC-free implementation of cross-market output-group selection,
 * candidate classification counts, and executable-cell budget
 * arithmetic. Consumed independently by `planCrossMarket.ts` (a pure
 * planner describing a proposed workload) and `compareCrossMarket.ts`
 * (Phase 6H's existing executor, which enforces this same policy before
 * spending any RPC call) — neither of those two modules is a dependency
 * of the other; both depend ONLY on this file (and the primitives it
 * itself depends on: `classifyMatrixCandidates` from pool-quote,
 * `sameTokenOut` from `./compare`, and the frozen ladder length from
 * `./compareDepthThresholds`).
 *
 * This module deliberately imports NOTHING from `./planCrossMarket`,
 * `./compareCrossMarket`, or `./errors` — every function here is total
 * (never throws for a well-formed input) and returns plain data, so it
 * has no use for this module's own thrown-error hierarchy. Throwing is
 * an EXECUTOR-layer policy choice (Phase 6H's own established
 * HTTP-error-shaped contract), never a POLICY-layer one.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The minimum number of SELECTED OUTPUT MARKETS required for a
 * meaningful cross-market operation. This is a domain-meaningfulness
 * threshold, NOT an RPC-call-budget constraint — it has no relationship
 * to `MAX_CROSS_MARKET_DEPTH_CELLS` below, and the two must never be
 * confused or unified. Comparing execution evidence across FEWER than 2
 * output markets isn't "cross-market" at all; it's single-market
 * execution, already fully served by the existing single-group
 * primitives (`compare.ts`/`compareMatrix.ts`/`compareDepthThresholds.ts`).
 */
export const MIN_CROSS_MARKET_OUTPUT_MARKETS = 2;

/**
 * The canonical, request-wide cap on projected executable-depth cells
 * across every selected output group combined — never per-group. See
 * `computeCrossMarketBudget`'s own doc comment for the exact formula
 * this bounds.
 */
export const MAX_CROSS_MARKET_DEPTH_CELLS = 60;

// ---------------------------------------------------------------------------
// Group selection
// ---------------------------------------------------------------------------

/**
 * The exhaustive result of resolving a cross-market group selection
 * against a live snapshot. `RESOLVED` is the only variant carrying
 * groups to proceed with; the other three are exhaustive reasons a
 * selection could not be resolved into a usable group list.
 */
export type CrossMarketGroupSelectionOutcome =
  | { readonly kind: "RESOLVED"; readonly tokenOuts: readonly TokenOutIdentifier[] }
  | { readonly kind: "UNKNOWN_GROUP"; readonly tokenOut: TokenOutIdentifier }
  | { readonly kind: "INSUFFICIENT_MARKETS"; readonly availableMarketCount: 0 | 1 }
  | { readonly kind: "DEGRADED_INDETERMINATE" };

/**
 * Resolves which output-token groups a proposed cross-market
 * request/plan would touch, against a live snapshot's own group
 * summary. PURE, TOTAL, NON-THROWING, DETERMINISTIC — this is the ONE
 * authoritative decision function both the planner and the executor
 * consume; neither may reimplement any part of this branching.
 *
 * Omitted `requested` selects every group already present on `groups`,
 * preserving the snapshot's OWN deterministic order (`snapshot.ts`'s
 * `buildGroups`) — never re-sorted here:
 *  - `HEALTHY` + `groups.length < MIN_CROSS_MARKET_OUTPUT_MARKETS` ->
 *    `INSUFFICIENT_MARKETS` (a settled fact: every candidate reached a
 *    final, non-transient verification outcome).
 *  - `DEGRADED` + `groups.length < MIN_CROSS_MARKET_OUTPUT_MARKETS` ->
 *    `DEGRADED_INDETERMINATE` (the true group count is UNPROVEN, not
 *    settled-low — a candidate that would complete this set might
 *    still be mid-verification).
 *  - Otherwise -> `RESOLVED`, snapshot order.
 *
 * An explicit `requested` list is assumed ALREADY shape-validated (at
 * least `MIN_CROSS_MARKET_OUTPUT_MARKETS` entries, well-formed
 * addresses/`NATIVE_ETH`, no case-insensitive duplicates) by whichever
 * request/caller layer sits above this function — this function's only
 * remaining job is checking EXISTENCE against the live snapshot, per
 * requested entry, in CALLER order (never reordered, never
 * deduplicated, never silently dropped):
 *  - every entry found -> `RESOLVED`, caller order, using each matched
 *    group's own canonical `tokenOut` form (never the caller's raw
 *    casing).
 *  - an entry not found, `HEALTHY` -> `UNKNOWN_GROUP` for that entry (a
 *    settled fact about a bad caller input).
 *  - an entry not found, `DEGRADED` -> `DEGRADED_INDETERMINATE` (the
 *    absence might be a transient verification gap, not a settled
 *    "this group doesn't exist" fact).
 */
export function resolveCrossMarketGroupSelection(
  groups: readonly ComparableExecutionGroup[],
  requested: readonly TokenOutIdentifier[] | undefined,
  verificationHealth: VerifiedExecutionSnapshot["verificationHealth"],
): CrossMarketGroupSelectionOutcome {
  if (requested === undefined) {
    if (groups.length < MIN_CROSS_MARKET_OUTPUT_MARKETS) {
      if (verificationHealth === "DEGRADED") {
        return { kind: "DEGRADED_INDETERMINATE" };
      }
      return { kind: "INSUFFICIENT_MARKETS", availableMarketCount: groups.length as 0 | 1 };
    }
    return { kind: "RESOLVED", tokenOuts: groups.map((g) => g.tokenOut) };
  }

  const resolved: TokenOutIdentifier[] = [];
  for (const tokenOut of requested) {
    const match = groups.find((g) => sameTokenOut(g.tokenOut, tokenOut));
    if (!match) {
      if (verificationHealth === "DEGRADED") {
        return { kind: "DEGRADED_INDETERMINATE" };
      }
      return { kind: "UNKNOWN_GROUP", tokenOut };
    }
    resolved.push(match.tokenOut);
  }
  return { kind: "RESOLVED", tokenOuts: resolved };
}

// ---------------------------------------------------------------------------
// Candidate classification
// ---------------------------------------------------------------------------

/**
 * One group's candidate classification counts. `verifiedCandidateCount`
 * is a FACT (the size of the array actually classified);
 * `executableCandidateCount`/`preconditionFailedCandidateCount` are
 * DERIVED from the SAME authoritative `classifyMatrixCandidates` every
 * other cross-pool primitive in this codebase already uses — this type
 * introduces NO new executability rule of its own.
 */
export interface CrossMarketGroupClassification {
  readonly tokenOut: TokenOutIdentifier;
  readonly verifiedCandidateCount: number;
  readonly executableCandidateCount: number;
  readonly preconditionFailedCandidateCount: number;
}

/**
 * A thin, direct wrapper over `classifyMatrixCandidates` — adds ZERO
 * new protocol/precondition logic, only reshapes its already-
 * authoritative output into three named counts so every consumer of
 * this policy module reports the identical numbers for the identical
 * input. Takes an ALREADY-BUILT candidate array; does not know about
 * `VerifiedExecutionSnapshot`, `hookData` maps, or how the array was
 * assembled — see this module's own header comment on why candidate
 * assembly is deliberately NOT centralized here.
 *
 * Every candidate in `candidates` is accounted for EXACTLY ONCE across
 * `executableCandidateCount` + `preconditionFailedCandidateCount` —
 * `classifyMatrixCandidates`'s own loop either pushes a V3 candidate
 * (or a V4 candidate with resolvable `hookData`) to `executable`, or
 * pushes a hooked V4 candidate lacking `hookData` to `preconditionFailed`
 * — there is no third fallthrough for a V3/V4 candidate, so
 * `verifiedCandidateCount === executableCandidateCount +
 * preconditionFailedCandidateCount` always holds for snapshot-sourced,
 * V3/V4-only input (see the codebase's own pool-quote classifier for
 * the exhaustiveness proof).
 */
export function classifyCrossMarketGroup(
  candidates: readonly ComparisonCandidateInput[],
  tokenOut: TokenOutIdentifier,
  tokenIn: Address,
  chainId: number,
): CrossMarketGroupClassification {
  const { executable, preconditionFailed } = classifyMatrixCandidates(candidates, tokenIn, chainId);
  return {
    tokenOut,
    verifiedCandidateCount: candidates.length,
    executableCandidateCount: executable.length,
    preconditionFailedCandidateCount: preconditionFailed.length,
  };
}

// ---------------------------------------------------------------------------
// Budget arithmetic
// ---------------------------------------------------------------------------

/**
 * The request-wide executable-cell budget verdict for a proposed set of
 * selected groups. `ladderLength`/`maxCells` are FACTS (echoed
 * constants, for caller transparency); `requestProjectedCells`/
 * `fitsExecutionBudget` are DERIVED. None of these fields claim
 * anything about whether execution will actually succeed — see
 * `computeCrossMarketBudget`'s own doc comment.
 */
export interface CrossMarketExecutionBudget {
  readonly ladderLength: number;
  readonly requestProjectedCells: number;
  readonly maxCells: number;
  readonly fitsExecutionBudget: boolean;
}

/**
 * Pure arithmetic over plain numbers only — no snapshot, no candidate
 * arrays, no execution types of any kind. `ladderLength` is ALWAYS
 * `DEPTH_THRESHOLD_LADDER_MULTIPLIERS.length` (currently 12), imported
 * from its existing canonical source — never a second, independently
 * hardcoded `12`.
 *
 *   requestProjectedCells = sum(executableCandidateCount * ladderLength)
 *   fitsExecutionBudget   = requestProjectedCells <= MAX_CROSS_MARKET_DEPTH_CELLS
 *
 * A precondition-failed candidate was already excluded from
 * `executableCandidateCount` by `classifyCrossMarketGroup` — it
 * consumes zero cells here, by construction, not by any special-casing
 * in this function. This function never prunes its input, never
 * attempts a "best effort" partial sum, and never itself constitutes an
 * execution attempt — it is a projection only.
 */
export function computeCrossMarketBudget(executableCandidateCountsByGroup: readonly number[]): CrossMarketExecutionBudget {
  const ladderLength = DEPTH_THRESHOLD_LADDER_MULTIPLIERS.length;
  const requestProjectedCells = executableCandidateCountsByGroup.reduce((sum, executableCandidateCount) => sum + executableCandidateCount * ladderLength, 0);
  return {
    ladderLength,
    requestProjectedCells,
    maxCells: MAX_CROSS_MARKET_DEPTH_CELLS,
    fitsExecutionBudget: requestProjectedCells <= MAX_CROSS_MARKET_DEPTH_CELLS,
  };
}
