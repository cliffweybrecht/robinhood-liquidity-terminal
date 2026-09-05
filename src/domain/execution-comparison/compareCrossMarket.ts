import type { Hex } from "viem";
import type { CanonicalRobinhoodAsset } from "@/domain/asset";
import {
  classifyMatrixCandidates,
  computeVerifiedPoolDepthThresholds,
  type ComparisonCandidateInput,
  type VerifiedPoolDepthThresholdsResult,
} from "@/domain/pool-quote";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { sameTokenOut } from "./compare";
import { DEPTH_THRESHOLD_BPS, DEPTH_THRESHOLD_LADDER_MULTIPLIERS } from "./compareDepthThresholds";
import { CrossMarketDepthTooLargeError, MissingTokenDecimalsError, UnknownOutputGroupError, VerificationDegradedError } from "./errors";
import { synthesizeExecutionSummary, type ExecutionSummary } from "./executionSummary";
import { NATIVE_ETH, type ComparableExecutionGroup, type TokenOutIdentifier, type VerifiedExecutionSnapshot } from "./types";

/**
 * Phase 6H — Cross-Market Execution Synthesis. Produces one request-
 * scoped, SAME-BLOCK execution-evidence set across at least two of one
 * asset's eligible output-token groups (WETH/USDG/NATIVE_ETH/...), then
 * independently applies the existing, UNMODIFIED Phase 6G
 * `synthesizeExecutionSummary` to each group's own result.
 *
 * Same-block evidence across groups is NOT economic comparability: this
 * module NEVER ranks, sums, or normalizes `amountOut` across different
 * `tokenOut` units — see `CrossMarketValueComparisonUnavailable`, whose
 * only value in this phase is `{availability: "UNAVAILABLE", reason:
 * "NO_TRUSTED_NORMALIZATION_SOURCE"}`. There is no `AVAILABLE`
 * alternative, no `SAME_TOKEN` state, and no WETH/native-ETH special
 * case — see this type's own doc comment.
 *
 * Concurrency: output groups execute STRICTLY SEQUENTIALLY, via a plain
 * `for...of` loop with each iteration fully `await`ed before the next
 * begins — deliberately never `Promise.all` across groups, and this
 * module introduces no shared/global limiter of its own. Each group's
 * OWN internal concurrency/spacing
 * (`DEPTH_THRESHOLD_QUOTE_CONCURRENCY`/`_INTERVAL_MS`,
 * `DEPTH_CURVE_CONCURRENCY`, all inside `computeVerifiedPoolDepthThresholds`)
 * is completely untouched.
 *
 * Block pinning: exactly ONE `rpc.getBlockNumber()` call for the ENTIRE
 * request, made here, AFTER the request-wide cell-cap preflight and
 * BEFORE any group executes. That single value is passed as the new
 * `blockNumber` input to every per-group `computeVerifiedPoolDepthThresholds`
 * call, which then makes ZERO `eth_blockNumber` calls of its own (see
 * that primitive's own doc comment). If the shared pin fails, the ENTIRE
 * request reports `{status: "BLOCK_PIN_FAILURE"}` — no group executes,
 * no Phase 6G synthesis runs. There is deliberately no group-level
 * `BLOCK_PIN_FAILURE` in this schema: once a shared block exists,
 * `computeVerifiedPoolDepthThresholds` is structurally incapable of
 * self-pinning again (it was given one), so any `BLOCK_PIN_FAILURE`
 * surfacing from a group call at that point would mean this module's
 * own orchestration is broken, not a legitimate per-group outcome —
 * see `assertOkDepthThresholdsResultAtSharedBlock`, which ALSO verifies
 * every successful group result reports EXACTLY this shared block, not
 * merely `"OK"`.
 */

export const MAX_CROSS_MARKET_DEPTH_CELLS = 60;

/**
 * The ONLY comparability state Phase 6H V1 can ever report. There is no
 * `AVAILABLE` alternative: no on-chain, verified WETH/USDG/native-ETH
 * exchange rate exists anywhere in this codebase, so ranking, summing,
 * or normalizing `amountOut` across groups would fabricate a claim this
 * system cannot back with evidence. Same-block evidence proves every
 * group was measured at one consistent chain state — it says nothing
 * about the relative economic value of what was measured.
 */
