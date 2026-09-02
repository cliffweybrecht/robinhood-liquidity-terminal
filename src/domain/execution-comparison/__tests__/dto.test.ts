import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type {
  ComparisonCandidate,
  CrossPoolComparisonResult,
  UniswapV3ComparisonCandidate,
  UniswapV4ComparisonCandidate,
} from "@/domain/pool-quote";
import { toAssetExecutionComparisonDto } from "../dto";
import { NATIVE_ETH } from "../types";
import { NVDA, NVDA_ASSET, USDG, WETH } from "./fixtures";
import type { AssetExecutionComparison } from "../compare";

const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;

function classifiedPoolIdentity(pairAddress: Hex) {
  return {
    chainId: "robinhood",
    pairAddress,
    dexId: "uniswap",
    canonicalAssetAddress: NVDA,
    canonicalAssetSymbol: "NVDA",
    canonicalAssetSide: "base" as const,
  };
}

function quotedV3Candidate(overrides: Partial<UniswapV3ComparisonCandidate> = {}): UniswapV3ComparisonCandidate {
  return {
    pool: classifiedPoolIdentity(POOL_A),
    identityVerificationBlock: 90n,
    family: "UNISWAP_V3",
    status: "QUOTED",
    amountOut: 123_456_789_012_345_678n,
    analyticsStatus: "OK",
    executionPrice: { numerator: 987n, denominator: 1000n },
    priceImpactBps: { numerator: -5n, denominator: 1n },
    evidence: [{ kind: "QUOTE_CALL", outcome: "ok", source: "QuoterV2.quoteExactInputSingle", detail: "ok" }],
    metadata: { sqrtPriceX96After: 111n, initializedTicksCrossed: 2, gasEstimate: 132_533n },
    ...overrides,
  };
}

function preconditionFailedV4Candidate(overrides: Partial<UniswapV4ComparisonCandidate> = {}): UniswapV4ComparisonCandidate {
  return {
    pool: classifiedPoolIdentity(POOL_B),
    identityVerificationBlock: 90n,
    family: "UNISWAP_V4",
    status: "PRECONDITION_FAILED",
    analyticsStatus: "INDETERMINATE",
    evidence: [],
    preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "This pool requires caller-supplied hookData that was not provided." },
    ...overrides,
  };
}

function comparisonResult(candidates: readonly ComparisonCandidate[]): CrossPoolComparisonResult {
  const quoted = candidates.filter((c): c is ComparisonCandidate & { status: "QUOTED"; amountOut: bigint } => c.status === "QUOTED" && c.amountOut !== undefined);
  const sorted = [...quoted].sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  const best = sorted.length > 0 ? sorted.filter((c) => c.amountOut === sorted[0]!.amountOut).map((c) => c.pool.pairAddress) : [];
  return {
    status: "OK",
    blockNumber: 100n,
    tokenIn: NVDA,
    tokenOut: WETH,
    amountIn: 1_000_000_000_000_000_000n,
    tokenInDecimals: 18,
    tokenOutDecimals: 18,
    sharedAnalyticsStatus: "OK",
    sharedEvidence: [{ kind: "DECIMALS_READ", outcome: "ok", source: "ERC20.decimals", detail: "ok" }],
    candidates,
    ranking: {
      rankedQuotedPoolAddresses: sorted.map((c) => c.pool.pairAddress),
      bestCandidatePoolAddresses: best,
    },
  };
}

function assetExecutionComparison(overrides: Partial<AssetExecutionComparison> = {}): AssetExecutionComparison {
  return {
    asset: NVDA_ASSET,
    groups: [
      { tokenOut: WETH, tokenOutSymbol: "WETH", candidateCount: 2, v3Count: 1, v4Count: 1 },
      { tokenOut: USDG, tokenOutSymbol: "USDG", candidateCount: 1, v3Count: 1, v4Count: 0 },
    ],
    selectedTokenOut: WETH,
    comparison: comparisonResult([quotedV3Candidate(), preconditionFailedV4Candidate()]),
    ...overrides,
  };
}

