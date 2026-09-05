import { zeroAddress, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputeVerifiedPoolDepthThresholdsInput, VerifiedPoolDepthThresholdsResult } from "@/domain/pool-quote";
import { NATIVE_ETH } from "../types";
import { CrossMarketDepthTooLargeError, UnknownOutputGroupError, VerificationDegradedError } from "../errors";
import { synthesizeExecutionSummary } from "../executionSummary";
import { NVDA, NVDA_ASSET, pool, snapshotFixture, verifiedV3Identity, verifiedV4Identity, USDG, WETH } from "./fixtures";
import type { ComparableExecutionGroup, VerifiedExecutionCandidate } from "../types";

// ---------------------------------------------------------------------------
// Hoisted, shared mock state — `vi.hoisted` so it's assignable from inside
// the `vi.mock` factory below (hoisted above imports) but readable/settable
// from ordinary test code.
// ---------------------------------------------------------------------------

const { rpcState } = vi.hoisted(() => ({
  rpcState: {
    clientCreations: 0,
    blockNumberCalls: 0,
    blockNumberImpl: async (): Promise<bigint> => 999n,
  },
}));

vi.mock("@/providers/robinhood-rpc", () => ({
  createVerifiedRobinhoodRpcClient: vi.fn(async () => {
    rpcState.clientCreations += 1;
    return {
      chainId: 4663,
      getBlockNumber: async () => {
        rpcState.blockNumberCalls += 1;
        return rpcState.blockNumberImpl();
      },
    } as unknown;
  }),
}));

const { depthState } = vi.hoisted(() => ({
  depthState: {
    log: [] as string[],
    delayMs: 5,
    tokenOutByPairAddress: new Map<string, string>(),
  },
}));

vi.mock("@/domain/pool-quote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/pool-quote")>();
  return {
    ...actual,
    computeVerifiedPoolDepthThresholds: vi.fn(
      async (args: {
        candidates: readonly { pool: { pairAddress: string } }[];
        tokenIn: string;
        amountsIn: readonly bigint[];
        thresholdsBps: readonly number[];
        blockNumber?: bigint;
      }) => {
        const label = args.candidates[0]?.pool.pairAddress ?? "unknown";
        depthState.log.push(`start(${label})`);
        await new Promise((resolve) => setTimeout(resolve, depthState.delayMs));
        depthState.log.push(`finish(${label})`);
        const tokenOut = depthState.tokenOutByPairAddress.get(label.toLowerCase()) ?? WETH;
        return {
          status: "OK",
          blockNumber: args.blockNumber ?? 0n,
          tokenIn: args.tokenIn,
          tokenOut,
          ladderAmountsIn: args.amountsIn,
          thresholdsBps: args.thresholdsBps,
          tokenInDecimals: 18,
          tokenOutDecimals: 18,
          sharedAnalyticsStatus: "OK",
          sharedEvidence: [],
          pools: [],
          bestVenueByThreshold: args.thresholdsBps.map((thresholdBps) => ({ thresholdBps, poolAddresses: [] })),
        };
      },
    ),
  };
});

const { compareAssetExecutionCrossMarketFromSnapshot, resolveSelectedGroupsForCrossMarket } = await import("../compareCrossMarket");
const { MAX_CROSS_MARKET_DEPTH_CELLS } = await import("../crossMarketPolicy");
const { computeVerifiedPoolDepthThresholds, classifyMatrixCandidates } = await import("@/domain/pool-quote");
const { planAssetExecutionCrossMarketFromSnapshot } = await import("../planCrossMarket");

function group(tokenOut: ComparableExecutionGroup["tokenOut"], candidateCount: number): ComparableExecutionGroup {
  return { tokenOut, candidateCount, v3Count: candidateCount, v4Count: 0 };
}

/** A well-formed, all-lowercase 20-byte address, deterministic from `n` — `getAddress` (used deep inside the REAL, unmocked `classifyMatrixCandidates`) rejects malformed/wrong-length hex, so every V3/generic test address goes through this helper rather than a hand-typed literal. */
function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