export interface CrossMarketValueComparisonUnavailable {
  readonly availability: "UNAVAILABLE";
  readonly reason: "NO_TRUSTED_NORMALIZATION_SOURCE";
}

/**
 * One group's contribution to the cross-market envelope. `result` is
 * always the `"OK"` variant, and its own `blockNumber` is GUARANTEED to
 * equal the envelope's top-level `blockNumber` — an externally-pinned
 * `computeVerifiedPoolDepthThresholds` call cannot legitimately return
 * `"BLOCK_PIN_FAILURE"` or a different block (see
 * `assertOkDepthThresholdsResultAtSharedBlock`). `summary`
 * is Phase 6G's own, UNMODIFIED `synthesizeExecutionSummary`, applied to
 * this SAME `result` and the SAME snapshot's `verificationHealth` —
 * never recomputed, never altered. `CROSS_GROUP_COMPARISON_NOT_ATTEMPTED`
 * remains present in `summary.unknown` exactly as Phase 6G always
 * produces it: this envelope provides an outer same-block CONTEXT only,
 * never a per-group comparison claim.
 */
export interface CrossMarketExecutionGroup {
  readonly tokenOut: TokenOutIdentifier;
  readonly result: Extract<VerifiedPoolDepthThresholdsResult, { readonly status: "OK" }>;
  readonly summary: ExecutionSummary;
}

export interface CrossMarketExecutionOk {
  readonly status: "OK";
  readonly asset: CanonicalRobinhoodAsset;
  readonly blockNumber: bigint;
  readonly groups: readonly CrossMarketExecutionGroup[];
  readonly valueComparison: CrossMarketValueComparisonUnavailable;
}

/**
 * A settled, domain-level state — NOT malformed input. Reachable only
 * for DEFAULT (omitted `tokenOuts`) selection: a `HEALTHY` snapshot with
 * fewer than 2 verified groups is a proven fact (every candidate reached
 * a final outcome), not a transient condition — see
 * `resolveSelectedGroupsForCrossMarket`. A `DEGRADED` snapshot with
 * fewer than 2 groups is NEVER reported this way — that case throws
 * `VerificationDegradedError` instead, since a degraded build's true
 * group count is unproven, not settled-low.
 */
export interface CrossMarketExecutionInsufficientMarkets {
  readonly status: "INSUFFICIENT_MARKETS";
  readonly asset: CanonicalRobinhoodAsset;
  readonly requiredMarketCount: 2;
  readonly availableMarketCount: 0 | 1;
}

/** The ONE shared `eth_blockNumber` call (made after the cell-cap preflight, before any group executes) failed — the entire request is reported this way; no group ever executed, no Phase 6G synthesis ever ran. */
export interface CrossMarketExecutionBlockPinFailure {
  readonly status: "BLOCK_PIN_FAILURE";
  readonly asset: CanonicalRobinhoodAsset;
}

export type AssetCrossMarketExecution = CrossMarketExecutionOk | CrossMarketExecutionInsufficientMarkets | CrossMarketExecutionBlockPinFailure;

export interface CompareAssetExecutionCrossMarketInput {
  readonly symbol: string;
  /**
   * Omit to select EVERY eligible group from the snapshot, in the
   * snapshot's own deterministic order (`snapshot.groups`, never
   * re-sorted here). When supplied, this value MUST already be
   * shape-validated by the request layer (`requestCrossMarket.ts`): an
   * array of at least 2 entries, each a well-formed address or
   * `NATIVE_ETH`, with no case-insensitive duplicates — this function's
   * only remaining job is checking EXISTENCE against the live snapshot
   * (see `resolveSelectedGroupsForCrossMarket`). Caller order is
   * preserved for a successful resolution.
   */
  readonly tokenOuts?: readonly TokenOutIdentifier[];
  /** Per-candidate, keyed by that candidate's own `pool.pairAddress` (case-insensitive) — identical semantics to every sibling orchestrator's own `hookData` field. Never a single global value, never guessed. */
  readonly hookData?: ReadonlyMap<string, Hex>;
}

type GroupSelection =
  | { readonly kind: "GROUPS"; readonly tokenOuts: readonly TokenOutIdentifier[] }
  | { readonly kind: "INSUFFICIENT_MARKETS"; readonly availableMarketCount: 0 | 1 };

