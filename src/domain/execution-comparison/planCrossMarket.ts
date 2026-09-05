import type { Hex } from "viem";
import type { CanonicalRobinhoodAsset } from "@/domain/asset";
import type { ComparisonCandidateInput } from "@/domain/pool-quote";
import { sameTokenOut } from "./compare";
import { classifyCrossMarketGroup, computeCrossMarketBudget, resolveCrossMarketGroupSelection, type CrossMarketExecutionBudget } from "./crossMarketPolicy";
import type { TokenOutIdentifier, VerifiedExecutionSnapshot } from "./types";

/**
 * Phase 6I — Cross-Market Execution Planning. A PURE, SYNCHRONOUS,
 * RPC-FREE planner that DESCRIBES a proposed cross-market workload
 * against an ALREADY-RESOLVED `VerifiedExecutionSnapshot` — it never
 * acquires, refreshes, or otherwise (re)fetches a snapshot itself, and
 * it issues ZERO quote RPC calls, ZERO `getBlockNumber()` calls, ZERO
 * verified execution RPC client construction, ZERO decimals/spot reads,
 * and ZERO block pinning of any kind. There is no RPC-provider import
 * anywhere in this file.
 *
 * A plan produced here is a DESCRIPTION of a proposed workload, NEVER
 * execution evidence. It never claims `amountOut`, price impact, best
 * venue, depth winner, economic ranking, normalized/combined value,
 * cross-token comparison, a shared block, or any future quote/analytics/
 * execution success. `status: "DESCRIBED"` is chosen deliberately over
 * a word like `"PLANNED"` specifically because it cannot reasonably be
 * misread as "execution is scheduled/reserved/prepared" — this planner
 * only ever describes a point-in-time feasibility projection over an
 * already-resolved snapshot.
 *
 * This module depends ONLY on `./crossMarketPolicy` (the one
 * authoritative selection/classification/budget implementation),
 * `./compare`'s `sameTokenOut`, and this module's own types — it NEVER
 * imports `./compareCrossMarket` (Phase 6H's executor). The planner is
 * not, and must never become, an execution dependency.
 *
 * Candidate-array assembly (filtering `snapshot.candidates` by
 * `tokenOut` and attaching per-pool `hookData`) is DELIBERATELY
 * restated here, independently from `compareCrossMarket.ts`'s own
 * identical restatement, rather than centralized in `./crossMarketPolicy`
 * — this is mechanical data-shaping with no business decision embedded
 * in it, and centralizing it would require exposing pool-quote's own
 * `ComparisonCandidateInput` execution-input type through the shared
 * policy surface for no decision-logic benefit (see
 * `./crossMarketPolicy`'s own header comment). Planner/executor PARITY
 * on the actual classification DECISION is still guaranteed, because
 * both restatements feed the SAME `classifyCrossMarketGroup` — see this
 * module's own test suite's parity tests against `compareCrossMarket.ts`.
 */

export interface PlanAssetExecutionCrossMarketInput {
  readonly tokenOuts?: readonly TokenOutIdentifier[];
  readonly hookData?: ReadonlyMap<string, Hex>;
}

/**
 * One group's contribution to a `"DESCRIBED"` plan. Every field is a
 * FACT or DERIVED value about the snapshot's own present candidates —
 * never a claim about future quote/execution success.
 */
export interface CrossMarketExecutionPlanGroup {
  readonly tokenOut: TokenOutIdentifier;
  /** FACT — the number of verified candidates in this group, in this snapshot. */
  readonly verifiedCandidateCount: number;
  /** DERIVED — via `classifyCrossMarketGroup`, given whatever `hookData` this plan call was given. Not a claim these candidates will quote successfully — only that no known precondition rules them out up front. */
  readonly executableCandidateCount: number;
  /** DERIVED — the exhaustive complement of `executableCandidateCount` (see `classifyCrossMarketGroup`'s own doc comment). */
  readonly preconditionFailedCandidateCount: number;
  /** DERIVED — `executableCandidateCount * budget.ladderLength`. A projection of RPC-call COST, never a claim any cell will succeed. */
  readonly projectedCells: number;
}