/** A well-formed 32-byte V4 poolId, deterministic from `n` — mirrors the existing `hookedV4Candidate` fixture convention in `compareDepthThresholds.test.ts`. */
function poolId(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function v3Candidate(pairAddress: `0x${string}`, tokenOut: `0x${string}`): VerifiedExecutionCandidate {
  return {
    pool: pool({ pairAddress, quoteToken: { address: tokenOut, name: "x", symbol: "X" } }),
    identity: verifiedV3Identity(pairAddress, NVDA, tokenOut),
    tokenOut,
  };
}

function nativeEthCandidate(poolId: `0x${string}`): VerifiedExecutionCandidate {
  return {
    pool: pool({ pairAddress: poolId, quoteToken: { address: zeroAddress, name: "ETH", symbol: "ETH" } }),
    identity: verifiedV4Identity(poolId, zeroAddress, NVDA, 500, 10, zeroAddress),
    tokenOut: NATIVE_ETH,
  };
}

function hookedV4Candidate(poolId: `0x${string}`, tokenOut: `0x${string}` = WETH): VerifiedExecutionCandidate {
  const HOOK = "0xf869A735ec31e28f77A6f917157BE63729F60880" as `0x${string}`;
  return {
    pool: pool({ pairAddress: poolId, quoteToken: { address: tokenOut, name: "x", symbol: "X" } }),
    identity: verifiedV4Identity(poolId, tokenOut, NVDA, 8388608, 4, HOOK),
    tokenOut,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcState.clientCreations = 0;
  rpcState.blockNumberCalls = 0;
  rpcState.blockNumberImpl = async () => 999n;
  depthState.log = [];
  depthState.delayMs = 5;
  depthState.tokenOutByPairAddress = new Map();
});

describe("resolveSelectedGroupsForCrossMarket", () => {
  it("omitted requested -> selects every group, preserving the snapshot's own deterministic order", () => {
    const groups = [group(WETH, 5), group(USDG, 3)];
    const selection = resolveSelectedGroupsForCrossMarket("NVDA", groups, undefined, "HEALTHY");
    expect(selection).toEqual({ kind: "GROUPS", tokenOuts: [WETH, USDG] });
  });

  it("HEALTHY + fewer than 2 groups (zero) -> INSUFFICIENT_MARKETS with availableMarketCount 0", () => {
    const selection = resolveSelectedGroupsForCrossMarket("NVDA", [], undefined, "HEALTHY");
    expect(selection).toEqual({ kind: "INSUFFICIENT_MARKETS", availableMarketCount: 0 });
  });

  it("HEALTHY + exactly 1 group -> INSUFFICIENT_MARKETS with availableMarketCount 1", () => {
    const selection = resolveSelectedGroupsForCrossMarket("NVDA", [group(WETH, 1)], undefined, "HEALTHY");
    expect(selection).toEqual({ kind: "INSUFFICIENT_MARKETS", availableMarketCount: 1 });
  });

  it("DEGRADED + fewer than 2 groups -> throws VerificationDegradedError, never INSUFFICIENT_MARKETS", () => {
    expect(() => resolveSelectedGroupsForCrossMarket("NVDA", [], undefined, "DEGRADED")).toThrow(VerificationDegradedError);
    expect(() => resolveSelectedGroupsForCrossMarket("NVDA", [group(WETH, 1)], undefined, "DEGRADED")).toThrow(VerificationDegradedError);
  });

  it("explicit selection preserves CALLER order, not the snapshot's own group order", () => {
    const groups = [group(WETH, 5), group(USDG, 3)];
    const selection = resolveSelectedGroupsForCrossMarket("NVDA", groups, [USDG, WETH], "HEALTHY");
    expect(selection).toEqual({ kind: "GROUPS", tokenOuts: [USDG, WETH] });
  });

  it("HEALTHY + one explicit group absent -> UnknownOutputGroupError", () => {
    const groups = [group(WETH, 5)];
    expect(() => resolveSelectedGroupsForCrossMarket("NVDA", groups, [WETH, USDG], "HEALTHY")).toThrow(UnknownOutputGroupError);
  });

  it("DEGRADED + one explicit group absent -> VerificationDegradedError, never UnknownOutputGroupError", () => {
    const groups = [group(WETH, 5)];
    const error: unknown = (() => {
      try {
        resolveSelectedGroupsForCrossMarket("NVDA", groups, [WETH, USDG], "DEGRADED");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(VerificationDegradedError);
    expect(error).not.toBeInstanceOf(UnknownOutputGroupError);
  });

  it("DEGRADED + every explicit group present -> proceeds normally, no error", () => {
    const groups = [group(WETH, 5), group(USDG, 3)];
    const selection = resolveSelectedGroupsForCrossMarket("NVDA", groups, [WETH, USDG], "DEGRADED");
    expect(selection).toEqual({ kind: "GROUPS", tokenOuts: [WETH, USDG] });
  });
});

describe("compareAssetExecutionCrossMarketFromSnapshot — insufficient markets (domain state, not an error)", () => {
  it("HEALTHY + zero groups + default selection -> INSUFFICIENT_MARKETS, zero RPC of any kind", async () => {
    const snapshot = snapshotFixture({ groups: [], candidates: [] });
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result).toEqual({ status: "INSUFFICIENT_MARKETS", asset: NVDA_ASSET, requiredMarketCount: 2, availableMarketCount: 0 });
    expect(rpcState.clientCreations).toBe(0);
    expect(computeVerifiedPoolDepthThresholds).not.toHaveBeenCalled();
  });

  it("HEALTHY + exactly one group + default selection -> INSUFFICIENT_MARKETS with availableMarketCount 1, zero RPC", async () => {
    const snapshot = snapshotFixture({ groups: [group(WETH, 3)], candidates: [v3Candidate(addr(0xaa), WETH)] });
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result).toEqual({ status: "INSUFFICIENT_MARKETS", asset: NVDA_ASSET, requiredMarketCount: 2, availableMarketCount: 1 });
    expect(rpcState.clientCreations).toBe(0);
  });

  it("DEGRADED + fewer than 2 groups -> throws VerificationDegradedError, never INSUFFICIENT_MARKETS", async () => {
    const snapshot = snapshotFixture({ groups: [], candidates: [], verificationHealth: "DEGRADED" });
    await expect(compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" })).rejects.toThrow(VerificationDegradedError);
    expect(rpcState.clientCreations).toBe(0);
  });
});

describe("compareAssetExecutionCrossMarketFromSnapshot — request-wide cell cap (preflight, before any RPC)", () => {
  function candidates(count: number, tokenOut: `0x${string}`, offset: number): VerifiedExecutionCandidate[] {
    return Array.from({ length: count }, (_, i) => v3Candidate((`0x${(offset + i + 1).toString(16).padStart(40, "0")}`) as `0x${string}`, tokenOut));
  }

  it("exactly 60 cells (5 executable x 12, split across 2 groups) is allowed", async () => {
    const wethCandidates = candidates(4, WETH, 0);
    const snapshot = snapshotFixture({ groups: [group(WETH, 4), group(USDG, 1)], candidates: [...wethCandidates, ...candidates(1, USDG, 100)] });
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result.status).toBe("OK");
  });

  it("84 cells (> 60) rejected with CrossMarketDepthTooLargeError, before any RPC client creation", async () => {
    const wethCandidates = candidates(5, WETH, 0);
    const usdgCandidates = candidates(2, USDG, 100);
    // 5 WETH + 2 USDG = 7 executable x 12 = 84 > 60.
    const snapshot = snapshotFixture({
      groups: [group(WETH, 5), group(USDG, 2)],
      candidates: [...wethCandidates, ...usdgCandidates],
    });
    const error: unknown = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrossMarketDepthTooLargeError);
    expect(rpcState.clientCreations).toBe(0);
    expect(computeVerifiedPoolDepthThresholds).not.toHaveBeenCalled();
  });

  it("combined groups may exceed the cap even though EACH group individually would not", async () => {
    // 3 WETH executable + 3 USDG executable = 6 x 12 = 72 > 60, but
    // 3 x 12 = 36 alone would never trip any single-group check.
    const snapshot = snapshotFixture({
      groups: [group(WETH, 3), group(USDG, 3)],
      candidates: [...candidates(3, WETH, 0), ...candidates(3, USDG, 100)],
    });
    const error: unknown = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrossMarketDepthTooLargeError);
  });

  it("PRECONDITION_FAILED hooked V4 rows (no hookData supplied) do NOT count toward the cap", async () => {
    // 2 executable V3 (WETH) + 12 hooked-without-hookData V4 (USDG) = 14
    // raw candidates. 14 x 12 = 168 > 60 (would wrongly reject if
    // counted raw); 2 x 12 = 24, well under MAX_CROSS_MARKET_DEPTH_CELLS.
    const executables = candidates(2, WETH, 0);
    const hooked = Array.from({ length: 12 }, (_, i) => hookedV4Candidate((`0x${(i + 1).toString(16).padStart(64, "0")}`) as `0x${string}`, USDG));
    const snapshot = snapshotFixture({
      groups: [group(WETH, 2), group(USDG, 12)],
      candidates: [...executables, ...hooked],
    });
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result.status).toBe("OK");
  });

  it("MAX_CROSS_MARKET_DEPTH_CELLS is frozen at 60", () => {
    expect(MAX_CROSS_MARKET_DEPTH_CELLS).toBe(60);
  });
});

