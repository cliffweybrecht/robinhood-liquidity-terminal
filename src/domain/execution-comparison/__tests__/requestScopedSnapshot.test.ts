import { beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyedTtlCache } from "@/lib/cache/keyedTtlCache";
import { compareVerifiedPoolsExactInput } from "@/domain/pool-quote";
import { compareAssetExecutionFromSnapshot, groupsFromSnapshot } from "../compare";
import { NoVerifiedGroupsError, VerificationDegradedError } from "../errors";
import { getVerifiedExecutionSnapshotFromCache } from "../snapshot";
import type { VerifiedExecutionSnapshot } from "../types";
import { NVDA, USDG, WETH, pool, snapshotFixture, verifiedV3Identity } from "./fixtures";

/**
 * Release-critical regression suite for the request-scoped verified-
 * snapshot consistency bug: before this fix, a single POST /execution/
 * compare request could resolve `getVerifiedExecutionSnapshot` TWICE
 * (once via `getAssetExecutionGroupsBySymbol` for `tokenDecimals`, once
 * more inside `compareAssetExecutionBySymbol`) — and because a
 * `"DEGRADED"` snapshot is evicted from the cache the instant it's
 * returned (`getVerifiedExecutionSnapshotFromCache`, `snapshot.ts`), the
 * second call could rebuild and observe a MATERIALLY DIFFERENT
 * candidate/group set than the first, within the same HTTP request —
 * live-observed as a spurious "no verified execution candidates" 404
 * immediately followed by a successful comparison a moment later.
 *
 * `compareAssetExecutionFromSnapshot`/`groupsFromSnapshot` now take an
 * ALREADY-RESOLVED snapshot and never fetch one themselves — the route
 * resolves exactly one snapshot and passes it to both. These tests
 * simulate the route's exact call pattern (one `getVerifiedExecution
 * SnapshotFromCache` call, reused for both groups and comparison) using
 * a producer that intentionally returns a DIFFERENT snapshot on each
 * call, so a regression that reintroduces a second independent fetch
 * would be caught by an observed mixture.
 */

function candidateFor(tokenOut: typeof WETH | typeof USDG, pairAddress: `0x${string}`) {
  return {
    pool: pool({ pairAddress, quoteToken: { address: tokenOut, name: "x", symbol: "X" } }),
    identity: verifiedV3Identity(pairAddress, NVDA, tokenOut),
    tokenOut,
  };
}

vi.mock("@/providers/robinhood-rpc", () => ({
  createVerifiedRobinhoodRpcClient: vi.fn(async () => ({ chainId: 4663 }) as unknown),
}));

vi.mock("@/domain/pool-quote", () => ({
  compareVerifiedPoolsExactInput: vi.fn(async (args: { tokenIn: string; amountIn: bigint }) => ({
    status: "OK",
    blockNumber: 999n,
    tokenIn: args.tokenIn,
    tokenOut: WETH,
    amountIn: args.amountIn,
    tokenInDecimals: 18,
    tokenOutDecimals: 18,
    sharedAnalyticsStatus: "OK",
    candidates: [],
    ranking: { rankedQuotedPoolAddresses: [], bestCandidatePoolAddresses: [] },
  })),
}));