/**
 * The successful description of a resolvable cross-market selection.
 *
 * `candidateSetComplete` mirrors Phase 6G's own
 * `ExecutionSummaryAvailable.candidateSetComplete` field name AND
 * meaning exactly (`verificationHealth === "HEALTHY"`) — deliberately
 * reused vocabulary for an identical concept, rather than inventing a
 * second name for the same fact. `false` means: every count below is
 * accurate for what's IN this snapshot right now, but the snapshot may
 * be missing a candidate still pending verification — this is a
 * qualifier on COMPLETENESS, never a qualifier on the ACCURACY of the
 * facts that ARE present.
 *
 * `tokenDecimalsKnown` is a SEPARATE, ORTHOGONAL prerequisite fact —
 * `snapshot.asset.tokenDecimals !== null`. This plan describes RPC-
 * CALL-COUNT feasibility ONLY (whether the projected cell count fits
 * the budget) — it does NOT describe whether a complete execution
 * request could actually be constructed. `tokenDecimalsKnown === true`
 * AND `budget.fitsExecutionBudget === true` together still do NOT mean
 * execution will succeed: block pinning, decimals/spot reads, quotes,
 * analytics, and the RPC provider itself may all still fail at
 * execution time. There is deliberately NO `canExecute`/`isExecutable`/
 * `executionReady`/`requestWillSucceed` field anywhere on this type,
 * or any type in this module — no combination of facts here is ever
 * collapsed into a single "go/no-go" execution-readiness claim.
 *
 * `groups` ALWAYS contains exactly one entry per resolved group, in
 * resolved order, regardless of `budget.fitsExecutionBudget` — an
 * over-budget plan is still a normal `"DESCRIBED"` plan; groups are
 * NEVER pruned, truncated, or selected on a "best effort" basis.
 */
export interface AssetCrossMarketExecutionPlanDescribed {
  readonly status: "DESCRIBED";
  readonly asset: CanonicalRobinhoodAsset;
  readonly candidateSetComplete: boolean;
  readonly tokenDecimalsKnown: boolean;
  readonly groups: readonly CrossMarketExecutionPlanGroup[];
  readonly budget: CrossMarketExecutionBudget;
}

/**
 * A settled, domain-level state — NOT malformed input. Reachable ONLY
 * for DEFAULT (omitted `tokenOuts`) selection, and ONLY when
 * `verificationHealth === "HEALTHY"`: a settled fact that fewer than
 * `MIN_CROSS_MARKET_OUTPUT_MARKETS` groups exist. See
 * `AssetCrossMarketExecutionPlanIndeterminate` for the DEGRADED
 * counterpart — a DEGRADED snapshot's true group count is unproven,
 * and must NEVER be reported this way.
 */
export interface AssetCrossMarketExecutionPlanInsufficientMarkets {
  readonly status: "INSUFFICIENT_MARKETS";
  readonly asset: CanonicalRobinhoodAsset;
  readonly requiredMarketCount: 2;
  readonly availableMarketCount: 0 | 1;
}

/** An explicitly-requested `tokenOut` does not exist in this `HEALTHY` snapshot's groups — a settled fact about the caller's input, never a transient condition. */
export interface AssetCrossMarketExecutionPlanUnknownGroup {
  readonly status: "UNKNOWN_OUTPUT_GROUP";
  readonly asset: CanonicalRobinhoodAsset;
  readonly tokenOut: TokenOutIdentifier;
}

/**
 * Verification has not yet reached a settled outcome for every
 * candidate, AND the requested selection's resolvability depends on
 * that unproven completeness (either: default selection with fewer
 * than `MIN_CROSS_MARKET_OUTPUT_MARKETS` groups currently present, or
 * an explicitly-requested group not currently present). This is NEVER
 * converted into `INSUFFICIENT_MARKETS` or `UNKNOWN_OUTPUT_GROUP` — a
 * missing candidate under DEGRADED health might simply still be
 * mid-verification, not proven absent.
 */
export interface AssetCrossMarketExecutionPlanIndeterminate {
  readonly status: "VERIFICATION_DEGRADED";
  readonly asset: CanonicalRobinhoodAsset;
}