function tokenOutToString(tokenOut: TokenOutIdentifier): string {
  return tokenOut === NATIVE_ETH ? NATIVE_ETH : tokenOut;
}

/**
 * Resolves which output-token groups this cross-market request will
 * synthesize, against the live snapshot. Omitted `requested` selects
 * every group already present on `groups`, preserving the snapshot's
 * own deterministic order (`snapshot.ts`'s `buildGroups`) — if fewer
 * than 2 groups exist:
 *  - `HEALTHY` -> `{kind: "INSUFFICIENT_MARKETS", ...}` (a settled fact,
 *    never an error — see `CrossMarketExecutionInsufficientMarkets`).
 *  - `DEGRADED` -> throws `VerificationDegradedError` (the true group
 *    count is unproven, not settled-low — mirrors
 *    `resolveSelectedTokenOutForDepthThresholds`'s own zero-group
 *    precedent, generalized to "fewer than 2").
 *
 * An explicit `requested` list is assumed already shape-validated
 * (>= 2 entries, well-formed addresses/`NATIVE_ETH`, no duplicates) by
 * the request layer — this function's only remaining job is checking
 * EXISTENCE against the live snapshot, per requested entry, in caller
 * order: a `HEALTHY` snapshot's absence is a settled fact about a bad
 * caller input (`UnknownOutputGroupError`); a `DEGRADED` snapshot's
 * absence might just be a transient verification gap
 * (`VerificationDegradedError`) — exactly the same per-entry
 * distinction `resolveSelectedTokenOutForDepthThresholds` already
 * established for the single-group case. Never silently drops or falls
 * back from an unknown requested group.
 */
export function resolveSelectedGroupsForCrossMarket(
  symbol: string,
  groups: readonly ComparableExecutionGroup[],
  requested: readonly TokenOutIdentifier[] | undefined,
  verificationHealth: VerifiedExecutionSnapshot["verificationHealth"],
): GroupSelection {
  if (requested === undefined) {
    if (groups.length < 2) {
      if (verificationHealth === "DEGRADED") {
        throw new VerificationDegradedError(symbol);
      }
      return { kind: "INSUFFICIENT_MARKETS", availableMarketCount: groups.length as 0 | 1 };
    }
    return { kind: "GROUPS", tokenOuts: groups.map((g) => g.tokenOut) };
  }

  const resolved: TokenOutIdentifier[] = [];
  for (const tokenOut of requested) {
    const match = groups.find((g) => sameTokenOut(g.tokenOut, tokenOut));
    if (!match) {
      if (verificationHealth === "DEGRADED") {
        throw new VerificationDegradedError(symbol);
      }
      throw new UnknownOutputGroupError(tokenOutToString(tokenOut));
    }
    resolved.push(match.tokenOut);
  }
  return { kind: "GROUPS", tokenOuts: resolved };
}

/** The fixed 12-point ladder, in RAW base units — restated from `compareDepthThresholds.ts`'s own identical `defaultLadderAmountsIn` (private there), scaled via the SAME imported `DEPTH_THRESHOLD_LADDER_MULTIPLIERS` — never a second, independently-declared ladder. */
function ladderAmountsIn(tokenDecimals: number | null, symbol: string): readonly bigint[] {
  if (tokenDecimals === null) {
    throw new MissingTokenDecimalsError(symbol);
  }
  const unit = 10n ** BigInt(tokenDecimals);
  return DEPTH_THRESHOLD_LADDER_MULTIPLIERS.map((m) => m * unit);
}

interface PreparedGroup {
  readonly tokenOut: TokenOutIdentifier;
  readonly candidates: readonly ComparisonCandidateInput[];
  readonly executableCount: number;
}

/**
 * Filters this group's candidates from the SAME snapshot (never a
 * second acquisition), attaches per-pool `hookData`, and classifies via
 * the SAME authoritative, PURE `classifyMatrixCandidates` every peer
 * primitive already uses — called with `snapshot.asset.chainId` (a
 * plain number already known from the snapshot), deliberately NOT
 * `rpc.chainId`, so this preflight step runs BEFORE any RPC client
 * exists (see `MAX_CROSS_MARKET_DEPTH_CELLS`'s own enforcement point in
 * `compareAssetExecutionCrossMarketFromSnapshot`).
 */
