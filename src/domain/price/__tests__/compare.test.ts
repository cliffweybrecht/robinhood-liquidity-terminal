import { describe, expect, it } from "vitest";
import type { LiquidityPool } from "@/domain/pool";
import type { RobinhoodPriceQuote } from "@/providers/robinhood-price";
import {
  buildAssetPriceComparison,
  buildRobinhoodReferencePrice,
  calculatePremiumDiscountPct,
} from "../compare";
import { CrossedReferenceMarketError, InvalidReferenceQuoteError } from "../errors";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

function quote(overrides: Partial<RobinhoodPriceQuote> = {}): RobinhoodPriceQuote {
  return {
    tokenSymbol: "NVDA",
    bid: "213",
    ask: "217.55",
    currency: "USD",
    isTradingHalt: false,
    generatedAt: "2026-08-22T19:15:25.104646145Z",
    ...overrides,
  };
}

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

describe("buildRobinhoodReferencePrice", () => {
  it("computes the mid of bid/ask and applies the multiplier", () => {
    const ref = buildRobinhoodReferencePrice(quote({ bid: "213", ask: "217.55" }), "1.000000000000000000");
    expect(ref.rawUnderlyingBidUsd).toBe(213);
    expect(ref.rawUnderlyingAskUsd).toBe(217.55);
    expect(ref.rawUnderlyingMidUsd).toBeCloseTo(215.275);
    expect(ref.referencePriceUsd).toBeCloseTo(215.275);
  });

  it("scales the reference price by a non-1.0 multiplier (documented CRWD 4-for-1 split case)", () => {
    const ref = buildRobinhoodReferencePrice(quote({ bid: "191.01", ask: "191.8" }), "4.000000000000000000");
    // mid = 191.405, * 4 = 765.62
    expect(ref.rawUnderlyingMidUsd).toBeCloseTo(191.405);
    expect(ref.referencePriceUsd).toBeCloseTo(765.62);
  });

  it("preserves the original decimal-string multiplier alongside the parsed number used in arithmetic", () => {
    const ref = buildRobinhoodReferencePrice(quote(), "1.000566080061092436");
    expect(ref.currentMultiplier).toBe("1.000566080061092436");
  });

  it("preserves Robinhood's own fields (currency, isTradingHalt, generatedAt)", () => {
    const ref = buildRobinhoodReferencePrice(
      quote({ currency: "USD", isTradingHalt: true, generatedAt: "2026-01-01T00:00:00Z" }),
      "1",
    );
    expect(ref.currency).toBe("USD");
    expect(ref.isTradingHalt).toBe(true);
    expect(ref.generatedAt).toBe("2026-01-01T00:00:00Z");
    expect(ref.source).toBe("robinhood");
  });

  it("accepts the documented CRWD 4.0 multiplier (valid non-1.0 case)", () => {
    const ref = buildRobinhoodReferencePrice(quote({ bid: "191.01", ask: "191.8" }), "4.000000000000000000");
    expect(ref.referencePriceUsd).toBeCloseTo(765.62);
  });

  it("accepts a small non-1.0 multiplier (valid AAPL-style case)", () => {
    const ref = buildRobinhoodReferencePrice(quote({ bid: "310.80", ask: "311.00" }), "1.000566080061092436");
    expect(ref.referencePriceUsd).toBeCloseTo(310.9 * 1.000566080061092436, 5);
  });
});

