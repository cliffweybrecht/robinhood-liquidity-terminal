import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import { CANONICAL_USDG_ADDRESS, buildAssetLiquidityProfile } from "../aggregate";
import type { AssetIdentityForProfile } from "../aggregate";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const OTHER = "0x1111111111111111111111111111111111111111";

const asset: AssetIdentityForProfile = {
  symbol: "NVDA",
  name: "NVIDIA • Robinhood Token",
  contractAddress: NVDA,
};

function pool(overrides: Partial<LiquidityPool> = {}): LiquidityPool {
  return {
    provider: "dexscreener",
    chainId: "robinhood",
    dexId: "uniswap",
    pairAddress: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3",
    canonicalAssetAddress: NVDA,
    canonicalAssetSymbol: "NVDA",
    canonicalAssetSide: "base",
    baseToken: { address: NVDA, name: "NVIDIA • Robinhood Token", symbol: "NVDA" },
    quoteToken: { address: CANONICAL_USDG_ADDRESS, name: "Global Dollar", symbol: "USDG" },
    priceUsd: 215.18,
    priceNative: 215.1838,
    liquidityUsd: 100_000,
    liquidityBase: 500,
    liquidityQuote: 100_000,
    volume5m: 100,
    volume1h: 1000,
    volume6h: 5000,
    volume24h: 20_000,
    buys5m: 1,
    sells5m: 1,
    buys1h: 10,
    sells1h: 9,
    buys6h: 50,
    sells6h: 45,
    buys24h: 200,
    sells24h: 190,
    priceChange5m: 0,
    priceChange1h: 0,
    priceChange6h: 0,
    priceChange24h: 0,
    fdv: 1_000_000,
    marketCap: 900_000,
    pairCreatedAt: 1_700_000_000_000,
    dexScreenerUrl: "https://dexscreener.com/robinhood/x",
    labels: [],
    ...overrides,
  };
}

describe("displayed liquidity", () => {
  it("sums multiple non-null liquidityUsd values", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", liquidityUsd: 100 }),
      pool({ pairAddress: "0xbbb", liquidityUsd: 200 }),
    ]);
    expect(profile.displayedLiquidityUsd).toBe(300);
  });

  it("preserves a genuinely-zero liquidity value (does not conflate with missing)", () => {
    const profile = buildAssetLiquidityProfile(asset, [pool({ liquidityUsd: 0 })]);
    expect(profile.displayedLiquidityUsd).toBe(0);
    expect(profile.coverage.liquidity).toEqual({ poolsReporting: 1, poolsMissing: 0, complete: true });
  });

  it("returns null when every pool has null liquidityUsd", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", liquidityUsd: null }),
      pool({ pairAddress: "0xbbb", liquidityUsd: null }),
    ]);
    expect(profile.displayedLiquidityUsd).toBeNull();
    expect(profile.coverage.liquidity).toEqual({ poolsReporting: 0, poolsMissing: 2, complete: false });
  });

  it("sums only the non-null values in a mixed null/non-null set, and reports incomplete coverage", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", liquidityUsd: 100 }),
      pool({ pairAddress: "0xbbb", liquidityUsd: null }),
    ]);
    expect(profile.displayedLiquidityUsd).toBe(100);
    expect(profile.coverage.liquidity).toEqual({ poolsReporting: 1, poolsMissing: 1, complete: false });
  });

  it("returns a valid, empty-shaped profile for a zero-pool asset", () => {
    const profile = buildAssetLiquidityProfile(asset, []);
    expect(profile.displayedLiquidityUsd).toBeNull();
    expect(profile.poolCount).toBe(0);
    expect(profile.dexCount).toBe(0);
    expect(profile.largestPool).toBeNull();
    expect(profile.concentration).toEqual({ top1Pct: null, top3Pct: null, top5Pct: null });
    expect(profile.quoteAssets).toEqual([]);
    expect(profile.dexes).toEqual([]);
    expect(profile.coverage.liquidity).toEqual({ poolsReporting: 0, poolsMissing: 0, complete: true });
  });
});

