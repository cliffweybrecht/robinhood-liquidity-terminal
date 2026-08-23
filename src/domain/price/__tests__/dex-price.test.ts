import { describe, expect, it } from "vitest";
import type { LiquidityPool } from "@/domain/pool";
import { buildDexPriceSummary, buildPoolPriceObservation, deriveCanonicalAssetPriceUsd } from "../dex-price";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const HOTDOG = "0x45443A4a7b58ab26A4B4D72616cf36D5aAE7188C";

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
    quoteToken: { address: USDG, name: "Global Dollar", symbol: "USDG" },
    priceUsd: 215.18,
    priceNative: 215.1838,
    liquidityUsd: 100_000,
    liquidityBase: 500,
    liquidityQuote: 100_000,
    volume5m: 0,
    volume1h: 0,
    volume6h: 0,
    volume24h: 0,
    buys5m: 0,
    sells5m: 0,
    buys1h: 0,
    sells1h: 0,
    buys6h: 0,
    sells6h: 0,
    buys24h: 0,
    sells24h: 0,
    priceChange5m: 0,
    priceChange1h: 0,
    priceChange6h: 0,
    priceChange24h: 0,
    fdv: null,
    marketCap: null,
    pairCreatedAt: null,
    dexScreenerUrl: "https://dexscreener.com/robinhood/x",
    labels: [],
    ...overrides,
  };
}

describe("deriveCanonicalAssetPriceUsd", () => {
  it("uses priceUsd directly when the canonical asset is base (CANONICAL_AS_BASE)", () => {
    const result = deriveCanonicalAssetPriceUsd(pool({ canonicalAssetSide: "base", priceUsd: 215.18 }));
    expect(result).toEqual({ priceUsd: 215.18, derivation: "CANONICAL_AS_BASE" });
  });

  it("derives priceUsd / priceNative when the canonical asset is quote (CANONICAL_AS_QUOTE_DERIVED)", () => {
    // Real live values: HOTDOG/COST pool — priceUsd=0.0005056 (HOTDOG's USD price),
    // priceNative=0.0000005340 (HOTDOG price in COST units) => COST price ≈ 946.82,
    // matching COST's directly-observed base-side price (946.81) to within 0.01%.
    const result = deriveCanonicalAssetPriceUsd(
      pool({
        canonicalAssetSide: "quote",
        baseToken: { address: HOTDOG, name: "hotdog", symbol: "HOTDOG" },
        quoteToken: { address: NVDA, name: "Costco • Robinhood Token", symbol: "COST" },
        priceUsd: 0.0005056,
        priceNative: 0.000000534,
      }),
    );
    expect(result.derivation).toBe("CANONICAL_AS_QUOTE_DERIVED");
    expect(result.priceUsd).toBeCloseTo(946.82, 1);
  });

  it("determines orientation only from canonicalAssetSide, never from symbol/name", () => {
    // baseToken/quoteToken symbols are deliberately misleading here (label
    // says "NVDA" on the quote side) — canonicalAssetSide is what governs.
    const result = deriveCanonicalAssetPriceUsd(
      pool({
        canonicalAssetSide: "base",
        baseToken: { address: NVDA, name: "impostor", symbol: "NOT_NVDA" },
        quoteToken: { address: USDG, name: "impostor2", symbol: "NVDA" },
        priceUsd: 215.18,
      }),
    );
    expect(result).toEqual({ priceUsd: 215.18, derivation: "CANONICAL_AS_BASE" });
  });

  it("returns UNAVAILABLE (never NaN) for a zero priceNative denominator on the quote side", () => {
    const result = deriveCanonicalAssetPriceUsd(
      pool({ canonicalAssetSide: "quote", priceUsd: 0.0005, priceNative: 0 }),
    );
    expect(result).toEqual({ priceUsd: null, derivation: "UNAVAILABLE" });
    expect(Number.isNaN(result.priceUsd)).toBe(false);
  });

  it("returns UNAVAILABLE for a negative priceNative denominator on the quote side", () => {
    const result = deriveCanonicalAssetPriceUsd(
      pool({ canonicalAssetSide: "quote", priceUsd: 0.0005, priceNative: -1 }),
    );
    expect(result).toEqual({ priceUsd: null, derivation: "UNAVAILABLE" });
  });

  it("returns UNAVAILABLE when priceUsd is missing on the base side", () => {
    const result = deriveCanonicalAssetPriceUsd(pool({ canonicalAssetSide: "base", priceUsd: null }));
    expect(result).toEqual({ priceUsd: null, derivation: "UNAVAILABLE" });
  });

  it("returns UNAVAILABLE when priceUsd is missing on the quote side", () => {
    const result = deriveCanonicalAssetPriceUsd(
      pool({ canonicalAssetSide: "quote", priceUsd: null, priceNative: 1 }),
    );
    expect(result).toEqual({ priceUsd: null, derivation: "UNAVAILABLE" });
  });

  it("returns UNAVAILABLE when priceNative is missing on the quote side", () => {
    const result = deriveCanonicalAssetPriceUsd(
      pool({ canonicalAssetSide: "quote", priceUsd: 0.0005, priceNative: null }),
    );
    expect(result).toEqual({ priceUsd: null, derivation: "UNAVAILABLE" });
  });

  it("never produces Infinity or NaN for any input combination", () => {
    const cases = [
      pool({ canonicalAssetSide: "quote", priceUsd: 1e300, priceNative: 1e-300 }),
      pool({ canonicalAssetSide: "quote", priceUsd: 0, priceNative: 1 }),
      pool({ canonicalAssetSide: "base", priceUsd: 0 }),
    ];
    for (const p of cases) {
      const result = deriveCanonicalAssetPriceUsd(p);
      if (result.priceUsd !== null) {
        expect(Number.isFinite(result.priceUsd)).toBe(true);
      }
    }
  });
});

