import type { Hex } from "viem";
import type { CanonicalRobinhoodAsset } from "@/domain/asset";
import { compareVerifiedPoolsExactInput, type ComparisonCandidateInput, type CrossPoolComparisonResult } from "@/domain/pool-quote";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { MissingTokenDecimalsError, NoVerifiedGroupsError, UnknownOutputGroupError, VerificationDegradedError } from "./errors";
import { getVerifiedExecutionSnapshot } from "./snapshot";
import { NATIVE_ETH, type ComparableExecutionGroup, type TokenOutIdentifier, type VerifiedExecutionSnapshot } from "./types";

/**
 * Public shape combining a symbol's authoritative verified groups with
 * ONE comparison result — the same shape both
 * `getAssetExecutionGroupsBySymbol` and `compareAssetExecutionBySymbol`
 * return a subset/superset of, so a caller (the API route) never needs
 * two independently-shaped responses.
 */
export interface AssetExecutionComparison {
  readonly asset: CanonicalRobinhoodAsset;
  readonly groups: readonly ComparableExecutionGroup[];
  readonly selectedTokenOut: TokenOutIdentifier;
  readonly comparison: CrossPoolComparisonResult;
}

export interface AssetExecutionGroups {
  readonly asset: CanonicalRobinhoodAsset;
  readonly groups: readonly ComparableExecutionGroup[];
}