describe("USDG liquidity", () => {
  it("counts a pool whose non-canonical side is the exact canonical USDG address", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ quoteToken: { address: CANONICAL_USDG_ADDRESS, name: "Global Dollar", symbol: "USDG" }, liquidityUsd: 500 }),
    ]);
    expect(profile.usdGLiquidityUsd).toBe(500);
  });

  it("matches the canonical USDG address case-insensitively", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({
        quoteToken: { address: CANONICAL_USDG_ADDRESS.toLowerCase() as Address, name: "Global Dollar", symbol: "USDG" },
        liquidityUsd: 500,
      }),
    ]);
    expect(profile.usdGLiquidityUsd).toBe(500);
  });

  it("does not count a token merely labeled 'USDG' on a different contract address", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ quoteToken: { address: WETH, name: "Fake Global Dollar", symbol: "USDG" }, liquidityUsd: 500 }),
    ]);
    expect(profile.usdGLiquidityUsd).toBeNull();
  });

  it("qualifies when the canonical asset is the base token and USDG is the quote token", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({
        canonicalAssetSide: "base",
        baseToken: { address: NVDA, name: "NVDA", symbol: "NVDA" },
        quoteToken: { address: CANONICAL_USDG_ADDRESS, name: "Global Dollar", symbol: "USDG" },
        liquidityUsd: 500,
      }),
    ]);
    expect(profile.usdGLiquidityUsd).toBe(500);
  });

  it("qualifies when the canonical asset is the quote token and USDG is the base token", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({
        canonicalAssetSide: "quote",
        baseToken: { address: CANONICAL_USDG_ADDRESS, name: "Global Dollar", symbol: "USDG" },
        quoteToken: { address: NVDA, name: "NVDA", symbol: "NVDA" },
        liquidityUsd: 500,
      }),
    ]);
    expect(profile.usdGLiquidityUsd).toBe(500);
  });
});

describe("quote-asset composition", () => {
  it("groups multiple pools with the identical quote address into one entry", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", liquidityUsd: 100 }),
      pool({ pairAddress: "0xbbb", liquidityUsd: 200 }),
    ]);
    expect(profile.quoteAssets).toHaveLength(1);
    expect(profile.quoteAssets[0]).toMatchObject({ poolCount: 2, displayedLiquidityUsd: 300 });
  });

  it("does not fragment groups when the same quote address appears with different casing", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", quoteToken: { address: CANONICAL_USDG_ADDRESS, name: "Global Dollar", symbol: "USDG" }, liquidityUsd: 100 }),
      pool({
        pairAddress: "0xbbb",
        quoteToken: { address: CANONICAL_USDG_ADDRESS.toLowerCase() as Address, name: "Global Dollar", symbol: "USDG" },
        liquidityUsd: 200,
      }),
    ]);
    expect(profile.quoteAssets).toHaveLength(1);
    expect(profile.quoteAssets[0]?.poolCount).toBe(2);
  });

  it("keeps different addresses with the same symbol as separate groups", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", quoteToken: { address: CANONICAL_USDG_ADDRESS, name: "Global Dollar", symbol: "USDG" }, liquidityUsd: 100 }),
      pool({ pairAddress: "0xbbb", quoteToken: { address: OTHER, name: "Fake USDG", symbol: "USDG" }, liquidityUsd: 100 }),
    ]);
    expect(profile.quoteAssets).toHaveLength(2);
  });

  it("computes correct shares relative to total displayed liquidity", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", quoteToken: { address: CANONICAL_USDG_ADDRESS, name: "Global Dollar", symbol: "USDG" }, liquidityUsd: 100 }),
      pool({ pairAddress: "0xbbb", quoteToken: { address: WETH, name: "WETH", symbol: "WETH" }, liquidityUsd: 300 }),
    ]);
    const usdg = profile.quoteAssets.find((q) => q.address.toLowerCase() === CANONICAL_USDG_ADDRESS.toLowerCase());
    const weth = profile.quoteAssets.find((q) => q.address.toLowerCase() === WETH.toLowerCase());
    expect(usdg?.shareOfDisplayedLiquidityPct).toBeCloseTo(25);
    expect(weth?.shareOfDisplayedLiquidityPct).toBeCloseTo(75);
  });

  it("reports null liquidity/share for a group whose pools all report null liquidityUsd", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ quoteToken: { address: CANONICAL_USDG_ADDRESS, name: "Global Dollar", symbol: "USDG" }, liquidityUsd: null }),
    ]);
    expect(profile.quoteAssets[0]).toMatchObject({
      displayedLiquidityUsd: null,
      shareOfDisplayedLiquidityPct: null,
      poolCount: 1,
    });
  });

  it("flags symbolConflict when the same address reports materially different symbols", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", quoteToken: { address: OTHER, name: "X", symbol: "USDX" } }),
      pool({ pairAddress: "0xbbb", quoteToken: { address: OTHER, name: "Y", symbol: "USDY" } }),
    ]);
    expect(profile.quoteAssets[0]?.symbolConflict).toBe(true);
  });

  it("does not flag symbolConflict when symbols differ only by case/whitespace", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", quoteToken: { address: OTHER, name: "X", symbol: "usdg" } }),
      pool({ pairAddress: "0xbbb", quoteToken: { address: OTHER, name: "Y", symbol: "USDG" } }),
    ]);
    expect(profile.quoteAssets[0]?.symbolConflict).toBe(false);
  });
});