function prepareGroup(snapshot: VerifiedExecutionSnapshot, tokenOut: TokenOutIdentifier, hookData: ReadonlyMap<string, Hex> | undefined): PreparedGroup {
  const groupCandidates = snapshot.candidates.filter((c) => sameTokenOut(c.tokenOut, tokenOut));
  const candidates: ComparisonCandidateInput[] = groupCandidates.map((c) => ({
    pool: c.pool,
    identity: c.identity,
    hookData: hookData?.get(c.pool.pairAddress.toLowerCase()),
  }));
  const { executable } = classifyMatrixCandidates(candidates, snapshot.asset.contractAddress, snapshot.asset.chainId);
  return { tokenOut, candidates, executableCount: executable.length };
}

/**
 * Internal invariant guard, enforced at the Phase 6H boundary for EVERY
 * group result — two DISTINCT invariants, both release-critical:
 *
 *  1. An externally-pinned `computeVerifiedPoolDepthThresholds` call
 *     MUST NOT self-pin, and therefore MUST NEVER report
 *     `"BLOCK_PIN_FAILURE"` — that primitive's own contract (see its
 *     `blockNumber?: bigint` input doc comment) is that supplying a
 *     block skips the `eth_blockNumber` call entirely.
 *  2. A group result that DOES report `"OK"` must report EXACTLY the
 *     shared `sharedBlockNumber` this whole cross-market request
 *     pinned — `result.blockNumber !== sharedBlockNumber` would mean
 *     some group's evidence was measured at a DIFFERENT chain state
 *     than the rest, silently violating the entire premise of this
 *     phase (one same-block evidence set) while still LOOKING like a
 *     normal, successful `AssetCrossMarketExecution.groups` entry to
 *     any caller that doesn't independently re-check every block. This
 *     can only happen if this module's own orchestration is broken
 *     (e.g. a future refactor stops threading `blockNumber` through to
 *     one call) — never a legitimate, organically-occurring per-group
 *     outcome.
 *
 * Reaching either branch means Phase 6H's own orchestration is broken,
 * not a legitimate per-group outcome — there is deliberately no
 * group-level failure union in this schema (`AssetCrossMarketExecution`'s
 * own doc comment); both branches fail the ENTIRE request closed via a
 * thrown error, mapped by the API route to the existing generic 500
 * `INTERNAL_ERROR` path (the same fallback `QuotePreconditionError`
 * reaching a sibling route already uses for an equivalent "should never
 * happen" condition) — never a fabricated/partial envelope.
 */
function assertOkDepthThresholdsResultAtSharedBlock(
  result: VerifiedPoolDepthThresholdsResult,
  tokenOut: TokenOutIdentifier,
  sharedBlockNumber: bigint,
): Extract<VerifiedPoolDepthThresholdsResult, { readonly status: "OK" }> {
  if (result.status !== "OK") {
    throw new Error(
      `Internal invariant violation: computeVerifiedPoolDepthThresholds reported "${result.status}" for tokenOut "${tokenOutToString(tokenOut)}" despite Phase 6H supplying an externally-pinned blockNumber — this primitive must not self-pin, and therefore must never report BLOCK_PIN_FAILURE, when a blockNumber is supplied.`,
    );
  }
  if (result.blockNumber !== sharedBlockNumber) {
    throw new Error(
      `Internal invariant violation: computeVerifiedPoolDepthThresholds returned blockNumber ${result.blockNumber} for tokenOut "${tokenOutToString(tokenOut)}", but this cross-market request pinned shared blockNumber ${sharedBlockNumber} — every group's result MUST report the exact shared block, never a different one.`,
    );
  }
  return result;
}

