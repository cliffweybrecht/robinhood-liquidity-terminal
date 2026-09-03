import type { Hex } from "viem";
import type { CanonicalRobinhoodAsset } from "@/domain/asset";
import {
  classifyMatrixCandidates,
  compareVerifiedPoolsAcrossExactInputs,
  MAX_MATRIX_CELLS,
  type ComparisonCandidateInput,
  type CrossPoolExecutionMatrixResult,
} from "@/domain/pool-quote";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { sameTokenOut } from "./compare";
import { MatrixTooLargeError, MissingTokenDecimalsError, NoVerifiedGroupsError, UnknownOutputGroupError, VerificationDegradedError } from "./errors";
import type { ComparableExecutionGroup, TokenOutIdentifier, VerifiedExecutionSnapshot } from "./types";

/**
 * Public shape combining a symbol's authoritative verified groups with
 * ONE execution matrix — mirrors `AssetExecutionComparison`'s own shape
 * exactly (`compare.ts`), one dimension wider.
 */
export interface AssetExecutionMatrix {
  readonly asset: CanonicalRobinhoodAsset;
  readonly groups: readonly ComparableExecutionGroup[];
  readonly selectedTokenOut: TokenOutIdentifier;
  readonly matrix: CrossPoolExecutionMatrixResult;
}

/**
 * Frozen UI V1.1 default trade-size ladder (frozen implementation plan
 * correction 4): `1, 10, 100, 500, 1000` asset units. `1` matches UI
 * V1's own existing single-amount default (`compare.ts`'s
 * `defaultAmountIn`, `ExecutionComparison.tsx`'s initial `amountText`);
 * `1000` matches the size UI V1's own manual browser acceptance testing
 * already live-validated end to end; `500` sits between the two sizes
 * UI V1's own acceptance evidence already showed a WETH best-venue
 * change occurring between. Scaled to raw base units via `multiplier *
 * 10n ** BigInt(tokenDecimals)` — the SAME per-unit formula
 * `defaultAmountIn` already uses, reused, never re-derived. The
 * canonical `pool-quote` matrix primitive itself owns NO default
 * ladder (accepts explicit `amountsIn` only) — this constant is
 * deliberately a PRODUCT/orchestration-layer concern, per the approved
 * architecture correction.
 */
export const DEFAULT_MATRIX_LADDER_MULTIPLIERS: readonly bigint[] = [1n, 10n, 100n, 500n, 1000n];

/**
 * Mirrors `compare.ts`'s own private `resolveSelectedTokenOut` exactly
 * (identical precedence: DEGRADED+zero-groups -> `VerificationDegradedError`;
 * omitted `requested` -> default to `groups[0]` or `NoVerifiedGroupsError`;
 * explicit `requested` -> match or `UnknownOutputGroupError`). Re-stated
 * here rather than imported because `compare.ts` exports that function
 * ONLY as `resolveSelectedTokenOutForTesting`, explicitly scoped to that
 * module's own tests, not production reuse elsewhere.
 */
function resolveSelectedTokenOutForMatrix(
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

function defaultAmountsIn(tokenDecimals: number | null, symbol: string): readonly bigint[] {
  if (tokenDecimals === null) {
    throw new MissingTokenDecimalsError(symbol);
  }
  const unit = 10n ** BigInt(tokenDecimals);
  return DEFAULT_MATRIX_LADDER_MULTIPLIERS.map((m) => m * unit);
}

export interface CompareAssetExecutionMatrixInput {
  readonly symbol: string;
  /** Omit to let the server choose the largest authoritative verified group — identical semantics to `CompareAssetExecutionBySymbolInput.tokenOut`. */
  readonly tokenOut?: TokenOutIdentifier;
  /** Omit to use the frozen default 5-size ladder (`DEFAULT_MATRIX_LADDER_MULTIPLIERS`). Never an empty array — see `requestMatrix.ts`'s own fail-closed rejection of that case before this function is ever reached. */
  readonly amountsIn?: readonly bigint[];
  /** Identical semantics to `CompareAssetExecutionBySymbolInput.hookData` — per-candidate, never a single global value, never guessed. */
  readonly hookData?: ReadonlyMap<string, Hex>;
}

/**
 * Prices ONE same-block execution MATRIX from an ALREADY-RESOLVED
 * `VerifiedExecutionSnapshot` — never fetches, rebuilds, or otherwise
 * (re)acquires one itself. Mirrors `compareAssetExecutionFromSnapshot`'s
 * own request-scoped-consistency discipline exactly (this session's
 * already-shipped fix for the single-comparison endpoint): group
 * listing, default/explicit group selection, tokenIn decimals, and
 * candidate filtering ALL come from the exact SAME `snapshot` the
 * caller already holds.
 *
 * Enforces `MAX_MATRIX_CELLS` as a fast-path pre-check, computed via the
 * SAME `classifyMatrixCandidates`/`MAX_MATRIX_CELLS` the pool-quote
 * primitive itself authoritatively re-enforces — never a cruder raw-
 * candidate-count check (which could produce a false-positive rejection
 * for a request with many precondition-failed candidates but few
 * executable ones — see the frozen implementation plan's correction 2).
 * This layer's own rejection (`MatrixTooLargeError`, `./errors`) is a
 * pure latency/cost optimization; the primitive's own identical check
 * remains the sole AUTHORITATIVE enforcement point.
 */
export async function compareAssetExecutionMatrixFromSnapshot(
  snapshot: VerifiedExecutionSnapshot,
  input: CompareAssetExecutionMatrixInput,
): Promise<AssetExecutionMatrix> {
  const selectedTokenOut = resolveSelectedTokenOutForMatrix(input.symbol, snapshot.groups, input.tokenOut, snapshot.verificationHealth);

  const groupCandidates = snapshot.candidates.filter((c) => sameTokenOut(c.tokenOut, selectedTokenOut));
  if (groupCandidates.length === 0) {
    // Defensive: resolveSelectedTokenOutForMatrix already proved this
    // group exists with candidateCount > 0 within this SAME snapshot.
    throw new NoVerifiedGroupsError(input.symbol);
  }

  const amountsIn = input.amountsIn ?? defaultAmountsIn(snapshot.asset.tokenDecimals, input.symbol);

  const rpc = await createVerifiedRobinhoodRpcClient();

  const candidates: ComparisonCandidateInput[] = groupCandidates.map((c) => ({
    pool: c.pool,
    identity: c.identity,
    hookData: input.hookData?.get(c.pool.pairAddress.toLowerCase()),
  }));

  const { executable } = classifyMatrixCandidates(candidates, snapshot.asset.contractAddress, rpc.chainId);
  if (executable.length * amountsIn.length > MAX_MATRIX_CELLS) {
    throw new MatrixTooLargeError(executable.length, amountsIn.length, MAX_MATRIX_CELLS);
  }

  const matrix = await compareVerifiedPoolsAcrossExactInputs({
    candidates,
    tokenIn: snapshot.asset.contractAddress,
    amountsIn,
    rpc,
  });

  return { asset: snapshot.asset, groups: snapshot.groups, selectedTokenOut, matrix };
}

// Exported for tests only.
export { resolveSelectedTokenOutForMatrix as resolveSelectedTokenOutForMatrixForTesting };
