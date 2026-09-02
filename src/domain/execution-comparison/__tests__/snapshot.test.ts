import { zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyedTtlCache } from "@/lib/cache/keyedTtlCache";
import { NATIVE_ETH } from "../types";
import type { VerifiedExecutionSnapshot } from "../types";
import { buildGroups, buildVerifiedExecutionSnapshotWithDeps, deriveVerifiedTokenOut, getVerifiedExecutionSnapshotFromCache, verifyWithRetry } from "../snapshot";
import { NVDA, NVDA_ASSET, nonVerifiedIdentity, pool, snapshotFixture, USDG, verifiedV3Identity, verifiedV4Identity, WETH } from "./fixtures";

describe("deriveVerifiedTokenOut — verified grouping direction", () => {
  it("V3: tokenIn === token0 -> tokenOut is token1", () => {
    const identity = verifiedV3Identity("0xaa", NVDA, USDG);
    expect(deriveVerifiedTokenOut(NVDA, identity)).toBe(USDG);
  });

  it("V3: tokenIn === token1 -> tokenOut is token0", () => {
    const identity = verifiedV3Identity("0xaa", USDG, NVDA);
    expect(deriveVerifiedTokenOut(NVDA, identity)).toBe(USDG);
  });

  it("V4: tokenIn === currency0 -> tokenOut is currency1", () => {
    const identity = verifiedV4Identity("0xbb", NVDA, WETH);
    expect(deriveVerifiedTokenOut(NVDA, identity)).toBe(WETH);
  });

  it("V4: tokenIn === currency1 -> tokenOut is currency0", () => {
    const identity = verifiedV4Identity("0xbb", WETH, NVDA);
    expect(deriveVerifiedTokenOut(NVDA, identity)).toBe(WETH);
  });

  it("V4 native ETH: a zero-address currency resolves to the NATIVE_ETH sentinel, never a raw zero address", () => {
    const identity = verifiedV4Identity("0xbb", zeroAddress, NVDA);
    expect(deriveVerifiedTokenOut(NVDA, identity)).toBe(NATIVE_ETH);
  });

  it("V4 native ETH kept distinct from WETH — the two never collapse to the same tokenOut value", () => {
    const nativeSide = deriveVerifiedTokenOut(NVDA, verifiedV4Identity("0xbb", zeroAddress, NVDA));
    const wethSide = deriveVerifiedTokenOut(NVDA, verifiedV4Identity("0xcc", WETH, NVDA));
    expect(nativeSide).toBe(NATIVE_ETH);
    expect(wethSide).toBe(WETH);
    expect(nativeSide).not.toBe(wethSide);
  });

  it("returns null when the canonical asset is not actually a side of the verified pair (defensive)", () => {
    const identity = verifiedV3Identity("0xaa", USDG, WETH);
    expect(deriveVerifiedTokenOut(NVDA, identity)).toBeNull();
  });

  it("returns null for a non-VERIFIED-shaped identity missing v3PoolKey/poolKey", () => {
    expect(deriveVerifiedTokenOut(NVDA, nonVerifiedIdentity("INDETERMINATE"))).toBeNull();
  });
});

describe("deriveVerifiedTokenOut — Dexscreener metadata cannot override verified identity", () => {
  it("tokenOut is derived ONLY from v3PoolKey, never from pool.baseToken/quoteToken (which this function does not even receive)", () => {
    // The verified identity says NVDA/USDG. There is no `pool` object
    // passed to this function at all — it is structurally impossible
    // for spoofed baseToken/quoteToken metadata to influence the
    // result, since the function's own signature never accepts it.
    const identity = verifiedV3Identity("0xaa", NVDA, USDG);
    expect(deriveVerifiedTokenOut(NVDA, identity)).toBe(USDG);
  });
});

