import { describe, expect, it, vi } from "vitest";
import { NATIVE_ETH } from "../types";
import { MissingTokenDecimalsError, NoVerifiedGroupsError, UnknownOutputGroupError, VerificationDegradedError, MatrixTooLargeError } from "../errors";
import { NVDA, NVDA_ASSET, pool, snapshotFixture, verifiedV3Identity, verifiedV4Identity, WETH } from "./fixtures";
import type { ComparableExecutionGroup, VerifiedExecutionCandidate } from "../types";

vi.mock("@/providers/robinhood-rpc", () => ({
  createVerifiedRobinhoodRpcClient: vi.fn(async () => ({ chainId: 4663 }) as unknown),
}));

vi.mock("@/domain/pool-quote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/pool-quote")>();
  return {
    ...actual,
    compareVerifiedPoolsAcrossExactInputs: vi.fn(async (args: { tokenIn: string; amountsIn: readonly bigint[] }) => ({
      status: "OK",
      blockNumber: 999n,
      tokenIn: args.tokenIn,
      tokenOut: WETH,
      amountsIn: args.amountsIn,
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      sharedAnalyticsStatus: "OK",
      rows: [],
      rankingsByAmount: [],
    })),
  };
});

const { compareAssetExecutionMatrixFromSnapshot, resolveSelectedTokenOutForMatrixForTesting, DEFAULT_MATRIX_LADDER_MULTIPLIERS } = await import("../compareMatrix");
const { compareVerifiedPoolsAcrossExactInputs } = await import("@/domain/pool-quote");

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

describe("resolveSelectedTokenOutForMatrix (mirrors compare.ts's own resolveSelectedTokenOut precedence)", () => {
  it("omitted tokenOut -> selects groups[0]", () => {
    const groups = [group(WETH, 5)];
    expect(resolveSelectedTokenOutForMatrixForTesting("NVDA", groups, undefined, "HEALTHY")).toBe(WETH);
  });

  it("throws NoVerifiedGroupsError when HEALTHY and zero groups", () => {
    expect(() => resolveSelectedTokenOutForMatrixForTesting("NVDA", [], undefined, "HEALTHY")).toThrow(NoVerifiedGroupsError);
  });

  it("throws VerificationDegradedError (not NoVerifiedGroupsError) when DEGRADED and zero groups", () => {
    const error: unknown = (() => {
      try {
        resolveSelectedTokenOutForMatrixForTesting("NVDA", [], undefined, "DEGRADED");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(VerificationDegradedError);
    expect(error).not.toBeInstanceOf(NoVerifiedGroupsError);
  });

  it("throws UnknownOutputGroupError for an explicit tokenOut with no match", () => {
    const groups = [group(WETH, 5)];
    expect(() => resolveSelectedTokenOutForMatrixForTesting("NVDA", groups, NATIVE_ETH, "HEALTHY")).toThrow(UnknownOutputGroupError);
  });
});

describe("compareAssetExecutionMatrixFromSnapshot", () => {
  it("resolves NO snapshot itself — uses exactly the one passed in, never re-fetching", async () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1)],
      candidates: [v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    });
    const result = await compareAssetExecutionMatrixFromSnapshot(snapshot, { symbol: "NVDA" });
    expect(result.asset).toBe(NVDA_ASSET);
    expect(result.selectedTokenOut).toBe(WETH);
  });

  it("applies the frozen DEFAULT_MATRIX_LADDER_MULTIPLIERS, scaled by tokenDecimals, when amountsIn is omitted", async () => {
    expect(DEFAULT_MATRIX_LADDER_MULTIPLIERS).toEqual([1n, 10n, 100n, 500n, 1000n]);
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1)],
      candidates: [v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    });
    await compareAssetExecutionMatrixFromSnapshot(snapshot, { symbol: "NVDA" });
    const mock = vi.mocked(compareVerifiedPoolsAcrossExactInputs);
    const lastCall = mock.mock.calls[mock.mock.calls.length - 1]![0];
    expect(lastCall.amountsIn).toEqual([
      1_000_000_000_000_000_000n,
      10_000_000_000_000_000_000n,
      100_000_000_000_000_000_000n,
      500_000_000_000_000_000_000n,
      1_000_000_000_000_000_000_000n,
    ]);
  });

  it("uses the caller-supplied amountsIn verbatim, in order, when provided", async () => {
    const snapshot = snapshotFixture({
      groups: [group(WETH, 1)],
      candidates: [v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    });
    const customLadder = [7n, 3n, 42n];
    await compareAssetExecutionMatrixFromSnapshot(snapshot, { symbol: "NVDA", amountsIn: customLadder });
    const mock = vi.mocked(compareVerifiedPoolsAcrossExactInputs);
    const lastCall = mock.mock.calls[mock.mock.calls.length - 1]![0];
    expect(lastCall.amountsIn).toEqual(customLadder);
  });

  it("throws NoVerifiedGroupsError when the selected group's candidate filter is empty", async () => {
    const snapshot = snapshotFixture({ groups: [], candidates: [] });
    await expect(compareAssetExecutionMatrixFromSnapshot(snapshot, { symbol: "NVDA" })).rejects.toThrow(NoVerifiedGroupsError);
  });

  it("throws MissingTokenDecimalsError when applying the default ladder against an asset with null tokenDecimals", async () => {
    const snapshot = snapshotFixture({
      asset: { ...NVDA_ASSET, tokenDecimals: null },
      groups: [group(WETH, 1)],
      candidates: [v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    });
    await expect(compareAssetExecutionMatrixFromSnapshot(snapshot, { symbol: "NVDA" })).rejects.toThrow(MissingTokenDecimalsError);
  });

  it("MAX_MATRIX_CELLS fast-path is computed against EXECUTABLE candidates only — a mix of executable + hooked-without-hookData candidates that would exceed the cap if counted raw, but not when counted executable, is NOT rejected", async () => {
    // 2 executable V3 + 10 hooked-without-hookData V4 = 12 raw candidates.
    // 12 x 5 = 60 (at the cap if counted raw — this test uses 10 amounts
    // to prove raw-counting would reject: 12 x 10 = 120 > 60), but
    // 2 x 10 = 20, well under 60.
    const executables = [
      v3Candidate("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      v3Candidate("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ];
    const hooked = Array.from({ length: 10 }, (_, i) =>
      hookedV4Candidate((`0x${(i + 1).toString(16).padStart(64, "0")}`) as `0x${string}`),
    );
    const snapshot = snapshotFixture({ groups: [group(WETH, 12)], candidates: [...executables, ...hooked] });
    const amounts = Array.from({ length: 10 }, (_, i) => BigInt(i + 1));
    const result = await compareAssetExecutionMatrixFromSnapshot(snapshot, { symbol: "NVDA", amountsIn: amounts });
    expect(result.selectedTokenOut).toBe(WETH);
  });

  it("throws MatrixTooLargeError (execution-comparison's OWN class, not pool-quote's) when EXECUTABLE candidates x amounts exceeds MAX_MATRIX_CELLS", async () => {
    const executables = Array.from({ length: 13 }, (_, i) =>
      v3Candidate((`0x${(i + 1).toString(16).padStart(40, "0")}`) as `0x${string}`),
    );
    const snapshot = snapshotFixture({ groups: [group(WETH, 13)], candidates: executables });
    const amounts = Array.from({ length: 5 }, (_, i) => BigInt(i + 1)); // 13 x 5 = 65 > 60
    const error: unknown = await compareAssetExecutionMatrixFromSnapshot(snapshot, { symbol: "NVDA", amountsIn: amounts }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MatrixTooLargeError);
  });
});