describe("compareAssetExecutionCrossMarketFromSnapshot — block orchestration", () => {
  function threeGroupSnapshot() {
    return snapshotFixture({
      groups: [group(WETH, 1), group(USDG, 1), group(NATIVE_ETH, 1)],
      candidates: [v3Candidate(addr(0xa1), WETH), v3Candidate(addr(0xa2), USDG), nativeEthCandidate(poolId(0xa3))],
    });
  }

  it("with 3 groups: exactly ONE createVerifiedRobinhoodRpcClient call and exactly ONE getBlockNumber call for the whole request", async () => {
    const { createVerifiedRobinhoodRpcClient } = await import("@/providers/robinhood-rpc");
    const snapshot = threeGroupSnapshot();
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result.status).toBe("OK");
    expect(vi.mocked(createVerifiedRobinhoodRpcClient)).toHaveBeenCalledTimes(1);
    expect(rpcState.blockNumberCalls).toBe(1);
  });

  it("every group's own result.blockNumber equals the single top-level blockNumber", async () => {
    rpcState.blockNumberImpl = async () => 555_555n;
    const snapshot = threeGroupSnapshot();
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    if (result.status !== "OK") throw new Error("expected OK");
    expect(result.blockNumber).toBe(555_555n);
    for (const g of result.groups) {
      expect(g.result.blockNumber).toBe(555_555n);
    }
  });

  it("block-pin failure -> top-level BLOCK_PIN_FAILURE, ZERO group executions, ZERO Phase 6G synthesis calls", async () => {
    rpcState.blockNumberImpl = async () => {
      throw new Error("boom");
    };
    const snapshot = threeGroupSnapshot();
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result).toEqual({ status: "BLOCK_PIN_FAILURE", asset: NVDA_ASSET });
    expect(computeVerifiedPoolDepthThresholds).not.toHaveBeenCalled();
    expect(depthState.log).toEqual([]);
  });

  it("RELEASE-CRITICAL: a group result reporting status OK but a DIFFERENT block than the shared request block fails the WHOLE request closed — never fabricates an inconsistent envelope", async () => {
    rpcState.blockNumberImpl = async () => 555_555n;
    const snapshot = threeGroupSnapshot();
    // The mocked primitive misbehaves for its very first call: it
    // reports "OK" (a legitimate-looking status) but echoes back a
    // WRONG block — one off from the shared 555_555n every group was
    // supposed to share. This is exactly the kind of quiet corruption
    // `assertOkDepthThresholdsResultAtSharedBlock` exists to catch: a
    // per-group `status` check alone would have accepted this result.
    vi.mocked(computeVerifiedPoolDepthThresholds).mockImplementationOnce(
      async (args: ComputeVerifiedPoolDepthThresholdsInput): Promise<VerifiedPoolDepthThresholdsResult> => ({
        status: "OK",
        blockNumber: (args.blockNumber ?? 0n) + 1n,
        tokenIn: args.tokenIn,
        tokenOut: WETH as Address,
        ladderAmountsIn: args.amountsIn,
        thresholdsBps: args.thresholdsBps,
        tokenInDecimals: 18,
        tokenOutDecimals: 18,
        sharedAnalyticsStatus: "OK",
        sharedEvidence: [],
        pools: [],
        bestVenueByThreshold: args.thresholdsBps.map((thresholdBps) => ({ thresholdBps, poolAddresses: [] })),
      }),
    );

    await expect(compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" })).rejects.toThrow(/blockNumber/);
  });
});

