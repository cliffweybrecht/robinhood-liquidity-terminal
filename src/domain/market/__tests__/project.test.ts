import { describe, expect, it } from "vitest";
import type { AssetLiquidityProfile } from "@/domain/liquidity";
import { projectLiquidityProfileToMarketRow, sortMarketRows } from "../project";
import type { MarketLiquidityRow } from "../types";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

function profile(overrides: Partial<AssetLiquidityProfile> = {}): AssetLiquidityProfile {
  return {
    asset: { symbol: "NVDA", name: "NVIDIA • Robinhood Token", contractAddress: NVDA },
    displayedLiquidityUsd: 1000,
    usdGLiquidityUsd: 800,
    poolCount: 5,
    dexCount: 2,
    largestPool: {
      dexId: "uniswap",
      pairAddress: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3",
      liquidityUsd: 600,
      shareOfDisplayedLiquidityPct: 60,
    },
    concentration: { top1Pct: 60, top3Pct: 90, top5Pct: 100 },
    quoteAssets: [],
    dexes: [],
    activity: {
      volume5m: 1,
      volume1h: 2,
      volume6h: 3,
      volume24h: 4000,
      buys5m: 1,
      sells5m: 1,
      buys1h: 1,
      sells1h: 1,
      buys6h: 1,
      sells6h: 1,
      buys24h: 200,
      sells24h: 190,
    },
    coverage: {
      liquidity: { poolsReporting: 5, poolsMissing: 0, complete: true },
      activity: {
        volume5m: { poolsReporting: 5, poolsMissing: 0, complete: true },
        volume1h: { poolsReporting: 5, poolsMissing: 0, complete: true },
        volume6h: { poolsReporting: 5, poolsMissing: 0, complete: true },
        volume24h: { poolsReporting: 5, poolsMissing: 0, complete: true },
        txns5m: { poolsReporting: 5, poolsMissing: 0, complete: true },
        txns1h: { poolsReporting: 5, poolsMissing: 0, complete: true },
        txns6h: { poolsReporting: 5, poolsMissing: 0, complete: true },
        txns24h: { poolsReporting: 5, poolsMissing: 0, complete: true },
      },
    },
    pools: [],
    ...overrides,
  };
}

describe("projectLiquidityProfileToMarketRow", () => {
  it("selects the correct fields without recomputing anything", () => {
    const row = projectLiquidityProfileToMarketRow(profile(), "https://cdn.example/nvda.png");

    expect(row).toEqual({
      asset: {
        symbol: "NVDA",
        name: "NVIDIA • Robinhood Token",
        contractAddress: NVDA,
        logoUrl: "https://cdn.example/nvda.png",
      },
      displayedLiquidityUsd: 1000,
      usdGLiquidityUsd: 800,
      poolCount: 5,
      dexCount: 2,
      observedVolume24h: 4000,
      buys24h: 200,
      sells24h: 190,
      largestPoolLiquidityUsd: 600,
      top1ConcentrationPct: 60,
      top3ConcentrationPct: 90,
      top5ConcentrationPct: 100,
      liquidityCoverageComplete: true,
      volume24hCoverageComplete: true,
      robinhoodReferencePriceUsd: null,
      dexLiquidityWeightedPriceUsd: null,
      dexMedianPriceUsd: null,
      premiumDiscountPct: null,
      priceDispersionPct: null,
      priceCoverageComplete: null,
    });
  });

  it("defaults all Phase 5 price fields to null — this function has no involvement with price data", () => {
    const row = projectLiquidityProfileToMarketRow(profile(), null);
    expect(row.robinhoodReferencePriceUsd).toBeNull();
    expect(row.dexLiquidityWeightedPriceUsd).toBeNull();
    expect(row.dexMedianPriceUsd).toBeNull();
    expect(row.premiumDiscountPct).toBeNull();
    expect(row.priceDispersionPct).toBeNull();
    expect(row.priceCoverageComplete).toBeNull();
  });

  it("passes through null largestPoolLiquidityUsd when there is no largest pool", () => {
    const row = projectLiquidityProfileToMarketRow(profile({ largestPool: null }), null);
    expect(row.largestPoolLiquidityUsd).toBeNull();
  });

  it("preserves null displayedLiquidityUsd for a zero-pool asset (never coerces to 0)", () => {
    const row = projectLiquidityProfileToMarketRow(
      profile({
        displayedLiquidityUsd: null,
        usdGLiquidityUsd: null,
        poolCount: 0,
        dexCount: 0,
        largestPool: null,
        concentration: { top1Pct: null, top3Pct: null, top5Pct: null },
      }),
      null,
    );
    expect(row.displayedLiquidityUsd).toBeNull();
    expect(row.poolCount).toBe(0);
  });

  it("propagates incomplete coverage flags", () => {
    const row = projectLiquidityProfileToMarketRow(
      profile({
        coverage: {
          liquidity: { poolsReporting: 2, poolsMissing: 3, complete: false },
          activity: {
            volume5m: { poolsReporting: 5, poolsMissing: 0, complete: true },
            volume1h: { poolsReporting: 5, poolsMissing: 0, complete: true },
            volume6h: { poolsReporting: 5, poolsMissing: 0, complete: true },
            volume24h: { poolsReporting: 1, poolsMissing: 4, complete: false },
            txns5m: { poolsReporting: 5, poolsMissing: 0, complete: true },
            txns1h: { poolsReporting: 5, poolsMissing: 0, complete: true },
            txns6h: { poolsReporting: 5, poolsMissing: 0, complete: true },
            txns24h: { poolsReporting: 5, poolsMissing: 0, complete: true },
          },
        },
      }),
      null,
    );
    expect(row.liquidityCoverageComplete).toBe(false);
    expect(row.volume24hCoverageComplete).toBe(false);
  });
});