describe("toAssetExecutionComparisonDto — explicit browser-facing mapper", () => {
  it("converts every bigint field to a decimal string", () => {
    const dto = toAssetExecutionComparisonDto(assetExecutionComparison(), "2026-08-23T00:00:00.000Z");
    const comparison = dto.comparison;
    if (comparison.status !== "OK") throw new Error("expected OK");
    expect(comparison.blockNumber).toBe("100");
    expect(comparison.amountIn).toBe("1000000000000000000");
    const quoted = comparison.candidates.find((c) => c.status === "QUOTED")!;
    expect(quoted.amountOut).toBe("123456789012345678");
    expect(quoted.gasEstimate).toBe("132533");
    expect(typeof comparison.blockNumber).toBe("string");
    expect(typeof quoted.amountOut).toBe("string");
  });

  it("converts RationalValue fields to {numerator, denominator} decimal-string pairs, never collapsing to Number", () => {
    const dto = toAssetExecutionComparisonDto(assetExecutionComparison());
    const comparison = dto.comparison;
    if (comparison.status !== "OK") throw new Error("expected OK");
    const quoted = comparison.candidates.find((c) => c.status === "QUOTED")!;
    expect(quoted.executionPrice).toEqual({ numerator: "987", denominator: "1000" });
    expect(quoted.priceImpactBps).toEqual({ numerator: "-5", denominator: "1" });
  });

  it("never exposes raw QuoteEvidence arrays, sharedEvidence, or identityVerificationBlock", () => {
    const dto = toAssetExecutionComparisonDto(assetExecutionComparison());
    const raw = JSON.stringify(dto);
    expect(raw).not.toContain("evidence");
    expect(raw).not.toContain("sharedEvidence");
    expect(raw).not.toContain("identityVerificationBlock");
    expect(raw).not.toContain("QUOTE_CALL");
    expect(raw).not.toContain("DECIMALS_READ");
  });

  it("preserves the server ranking arrays unchanged (never re-sorted, never re-derived client-side)", () => {
    const dto = toAssetExecutionComparisonDto(assetExecutionComparison());
    const comparison = dto.comparison;
    if (comparison.status !== "OK") throw new Error("expected OK");
    expect(comparison.ranking.rankedQuotedPoolAddresses).toEqual([POOL_A]);
    expect(comparison.ranking.bestCandidatePoolAddresses).toEqual([POOL_A]);
  });

  it("maps a PRECONDITION_FAILED candidate's code/detail without inventing an economic ranking meaning", () => {
    const dto = toAssetExecutionComparisonDto(assetExecutionComparison());
    const comparison = dto.comparison;
    if (comparison.status !== "OK") throw new Error("expected OK");
    const failed = comparison.candidates.find((c) => c.status === "PRECONDITION_FAILED")!;
    expect(failed.preconditionFailure).toEqual({ code: "MISSING_HOOK_DATA", detail: expect.stringContaining("hookData") });
    expect(failed.amountOut).toBeUndefined();
    expect(comparison.ranking.rankedQuotedPoolAddresses).not.toContain(failed.pairAddress);
  });

  it("preserves the NATIVE_ETH sentinel as the literal string, never a raw zero address", () => {
    const result = assetExecutionComparison({
      selectedTokenOut: NATIVE_ETH,
      groups: [{ tokenOut: NATIVE_ETH, candidateCount: 1, v3Count: 0, v4Count: 1 }],
      comparison: comparisonResult([quotedV3Candidate()]) as CrossPoolComparisonResult,
    });
    const dto = toAssetExecutionComparisonDto(result);
    expect(dto.selectedTokenOut).toBe(NATIVE_ETH);
    expect(dto.groups[0]!.tokenOut).toBe(NATIVE_ETH);
  });

  it("maps a BLOCK_PIN_FAILURE comparison as its own distinct shape, never fabricating candidate results", () => {
    const result = assetExecutionComparison({
      comparison: {
        status: "BLOCK_PIN_FAILURE",
        tokenIn: NVDA,
        tokenOut: WETH,
        amountIn: 1_000_000_000_000_000_000n,
        evidence: [],
      },
    });
    const dto = toAssetExecutionComparisonDto(result);
    expect(dto.comparison.status).toBe("BLOCK_PIN_FAILURE");
    expect(dto.comparison).not.toHaveProperty("candidates");
    expect(dto.comparison).not.toHaveProperty("ranking");
    expect(dto.comparison.amountIn).toBe("1000000000000000000");
  });

  it("maps groups with their exact tokenOut/candidateCount/v3Count/v4Count fields", () => {
    const dto = toAssetExecutionComparisonDto(assetExecutionComparison());
    expect(dto.groups).toEqual([
      { tokenOut: WETH, tokenOutSymbol: "WETH", candidateCount: 2, v3Count: 1, v4Count: 1 },
      { tokenOut: USDG, tokenOutSymbol: "USDG", candidateCount: 1, v3Count: 1, v4Count: 0 },
    ]);
  });

  it("omits hookDataCallerSupplied for a V3 candidate and for an unhooked/non-applicable case", () => {
    const dto = toAssetExecutionComparisonDto(assetExecutionComparison());
    const comparison = dto.comparison;
    if (comparison.status !== "OK") throw new Error("expected OK");
    const quotedV3 = comparison.candidates.find((c) => c.family === "UNISWAP_V3")!;
    expect(quotedV3.hookDataCallerSupplied).toBeUndefined();
  });

  it("marks hookDataCallerSupplied true only when the caller actually supplied it for a hooked V4 candidate", () => {
    const hookedV4Candidate: UniswapV4ComparisonCandidate = {
      pool: classifiedPoolIdentity(POOL_B),
      identityVerificationBlock: 90n,
      family: "UNISWAP_V4",
      status: "QUOTED",
      amountOut: 1n,
      analyticsStatus: "OK",
      evidence: [],
      metadata: { gasEstimate: 100n },
      hookDataCallerSupplied: true,
    };
    const result = assetExecutionComparison({
      comparison: comparisonResult([hookedV4Candidate]),
    });
    const dto = toAssetExecutionComparisonDto(result);
    const comparison = dto.comparison;
    if (comparison.status !== "OK") throw new Error("expected OK");
    expect(comparison.candidates[0]!.hookDataCallerSupplied).toBe(true);
  });

  it("uses the supplied fetchedAt verbatim rather than deriving its own", () => {
    const dto = toAssetExecutionComparisonDto(assetExecutionComparison(), "2020-01-01T00:00:00.000Z");
    if (dto.comparison.status !== "OK") throw new Error("expected OK");
    expect(dto.comparison.fetchedAt).toBe("2020-01-01T00:00:00.000Z");
  });
});