describe("compareAssetExecutionCrossMarketFromSnapshot — sequential group execution (release-critical)", () => {
  it("groups execute strictly sequentially: start(A) finish(A) start(B) finish(B) start(C) finish(C), never interleaved", async () => {
    const A = addr(0xa1);
    const B = addr(0xb1);
    const C = poolId(0xc1);
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(USDG, 1), group(NATIVE_ETH, 1)],
      candidates: [v3Candidate(A, WETH), v3Candidate(B, USDG), nativeEthCandidate(C)],
    });

    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result.status).toBe("OK");
    expect(depthState.log).toEqual([`start(${A})`, `finish(${A})`, `start(${B})`, `finish(${B})`, `start(${C})`, `finish(${C})`]);
  });
});

describe("compareAssetExecutionCrossMarketFromSnapshot — Phase 6G reuse (unmodified)", () => {
  it("each group's summary deeply equals a DIRECT synthesizeExecutionSummary(result, verificationHealth) call", async () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(USDG, 1)],
      candidates: [v3Candidate(addr(0xb1), WETH), v3Candidate(addr(0xb2), USDG)],
      verificationHealth: "DEGRADED",
    });
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    if (result.status !== "OK") throw new Error("expected OK");
    for (const g of result.groups) {
      expect(g.summary).toEqual(synthesizeExecutionSummary(g.result, "DEGRADED"));
    }
  });
});