function row(overrides: Partial<MarketLiquidityRow> = {}): MarketLiquidityRow {
  return {
    asset: { symbol: "AAA", name: "Asset A", contractAddress: NVDA, logoUrl: null },
    displayedLiquidityUsd: 100,
    usdGLiquidityUsd: 100,
    poolCount: 1,
    dexCount: 1,
    observedVolume24h: 1,
    buys24h: 1,
    sells24h: 1,
    largestPoolLiquidityUsd: 100,
    top1ConcentrationPct: 100,
    top3ConcentrationPct: 100,
    top5ConcentrationPct: 100,
    liquidityCoverageComplete: true,
    volume24hCoverageComplete: true,
    robinhoodReferencePriceUsd: null,
    dexLiquidityWeightedPriceUsd: null,
    dexMedianPriceUsd: null,
    premiumDiscountPct: null,
    priceDispersionPct: null,
    priceCoverageComplete: null,
    ...overrides,
  };
}

describe("sortMarketRows", () => {
  it("sorts by displayedLiquidityUsd descending", () => {
    const rows = [
      row({ asset: { ...row().asset, symbol: "AAA" }, displayedLiquidityUsd: 100 }),
      row({ asset: { ...row().asset, symbol: "BBB" }, displayedLiquidityUsd: 300 }),
      row({ asset: { ...row().asset, symbol: "CCC" }, displayedLiquidityUsd: 200 }),
    ];
    expect(sortMarketRows(rows).map((r) => r.asset.symbol)).toEqual(["BBB", "CCC", "AAA"]);
  });

  it("sorts rows with null liquidity after every non-null row", () => {
    const rows = [
      row({ asset: { ...row().asset, symbol: "NULLA" }, displayedLiquidityUsd: null }),
      row({ asset: { ...row().asset, symbol: "HASVAL" }, displayedLiquidityUsd: 50 }),
    ];
    expect(sortMarketRows(rows).map((r) => r.asset.symbol)).toEqual(["HASVAL", "NULLA"]);
  });

  it("breaks ties (including all-null) by symbol ascending", () => {
    const rows = [
      row({ asset: { ...row().asset, symbol: "ZZZ" }, displayedLiquidityUsd: null }),
      row({ asset: { ...row().asset, symbol: "AAA" }, displayedLiquidityUsd: null }),
      row({ asset: { ...row().asset, symbol: "CCC" }, displayedLiquidityUsd: 50 }),
      row({ asset: { ...row().asset, symbol: "BBB" }, displayedLiquidityUsd: 50 }),
    ];
    expect(sortMarketRows(rows).map((r) => r.asset.symbol)).toEqual(["BBB", "CCC", "AAA", "ZZZ"]);
  });

  it("does not mutate the input array", () => {
    const rows = [row({ displayedLiquidityUsd: 1 }), row({ displayedLiquidityUsd: 2 })];
    const copy = [...rows];
    sortMarketRows(rows);
    expect(rows).toEqual(copy);
  });
});