describe("request-scoped snapshot consistency (release-critical)", () => {
  beforeEach(() => {
    vi.mocked(compareVerifiedPoolsExactInput).mockClear();
  });

  it("1 & 5. one request resolves at most one snapshot, and groups + comparison never mix two different snapshots even when the producer would return a different one on a second call", async () => {
    const snapshotA = snapshotFixture({
      verificationHealth: "HEALTHY",
      groups: [{ tokenOut: WETH, candidateCount: 1, v3Count: 1, v4Count: 0 }],
      candidates: [candidateFor(WETH, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    });
    const snapshotB = snapshotFixture({
      verificationHealth: "HEALTHY",
      groups: [{ tokenOut: USDG, candidateCount: 1, v3Count: 1, v4Count: 0 }],
      candidates: [candidateFor(USDG, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
    });
    const produce = vi.fn().mockResolvedValueOnce(snapshotA).mockResolvedValueOnce(snapshotB);
    const cache = createKeyedTtlCache<VerifiedExecutionSnapshot>({ ttlMs: 60_000, produce });

    // Exactly the route's pattern: ONE snapshot resolution for the request.
    const snapshot = await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(snapshot).toBe(snapshotA);

    const groupsResult = groupsFromSnapshot(snapshot);
    const comparison = await compareAssetExecutionFromSnapshot(snapshot, { symbol: "NVDA" });

    // No further snapshot resolution happened while deriving groups/comparison.
    expect(produce).toHaveBeenCalledTimes(1);
    expect(groupsResult.groups).toEqual(snapshotA.groups);
    expect(comparison.groups).toEqual(snapshotA.groups);
    expect(comparison.selectedTokenOut).toBe(WETH);
    // Never observes snapshot B's group/candidate — proves no mixture.
    expect(comparison.selectedTokenOut).not.toBe(USDG);
  });

  it("2 & 3. a DEGRADED snapshot is reused for the rest of the CURRENT request, but is not reusable by the NEXT request", async () => {
    const degraded = snapshotFixture({
      verificationHealth: "DEGRADED",
      groups: [{ tokenOut: WETH, candidateCount: 1, v3Count: 1, v4Count: 0 }],
      candidates: [candidateFor(WETH, "0xcccccccccccccccccccccccccccccccccccccccc")],
    });
    const nextHealthy = snapshotFixture({
      verificationHealth: "HEALTHY",
      groups: [{ tokenOut: USDG, candidateCount: 1, v3Count: 1, v4Count: 0 }],
      candidates: [candidateFor(USDG, "0xdddddddddddddddddddddddddddddddddddddddd")],
    });
    const produce = vi.fn().mockResolvedValueOnce(degraded).mockResolvedValueOnce(nextHealthy);
    const cache = createKeyedTtlCache<VerifiedExecutionSnapshot>({ ttlMs: 60_000, produce });

    // Request #1 — resolves the degraded snapshot once, reuses it throughout.
    const snapshot1 = await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    expect(snapshot1).toBe(degraded);
    const groups1 = groupsFromSnapshot(snapshot1);
    const comparison1 = await compareAssetExecutionFromSnapshot(snapshot1, { symbol: "NVDA" });
    expect(produce).toHaveBeenCalledTimes(1);
    expect(groups1.groups).toEqual(degraded.groups);
    expect(comparison1.selectedTokenOut).toBe(WETH);

    // Request #2 — the degraded snapshot must NOT still be cached.
    const snapshot2 = await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    expect(produce).toHaveBeenCalledTimes(2);
    expect(snapshot2).toBe(nextHealthy);
    expect(snapshot2).not.toBe(degraded);
  });

  it("4. a later healthy request's snapshot enters the normal TTL cache and is reused by a subsequent request", async () => {
    const degraded = snapshotFixture({ verificationHealth: "DEGRADED" });
    const healthy = snapshotFixture({ verificationHealth: "HEALTHY" });
    const produce = vi.fn().mockResolvedValueOnce(degraded).mockResolvedValueOnce(healthy);
    const cache = createKeyedTtlCache<VerifiedExecutionSnapshot>({ ttlMs: 60_000, produce });

    const first = await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    expect(first).toBe(degraded);

    const second = await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    expect(second).toBe(healthy);

    const third = await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    expect(produce).toHaveBeenCalledTimes(2);
    expect(third).toBe(healthy);
  });

  it("8. quote/result caching remains absent — compareAssetExecutionFromSnapshot calls the pricing primitive fresh on every call, even for the identical snapshot and input", async () => {
    const snapshot = snapshotFixture({
      verificationHealth: "HEALTHY",
      groups: [{ tokenOut: WETH, candidateCount: 1, v3Count: 1, v4Count: 0 }],
      candidates: [candidateFor(WETH, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")],
    });

    await compareAssetExecutionFromSnapshot(snapshot, { symbol: "NVDA" });
    await compareAssetExecutionFromSnapshot(snapshot, { symbol: "NVDA" });

    expect(vi.mocked(compareVerifiedPoolsExactInput)).toHaveBeenCalledTimes(2);
  });
});

describe("zero-groups error semantics distinguish DEGRADED from HEALTHY (release-critical)", () => {
  it("7. HEALTHY + genuinely zero verified groups preserves the existing honest NoVerifiedGroupsError behavior", async () => {
    const snapshot = snapshotFixture({ verificationHealth: "HEALTHY", groups: [], candidates: [] });
    await expect(compareAssetExecutionFromSnapshot(snapshot, { symbol: "NVDA" })).rejects.toThrow(NoVerifiedGroupsError);
  });

  it("6. DEGRADED + zero groups throws VerificationDegradedError instead of NoVerifiedGroupsError — never the same definitive error", async () => {
    const snapshot = snapshotFixture({ verificationHealth: "DEGRADED", groups: [], candidates: [] });
    const error: unknown = await compareAssetExecutionFromSnapshot(snapshot, { symbol: "NVDA" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerificationDegradedError);
    expect(error).not.toBeInstanceOf(NoVerifiedGroupsError);
  });

  it("DEGRADED + zero groups is distinct on the explicit-tokenOut path too, not just the default-group path", async () => {
    const snapshot = snapshotFixture({ verificationHealth: "DEGRADED", groups: [], candidates: [] });
    await expect(compareAssetExecutionFromSnapshot(snapshot, { symbol: "NVDA", tokenOut: WETH })).rejects.toThrow(VerificationDegradedError);
  });

  it("DEGRADED with at least one verified group is unaffected — existing graceful-degraded-operation behavior is preserved", async () => {
    const snapshot = snapshotFixture({
      verificationHealth: "DEGRADED",
      groups: [{ tokenOut: WETH, candidateCount: 1, v3Count: 1, v4Count: 0 }],
      candidates: [candidateFor(WETH, "0xffffffffffffffffffffffffffffffffffffffff")],
    });
    const result = await compareAssetExecutionFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result.selectedTokenOut).toBe(WETH);
  });
});