describe("DEX composition", () => {
  it("aggregates pools sharing the same dexId", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", dexId: "uniswap", liquidityUsd: 100 }),
      pool({ pairAddress: "0xbbb", dexId: "uniswap", liquidityUsd: 200 }),
    ]);
    expect(profile.dexes).toHaveLength(1);
    expect(profile.dexes[0]).toMatchObject({ dexId: "uniswap", poolCount: 2, displayedLiquidityUsd: 300 });
  });

  it("separates genuinely distinct dexIds", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", dexId: "uniswap" }),
      pool({ pairAddress: "0xbbb", dexId: "ramses" }),
    ]);
    expect(profile.dexes.map((d) => d.dexId).sort()).toEqual(["ramses", "uniswap"]);
  });

  it("reports null liquidity/share for a DEX group with no reporting pools", () => {
    const profile = buildAssetLiquidityProfile(asset, [pool({ dexId: "ramses", liquidityUsd: null })]);
    expect(profile.dexes[0]).toMatchObject({ displayedLiquidityUsd: null, shareOfDisplayedLiquidityPct: null });
  });
});

describe("concentration", () => {
  it("computes top1/top3/top5 shares correctly", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xa", liquidityUsd: 500 }),
      pool({ pairAddress: "0xb", liquidityUsd: 300 }),
      pool({ pairAddress: "0xc", liquidityUsd: 100 }),
      pool({ pairAddress: "0xd", liquidityUsd: 50 }),
      pool({ pairAddress: "0xe", liquidityUsd: 50 }),
    ]);
    expect(profile.concentration.top1Pct).toBeCloseTo(50);
    expect(profile.concentration.top3Pct).toBeCloseTo(90);
    expect(profile.concentration.top5Pct).toBeCloseTo(100);
  });

  it("treats topN beyond the available pool count as summing everything (fewer than 3 pools)", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xa", liquidityUsd: 100 }),
      pool({ pairAddress: "0xb", liquidityUsd: 100 }),
    ]);
    expect(profile.concentration.top3Pct).toBeCloseTo(100);
    expect(profile.concentration.top5Pct).toBeCloseTo(100);
  });

  it("returns null (not NaN) when total displayed liquidity is exactly zero", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xa", liquidityUsd: 0 }),
      pool({ pairAddress: "0xb", liquidityUsd: 0 }),
    ]);
    expect(profile.concentration).toEqual({ top1Pct: null, top3Pct: null, top5Pct: null });
    expect(Number.isNaN(profile.concentration.top1Pct)).toBe(false);
  });

  it("returns null when no pool reports liquidityUsd", () => {
    const profile = buildAssetLiquidityProfile(asset, [pool({ liquidityUsd: null })]);
    expect(profile.concentration).toEqual({ top1Pct: null, top3Pct: null, top5Pct: null });
  });

  it("computes concentration only over pools with non-null liquidity in a mixed set", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xa", liquidityUsd: 100 }),
      pool({ pairAddress: "0xb", liquidityUsd: null }),
    ]);
    expect(profile.concentration.top1Pct).toBeCloseTo(100);
  });
});

