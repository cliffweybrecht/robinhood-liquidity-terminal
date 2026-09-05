import { zeroAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_ETH } from "../types";
import { DepthThresholdsTooLargeError, MissingTokenDecimalsError, NoVerifiedGroupsError, UnknownOutputGroupError, VerificationDegradedError } from "../errors";
import { NVDA, NVDA_ASSET, pool, snapshotFixture, verifiedV3Identity, verifiedV4Identity, WETH } from "./fixtures";
import type { ComparableExecutionGroup, VerifiedExecutionCandidate } from "../types";

vi.mock("@/providers/robinhood-rpc", () => ({
  createVerifiedRobinhoodRpcClient: vi.fn(async () => ({ chainId: 4663 }) as unknown),
}));

vi.mock("@/domain/pool-quote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/pool-quote")>();
  return {
    ...actual,
    computeVerifiedPoolDepthThresholds: vi.fn(async (args: { tokenIn: string; amountsIn: readonly bigint[]; thresholdsBps: readonly number[] }) => ({
      status: "OK",
      blockNumber: 999n,
      tokenIn: args.tokenIn,
      tokenOut: WETH,
      ladderAmountsIn: args.amountsIn,
      thresholdsBps: args.thresholdsBps,
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      sharedAnalyticsStatus: "OK",
      sharedEvidence: [],
      pools: [],
      bestVenueByThreshold: [],
    })),
  };
});

const { compareAssetExecutionDepthThresholdsFromSnapshot, resolveSelectedTokenOutForDepthThresholdsForTesting, DEPTH_THRESHOLD_BPS, DEPTH_THRESHOLD_LADDER_MULTIPLIERS } =
  await import("../compareDepthThresholds");
const { computeVerifiedPoolDepthThresholds } = await import("@/domain/pool-quote");

function group(tokenOut: ComparableExecutionGroup["tokenOut"], candidateCount: number): ComparableExecutionGroup {
  return { tokenOut, candidateCount, v3Count: candidateCount, v4Count: 0 };
}