describe("buildPoolPriceObservation", () => {
  it("preserves pool identity fields alongside the derived price", () => {
    const obs = buildPoolPriceObservation(pool({ dexId: "ramses", liquidityUsd: 500 }));
    expect(obs).toMatchObject({
      dexId: "ramses",
      canonicalAssetSide: "base",
      canonicalAssetPriceUsd: 215.18,
      derivation: "CANONICAL_AS_BASE",
      liquidityUsd: 500,
    });
  });
});

describe("buildDexPriceSummary", () => {
  it("handles a single pool", () => {
    const summary = buildDexPriceSummary([pool({ priceUsd: 100, liquidityUsd: 1000 })]);
    expect(summary.largestPoolPriceUsd).toBe(100);
    expect(summary.liquidityWeightedPriceUsd).toBe(100);
    expect(summary.medianPriceUsd).toBe(100);
    expect(summary.minPriceUsd).toBe(100);
    expect(summary.maxPriceUsd).toBe(100);
    expect(summary.priceDispersionPct).toBe(0);
  });

  it("selects the largest-liquidity pool's price as largestPoolPriceUsd", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: 100, liquidityUsd: 500 }),
      pool({ pairAddress: "0xb", priceUsd: 200, liquidityUsd: 5000 }),
      pool({ pairAddress: "0xc", priceUsd: 150, liquidityUsd: 2000 }),
    ]);
    expect(summary.largestPoolPriceUsd).toBe(200);
  });

  it("breaks largest-pool ties deterministically by pairAddress ascending", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xbbbb000000000000000000000000000000000000", priceUsd: 200, liquidityUsd: 1000 }),
      pool({ pairAddress: "0xaaaa000000000000000000000000000000000000", priceUsd: 300, liquidityUsd: 1000 }),
    ]);
    expect(summary.largestPoolPriceUsd).toBe(300);
  });

  it("computes the liquidity-weighted average correctly", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: 100, liquidityUsd: 100 }),
      pool({ pairAddress: "0xb", priceUsd: 200, liquidityUsd: 300 }),
    ]);
    // (100*100 + 200*300) / (100+300) = 70000/400 = 175
    expect(summary.liquidityWeightedPriceUsd).toBe(175);
  });

  it("computes the median for an odd number of usable pools", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: 100 }),
      pool({ pairAddress: "0xb", priceUsd: 300 }),
      pool({ pairAddress: "0xc", priceUsd: 200 }),
    ]);
    expect(summary.medianPriceUsd).toBe(200);
  });

  it("computes the median as the average of the two center values for an even number of usable pools", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: 100 }),
      pool({ pairAddress: "0xb", priceUsd: 200 }),
      pool({ pairAddress: "0xc", priceUsd: 300 }),
      pool({ pairAddress: "0xd", priceUsd: 400 }),
    ]);
    expect(summary.medianPriceUsd).toBe(250);
  });

  it("computes min/max/dispersion correctly", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: 90 }),
      pool({ pairAddress: "0xb", priceUsd: 100 }),
      pool({ pairAddress: "0xc", priceUsd: 130 }),
    ]);
    expect(summary.minPriceUsd).toBe(90);
    expect(summary.maxPriceUsd).toBe(130);
    expect(summary.medianPriceUsd).toBe(100);
    // (130-90)/100*100 = 40
    expect(summary.priceDispersionPct).toBe(40);
  });

  it("returns null for all price stats when every pool has an unusable price", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: null }),
      pool({ pairAddress: "0xb", canonicalAssetSide: "quote", priceUsd: 1, priceNative: 0 }),
    ]);
    expect(summary.largestPoolPriceUsd).toBeNull();
    expect(summary.liquidityWeightedPriceUsd).toBeNull();
    expect(summary.medianPriceUsd).toBeNull();
    expect(summary.minPriceUsd).toBeNull();
    expect(summary.maxPriceUsd).toBeNull();
    expect(summary.priceDispersionPct).toBeNull();
    expect(summary.usablePricePoolCount).toBe(0);
    expect(summary.totalPoolCount).toBe(2);
    expect(summary.priceCoverage).toEqual({ poolsReporting: 0, poolsMissing: 2, complete: false });
  });

  it("computes stats only over usable pools when some prices are missing", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: 100, liquidityUsd: 1000 }),
      pool({ pairAddress: "0xb", priceUsd: null }),
    ]);
    expect(summary.usablePricePoolCount).toBe(1);
    expect(summary.totalPoolCount).toBe(2);
    expect(summary.priceCoverage).toEqual({ poolsReporting: 1, poolsMissing: 1, complete: false });
    expect(summary.medianPriceUsd).toBe(100);
  });

  it("excludes pools with null liquidity from the weighted price but still counts their usable price elsewhere", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: 100, liquidityUsd: null }),
      pool({ pairAddress: "0xb", priceUsd: 200, liquidityUsd: 1000 }),
    ]);
    expect(summary.usablePricePoolCount).toBe(2);
    expect(summary.weightedPricePoolCount).toBe(1);
    expect(summary.liquidityWeightedPriceUsd).toBe(200);
    expect(summary.medianPriceUsd).toBe(150);
  });

  it("excludes zero-liquidity pools from the weighted calculation", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: 100, liquidityUsd: 0 }),
      pool({ pairAddress: "0xb", priceUsd: 200, liquidityUsd: 1000 }),
    ]);
    expect(summary.weightedPricePoolCount).toBe(1);
    expect(summary.liquidityWeightedPriceUsd).toBe(200);
  });

  it("excludes negative liquidity from the weighted calculation (defensive — schema shouldn't allow it)", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: 100, liquidityUsd: -50 }),
      pool({ pairAddress: "0xb", priceUsd: 200, liquidityUsd: 1000 }),
    ]);
    expect(summary.weightedPricePoolCount).toBe(1);
    expect(summary.liquidityWeightedPriceUsd).toBe(200);
  });

  it("keeps an outlier pool visible in `pools` rather than silently deleting it", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xa", priceUsd: 100, liquidityUsd: 100_000 }),
      pool({ pairAddress: "0xb", priceUsd: 5, liquidityUsd: 10 }), // tiny, wildly-off micro-pool
    ]);
    expect(summary.pools).toHaveLength(2);
    expect(summary.pools.some((p) => p.canonicalAssetPriceUsd === 5)).toBe(true);
    // The outlier pulls min down and widens dispersion rather than being deleted.
    expect(summary.minPriceUsd).toBe(5);
    expect(summary.priceDispersionPct).toBeGreaterThan(0);
  });

  it("returns a valid empty-shaped summary for zero pools", () => {
    const summary = buildDexPriceSummary([]);
    expect(summary.totalPoolCount).toBe(0);
    expect(summary.usablePricePoolCount).toBe(0);
    expect(summary.largestPoolPriceUsd).toBeNull();
    expect(summary.priceCoverage).toEqual({ poolsReporting: 0, poolsMissing: 0, complete: true });
    expect(summary.pools).toEqual([]);
  });

  it("orders `pools` deterministically by liquidity descending, nulls last, pairAddress tie-break", () => {
    const summary = buildDexPriceSummary([
      pool({ pairAddress: "0xzzz", priceUsd: 1, liquidityUsd: null }),
      pool({ pairAddress: "0xaaa", priceUsd: 1, liquidityUsd: 100 }),
      pool({ pairAddress: "0xbbb", priceUsd: 1, liquidityUsd: 500 }),
    ]);
    expect(summary.pools.map((p) => p.pairAddress)).toEqual(["0xbbb", "0xaaa", "0xzzz"]);
  });
});