describe("buildGroups — default group selection and deterministic tie-break", () => {
  it("orders groups by candidateCount descending", () => {
    const candidates = [
      { pool: pool(), identity: verifiedV3Identity("0xa1", NVDA, USDG), tokenOut: USDG },
      { pool: pool(), identity: verifiedV3Identity("0xa2", NVDA, USDG), tokenOut: USDG },
      { pool: pool(), identity: verifiedV4Identity("0xb1", NVDA, WETH), tokenOut: WETH },
    ];
    const groups = buildGroups(candidates);
    expect(groups[0]!.tokenOut).toBe(USDG);
    expect(groups[0]!.candidateCount).toBe(2);
    expect(groups[1]!.tokenOut).toBe(WETH);
    expect(groups[1]!.candidateCount).toBe(1);
  });

  it("ties are broken deterministically by tokenOut string, never by insertion/Map iteration order", () => {
    // WETH (0x0Bd7...) < USDG (0x5fc5...) lexicographically when lowercased.
    const candidatesOrderA = [
      { pool: pool(), identity: verifiedV3Identity("0xa1", NVDA, USDG), tokenOut: USDG },
      { pool: pool(), identity: verifiedV4Identity("0xb1", NVDA, WETH), tokenOut: WETH },
    ];
    const candidatesOrderB = [...candidatesOrderA].reverse();

    const groupsA = buildGroups(candidatesOrderA);
    const groupsB = buildGroups(candidatesOrderB);

    expect(groupsA.map((g) => g.tokenOut)).toEqual(groupsB.map((g) => g.tokenOut));
    expect(groupsA[0]!.tokenOut.toLowerCase()).toBe(WETH.toLowerCase());
  });

  it("counts v3Count/v4Count correctly per group", () => {
    const candidates = [
      { pool: pool(), identity: verifiedV3Identity("0xa1", NVDA, USDG), tokenOut: USDG },
      { pool: pool(), identity: verifiedV4Identity("0xb1", NVDA, USDG), tokenOut: USDG },
      { pool: pool(), identity: verifiedV4Identity("0xb2", NVDA, USDG), tokenOut: USDG },
    ];
    const groups = buildGroups(candidates);
    expect(groups[0]!.v3Count).toBe(1);
    expect(groups[0]!.v4Count).toBe(2);
  });

  it("keeps a native-ETH group separate from a WETH group even when candidate counts tie", () => {
    const candidates = [
      { pool: pool(), identity: verifiedV4Identity("0xb1", zeroAddress, NVDA), tokenOut: NATIVE_ETH },
      { pool: pool(), identity: verifiedV4Identity("0xb2", WETH, NVDA), tokenOut: WETH },
    ];
    const groups = buildGroups(candidates);
    expect(groups).toHaveLength(2);
    expect(groups.some((g) => g.tokenOut === NATIVE_ETH)).toBe(true);
    expect(groups.some((g) => g.tokenOut === WETH)).toBe(true);
  });
});