function v3Candidate(pairAddress: `0x${string}`, tokenOut: `0x${string}` = WETH): VerifiedExecutionCandidate {
  return {
    pool: pool({ pairAddress, quoteToken: { address: tokenOut, name: "x", symbol: "X" } }),
    identity: verifiedV3Identity(pairAddress, NVDA, tokenOut),
    tokenOut,
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

describe("resolveSelectedTokenOutForDepthThresholds (mirrors compare.ts's own resolveSelectedTokenOut precedence)", () => {
  it("omitted tokenOut -> selects groups[0]", () => {
    const groups = [group(WETH, 5)];
    expect(resolveSelectedTokenOutForDepthThresholdsForTesting("NVDA", groups, undefined, "HEALTHY")).toBe(WETH);
  });

  it("throws NoVerifiedGroupsError when HEALTHY and zero groups", () => {
    expect(() => resolveSelectedTokenOutForDepthThresholdsForTesting("NVDA", [], undefined, "HEALTHY")).toThrow(NoVerifiedGroupsError);
  });

  it("throws VerificationDegradedError (not NoVerifiedGroupsError) when DEGRADED and zero groups", () => {
    const error: unknown = (() => {
      try {
        resolveSelectedTokenOutForDepthThresholdsForTesting("NVDA", [], undefined, "DEGRADED");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(VerificationDegradedError);
    expect(error).not.toBeInstanceOf(NoVerifiedGroupsError);
  });

  it("throws UnknownOutputGroupError for an explicit tokenOut with no match", () => {
    const groups = [group(WETH, 5)];
    expect(() => resolveSelectedTokenOutForDepthThresholdsForTesting("NVDA", groups, NATIVE_ETH, "HEALTHY")).toThrow(UnknownOutputGroupError);
  });
});

describe("compareAssetExecutionDepthThresholdsFromSnapshot", () => {
  it("resolves NO snapshot itself — uses exactly the one passed in, never re-fetching", async () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1)],
      candidates: [v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    });
    const result = await compareAssetExecutionDepthThresholdsFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result.asset).toBe(NVDA_ASSET);
    expect(result.selectedTokenOut).toBe(WETH);
  });

  it("forwards the snapshot's own verificationHealth verbatim — no re-derivation, no new RPC (Phase 6G's own candidateSetComplete depends on this)", async () => {
    const healthySnapshot = snapshotFixture({
      groups: [group(WETH, 1)],
      candidates: [v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
      verificationHealth: "HEALTHY",
    });
    const healthyResult = await compareAssetExecutionDepthThresholdsFromSnapshot(healthySnapshot, { symbol: "NVDA" });
    expect(healthyResult.verificationHealth).toBe("HEALTHY");

    const degradedSnapshot = snapshotFixture({
      groups: [group(WETH, 1)],
      candidates: [v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
      verificationHealth: "DEGRADED",
    });
    const degradedResult = await compareAssetExecutionDepthThresholdsFromSnapshot(degradedSnapshot, { symbol: "NVDA" });
    expect(degradedResult.verificationHealth).toBe("DEGRADED");
  });

  it("applies the frozen DEPTH_THRESHOLD_LADDER_MULTIPLIERS, scaled by tokenDecimals — no caller override exists for this endpoint", async () => {
    expect(DEPTH_THRESHOLD_LADDER_MULTIPLIERS).toEqual([1n, 2n, 5n, 10n, 25n, 50n, 100n, 250n, 500n, 1000n, 2500n, 5000n]);
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1)],
      candidates: [v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    });
    await compareAssetExecutionDepthThresholdsFromSnapshot(snapshot, { symbol: "NVDA" });
    const mock = vi.mocked(computeVerifiedPoolDepthThresholds);
    const lastCall = mock.mock.calls[mock.mock.calls.length - 1]![0];
    expect(lastCall.amountsIn).toEqual(DEPTH_THRESHOLD_LADDER_MULTIPLIERS.map((m) => m * 10n ** 18n));
  });

  it("applies the frozen DEPTH_THRESHOLD_BPS threshold set — no caller override exists for this endpoint", async () => {
    expect(DEPTH_THRESHOLD_BPS).toEqual([50, 100, 200, 500]);
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1)],
      candidates: [v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    });
    await compareAssetExecutionDepthThresholdsFromSnapshot(snapshot, { symbol: "NVDA" });
    const mock = vi.mocked(computeVerifiedPoolDepthThresholds);
    const lastCall = mock.mock.calls[mock.mock.calls.length - 1]![0];
    expect(lastCall.thresholdsBps).toEqual(DEPTH_THRESHOLD_BPS);
  });

  it("throws NoVerifiedGroupsError when the selected group's candidate filter is empty", async () => {
    const snapshot = snapshotFixture({ groups: [], candidates: [] });
    await expect(compareAssetExecutionDepthThresholdsFromSnapshot(snapshot, { symbol: "NVDA" })).rejects.toThrow(NoVerifiedGroupsError);
  });

  it("throws MissingTokenDecimalsError when applying the default ladder against an asset with null tokenDecimals", async () => {
    const snapshot = snapshotFixture({
      asset: { ...NVDA_ASSET, tokenDecimals: null },
      groups: [group(WETH, 1)],
      candidates: [v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    });
    await expect(compareAssetExecutionDepthThresholdsFromSnapshot(snapshot, { symbol: "NVDA" })).rejects.toThrow(MissingTokenDecimalsError);
  });

  it("distinguishes native ETH and WETH output groups — selecting one never matches candidates from the other", async () => {
    const wethCandidate = v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", WETH);
    const nativePoolId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
    const nativeCandidate: VerifiedExecutionCandidate = {
      pool: pool({ pairAddress: nativePoolId, quoteToken: { address: zeroAddress, name: "ETH", symbol: "ETH" } }),
      identity: verifiedV4Identity(nativePoolId, zeroAddress, NVDA, 500, 10, zeroAddress),
      tokenOut: NATIVE_ETH,
    };
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1), group(NATIVE_ETH, 1)],
      candidates: [wethCandidate, nativeCandidate],
    });
    const result = await compareAssetExecutionDepthThresholdsFromSnapshot(snapshot, { symbol: "NVDA", tokenOut: NATIVE_ETH });
    expect(result.selectedTokenOut).toBe(NATIVE_ETH);
    const mock = vi.mocked(computeVerifiedPoolDepthThresholds);
    const lastCall = mock.mock.calls[mock.mock.calls.length - 1]![0];
    expect(lastCall.candidates).toHaveLength(1);
    expect(lastCall.candidates[0]!.pool.pairAddress.toLowerCase()).toBe(nativePoolId.toLowerCase());
  });

  it("cap fast-path is computed against EXECUTABLE candidates only — a mix of executable + hooked-without-hookData candidates that would exceed the cap if counted raw, but not when counted executable, is NOT rejected", async () => {
    // 4 executable V3 + 10 hooked-without-hookData V4 = 14 raw
    // candidates. 14 x 12 = 168 > 60 (would wrongly reject if counted
    // raw); 4 x 12 = 48, well under 60.
    const executables = Array.from({ length: 4 }, (_, i) =>
      v3Candidate((`0x${(i + 1).toString(16).padStart(40, "0")}`) as `0x${string}`),
    );
    const hooked = Array.from({ length: 10 }, (_, i) => hookedV4Candidate((`0x${(i + 1).toString(16).padStart(64, "0")}`) as `0x${string}`));
    const snapshot = snapshotFixture({ groups: [group(WETH, 14)], candidates: [...executables, ...hooked] });
    const result = await compareAssetExecutionDepthThresholdsFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result.selectedTokenOut).toBe(WETH);
  });

  it("throws DepthThresholdsTooLargeError (execution-comparison's OWN class, not pool-quote's) when EXECUTABLE candidates x 12 exceeds MAX_DEPTH_THRESHOLD_CELLS", async () => {
    // 6 executable candidates x 12 = 72 > 60.
    const executables = Array.from({ length: 6 }, (_, i) =>
      v3Candidate((`0x${(i + 1).toString(16).padStart(40, "0")}`) as `0x${string}`),
    );
    const snapshot = snapshotFixture({ groups: [group(WETH, 6)], candidates: executables });
    const error: unknown = await compareAssetExecutionDepthThresholdsFromSnapshot(snapshot, { symbol: "NVDA" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DepthThresholdsTooLargeError);
  });
});
