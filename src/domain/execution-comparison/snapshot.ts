import { zeroAddress, type Address } from "viem";
import { getRobinhoodAssetBySymbol, type CanonicalRobinhoodAsset } from "@/domain/asset";
import { getDexScreenerPoolsForAsset } from "@/domain/pool";
import type { LiquidityPool } from "@/domain/pool";
import { classifyPoolProtocol } from "@/domain/protocol";
import type { PoolProtocolClassification } from "@/domain/protocol";
import { verifyPoolIdentity, type PoolIdentityVerification } from "@/domain/pool-verification";
import { createVerifiedRobinhoodRpcClient, type VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { createKeyedTtlCache, type KeyedTtlCache } from "@/lib/cache/keyedTtlCache";
import { createLimiter } from "@/lib/concurrency/limiter";
import { NATIVE_ETH, type ComparableExecutionGroup, type TokenOutIdentifier, type VerifiedExecutionCandidate, type VerifiedExecutionSnapshot } from "./types";

/**
 * Bounded-concurrency cap for identity-verification fan-out.
 * Deliberately NOT the same `DEPTH_CURVE_CONCURRENCY = 5` constant
 * `pool-quote` uses for its own (different) RPC workload
 * (`QuoterV2`/`V4Quoter` `eth_call`s) — this project's own adversarial
 * live measurement of THIS specific workload (identity verification,
 * which additionally issues `eth_getLogs` for every V4 candidate's
 * historical `Initialize` event search) found HTTP 429 failures at
 * concurrency 5 and 8 that did not occur at concurrency 3 across
 * repeated runs. 3 is the highest concurrency directly observed with
 * zero failures.
 */
const VERIFICATION_CONCURRENCY = 3;

/**
 * Minimum spacing between successive verification call STARTS, on top
 * of the concurrency cap above — the same two-constraint throttling
 * model `src/domain/market/snapshot.ts` already uses for its own
 * Dexscreener fan-out (concurrency alone bounds how many requests
 * overlap, not how many happen per unit time). A modest, conservative
 * default; not independently measured the way `VERIFICATION_CONCURRENCY`
 * was, but stacked on top of an already-zero-failure concurrency as
 * additional headroom against the same rate-limit behavior.
 */
const VERIFICATION_INTERVAL_MS = 50;

/** Up to 2 retries (3 attempts total), ~250ms then ~750ms — release-critical per this project's own architecture review: a transient HTTP 429 must not make a legitimately-verifiable pool silently disappear from a group. */
const VERIFICATION_RETRY_DELAYS_MS = [250, 750] as const;

const SNAPSHOT_TTL_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `verify()` ONLY when its result is `"RPC_ERROR"` — a TYPED
 * classification already provided by the domain layer itself
 * (`PoolVerificationStatus`'s own doc comment: `RPC_ERROR` means
 * exactly "a transport/RPC failure... prevented a required read from
 * completing at all", structurally distinct from `INDETERMINATE`
 * ("RPC reads succeeded... but could not be decoded") and from the
 * deterministic `CONTRADICTED`/`UNSUPPORTED` outcomes). This is why no
 * string/regex matching on `evidence` detail text is needed anywhere in
 * this module: the ALREADY-EXISTING typed `status` field is itself the
 * correct transient/non-transient classifier. Bounded — never retries
 * more than `delaysMs.length` additional times — and returns whatever
 * the FINAL attempt produced, even if that is still `"RPC_ERROR"` (the
 * caller treats that exactly like any other non-VERIFIED result:
 * omitted from the snapshot, never cached as a durable negative fact,
 * naturally retried again on the next cache-miss rebuild). `verify` is
 * injected (rather than calling `verifyPoolIdentity` directly) so this
 * function's own retry/backoff/classification logic is unit-testable
 * without a real or fake RPC client.
 */
export async function verifyWithRetry(
  verify: () => Promise<PoolIdentityVerification>,
  delaysMs: readonly number[] = VERIFICATION_RETRY_DELAYS_MS,
): Promise<PoolIdentityVerification> {
  let result = await verify();
  for (const delayMs of delaysMs) {
    if (result.status !== "RPC_ERROR") return result;
    await sleep(delayMs);
    result = await verify();
  }
  return result;
}

/**
 * Derives this candidate's verified `tokenOut` EXCLUSIVELY from its
 * already-VERIFIED typed identity facts (`v3PoolKey.token0/token1` or
 * `poolKey.currency0/currency1`) — NEVER from `pool.baseToken`/
 * `quoteToken` (Dexscreener-reported, unverified). Returns `null` when
 * the canonical asset is not actually one side of this verified pair
 * (defensive — should be unreachable given `tokenIn` is always the
 * pool's own canonical asset, but never assumed). The V4 native-ETH
 * zero-address sentinel is recognized via the SAME `zeroAddress`
 * comparison `resolveV4Denomination` (`pool-quote`) already uses —
 * never a generic/reimplemented address-zero check.
 */
export function deriveVerifiedTokenOut(canonicalAssetAddress: Address, identity: PoolIdentityVerification): TokenOutIdentifier | null {
  const tokenInLower = canonicalAssetAddress.toLowerCase();

  if (identity.family === "UNISWAP_V3" && identity.v3PoolKey) {
    const { token0, token1 } = identity.v3PoolKey;
    if (token0.toLowerCase() === tokenInLower) return token1;
    if (token1.toLowerCase() === tokenInLower) return token0;
    return null;
  }

  if (identity.family === "UNISWAP_V4" && identity.poolKey) {
    const { currency0, currency1 } = identity.poolKey;
    let tokenOut: Address | null = null;
    if (currency0.toLowerCase() === tokenInLower) tokenOut = currency1;
    else if (currency1.toLowerCase() === tokenInLower) tokenOut = currency0;
    if (tokenOut === null) return null;
    return tokenOut.toLowerCase() === zeroAddress ? NATIVE_ETH : tokenOut;
  }

  return null;
}

function tokenOutSortKey(tokenOut: TokenOutIdentifier): string {
  return tokenOut === NATIVE_ETH ? NATIVE_ETH : tokenOut.toLowerCase();
}

/** Best-effort, DISPLAY-ONLY symbol for one `tokenOut` group — the lexicographically smallest distinct raw symbol observed among the group's own candidates' (unverified) `baseToken`/`quoteToken` metadata, mirroring `src/domain/liquidity/aggregate.ts`'s established "representative label, never identity" precedent. Never used for grouping/matching/ranking — only for a UI label. */
function deriveGroupSymbol(tokenOut: TokenOutIdentifier, groupCandidates: readonly VerifiedExecutionCandidate[]): string | undefined {
  if (tokenOut === NATIVE_ETH) return undefined;
  const lower = tokenOut.toLowerCase();
  const symbols = new Set<string>();
  for (const c of groupCandidates) {
    if (c.pool.baseToken.address.toLowerCase() === lower) symbols.add(c.pool.baseToken.symbol);
    if (c.pool.quoteToken.address.toLowerCase() === lower) symbols.add(c.pool.quoteToken.symbol);
  }
  if (symbols.size === 0) return undefined;
  return [...symbols].sort()[0];
}

/**
 * Groups already-verified candidates by `tokenOut`, deterministically
 * ordered: `candidateCount` descending, tie-broken by an EXPLICIT
 * string comparison on `tokenOut` — never dependent on `Map`/object
 * iteration order (a `Map` is used internally only to GROUP; the
 * trailing `.sort()` call is what actually decides the returned order,
 * and therefore the default-group selection in `compare.ts`).
 */
export function buildGroups(candidates: readonly VerifiedExecutionCandidate[]): ComparableExecutionGroup[] {
  const byTokenOut = new Map<string, VerifiedExecutionCandidate[]>();
  for (const candidate of candidates) {
    const key = tokenOutSortKey(candidate.tokenOut);
    const list = byTokenOut.get(key) ?? [];
    list.push(candidate);
    byTokenOut.set(key, list);
  }

  const groups: ComparableExecutionGroup[] = [...byTokenOut.values()].map((groupCandidates) => {
    const tokenOut = groupCandidates[0]!.tokenOut;
    return {
      tokenOut,
      tokenOutSymbol: deriveGroupSymbol(tokenOut, groupCandidates),
      candidateCount: groupCandidates.length,
      v3Count: groupCandidates.filter((c) => c.identity.family === "UNISWAP_V3").length,
      v4Count: groupCandidates.filter((c) => c.identity.family === "UNISWAP_V4").length,
    };
  });

  return groups.sort((a, b) => {
    if (b.candidateCount !== a.candidateCount) return b.candidateCount - a.candidateCount;
    const aKey = tokenOutSortKey(a.tokenOut);
    const bKey = tokenOutSortKey(b.tokenOut);
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}

/** Injectable dependencies for `buildVerifiedExecutionSnapshotWithDeps` — lets tests exercise the fan-out/retry/grouping orchestration with canned per-pool verification outcomes, without a real or fake RPC client (`verifyPoolIdentity`'s own correctness is already exhaustively covered by `pool-verification`'s own test suite; this module's job is orchestration, not re-proving that). */
export interface SnapshotBuildDeps {
  readonly getAsset: (symbol: string) => Promise<CanonicalRobinhoodAsset>;
  readonly getPools: (asset: CanonicalRobinhoodAsset) => Promise<{ readonly pools: readonly LiquidityPool[] }>;
  readonly verifyIdentity: (pool: LiquidityPool, classification: PoolProtocolClassification) => Promise<PoolIdentityVerification>;
}

function realDeps(rpc: VerifiedRobinhoodRpcClient): SnapshotBuildDeps {
  return {
    getAsset: (symbol) => getRobinhoodAssetBySymbol(symbol),
    getPools: (asset) => getDexScreenerPoolsForAsset(asset),
    verifyIdentity: (pool, classification) => verifyPoolIdentity({ pool, classification, rpc }),
  };
}

export async function buildVerifiedExecutionSnapshotWithDeps(symbol: string, deps: SnapshotBuildDeps): Promise<VerifiedExecutionSnapshot> {
  const asset = await deps.getAsset(symbol);
  const { pools } = await deps.getPools(asset);

  const classified = pools
    .map((pool) => ({ pool, classification: classifyPoolProtocol(pool) }))
    .filter(({ classification }) => classification.status === "CLASSIFIED" && (classification.family === "UNISWAP_V3" || classification.family === "UNISWAP_V4"));

  const limiter = createLimiter({ concurrency: VERIFICATION_CONCURRENCY, intervalMs: VERIFICATION_INTERVAL_MS });
  const verifiedResults = await Promise.all(
    classified.map(({ pool, classification }) => limiter.schedule(() => verifyWithRetry(() => deps.verifyIdentity(pool, classification)))),
  );

  // Only VERIFIED results become candidates — every non-VERIFIED
  // outcome is OMITTED from the returned candidate list. A still-
  // RPC_ERROR result after exhausting retries is ALSO omitted here (the
  // per-request behavior is unchanged from before), but unlike a
  // deterministic CONTRADICTED/INDETERMINATE/UNSUPPORTED omission, an
  // unresolved RPC_ERROR omission is not a settled fact — it flips
  // `verificationHealth` to `"DEGRADED"` below, which is what stops the
  // caching layer from treating this particular omission as durable for
  // a full TTL window (see `getVerifiedExecutionSnapshot`).
  const candidates: VerifiedExecutionCandidate[] = [];
  let hasUnresolvedTransientFailure = false;
  for (let i = 0; i < classified.length; i++) {
    const identity = verifiedResults[i]!;
    if (identity.status === "RPC_ERROR") {
      hasUnresolvedTransientFailure = true;
      continue;
    }
    if (identity.status !== "VERIFIED") continue;
    const pool = classified[i]!.pool;
    const tokenOut = deriveVerifiedTokenOut(asset.contractAddress, identity);
    if (tokenOut === null) continue;
    candidates.push({ pool, identity, tokenOut });
  }

  return {
    asset,
    generatedAt: Date.now(),
    candidates,
    groups: buildGroups(candidates),
    verificationHealth: hasUnresolvedTransientFailure ? "DEGRADED" : "HEALTHY",
  };
}

export async function buildVerifiedExecutionSnapshot(symbol: string, rpc: VerifiedRobinhoodRpcClient): Promise<VerifiedExecutionSnapshot> {
  return buildVerifiedExecutionSnapshotWithDeps(symbol, realDeps(rpc));
}

// See src/domain/market/cache.ts's own doc comment for why a plain
// module-level `const` is NOT reliably a process-wide singleton under
// Next.js's separate server/route bundling entry points — the same
// documented, empirically-verified lesson applies here, so the cache
// instance is stored on `globalThis`, exactly matching that precedent.
declare global {
  var __executionSnapshotCache: KeyedTtlCache<VerifiedExecutionSnapshot> | undefined;
}

function getSnapshotCache(): KeyedTtlCache<VerifiedExecutionSnapshot> {
  globalThis.__executionSnapshotCache ??= createKeyedTtlCache<VerifiedExecutionSnapshot>({
    ttlMs: SNAPSHOT_TTL_MS,
    produce: async (symbol) => {
      const rpc = await createVerifiedRobinhoodRpcClient();
      return buildVerifiedExecutionSnapshot(symbol, rpc);
    },
  });
  return globalThis.__executionSnapshotCache;
}

/**
 * Returns the current verified execution snapshot for `symbol` —
 * immediately if a fresh (< 60s old) one is cached, otherwise builds a
 * new one (discovery -> classify -> bounded-concurrency-3, retried
 * identity verification -> verified-tokenOut grouping) and awaits it.
 * Concurrent callers for the SAME symbol single-flight onto one
 * in-flight build (via `createKeyedTtlCache`, itself built on the
 * already-proven `createTtlCache`). Cache key is the symbol, normalized
 * (`trim().toUpperCase()`) to avoid `"nvda"`/`"NVDA"` producing two
 * independent cache entries for the same asset — matching the
 * canonical registry's own symbol-casing convention
 * (`src/domain/asset/registry.ts`'s `bySymbol` map is keyed the same
 * way).
 *
 * Contains ONLY verified identity facts and group summaries — NEVER
 * any execution quote result (no `amountOut`, no candidate `status`,
 * no ranking, no comparison block). Every actual comparison call made
 * against candidates from this snapshot still calls
 * `compareVerifiedPoolsExactInput` fresh, unconditionally — see
 * `compare.ts`.
 *
 * A `"DEGRADED"` build (see `VerifiedExecutionSnapshot.verificationHealth`
 * — at least one candidate was still `RPC_ERROR` after exhausting every
 * retry) is returned to THIS caller exactly as built (candidates
 * omitted, nothing fabricated), but is immediately evicted from the
 * cache — via `cache.invalidate(key)`, called synchronously right after
 * `cache.get(key)` resolves, with no `await` in between — before this
 * function returns. That ordering matters: it guarantees no OTHER
 * caller can ever observe the degraded snapshot as a cache hit, because
 * nothing else can run between the underlying `TtlCache` storing the
 * entry and this function clearing it again. The next call for this
 * symbol (from this caller or any other) therefore always triggers a
 * fresh verification build, giving every transiently-RPC_ERROR
 * candidate another chance — a transient RPC failure is never allowed
 * to harden into a 60-second "this pool doesn't exist" fact. A
 * `"HEALTHY"` build is cached normally for the full `SNAPSHOT_TTL_MS`.
 */
export async function getVerifiedExecutionSnapshot(symbol: string): Promise<VerifiedExecutionSnapshot> {
  return getVerifiedExecutionSnapshotFromCache(symbol, getSnapshotCache());
}

/**
 * The degraded-snapshot cache-eviction policy itself, factored out from
 * `getVerifiedExecutionSnapshot` so it is unit-testable against a real
 * `KeyedTtlCache` (proving the actual `get`/`invalidate` interaction,
 * not a hand-rolled fake of caching semantics) without needing a real
 * or fake RPC client — the `produce` function backing the cache is
 * whatever the test supplies, exactly like `SnapshotBuildDeps` decouples
 * `buildVerifiedExecutionSnapshotWithDeps` from real RPC above. See
 * `getVerifiedExecutionSnapshot`'s own doc comment for the policy this
 * implements.
 */
export async function getVerifiedExecutionSnapshotFromCache(
  symbol: string,
  cache: KeyedTtlCache<VerifiedExecutionSnapshot>,
): Promise<VerifiedExecutionSnapshot> {
  const key = symbol.trim().toUpperCase();
  const entry = await cache.get(key);
  if (entry.value.verificationHealth === "DEGRADED") {
    cache.invalidate(key);
  }
  return entry.value;
}
