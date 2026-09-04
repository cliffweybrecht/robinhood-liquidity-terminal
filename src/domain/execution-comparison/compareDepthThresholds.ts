import type { Hex } from "viem";
import type { CanonicalRobinhoodAsset } from "@/domain/asset";
import {
  classifyMatrixCandidates,
  computeVerifiedPoolDepthThresholds,
  MAX_DEPTH_THRESHOLD_CELLS,
  type ComparisonCandidateInput,
  type VerifiedPoolDepthThresholdsResult,
} from "@/domain/pool-quote";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { sameTokenOut } from "./compare";
import { DepthThresholdsTooLargeError, MissingTokenDecimalsError, NoVerifiedGroupsError, UnknownOutputGroupError, VerificationDegradedError } from "./errors";
import type { ComparableExecutionGroup, TokenOutIdentifier, VerifiedExecutionSnapshot } from "./types";

/**
 * Public shape combining a symbol's authoritative verified groups with
 * ONE depth-threshold result — mirrors `AssetExecutionComparison`'s
 * (`compare.ts`) and `AssetExecutionMatrix`'s (`compareMatrix.ts`) own
 * shape exactly.
 */
export interface AssetExecutionDepthThresholds {
  readonly asset: CanonicalRobinhoodAsset;
  readonly groups: readonly ComparableExecutionGroup[];
  readonly selectedTokenOut: TokenOutIdentifier;
  readonly result: VerifiedPoolDepthThresholdsResult;
}

/**
 * Frozen server-authoritative Executable-Depth Thresholds default
 * ladder — `1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000` asset
 * units, chosen and live-calibrated against real NVDA data (see
 * `CHATGPT_CLAUDE_PROJECT_FILES/EXECUTABLE_DEPTH/executable-depth-
 * architecture-research.txt`, "LIVE LADDER CALIBRATION" — this exact
 * ladder produced the fewest threshold collapses of the three
 * candidates measured live). NOT caller-customizable in this phase —
 * see `requestDepthThresholds.ts`'s own doc comment. Scaled to raw base
 * units via `multiplier * 10n ** BigInt(tokenDecimals)`, the SAME
 * per-unit formula `DEFAULT_MATRIX_LADDER_MULTIPLIERS` already uses.
 * The canonical `pool-quote` depth-threshold primitive itself owns NO
 * default ladder (accepts explicit `amountsIn` only) — this constant is
 * deliberately a PRODUCT/orchestration-layer concern, mirroring the
 * matrix's own identical architectural boundary.
 */
export const DEPTH_THRESHOLD_LADDER_MULTIPLIERS: readonly bigint[] = [1n, 2n, 5n, 10n, 25n, 50n, 100n, 250n, 500n, 1000n, 2500n, 5000n];

/**
 * Frozen Executable-Depth Thresholds price-impact thresholds, in bps —
 * 0.5% / 1% / 2% / 5%. All four, fixed, not caller-customizable in
 * this phase — evaluating a threshold against an already-fetched
 * ladder is a pure, zero-RPC derivation (`sampledDepthAtBps`), so there
 * is no RPC-cost argument for shipping fewer. Deliberately a PRODUCT/
 * orchestration-layer concern, mirroring `DEPTH_THRESHOLD_LADDER_
 * MULTIPLIERS`'s own placement — the canonical `pool-quote` primitive
 * itself owns no default threshold set either (accepts explicit
 * `thresholdsBps` only).
 */
export const DEPTH_THRESHOLD_BPS: readonly number[] = [50, 100, 200, 500];

/**
 * Mirrors `compareMatrix.ts`'s own private `resolveSelectedTokenOutForMatrix`
 * exactly (identical precedence: DEGRADED+zero-groups ->
 * `VerificationDegradedError`; omitted `requested` -> default to
 * `groups[0]` or `NoVerifiedGroupsError`; explicit `requested` -> match
 * or `UnknownOutputGroupError`). Re-stated here rather than imported —
 * `compareMatrix.ts` exports its own version only as
 * `resolveSelectedTokenOutForMatrixForTesting`, explicitly scoped to
 * that module's own tests, not production reuse — mirroring the exact
 * same restatement precedent `compareMatrix.ts` itself already
 * established relative to `compare.ts`'s own
 * `resolveSelectedTokenOutForTesting`.
 */