describe("verifyWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately on a VERIFIED first attempt, no retry", async () => {
    const verified = verifiedV3Identity("0xaa", NVDA, USDG);
    const verify = vi.fn().mockResolvedValue(verified);
    const result = await verifyWithRetry(verify, [250, 750]);
    expect(result).toBe(verified);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("retries a transient RPC_ERROR and succeeds on the second attempt", async () => {
    const rpcError = nonVerifiedIdentity("RPC_ERROR");
    const verified = verifiedV3Identity("0xaa", NVDA, USDG);
    const verify = vi.fn().mockResolvedValueOnce(rpcError).mockResolvedValueOnce(verified);

    const promise = verifyWithRetry(verify, [250, 750]);
    await vi.advanceTimersByTimeAsync(250);
    const result = await promise;

    expect(result).toBe(verified);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("uses the exact configured backoff delays in order", async () => {
    const rpcError = nonVerifiedIdentity("RPC_ERROR");
    const verified = verifiedV3Identity("0xaa", NVDA, USDG);
    const verify = vi.fn().mockResolvedValueOnce(rpcError).mockResolvedValueOnce(rpcError).mockResolvedValueOnce(verified);

    const promise = verifyWithRetry(verify, [250, 750]);
    // Not enough time yet for the second delay to have elapsed.
    await vi.advanceTimersByTimeAsync(250);
    expect(verify).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(750);
    const result = await promise;

    expect(result).toBe(verified);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it("is bounded — never retries more than delaysMs.length times, returns the final (still-failed) result", async () => {
    const rpcError = nonVerifiedIdentity("RPC_ERROR");
    const verify = vi.fn().mockResolvedValue(rpcError);

    const promise = verifyWithRetry(verify, [250, 750]);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(750);
    const result = await promise;

    expect(result.status).toBe("RPC_ERROR");
    // Initial attempt + 2 retries = 3 total calls, never more.
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a deterministic verification contradiction (CONTRADICTED)", async () => {
    const contradicted = nonVerifiedIdentity("CONTRADICTED");
    const verify = vi.fn().mockResolvedValue(contradicted);
    const result = await verifyWithRetry(verify, [250, 750]);
    expect(result.status).toBe("CONTRADICTED");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry INDETERMINATE (a decode failure, not a transport failure)", async () => {
    const indeterminate = nonVerifiedIdentity("INDETERMINATE");
    const verify = vi.fn().mockResolvedValue(indeterminate);
    const result = await verifyWithRetry(verify, [250, 750]);
    expect(result.status).toBe("INDETERMINATE");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry UNSUPPORTED", async () => {
    const unsupported = nonVerifiedIdentity("UNSUPPORTED");
    const verify = vi.fn().mockResolvedValue(unsupported);
    const result = await verifyWithRetry(verify, [250, 750]);
    expect(result.status).toBe("UNSUPPORTED");
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe("buildVerifiedExecutionSnapshotWithDeps", () => {
  it("includes only VERIFIED candidates, grouped by verified tokenOut", async () => {
    const poolA = pool({ pairAddress: "0x0100000000000000000000000000000000000001" });
    const poolB = pool({ pairAddress: "0x0200000000000000000000000000000000000000000000000000000000000002", labels: ["v4"] });
    const deps = {
      getAsset: async () => NVDA_ASSET,
      getPools: async () => ({ pools: [poolA, poolB] }),
      verifyIdentity: async (p: typeof poolA) =>
        p.pairAddress === "0x0100000000000000000000000000000000000001" ? verifiedV3Identity("0x0100000000000000000000000000000000000001", NVDA, USDG) : verifiedV4Identity("0x0200000000000000000000000000000000000000000000000000000000000002", NVDA, WETH),
    };

    const snapshot = await buildVerifiedExecutionSnapshotWithDeps("NVDA", deps);

    expect(snapshot.candidates).toHaveLength(2);
    expect(snapshot.groups).toHaveLength(2);
    expect(snapshot.asset).toBe(NVDA_ASSET);
    expect(snapshot.verificationHealth).toBe("HEALTHY");
  });

  it("a persistently-failing candidate (RPC_ERROR through all retries) is excluded from the snapshot, and the snapshot is marked DEGRADED, never cached as a durable negative result", async () => {
    const poolA = pool({ pairAddress: "0x0100000000000000000000000000000000000001" });
    const deps = {
      getAsset: async () => NVDA_ASSET,
      getPools: async () => ({ pools: [poolA] }),
      verifyIdentity: async () => nonVerifiedIdentity("RPC_ERROR"),
    };

    const snapshot = await buildVerifiedExecutionSnapshotWithDeps("NVDA", deps);

    expect(snapshot.candidates).toHaveLength(0);
    expect(snapshot.groups).toHaveLength(0);
    expect(snapshot.verificationHealth).toBe("DEGRADED");
  });

  it("a deterministic (non-transient) exclusion — CONTRADICTED/INDETERMINATE/UNSUPPORTED — does NOT mark the snapshot DEGRADED", async () => {
    const poolA = pool({ pairAddress: "0x0100000000000000000000000000000000000001" });
    const deps = {
      getAsset: async () => NVDA_ASSET,
      getPools: async () => ({ pools: [poolA] }),
      verifyIdentity: async () => nonVerifiedIdentity("INDETERMINATE"),
    };

    const snapshot = await buildVerifiedExecutionSnapshotWithDeps("NVDA", deps);

    expect(snapshot.candidates).toHaveLength(0);
    expect(snapshot.verificationHealth).toBe("HEALTHY");
  });

  it("a candidate that fails once (RPC_ERROR) then succeeds becomes VERIFIED, appears in the snapshot, and the snapshot is HEALTHY (the transient failure resolved)", async () => {
    const poolA = pool({ pairAddress: "0x0100000000000000000000000000000000000001" });
    let calls = 0;
    const deps = {
      getAsset: async () => NVDA_ASSET,
      getPools: async () => ({ pools: [poolA] }),
      verifyIdentity: async () => {
        calls++;
        return calls === 1 ? nonVerifiedIdentity("RPC_ERROR") : verifiedV3Identity("0x0100000000000000000000000000000000000001", NVDA, USDG);
      },
    };

    const snapshot = await buildVerifiedExecutionSnapshotWithDeps("NVDA", deps);

    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]!.identity.status).toBe("VERIFIED");
    expect(snapshot.verificationHealth).toBe("HEALTHY");
  }, 10000);

  it("non-CLASSIFIED / unsupported-family pools never reach verification at all", async () => {
    const poolA = pool({ pairAddress: "0x0100000000000000000000000000000000000001" });
    const verifyIdentity = vi.fn();
    const deps = {
      getAsset: async () => NVDA_ASSET,
      getPools: async () => ({ pools: [poolA] }),
      verifyIdentity,
    };
    // classifyPoolProtocol runs for real inside buildVerifiedExecutionSnapshotWithDeps —
    // poolA's default labels (["v3"]) with dexId "uniswap" should classify.
    // To exercise the "never reaches verification" path, use a pool with no recognizable labels.
    const unclassifiablePool = pool({ pairAddress: "0x0900000000000000000000000000000000000009", dexId: "totally-unknown-dex", labels: [] });
    const deps2 = { ...deps, getPools: async () => ({ pools: [unclassifiablePool] }) };

    const snapshot = await buildVerifiedExecutionSnapshotWithDeps("NVDA", deps2);

    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(snapshot.candidates).toHaveLength(0);
  });
});

describe("getVerifiedExecutionSnapshotFromCache — degraded snapshot must not enter the normal TTL cache (release-critical)", () => {
  it("A. a HEALTHY build is cached: a second request for the same symbol reuses it without re-producing", async () => {
    const produce = vi.fn(async () => snapshotFixture({ verificationHealth: "HEALTHY" }));
    const cache = createKeyedTtlCache<VerifiedExecutionSnapshot>({ ttlMs: 60_000, produce });

    const first = await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    const second = await getVerifiedExecutionSnapshotFromCache("NVDA", cache);

    expect(produce).toHaveBeenCalledTimes(1);
    expect(first.verificationHealth).toBe("HEALTHY");
    expect(second).toBe(first);
  });

  it("B. a candidate that failed transiently then succeeded on retry produces a HEALTHY snapshot, which is cached normally", async () => {
    // The retry itself is proven by verifyWithRetry's own tests and by
    // buildVerifiedExecutionSnapshotWithDeps's "fails once then succeeds"
    // test above; here we only need to confirm the CACHING layer treats
    // the resulting HEALTHY snapshot exactly like case A.
    const produce = vi.fn(async () => snapshotFixture({ verificationHealth: "HEALTHY", candidates: [] }));
    const cache = createKeyedTtlCache<VerifiedExecutionSnapshot>({ ttlMs: 60_000, produce });

    await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    await getVerifiedExecutionSnapshotFromCache("NVDA", cache);

    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("C. a DEGRADED build (persistent RPC_ERROR after retries) is returned for the CURRENT request, but is NOT retained in the cache", async () => {
    const produce = vi.fn(async () => snapshotFixture({ verificationHealth: "DEGRADED" }));
    const cache = createKeyedTtlCache<VerifiedExecutionSnapshot>({ ttlMs: 60_000, produce });

    const result = await getVerifiedExecutionSnapshotFromCache("NVDA", cache);

    expect(result.verificationHealth).toBe("DEGRADED");
    // Proof of non-retention: a SECOND call, still well within the 60s
    // TTL, must re-invoke produce() rather than reusing the degraded
    // value — see test D below, which asserts this explicitly.
  });

  it("D. after a DEGRADED build, the NEXT request re-runs the verification producer rather than reusing the degraded snapshot", async () => {
    const produce = vi.fn(async () => snapshotFixture({ verificationHealth: "DEGRADED" }));
    const cache = createKeyedTtlCache<VerifiedExecutionSnapshot>({ ttlMs: 60_000, produce });

    await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    await getVerifiedExecutionSnapshotFromCache("NVDA", cache);

    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("E. if the next verification (after a prior DEGRADED build) succeeds fully, the resulting HEALTHY snapshot IS cached", async () => {
    let calls = 0;
    const healthyCandidate = { pool: pool(), identity: verifiedV3Identity("0x0100000000000000000000000000000000000001", NVDA, USDG), tokenOut: USDG };
    const produce = vi.fn(async () => {
      calls++;
      return calls === 1
        ? snapshotFixture({ verificationHealth: "DEGRADED", candidates: [] })
        : snapshotFixture({ verificationHealth: "HEALTHY", candidates: [healthyCandidate] });
    });
    const cache = createKeyedTtlCache<VerifiedExecutionSnapshot>({ ttlMs: 60_000, produce });

    const degraded = await getVerifiedExecutionSnapshotFromCache("NVDA", cache); // call 1: DEGRADED, evicted
    const healthy = await getVerifiedExecutionSnapshotFromCache("NVDA", cache); // call 2: HEALTHY, cached
    const stillHealthy = await getVerifiedExecutionSnapshotFromCache("NVDA", cache); // reuses call 2's cached value

    expect(degraded.verificationHealth).toBe("DEGRADED");
    expect(healthy.verificationHealth).toBe("HEALTHY");
    expect(healthy.candidates).toHaveLength(1);
    expect(stillHealthy).toBe(healthy);
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("does not affect a DIFFERENT symbol's independently cached snapshot", async () => {
    const produce = vi.fn(async (symbol: string) =>
      symbol === "NVDA" ? snapshotFixture({ verificationHealth: "DEGRADED" }) : snapshotFixture({ verificationHealth: "HEALTHY" }),
    );
    const cache = createKeyedTtlCache<VerifiedExecutionSnapshot>({ ttlMs: 60_000, produce });

    await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    await getVerifiedExecutionSnapshotFromCache("NVDA", cache);
    await getVerifiedExecutionSnapshotFromCache("AAPL", cache);
    await getVerifiedExecutionSnapshotFromCache("AAPL", cache);

    // NVDA (DEGRADED): re-produced every call. AAPL (HEALTHY): produced once.
    expect(produce).toHaveBeenCalledTimes(3);
  });

  it("F. no execution quote/result field exists on the cached (or evicted) snapshot type — the caching change here cannot leak into cached execution truth", async () => {
    const produce = vi.fn(async () => snapshotFixture({ verificationHealth: "DEGRADED" }));
    const cache = createKeyedTtlCache<VerifiedExecutionSnapshot>({ ttlMs: 60_000, produce });

    const result = await getVerifiedExecutionSnapshotFromCache("NVDA", cache);

    const keys = Object.keys(result);
    for (const forbidden of ["amountOut", "status", "ranking", "executionPrice", "priceImpactBps", "blockNumber"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