describe("compareAssetExecutionCrossMarketFromSnapshot — value comparability (frozen, no ranking/normalization)", () => {
  it("every OK result's valueComparison is EXACTLY {availability: 'UNAVAILABLE', reason: 'NO_TRUSTED_NORMALIZATION_SOURCE'}", async () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(USDG, 1)],
      candidates: [v3Candidate(addr(0xc1), WETH), v3Candidate(addr(0xc2), USDG)],
    });
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    if (result.status !== "OK") throw new Error("expected OK");
    expect(result.valueComparison).toEqual({ availability: "UNAVAILABLE", reason: "NO_TRUSTED_NORMALIZATION_SOURCE" });
    expect(Object.keys(result.valueComparison)).toEqual(["availability", "reason"]);
  });

  it("WETH + NATIVE_ETH are NOT special-cased — identical valueComparison and identical group-envelope shape as any other pair", async () => {
    const wethPool = addr(0xd1);
    const nativePool = poolId(0xd2);
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(NATIVE_ETH, 1)],
      candidates: [v3Candidate(wethPool, WETH), nativeEthCandidate(nativePool)],
    });
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA" });
    if (result.status !== "OK") throw new Error("expected OK");
    expect(result.valueComparison).toEqual({ availability: "UNAVAILABLE", reason: "NO_TRUSTED_NORMALIZATION_SOURCE" });
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]!.tokenOut).toBe(WETH);
    expect(result.groups[1]!.tokenOut).toBe(NATIVE_ETH);
    // No group carries any additional field beyond the frozen schema —
    // in particular, no per-group "normalizedAmountOut"/"rank"/"winner".
    for (const g of result.groups) {
      expect(Object.keys(g).sort()).toEqual(["result", "summary", "tokenOut"]);
    }
  });
});

describe("compareAssetExecutionCrossMarketFromSnapshot — hookData is per-candidate, never a single global value", () => {
  it("hookData keyed by pairAddress is forwarded only to the matching candidate's own group call", async () => {
    const hookedPool = poolId(0xe1);
    const hex: Hex = "0xdead";
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(USDG, 1)],
      candidates: [hookedV4Candidate(hookedPool, WETH), v3Candidate(addr(0xe2), USDG)],
    });
    const hookData = new Map([[hookedPool.toLowerCase(), hex]]);
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA", hookData });
    expect(result.status).toBe("OK");
    const mock = vi.mocked(computeVerifiedPoolDepthThresholds);
    const wethCall = mock.mock.calls.find((call) => (call[0] as { candidates: readonly { pool: { pairAddress: string } }[] }).candidates[0]?.pool.pairAddress === hookedPool);
    expect(wethCall).toBeDefined();
    const forwardedHookData = (wethCall![0] as { candidates: readonly { hookData?: Hex }[] }).candidates[0]?.hookData;
    expect(forwardedHookData).toBe(hex);
  });
});