function resolveSelectedTokenOutForDepthThresholds(
  symbol: string,
  groups: readonly ComparableExecutionGroup[],
  requested: TokenOutIdentifier | undefined,
  verificationHealth: VerifiedExecutionSnapshot["verificationHealth"],
): TokenOutIdentifier {
  if (groups.length === 0 && verificationHealth === "DEGRADED") {
    throw new VerificationDegradedError(symbol);
  }
  if (requested === undefined) {
    const first = groups[0];
    if (!first) throw new NoVerifiedGroupsError(symbol);
    return first.tokenOut;
  }
  const match = groups.find((g) => sameTokenOut(g.tokenOut, requested));
  if (!match) throw new UnknownOutputGroupError(requested);
  return match.tokenOut;
}

function defaultLadderAmountsIn(tokenDecimals: number | null, symbol: string): readonly bigint[] {
  if (tokenDecimals === null) {
    throw new MissingTokenDecimalsError(symbol);
  }
  const unit = 10n ** BigInt(tokenDecimals);
  return DEPTH_THRESHOLD_LADDER_MULTIPLIERS.map((m) => m * unit);
}

export interface CompareAssetExecutionDepthThresholdsInput {
  readonly symbol: string;
  /** Omit to let the server choose the largest authoritative verified group — identical semantics to `CompareAssetExecutionMatrixInput.tokenOut`. */
  readonly tokenOut?: TokenOutIdentifier;
  /** Identical semantics to `CompareAssetExecutionMatrixInput.hookData` — per-candidate, never a single global value, never guessed. */
  readonly hookData?: ReadonlyMap<string, Hex>;
}

/**
 * Prices ONE same-block, per-pool Executable-Depth Threshold result
 * from an ALREADY-RESOLVED `VerifiedExecutionSnapshot` — never fetches,
 * rebuilds, or otherwise (re)acquires one itself. Mirrors
 * `compareAssetExecutionMatrixFromSnapshot`'s own request-scoped-
 * consistency discipline exactly: group listing, default/explicit group
 * selection, tokenIn decimals, and candidate filtering ALL come from
 * the exact SAME `snapshot` the caller already holds.
 *
 * Enforces `MAX_DEPTH_THRESHOLD_CELLS` as a fast-path pre-check,
 * computed via the SAME `classifyMatrixCandidates` the pool-quote
 * primitive itself authoritatively re-enforces — never a cruder raw-
 * candidate-count check. This layer's own rejection
 * (`DepthThresholdsTooLargeError`, `./errors`) is a pure latency/cost
 * optimization; the primitive's own identical check remains the sole
 * AUTHORITATIVE enforcement point.
 */
export async function compareAssetExecutionDepthThresholdsFromSnapshot(
  snapshot: VerifiedExecutionSnapshot,
  input: CompareAssetExecutionDepthThresholdsInput,
): Promise<AssetExecutionDepthThresholds> {
  const selectedTokenOut = resolveSelectedTokenOutForDepthThresholds(input.symbol, snapshot.groups, input.tokenOut, snapshot.verificationHealth);

  const groupCandidates = snapshot.candidates.filter((c) => sameTokenOut(c.tokenOut, selectedTokenOut));
  if (groupCandidates.length === 0) {
    // Defensive: resolveSelectedTokenOutForDepthThresholds already
    // proved this group exists with candidateCount > 0 within this
    // SAME snapshot.
    throw new NoVerifiedGroupsError(input.symbol);
  }

  const amountsIn = defaultLadderAmountsIn(snapshot.asset.tokenDecimals, input.symbol);

  const rpc = await createVerifiedRobinhoodRpcClient();

  const candidates: ComparisonCandidateInput[] = groupCandidates.map((c) => ({
    pool: c.pool,
    identity: c.identity,
    hookData: input.hookData?.get(c.pool.pairAddress.toLowerCase()),
  }));

  const { executable } = classifyMatrixCandidates(candidates, snapshot.asset.contractAddress, rpc.chainId);
  if (executable.length * amountsIn.length > MAX_DEPTH_THRESHOLD_CELLS) {
    throw new DepthThresholdsTooLargeError(executable.length, amountsIn.length, MAX_DEPTH_THRESHOLD_CELLS);
  }

  const result = await computeVerifiedPoolDepthThresholds({
    candidates,
    tokenIn: snapshot.asset.contractAddress,
    amountsIn,
    thresholdsBps: DEPTH_THRESHOLD_BPS,
    rpc,
  });

  return { asset: snapshot.asset, groups: snapshot.groups, selectedTokenOut, result };
}

// Exported for tests only.
export { resolveSelectedTokenOutForDepthThresholds as resolveSelectedTokenOutForDepthThresholdsForTesting };