/**
 * Prices ONE request-scoped, same-block cross-market execution
 * synthesis from an ALREADY-RESOLVED `VerifiedExecutionSnapshot` — never
 * fetches, rebuilds, or otherwise (re)acquires one itself, mirroring
 * every sibling `...FromSnapshot` function's own request-scoped-
 * consistency discipline. See this module's own header comment for the
 * full frozen architecture this implements.
 *
 * Order of operations (every step before "create the RPC client" is
 * zero-RPC):
 *  1. `snapshot.asset.tokenDecimals === null` -> `MissingTokenDecimalsError`
 *     (defense in depth — the API route already checks this before
 *     calling in).
 *  2. `resolveSelectedGroupsForCrossMarket` — may return
 *     `INSUFFICIENT_MARKETS` (returned immediately, no RPC of any kind)
 *     or throw `VerificationDegradedError`/`UnknownOutputGroupError`.
 *  3. The frozen 12-point ladder is constructed.
 *  4. EVERY selected group is prepared (`prepareGroup`): candidates
 *     filtered from THIS snapshot, `hookData` attached, classified via
 *     `classifyMatrixCandidates`.
 *  5. Every prepared group's `executableCount x ladder length` is
 *     summed; exceeding `MAX_CROSS_MARKET_DEPTH_CELLS` throws
 *     `CrossMarketDepthTooLargeError` — still before any RPC call.
 *  6. Exactly ONE `createVerifiedRobinhoodRpcClient()` call.
 *  7. Exactly ONE `rpc.getBlockNumber()` call. Failure ->
 *     `{status: "BLOCK_PIN_FAILURE", asset}`, no group ever executes.
 *  8. Every selected group executes SEQUENTIALLY (see this module's own
 *     header comment on concurrency), each via
 *     `computeVerifiedPoolDepthThresholds` with the SAME shared
 *     `blockNumber`, followed immediately by the SAME, UNMODIFIED
 *     `synthesizeExecutionSummary(result, snapshot.verificationHealth)`.
 *  9. The final `{status: "OK", ...}` envelope's `valueComparison` is
 *     ALWAYS `{availability: "UNAVAILABLE", reason:
 *     "NO_TRUSTED_NORMALIZATION_SOURCE"}` — never conditionally
 *     computed, never special-cased by which tokens were selected.
 */
export async function compareAssetExecutionCrossMarketFromSnapshot(
  snapshot: VerifiedExecutionSnapshot,
  input: CompareAssetExecutionCrossMarketInput,
): Promise<AssetCrossMarketExecution> {
  if (snapshot.asset.tokenDecimals === null) {
    throw new MissingTokenDecimalsError(input.symbol);
  }

  const selection = resolveSelectedGroupsForCrossMarket(input.symbol, snapshot.groups, input.tokenOuts, snapshot.verificationHealth);
  if (selection.kind === "INSUFFICIENT_MARKETS") {
    return {
      status: "INSUFFICIENT_MARKETS",
      asset: snapshot.asset,
      requiredMarketCount: 2,
      availableMarketCount: selection.availableMarketCount,
    };
  }

  const amountsIn = ladderAmountsIn(snapshot.asset.tokenDecimals, input.symbol);

  const prepared = selection.tokenOuts.map((tokenOut) => prepareGroup(snapshot, tokenOut, input.hookData));

  const totalExecutableCells = prepared.reduce((sum, group) => sum + group.executableCount * amountsIn.length, 0);
  if (totalExecutableCells > MAX_CROSS_MARKET_DEPTH_CELLS) {
    throw new CrossMarketDepthTooLargeError(totalExecutableCells, MAX_CROSS_MARKET_DEPTH_CELLS);
  }

  const rpc = await createVerifiedRobinhoodRpcClient();

  let blockNumber: bigint;
  try {
    blockNumber = await rpc.getBlockNumber();
  } catch {
    return { status: "BLOCK_PIN_FAILURE", asset: snapshot.asset };
  }

  // RELEASE-CRITICAL: this loop is intentionally sequential — each
  // group is fully awaited before the next begins. Never rewritten as
  // `Promise.all(prepared.map(...))` — see this module's own header
  // comment on concurrency.
  const groups: CrossMarketExecutionGroup[] = [];
  for (const group of prepared) {
    const rawResult = await computeVerifiedPoolDepthThresholds({
      candidates: group.candidates,
      tokenIn: snapshot.asset.contractAddress,
      amountsIn,
      thresholdsBps: DEPTH_THRESHOLD_BPS,
      rpc,
      blockNumber,
    });
    const result = assertOkDepthThresholdsResultAtSharedBlock(rawResult, group.tokenOut, blockNumber);
    const summary = synthesizeExecutionSummary(result, snapshot.verificationHealth);
    groups.push({ tokenOut: group.tokenOut, result, summary });
  }

  return {
    status: "OK",
    asset: snapshot.asset,
    blockNumber,
    groups,
    valueComparison: { availability: "UNAVAILABLE", reason: "NO_TRUSTED_NORMALIZATION_SOURCE" },
  };
}