describe("buildRobinhoodReferencePrice — domain validation (hardening)", () => {
  it("accepts a valid normal quote", () => {
    expect(() => buildRobinhoodReferencePrice(quote({ bid: "213", ask: "217.55" }), "1")).not.toThrow();
  });

  it("accepts bid = 0 (non-negative boundary, not invalid)", () => {
    const ref = buildRobinhoodReferencePrice(quote({ bid: "0", ask: "10" }), "1");
    expect(ref.rawUnderlyingBidUsd).toBe(0);
    expect(ref.referencePriceUsd).toBeCloseTo(5);
  });

  it("accepts ask = 0 only when bid is also 0 (otherwise it would be crossed)", () => {
    const ref = buildRobinhoodReferencePrice(quote({ bid: "0", ask: "0" }), "1");
    expect(ref.rawUnderlyingAskUsd).toBe(0);
    expect(ref.referencePriceUsd).toBe(0);
  });

  it("rejects a negative bid", () => {
    expect(() => buildRobinhoodReferencePrice(quote({ bid: "-1", ask: "10" }), "1")).toThrow(
      InvalidReferenceQuoteError,
    );
  });

  it("rejects a negative ask", () => {
    expect(() => buildRobinhoodReferencePrice(quote({ bid: "5", ask: "-1" }), "1")).toThrow(
      InvalidReferenceQuoteError,
    );
  });

  it("rejects a crossed market (bid > ask) with CrossedReferenceMarketError, not InvalidReferenceQuoteError", () => {
    let caught: unknown;
    try {
      buildRobinhoodReferencePrice(quote({ bid: "220", ask: "213" }), "1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CrossedReferenceMarketError);
    expect(caught).not.toBeInstanceOf(InvalidReferenceQuoteError);
    expect((caught as CrossedReferenceMarketError).bid).toBe(220);
    expect((caught as CrossedReferenceMarketError).ask).toBe(213);
    expect((caught as CrossedReferenceMarketError).symbol).toBe("NVDA");
  });

  it("does not treat bid === ask as crossed (a locked, not crossed, market)", () => {
    expect(() => buildRobinhoodReferencePrice(quote({ bid: "100", ask: "100" }), "1")).not.toThrow();
  });

  it("rejects a non-numeric multiplier string ('invalid multiplier')", () => {
    expect(() => buildRobinhoodReferencePrice(quote(), "not-a-number")).toThrow(InvalidReferenceQuoteError);
  });

  it("rejects a zero multiplier", () => {
    expect(() => buildRobinhoodReferencePrice(quote(), "0")).toThrow(InvalidReferenceQuoteError);
  });

  it("rejects a negative multiplier", () => {
    expect(() => buildRobinhoodReferencePrice(quote(), "-1")).toThrow(InvalidReferenceQuoteError);
  });

  it("rejects a non-finite parsed multiplier ('Infinity')", () => {
    expect(() => buildRobinhoodReferencePrice(quote(), "Infinity")).toThrow(InvalidReferenceQuoteError);
  });

  it("rejects a non-finite parsed bid ('NaN'-producing string, bypassing the upstream schema)", () => {
    expect(() => buildRobinhoodReferencePrice(quote({ bid: "not-a-number" }), "1")).toThrow(
      InvalidReferenceQuoteError,
    );
  });

  it("rejects a non-finite parsed ask, bypassing the upstream schema", () => {
    expect(() => buildRobinhoodReferencePrice(quote({ ask: "not-a-number" }), "1")).toThrow(
      InvalidReferenceQuoteError,
    );
  });

  it("never fabricates a reference price on any invalid-input path — the object is never constructed", () => {
    const cases: Array<[Partial<RobinhoodPriceQuote>, string]> = [
      [{ bid: "-1" }, "1"],
      [{ ask: "-1" }, "1"],
      [{ bid: "220", ask: "213" }, "1"],
      [{}, "0"],
      [{}, "-1"],
      [{}, "not-a-number"],
    ];
    for (const [overrides, multiplier] of cases) {
      expect(() => buildRobinhoodReferencePrice(quote(overrides), multiplier)).toThrow();
    }
  });

  it("all validation failures are PriceComparisonError subclasses with a stable code and the offending symbol", () => {
    try {
      buildRobinhoodReferencePrice(quote({ bid: "220", ask: "213" }), "1");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CrossedReferenceMarketError);
      expect((err as CrossedReferenceMarketError).code).toBe("CROSSED_REFERENCE_MARKET");
    }
    try {
      buildRobinhoodReferencePrice(quote(), "0");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidReferenceQuoteError);
      expect((err as InvalidReferenceQuoteError).code).toBe("INVALID_REFERENCE_QUOTE");
      expect((err as InvalidReferenceQuoteError).symbol).toBe("NVDA");
    }
  });
});

describe("calculatePremiumDiscountPct", () => {
  it("returns 0 for exact parity", () => {
    expect(calculatePremiumDiscountPct(100, 100)).toBe(0);
  });

  it("returns a positive premium when DEX price exceeds reference", () => {
    expect(calculatePremiumDiscountPct(110, 100)).toBeCloseTo(10);
  });

  it("returns a negative discount when DEX price is below reference", () => {
    expect(calculatePremiumDiscountPct(90, 100)).toBeCloseTo(-10);
  });

  it("returns null when reference price is zero", () => {
    expect(calculatePremiumDiscountPct(100, 0)).toBeNull();
  });

  it("returns null when reference price is negative", () => {
    expect(calculatePremiumDiscountPct(100, -50)).toBeNull();
  });

  it("returns null when DEX price is null (comparison unavailable)", () => {
    expect(calculatePremiumDiscountPct(null, 100)).toBeNull();
  });

  it("never returns NaN or Infinity", () => {
    const cases: Array<[number | null, number]> = [
      [1e300, 1e-300],
      [0, 100],
      [-50, 100],
    ];
    for (const [dex, ref] of cases) {
      const result = calculatePremiumDiscountPct(dex, ref);
      if (result !== null) {
        expect(Number.isFinite(result)).toBe(true);
      }
    }
  });
});

describe("buildAssetPriceComparison", () => {
  it("assembles a full comparison end-to-end", () => {
    const robinhood = buildRobinhoodReferencePrice(quote({ bid: "213", ask: "217.55" }), "1");
    const comparison = buildAssetPriceComparison(
      { symbol: "NVDA", name: "NVIDIA • Robinhood Token", contractAddress: NVDA },
      [pool({ priceUsd: 215.18, liquidityUsd: 100_000 })],
      robinhood,
    );

    expect(comparison.asset.symbol).toBe("NVDA");
    expect(comparison.robinhood.referencePriceUsd).toBeCloseTo(215.275);
    expect(comparison.dex.largestPoolPriceUsd).toBe(215.18);
    expect(comparison.comparison.largestPoolPremiumDiscountPct).toBeCloseTo(
      ((215.18 - 215.275) / 215.275) * 100,
    );
    expect(new Date(comparison.generatedAt).getTime()).not.toBeNaN();
  });

  it("propagates null premium/discount when a DEX price methodology is unavailable", () => {
    const robinhood = buildRobinhoodReferencePrice(quote(), "1");
    const comparison = buildAssetPriceComparison(
      { symbol: "NVDA", name: "NVIDIA", contractAddress: NVDA },
      [],
      robinhood,
    );
    expect(comparison.comparison.largestPoolPremiumDiscountPct).toBeNull();
    expect(comparison.comparison.liquidityWeightedPremiumDiscountPct).toBeNull();
    expect(comparison.comparison.medianPremiumDiscountPct).toBeNull();
  });
});