describe("Planner/executor EXACT PER-GROUP candidate-assembly parity (RELEASE-CRITICAL, adversarial gap fix)", () => {
  it("catches a per-group swap that an aggregate-only comparison would miss, AND a hookData-casing drift between planner and executor: group executable counts are DELIBERATELY ASYMMETRIC, one candidate is unlocked via MIXED-CASE hookData, and both are cross-checked by independently RE-CLASSIFYING the exact raw candidate array the executor actually handed to the quote primitive — never merely trusting either side's own self-reported number", async () => {
    // WETH group: 2 executable V3 + 1 precondition-failed V4 (no hookData) = 3 verified, 2 executable.
    // USDG group: 1 executable V3 + 1 precondition-failed V4 (no hookData)
    //             + 1 hooked V4 UNLOCKED via hookData supplied under a
    //             MIXED-CASE pairAddress key = 3 verified, 2 executable.
    // Total executable = 4 (48 projected cells, well under the 60 cap) —
    // chosen so the executor SUCCEEDS and reaches its sequential
    // per-group RPC calls, letting us capture exactly what candidate
    // array it built for EACH group individually (not just the
    // aggregate accept/reject verdict CrossMarketDepthTooLargeError
    // exposes). Two DISTINCT drift classes are covered simultaneously:
    //  (a) a per-group swap (e.g. planner computing 1+3 while the
    //      executor computes 2+2 — same aggregate, wrong per-group
    //      split) — caught because each group's count is checked
    //      INDIVIDUALLY, never merely summed;
    //  (b) a hookData-lookup CASING mismatch between the two
    //      independent candidate-assembly restatements (e.g. one side
    //      normalizing to lowercase, the other not normalizing at all)
    //      — caught because the supplied hookData key's casing does NOT
    //      match either candidate's own `pairAddress` casing verbatim,
    //      so only a correctly-normalizing lookup unlocks the candidate
    //      on BOTH sides.
    // The candidate's OWN pairAddress is stored MIXED-CASE (realistic —
    // pool addresses commonly arrive checksummed), while the hookData
    // map is keyed with the LOWERCASE form — the SAME real-world
    // convention `requestCrossMarket.ts` already establishes at the
    // HTTP boundary (`map.set(poolAddress.toLowerCase(), value)`). Only
    // a lookup that correctly lowercases the CANDIDATE's own address
    // before consulting the map — on BOTH sides — unlocks this
    // candidate; a one-sided casing bug leaves it precondition-failed
    // on exactly one side, breaking the cross-check below.
    const unlockedPoolIdLower = poolId(0xb2);
    const unlockedPoolIdMixedCase = (unlockedPoolIdLower.slice(0, 2) + unlockedPoolIdLower.slice(2).toUpperCase()) as `0x${string}`;
    const wethCandidates = [
      v3Candidate(addr(0xa1), WETH),
      v3Candidate(addr(0xa2), WETH),
      hookedV4Candidate(poolId(0xa3), WETH),
    ];
    const usdgCandidates = [
      v3Candidate(addr(0xb1), USDG),
      hookedV4Candidate(unlockedPoolIdMixedCase, USDG),
      hookedV4Candidate(poolId(0xb3), USDG),
    ];
    const snapshot = snapshotFixture({
      groups: [group(WETH, 3), group(USDG, 3)],
      candidates: [...wethCandidates, ...usdgCandidates],
    });
    const hex: Hex = "0xdead";
    const hookData = new Map([[unlockedPoolIdLower, hex]]);

    // 1. The planner's own per-group executable counts, with the SAME
    // mixed-case hookData map.
    const plan = planAssetExecutionCrossMarketFromSnapshot(snapshot, { hookData });
    if (plan.status !== "DESCRIBED") throw new Error("expected DESCRIBED");
    const plannerByTokenOut = new Map(plan.groups.map((g) => [g.tokenOut, g.executableCandidateCount]));
    expect(plannerByTokenOut.get(WETH)).toBe(2);
    expect(plannerByTokenOut.get(USDG)).toBe(2);

    // 2. Run the REAL executor (RPC/quote calls mocked, exactly like
    // every other test in this file), with the SAME hookData map, and
    // capture the EXACT raw candidate array it handed to
    // computeVerifiedPoolDepthThresholds for each of its two
    // sequential group calls.
    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, { symbol: "NVDA", hookData });
    expect(result.status).toBe("OK");
    const mock = vi.mocked(computeVerifiedPoolDepthThresholds);
    expect(mock.mock.calls).toHaveLength(2);

    // 3. For EACH captured call, independently re-classify the EXACT
    // array the executor actually built — via the REAL (unmocked)
    // classifyMatrixCandidates, the SAME authoritative function
    // classifyCrossMarketGroup itself wraps — to derive the executor's
    // OWN true per-group executable count from its own real output,
    // never from a number either side merely reports about itself.
    for (const [args] of mock.mock.calls) {
      const typedArgs = args as { candidates: readonly { pool: { pairAddress: string; quoteToken: { address: string } } }[]; tokenIn: Address };
      const executorTokenOut = typedArgs.candidates[0]!.pool.quoteToken.address as typeof WETH;
      const { executable } = classifyMatrixCandidates(
        typedArgs.candidates as Parameters<typeof classifyMatrixCandidates>[0],
        typedArgs.tokenIn,
        4663,
      );
      expect(executable.length).toBe(plannerByTokenOut.get(executorTokenOut));
    }
  });
});