export type AssetCrossMarketExecutionPlan =
  | AssetCrossMarketExecutionPlanDescribed
  | AssetCrossMarketExecutionPlanInsufficientMarkets
  | AssetCrossMarketExecutionPlanUnknownGroup
  | AssetCrossMarketExecutionPlanIndeterminate;

/**
 * Deliberately restated, independently from `compareCrossMarket.ts`'s
 * own identical private `prepareGroup`-internal step — see this
 * module's own header comment for why this duplication is accepted
 * rather than centralized. Mechanical only: filter by `tokenOut`,
 * attach per-pool `hookData` (case-insensitive `pairAddress` key). No
 * classification, no RPC, no decision logic.
 */
function buildGroupCandidateInputs(snapshot: VerifiedExecutionSnapshot, tokenOut: TokenOutIdentifier, hookData: ReadonlyMap<string, Hex> | undefined): readonly ComparisonCandidateInput[] {
  return snapshot.candidates
    .filter((c) => sameTokenOut(c.tokenOut, tokenOut))
    .map((c) => ({
      pool: c.pool,
      identity: c.identity,
      hookData: hookData?.get(c.pool.pairAddress.toLowerCase()),
    }));
}

/**
 * The ONLY entry point. Synchronous, zero RPC, resolves from an
 * already-existing snapshot only. See this module's own header comment
 * for the full frozen architecture this implements.
 *
 * Order of operations (every step here is zero-RPC by construction —
 * there is no RPC-capable dependency anywhere in this file's import
 * list to even make an RPC call with):
 *  1. `resolveCrossMarketGroupSelection` (shared policy) — may resolve,
 *     or return one of the three non-`RESOLVED` outcomes, each mapped
 *     1:1 to a corresponding non-`"DESCRIBED"` plan status below.
 *  2. For each resolved group, in resolved order: build its candidate
 *     array (this module's own restatement) and classify it via the
 *     SAME shared `classifyCrossMarketGroup` the executor also uses.
 *  3. Compute the request-wide budget via the SAME shared
 *     `computeCrossMarketBudget` the executor also uses — over budget
 *     is reported as a normal fact (`budget.fitsExecutionBudget:
 *     false`) on an otherwise-normal `"DESCRIBED"` plan, never pruned,
 *     never its own status, never thrown.
 */
export function planAssetExecutionCrossMarketFromSnapshot(
  snapshot: VerifiedExecutionSnapshot,
  input: PlanAssetExecutionCrossMarketInput = {},
): AssetCrossMarketExecutionPlan {
  const selection = resolveCrossMarketGroupSelection(snapshot.groups, input.tokenOuts, snapshot.verificationHealth);

  switch (selection.kind) {
    case "INSUFFICIENT_MARKETS":
      return { status: "INSUFFICIENT_MARKETS", asset: snapshot.asset, requiredMarketCount: 2, availableMarketCount: selection.availableMarketCount };
    case "UNKNOWN_GROUP":
      return { status: "UNKNOWN_OUTPUT_GROUP", asset: snapshot.asset, tokenOut: selection.tokenOut };
    case "DEGRADED_INDETERMINATE":
      return { status: "VERIFICATION_DEGRADED", asset: snapshot.asset };
    case "RESOLVED":
      break;
  }

  const classifications = selection.tokenOuts.map((tokenOut) => {
    const candidates = buildGroupCandidateInputs(snapshot, tokenOut, input.hookData);
    return classifyCrossMarketGroup(candidates, tokenOut, snapshot.asset.contractAddress, snapshot.asset.chainId);
  });

  const budget = computeCrossMarketBudget(classifications.map((c) => c.executableCandidateCount));

  const groups: CrossMarketExecutionPlanGroup[] = classifications.map((c) => ({
    tokenOut: c.tokenOut,
    verifiedCandidateCount: c.verifiedCandidateCount,
    executableCandidateCount: c.executableCandidateCount,
    preconditionFailedCandidateCount: c.preconditionFailedCandidateCount,
    projectedCells: c.executableCandidateCount * budget.ladderLength,
  }));

  return {
    status: "DESCRIBED",
    asset: snapshot.asset,
    candidateSetComplete: snapshot.verificationHealth === "HEALTHY",
    tokenDecimalsKnown: snapshot.asset.tokenDecimals !== null,
    groups,
    budget,
  };
}