describe("largest pool", () => {
  it("selects the pool with the highest liquidityUsd", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xaaa", dexId: "uniswap", liquidityUsd: 100 }),
      pool({ pairAddress: "0xbbb", dexId: "ramses", liquidityUsd: 500 }),
    ]);
    expect(profile.largestPool?.dexId).toBe("ramses");
    expect(profile.largestPool?.liquidityUsd).toBe(500);
    expect(profile.largestPool?.shareOfDisplayedLiquidityPct).toBeCloseTo((500 / 600) * 100);
  });

  it("breaks ties deterministically by pairAddress ascending", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xbbbb000000000000000000000000000000000000", dexId: "second", liquidityUsd: 100 }),
      pool({ pairAddress: "0xaaaa000000000000000000000000000000000000", dexId: "first", liquidityUsd: 100 }),
    ]);
    expect(profile.largestPool?.dexId).toBe("first");
  });

  it("is null when no pool reports liquidityUsd", () => {
    const profile = buildAssetLiquidityProfile(asset, [pool({ liquidityUsd: null })]);
    expect(profile.largestPool).toBeNull();
  });

  it("can select a zero-liquidity pool when it's the only reporting pool, with a null share", () => {
    const profile = buildAssetLiquidityProfile(asset, [pool({ liquidityUsd: 0 })]);
    expect(profile.largestPool?.liquidityUsd).toBe(0);
    expect(profile.largestPool?.shareOfDisplayedLiquidityPct).toBeNull();
  });
});

describe("activity aggregation", () => {
  it("sums volume across all timeframes", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xa", volume5m: 10, volume1h: 100, volume6h: 500, volume24h: 1000 }),
      pool({ pairAddress: "0xb", volume5m: 20, volume1h: 200, volume6h: 600, volume24h: 2000 }),
    ]);
    expect(profile.activity).toMatchObject({
      volume5m: 30,
      volume1h: 300,
      volume6h: 1100,
      volume24h: 3000,
    });
  });

  it("sums buys/sells across all timeframes", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xa", buys24h: 5, sells24h: 3 }),
      pool({ pairAddress: "0xb", buys24h: 7, sells24h: 1 }),
    ]);
    expect(profile.activity.buys24h).toBe(12);
    expect(profile.activity.sells24h).toBe(4);
  });

  it("preserves a genuinely-zero count (does not conflate with missing)", () => {
    const profile = buildAssetLiquidityProfile(asset, [pool({ buys24h: 0, sells24h: 0 })]);
    expect(profile.activity.buys24h).toBe(0);
    expect(profile.activity.sells24h).toBe(0);
    expect(profile.coverage.activity.txns24h).toEqual({ poolsReporting: 1, poolsMissing: 0, complete: true });
  });

  it("distinguishes missing from zero and reports incomplete coverage", () => {
    const profile = buildAssetLiquidityProfile(asset, [pool({ buys24h: null, sells24h: null })]);
    expect(profile.activity.buys24h).toBeNull();
    expect(profile.coverage.activity.txns24h).toEqual({ poolsReporting: 0, poolsMissing: 1, complete: false });
  });

  it("handles mixed missing/non-missing coverage across pools", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xa", volume24h: 100 }),
      pool({ pairAddress: "0xb", volume24h: null }),
    ]);
    expect(profile.activity.volume24h).toBe(100);
    expect(profile.coverage.activity.volume24h).toEqual({ poolsReporting: 1, poolsMissing: 1, complete: false });
  });

  it("returns all-null activity with complete coverage for zero pools", () => {
    const profile = buildAssetLiquidityProfile(asset, []);
    expect(profile.activity.volume24h).toBeNull();
    expect(profile.activity.buys24h).toBeNull();
    expect(profile.coverage.activity.volume24h).toEqual({ poolsReporting: 0, poolsMissing: 0, complete: true });
  });
});

describe("determinism", () => {
  it("sorts quoteAssets by displayedLiquidityUsd descending, address ascending as tie-breaker", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xa", quoteToken: { address: WETH, name: "WETH", symbol: "WETH" }, liquidityUsd: 100 }),
      pool({ pairAddress: "0xb", quoteToken: { address: CANONICAL_USDG_ADDRESS, name: "Global Dollar", symbol: "USDG" }, liquidityUsd: 500 }),
    ]);
    expect(profile.quoteAssets[0]?.symbol).toBe("USDG");
    expect(profile.quoteAssets[1]?.symbol).toBe("WETH");
  });

  it("sorts null-liquidity composition groups after all non-null groups", () => {
    const profile = buildAssetLiquidityProfile(asset, [
      pool({ pairAddress: "0xa", dexId: "ramses", liquidityUsd: null }),
      pool({ pairAddress: "0xb", dexId: "uniswap", liquidityUsd: 100 }),
    ]);
    expect(profile.dexes[0]?.dexId).toBe("uniswap");
    expect(profile.dexes[1]?.dexId).toBe("ramses");
  });
});