function sameTokenOut(a: TokenOutIdentifier, b: TokenOutIdentifier): boolean {
  if (a === NATIVE_ETH || b === NATIVE_ETH) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

/** Derives the group summary from an ALREADY-RESOLVED snapshot — never fetches or rebuilds one. The request-scoped-consistency-preserving primitive; see `getAssetExecutionGroupsBySymbol` for the fetch-and-derive convenience wrapper, and `compareAssetExecutionFromSnapshot`'s doc comment for why a caller that also needs a comparison in the SAME request must resolve one snapshot itself and pass it to both. */
export function groupsFromSnapshot(snapshot: VerifiedExecutionSnapshot): AssetExecutionGroups {
  return { asset: snapshot.asset, groups: snapshot.groups };
}

/**
 * Fetch-and-derive convenience wrapper — resolves ONE fresh/cached
 * snapshot via `getVerifiedExecutionSnapshot` and derives its group
 * summary. Correct and self-consistent when used ALONE (exactly one
 * snapshot resolution). A caller that ALSO needs a comparison for the
 * SAME request must NOT call this function and
 * `compareAssetExecutionBySymbol` back to back — each independently
 * resolves its own snapshot, and under `verificationHealth ===
 * "DEGRADED"` the first snapshot is evicted from the cache the instant
 * it's returned (see `snapshot.ts`), so the second call can rebuild and
 * observe a materially different candidate/group set within the same
 * HTTP request. Such a caller should instead call
 * `getVerifiedExecutionSnapshot` once and pass the result to
 * `groupsFromSnapshot` AND `compareAssetExecutionFromSnapshot` — see the
 * API route for the canonical example.
 */
export async function getAssetExecutionGroupsBySymbol(symbol: string): Promise<AssetExecutionGroups> {
  const snapshot = await getVerifiedExecutionSnapshot(symbol);
  return groupsFromSnapshot(snapshot);
}

function resolveSelectedTokenOut(
  symbol: string,
  groups: readonly ComparableExecutionGroup[],
  requested: TokenOutIdentifier | undefined,
  verificationHealth: VerifiedExecutionSnapshot["verificationHealth"] = "HEALTHY",
): TokenOutIdentifier {
  if (groups.length === 0 && verificationHealth === "DEGRADED") {
    // Distinct from NoVerifiedGroupsError below: zero groups here might
    // be a transient RPC condition (verification never reached a
    // settled outcome for every candidate — see
    // VerifiedExecutionSnapshot.verificationHealth's own doc comment),
    // never a proven "this asset has no execution venues" fact.
    // Checked before either branch below so neither the default-group
    // nor the explicit-tokenOut path can misreport an indeterminate
    // state as a definitive one.
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

export interface CompareAssetExecutionBySymbolInput {
  readonly symbol: string;
  /** Omit to let the server choose the largest authoritative verified group. */
  readonly tokenOut?: TokenOutIdentifier;
  /** Omit to use the server default: exactly 1 canonical token (`10n ** BigInt(tokenDecimals)`). Never derived from any reference/display price. */
  readonly amountIn?: bigint;
  /** Per-candidate, keyed by that candidate's own `pool.pairAddress` (case-insensitive) — NEVER a single global value. Absent/omitted entries mean "no hookData supplied for this candidate," which — for a hooked V4 candidate — is preserved, unweakened, existing domain behavior: `PRECONDITION_FAILED`/`MISSING_HOOK_DATA`. This module never invents, infers, or defaults a non-empty hookData value for any candidate. */
  readonly hookData?: ReadonlyMap<string, Hex>;
}

/**
 * Prices ONE same-block execution comparison from an ALREADY-RESOLVED
 * `VerifiedExecutionSnapshot` — never fetches, rebuilds, or otherwise
 * (re)acquires one itself. This is the request-scoped-consistency
 * primitive: group listing, default/explicit group selection, tokenIn
 * decimals, and candidate filtering ALL come from the exact SAME
 * `snapshot` the caller already holds — never a second, independently
 * resolved snapshot that could legitimately differ (a different
 * candidate/group set, a different `verificationHealth`) from whatever
 * the caller already used for anything else within the same request.
 * Calls `compareVerifiedPoolsExactInput` completely fresh,
 * unconditionally, on every single call — the snapshot can never make
 * an `amountOut`/`status`/ranking value stale, because it never
 * contains any of those in the first place (see
 * `VerifiedExecutionSnapshot`'s own doc comment in `types.ts`). See
 * `compareAssetExecutionBySymbol` for the fetch-and-compare convenience
 * wrapper, and the API route for why the route calls this function
 * directly instead of that wrapper.
 */
export async function compareAssetExecutionFromSnapshot(
  snapshot: VerifiedExecutionSnapshot,
  input: CompareAssetExecutionBySymbolInput,
): Promise<AssetExecutionComparison> {
  const selectedTokenOut = resolveSelectedTokenOut(input.symbol, snapshot.groups, input.tokenOut, snapshot.verificationHealth);

  const groupCandidates = snapshot.candidates.filter((c) => sameTokenOut(c.tokenOut, selectedTokenOut));
  if (groupCandidates.length === 0) {
    // Defensive: resolveSelectedTokenOut already proved this group
    // exists with candidateCount > 0 within this SAME snapshot — this
    // could only diverge if the snapshot were mutated after being
    // resolved, which it never is (every VerifiedExecutionSnapshot is
    // immutable once produced).
    throw new NoVerifiedGroupsError(input.symbol);
  }

  const amountIn = input.amountIn ?? defaultAmountIn(input.symbol, snapshot.asset.tokenDecimals);

  const rpc = await createVerifiedRobinhoodRpcClient();
  const candidates: ComparisonCandidateInput[] = groupCandidates.map((c) => ({
    pool: c.pool,
    identity: c.identity,
    hookData: input.hookData?.get(c.pool.pairAddress.toLowerCase()),
  }));

  const comparison = await compareVerifiedPoolsExactInput({
    candidates,
    tokenIn: snapshot.asset.contractAddress,
    amountIn,
    rpc,
  });

  return { asset: snapshot.asset, groups: snapshot.groups, selectedTokenOut, comparison };
}

/**
 * Fetch-and-compare convenience wrapper — resolves ONE fresh/cached
 * snapshot via `getVerifiedExecutionSnapshot`, then delegates to
 * `compareAssetExecutionFromSnapshot`. Correct and self-consistent when
 * used ALONE (exactly one snapshot resolution per call). NOT used by
 * the API route, which needs groups AND a comparison from the SAME
 * snapshot within one HTTP request — see
 * `compareAssetExecutionFromSnapshot`'s own doc comment.
 */
export async function compareAssetExecutionBySymbol(input: CompareAssetExecutionBySymbolInput): Promise<AssetExecutionComparison> {
  const snapshot = await getVerifiedExecutionSnapshot(input.symbol);
  return compareAssetExecutionFromSnapshot(snapshot, input);
}

function defaultAmountIn(symbol: string, tokenDecimals: number | null): bigint {
  if (tokenDecimals === null) {
    throw new MissingTokenDecimalsError(symbol);
  }
  return 10n ** BigInt(tokenDecimals);
}

// Exported for tests/DTO-layer reuse only.
export { resolveSelectedTokenOut as resolveSelectedTokenOutForTesting, sameTokenOut, defaultAmountIn };
