import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { VerifiedPoolDepthThresholdsResult } from "@/domain/pool-quote";
import type { AssetCrossMarketExecution, CrossMarketExecutionGroup } from "../compareCrossMarket";
import { toAssetCrossMarketExecutionDto } from "../crossMarketDto";
import { synthesizeExecutionSummary } from "../executionSummary";
import { NATIVE_ETH } from "../types";
import { NVDA, NVDA_ASSET, USDG, WETH } from "./fixtures";

const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;

function okDepthResult(tokenOut: Hex, blockNumber: bigint, pairAddress: Hex): Extract<VerifiedPoolDepthThresholdsResult, { status: "OK" }> {
  return {
    status: "OK",
    blockNumber,
    tokenIn: NVDA,
    tokenOut,
    tokenInDecimals: 18,
    tokenOutDecimals: 18,
    sharedAnalyticsStatus: "OK",
    sharedEvidence: [],
    ladderAmountsIn: [1_000_000_000_000_000_000n],
    thresholdsBps: [50],
    pools: [
      {
        row: {
          pool: { chainId: "robinhood", pairAddress, dexId: "uniswap", canonicalAssetAddress: NVDA, canonicalAssetSymbol: "NVDA", canonicalAssetSide: "base" },
          family: "UNISWAP_V3",
          identityVerificationBlock: 90n,
          cells: [
            {
              amountIn: 1_000_000_000_000_000_000n,
              status: "QUOTED",
              amountOut: 500_000_000_000n,
              analyticsStatus: "OK",
              executionPrice: { numerator: 987n, denominator: 1000n },
              priceImpactBps: { numerator: -5n, denominator: 1n },
              gasEstimate: 132_533n,
              evidence: [],
            },
          ],
        },
        outcomesByThreshold: [{ thresholdBps: 50, outcome: { kind: "WITHIN_THRESHOLD", qualifyingAmountIn: 1_000_000_000_000_000_000n, monotonicityObserved: true, upperRange: { kind: "OPEN" } } }],
      },
    ],
    bestVenueByThreshold: [{ thresholdBps: 50, poolAddresses: [pairAddress] }],
  };
}

function group(tokenOut: CrossMarketExecutionGroup["tokenOut"], result: CrossMarketExecutionGroup["result"], verificationHealth: "HEALTHY" | "DEGRADED" = "HEALTHY"): CrossMarketExecutionGroup {
  return { tokenOut, result, summary: synthesizeExecutionSummary(result, verificationHealth) };
}

function okEnvelope(groups: readonly CrossMarketExecutionGroup[], blockNumber = 999n): AssetCrossMarketExecution {
  return {
    status: "OK",
    asset: NVDA_ASSET,
    blockNumber,
    groups,
    valueComparison: { availability: "UNAVAILABLE", reason: "NO_TRUSTED_NORMALIZATION_SOURCE" },
  };
}

describe("toAssetCrossMarketExecutionDto — OK envelope", () => {
  it("stringifies the top-level blockNumber and stamps fetchedAt", () => {
    const dto = toAssetCrossMarketExecutionDto(okEnvelope([group(WETH, okDepthResult(WETH, 999n, POOL_A))]), "2026-01-01T00:00:00.000Z");
    expect(dto.status).toBe("OK");
    if (dto.status !== "OK") throw new Error("expected OK");
    expect(dto.blockNumber).toBe("999");
    expect(dto.fetchedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("top-level blockNumber matches every group's own nested result.blockNumber", () => {
    const dto = toAssetCrossMarketExecutionDto(okEnvelope([group(WETH, okDepthResult(WETH, 777n, POOL_A)), group(USDG, okDepthResult(USDG, 777n, POOL_B))], 777n));
    if (dto.status !== "OK") throw new Error("expected OK");
    expect(dto.blockNumber).toBe("777");
    for (const g of dto.groups) {
      expect(g.result.status).toBe("OK");
      if (g.result.status === "OK") {
        expect(g.result.blockNumber).toBe("777");
      }
    }
  });

  it("emits exactly one summary per group, one group entry per input group", () => {
    const dto = toAssetCrossMarketExecutionDto(okEnvelope([group(WETH, okDepthResult(WETH, 999n, POOL_A)), group(USDG, okDepthResult(USDG, 999n, POOL_B))]));
    if (dto.status !== "OK") throw new Error("expected OK");
    expect(dto.groups).toHaveLength(2);
    expect(dto.groups[0]!.tokenOut).toBe(WETH);
    expect(dto.groups[0]!.summary).toBeDefined();
    expect(dto.groups[1]!.tokenOut).toBe(USDG);
    expect(dto.groups[1]!.summary).toBeDefined();
  });

  it("maps the NATIVE_ETH sentinel for a group's tokenOut, never a raw zero address", () => {
    const dto = toAssetCrossMarketExecutionDto(
      okEnvelope([group(WETH, okDepthResult(WETH, 999n, POOL_A)), group(NATIVE_ETH, okDepthResult(WETH, 999n, POOL_B))]),
    );
    if (dto.status !== "OK") throw new Error("expected OK");
    expect(dto.groups[1]!.tokenOut).toBe(NATIVE_ETH);
  });

  it("every bigint in a group's nested result is stringified — ladder, cell amounts/gas, block", () => {
    const dto = toAssetCrossMarketExecutionDto(okEnvelope([group(WETH, okDepthResult(WETH, 999n, POOL_A)), group(USDG, okDepthResult(USDG, 999n, POOL_B))]));
    if (dto.status !== "OK") throw new Error("expected OK");
    const g0 = dto.groups[0]!;
    if (g0.result.status !== "OK") throw new Error("expected OK");
    expect(g0.result.ladderAmountsIn).toEqual(["1000000000000000000"]);
    const poolDto = g0.result.pools[0]!;
    expect(poolDto.ladder[0]!.amountIn).toBe("1000000000000000000");
    expect(poolDto.ladder[0]!.amountOut).toBe("500000000000");
    expect(poolDto.ladder[0]!.gasEstimate).toBe("132533");
    expect(poolDto.ladder[0]!.priceImpactBps).toEqual({ numerator: "-5", denominator: "1" });
    expect(JSON.stringify(dto)).not.toMatch(/\d{15,}n/); // no raw `123n`-style bigint ever serialized
  });

  it("the valueComparison is exactly the frozen UNAVAILABLE shape — no extra fields, never conditionally computed", () => {
    const dto = toAssetCrossMarketExecutionDto(okEnvelope([group(WETH, okDepthResult(WETH, 999n, POOL_A)), group(USDG, okDepthResult(USDG, 999n, POOL_B))]));
    if (dto.status !== "OK") throw new Error("expected OK");
    expect(dto.valueComparison).toEqual({ availability: "UNAVAILABLE", reason: "NO_TRUSTED_NORMALIZATION_SOURCE" });
    expect(Object.keys(dto.valueComparison).sort()).toEqual(["availability", "reason"]);
  });

  it("no internal-only field leaks — a group's DTO carries exactly tokenOut/result/summary", () => {
    const dto = toAssetCrossMarketExecutionDto(okEnvelope([group(WETH, okDepthResult(WETH, 999n, POOL_A)), group(USDG, okDepthResult(USDG, 999n, POOL_B))]));
    if (dto.status !== "OK") throw new Error("expected OK");
    for (const g of dto.groups) {
      expect(Object.keys(g).sort()).toEqual(["result", "summary", "tokenOut"]);
    }
  });
});

describe("toAssetCrossMarketExecutionDto — INSUFFICIENT_MARKETS", () => {
  it("carries requiredMarketCount/availableMarketCount and fetchedAt, with NO fabricated blockNumber or groups", () => {
    const dto = toAssetCrossMarketExecutionDto(
      { status: "INSUFFICIENT_MARKETS", asset: NVDA_ASSET, requiredMarketCount: 2, availableMarketCount: 1 },
      "2026-01-01T00:00:00.000Z",
    );
    expect(dto).toEqual({ status: "INSUFFICIENT_MARKETS", fetchedAt: "2026-01-01T00:00:00.000Z", requiredMarketCount: 2, availableMarketCount: 1 });
    expect(dto).not.toHaveProperty("blockNumber");
    expect(dto).not.toHaveProperty("groups");
  });

  it("availableMarketCount 0 is preserved distinctly from 1", () => {
    const dto = toAssetCrossMarketExecutionDto({ status: "INSUFFICIENT_MARKETS", asset: NVDA_ASSET, requiredMarketCount: 2, availableMarketCount: 0 });
    expect(dto).toMatchObject({ status: "INSUFFICIENT_MARKETS", requiredMarketCount: 2, availableMarketCount: 0 });
  });
});

describe("toAssetCrossMarketExecutionDto — BLOCK_PIN_FAILURE", () => {
  it("carries only status and fetchedAt — no blockNumber, no groups, no asset leak", () => {
    const dto = toAssetCrossMarketExecutionDto({ status: "BLOCK_PIN_FAILURE", asset: NVDA_ASSET }, "2026-01-01T00:00:00.000Z");
    expect(dto).toEqual({ status: "BLOCK_PIN_FAILURE", fetchedAt: "2026-01-01T00:00:00.000Z" });
    expect(dto).not.toHaveProperty("blockNumber");
    expect(dto).not.toHaveProperty("groups");
  });
});
