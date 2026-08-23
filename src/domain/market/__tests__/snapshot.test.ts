import { describe, expect, it, vi } from "vitest";
import { buildMarketLiquiditySnapshot } from "../snapshot";

const ROBINHOOD_BASE_URL = "https://robinhood.example.test";
const DEXSCREENER_BASE_URL = "https://dexscreener.example.test";
const ROBINHOOD_PRICE_BASE_URL = "https://robinhood-price.example.test";

const CRM = "0xd95B44124e475743a7589e68F3D74008A5536D44";
const P = "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D";
const CIEN = "0x44f6D488021f8233B9416294d1FE9b1fEe28382d";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const threeAssetRegistry = {
  assets: [
    {
      id: "0x1",
      tokenSymbol: "CRM",
      tokenName: "Salesforce • Robinhood Token",
      deployments: [{ contractAddress: CRM, chainId: 4663 }],
      currentMultiplier: "1.000000000000000000",
      status: "ASSET_STATUS_ACTIVE",
      logoUrl: "https://cdn.robinhood.com/crm.png",
    },
    {
      id: "0x2",
      tokenSymbol: "P",
      tokenName: "Everpure • Robinhood Token",
      deployments: [{ contractAddress: P, chainId: 4663 }],
      currentMultiplier: "1.000000000000000000",
      status: "ASSET_STATUS_ACTIVE",
    },
    {
      id: "0x3",
      tokenSymbol: "CIEN",
      tokenName: "Ciena • Robinhood Token",
      deployments: [{ contractAddress: CIEN, chainId: 4663 }],
      currentMultiplier: "1.000000000000000000",
      status: "ASSET_STATUS_ACTIVE",
    },
  ],
};

function pairFor(baseAddress: string, liquidityUsd: number, pairAddress: string) {
  return {
    chainId: "robinhood",
    dexId: "uniswap",
    url: `https://dexscreener.com/robinhood/${pairAddress}`,
    pairAddress,
    labels: ["v3"],
    baseToken: { address: baseAddress, name: "Token", symbol: "TKN" },
    quoteToken: { address: USDG, name: "Global Dollar", symbol: "USDG" },
    priceNative: "1.0",
    priceUsd: "1.0",
    txns: { h24: { buys: 1, sells: 1 } },
    volume: { h24: 10 },
    priceChange: { h24: 0 },
    liquidity: { usd: liquidityUsd, base: 1, quote: 1 },
    fdv: 1000,
    marketCap: 1000,
    pairCreatedAt: 1700000000000,
  };
}

/** Routes a fetchImpl by matching the requested token address embedded in the URL. */
function routedDexScreenerFetchImpl(
  routes: Record<string, { status: number; body: unknown }>,
): typeof fetch {
  return async (url) => {
    const urlStr = String(url).toLowerCase();
    for (const [address, route] of Object.entries(routes)) {
      if (urlStr.includes(address.toLowerCase())) {
        return new Response(JSON.stringify(route.body), { status: route.status });
      }
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
}

function robinhoodFetchImpl(body: unknown = threeAssetRegistry): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status: 200 });
}

function priceQuote(symbol: string, bid: string, ask: string) {
  return {
    tokenSymbol: symbol,
    bid,
    ask,
    currency: "USD",
    isTradingHalt: false,
    generatedAt: "2026-08-22T19:15:25.104646145Z",
  };
}

const threeAssetPriceFixture = {
  quotes: [priceQuote("CRM", "209.17", "220"), priceQuote("P", "104.88", "111.83"), priceQuote("CIEN", "395.79", "402")],
};

function robinhoodPriceFetchImpl(body: unknown = threeAssetPriceFixture, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

/** Default price options for tests that don't care about price specifics — always injected so no test hits live network. */
function defaultPriceOptions() {
  return { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImpl() };
}

describe("buildMarketLiquiditySnapshot", () => {
  it("succeeds for all assets, reusing Phase 3 aggregation for each row's numbers", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CRM]: { status: 200, body: [pairFor(CRM, 100, "0x00000000000000000000000000000000000000aa"), pairFor(CRM, 200, "0x00000000000000000000000000000000000000bb")] },
          [P]: { status: 200, body: [] },
          [CIEN]: { status: 200, body: [pairFor(CIEN, 500, "0x00000000000000000000000000000000000000cc")] },
        }),
      },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(snapshot.assetsRequested).toBe(3);
    expect(snapshot.assetsSucceeded).toBe(3);
    expect(snapshot.assetsFailed).toBe(0);
    expect(snapshot.completeness).toEqual({ complete: true, successPct: 100 });
    expect(snapshot.failures).toEqual([]);

    const crmRow = snapshot.rows.find((r) => r.asset.symbol === "CRM");
    // 100 + 200, exactly what buildAssetLiquidityProfile would compute — proves
    // the snapshot reuses Phase 3 math rather than reimplementing it.
    expect(crmRow?.displayedLiquidityUsd).toBe(300);
    expect(crmRow?.poolCount).toBe(2);
    expect(crmRow?.asset.logoUrl).toBe("https://cdn.robinhood.com/crm.png");
  });

  it("treats a zero-pool asset as a success, not a failure", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CRM]: { status: 200, body: [] },
          [P]: { status: 200, body: [] },
          [CIEN]: { status: 200, body: [] },
        }),
      },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(snapshot.assetsSucceeded).toBe(3);
    expect(snapshot.assetsFailed).toBe(0);
    const pRow = snapshot.rows.find((r) => r.asset.symbol === "P");
    expect(pRow?.poolCount).toBe(0);
    expect(pRow?.displayedLiquidityUsd).toBeNull();
  });

  it("collects a single asset's failure without aborting the snapshot, and never reports it as zero liquidity", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CRM]: { status: 200, body: [pairFor(CRM, 100, "0x00000000000000000000000000000000000000aa")] },
          [P]: { status: 200, body: [] },
          [CIEN]: { status: 503, body: "error" },
        }),
      },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(snapshot.assetsRequested).toBe(3);
    expect(snapshot.assetsSucceeded).toBe(2);
    expect(snapshot.assetsFailed).toBe(1);
    expect(snapshot.completeness.complete).toBe(false);
    expect(snapshot.completeness.successPct).toBeCloseTo((2 / 3) * 100);

    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures[0]).toMatchObject({ symbol: "CIEN", category: "DEXSCREENER_HTTP" });
    expect(snapshot.rows.some((r) => r.asset.symbol === "CIEN")).toBe(false);

    // Never a fabricated zero for the failed asset.
    expect(snapshot.rows.map((r) => r.displayedLiquidityUsd)).not.toContain(0);
  });

  it("collects multiple simultaneous failures independently", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CRM]: { status: 500, body: "error" },
          [P]: { status: 503, body: "error" },
          [CIEN]: { status: 200, body: [] },
        }),
      },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(snapshot.assetsSucceeded).toBe(1);
    expect(snapshot.assetsFailed).toBe(2);
    expect(snapshot.failures.map((f) => f.symbol).sort()).toEqual(["CRM", "P"]);
  });

  it("returns rows in deterministic descending-liquidity order", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CRM]: { status: 200, body: [pairFor(CRM, 50, "0x00000000000000000000000000000000000000aa")] },
          [P]: { status: 200, body: [pairFor(P, 500, "0x00000000000000000000000000000000000000bb")] },
          [CIEN]: { status: 200, body: [pairFor(CIEN, 200, "0x00000000000000000000000000000000000000cc")] },
        }),
      },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(snapshot.rows.map((r) => r.asset.symbol)).toEqual(["P", "CIEN", "CRM"]);
  });

  it("fetches the canonical registry exactly once regardless of asset count", async () => {
    const robinhoodFetch = vi.fn(robinhoodFetchImpl());

    await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetch },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({}),
      },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(robinhoodFetch).toHaveBeenCalledTimes(1);
  });

  it("reports refreshStartedAt, generatedAt, and a non-negative refreshDurationMs", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: routedDexScreenerFetchImpl({}) },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(new Date(snapshot.refreshStartedAt).getTime()).not.toBeNaN();
    expect(new Date(snapshot.generatedAt).getTime()).not.toBeNaN();
    expect(snapshot.refreshDurationMs).toBeGreaterThanOrEqual(0);
    expect(new Date(snapshot.generatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(snapshot.refreshStartedAt).getTime(),
    );
  });
});

describe("buildMarketLiquiditySnapshot — Phase 5 price integration", () => {
  function threeAssetDexScreenerFetchImpl() {
    return routedDexScreenerFetchImpl({
      [CRM]: { status: 200, body: [pairFor(CRM, 100, "0x00000000000000000000000000000000000000aa")] },
      [P]: { status: 200, body: [pairFor(P, 200, "0x00000000000000000000000000000000000000bb")] },
      [CIEN]: { status: 200, body: [pairFor(CIEN, 300, "0x00000000000000000000000000000000000000cc")] },
    });
  }

  it("liquidity succeeds + price succeeds: populates reference price and premium/discount from the bulk match", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: threeAssetDexScreenerFetchImpl() },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(snapshot.price).toEqual({
      available: true,
      generatedAt: snapshot.generatedAt,
      symbolsMatched: 3,
      symbolsMissing: 0,
      missingSymbols: [],
      symbolsInvalid: 0,
      invalidSymbols: [],
      // Every quote in threeAssetPriceFixture shares the same generatedAt.
      oldestQuoteGeneratedAt: "2026-08-22T19:15:25.104646145Z",
      newestQuoteGeneratedAt: "2026-08-22T19:15:25.104646145Z",
    });

    const crmRow = snapshot.rows.find((r) => r.asset.symbol === "CRM")!;
    // priceQuote("CRM", "209.17", "220") with multiplier 1 => mid 214.585
    expect(crmRow.robinhoodReferencePriceUsd).toBeCloseTo(214.585, 3);
    expect(crmRow.dexLiquidityWeightedPriceUsd).toBe(1); // pairFor always prices at 1.0
    expect(crmRow.dexMedianPriceUsd).toBe(1);
    expect(crmRow.premiumDiscountPct).not.toBeNull();
    expect(crmRow.priceCoverageComplete).toBe(true);
    // Liquidity data (Phase 3/4) untouched by the price merge.
    expect(crmRow.displayedLiquidityUsd).toBe(100);
    expect(crmRow.poolCount).toBe(1);
  });

  it("liquidity succeeds + price fetch fails entirely: liquidity data is untouched, price fields stay null, never fabricated as 0", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: threeAssetDexScreenerFetchImpl() },
      robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImpl(undefined, 500) },
    });

    expect(snapshot.price).toEqual({
      available: false,
      generatedAt: null,
      symbolsMatched: 0,
      symbolsMissing: 0,
      missingSymbols: [],
      symbolsInvalid: 0,
      invalidSymbols: [],
      oldestQuoteGeneratedAt: null,
      newestQuoteGeneratedAt: null,
    });

    // Liquidity succeeded for all three regardless of the price outage.
    expect(snapshot.assetsSucceeded).toBe(3);
    expect(snapshot.assetsFailed).toBe(0);

    for (const row of snapshot.rows) {
      expect(row.robinhoodReferencePriceUsd).toBeNull();
      expect(row.dexLiquidityWeightedPriceUsd).toBeNull();
      expect(row.dexMedianPriceUsd).toBeNull();
      expect(row.premiumDiscountPct).toBeNull();
      expect(row.priceCoverageComplete).toBeNull();
      // Never fabricated as a numeric zero.
      expect(row.robinhoodReferencePriceUsd).not.toBe(0);
      expect(row.premiumDiscountPct).not.toBe(0);
    }

    const crmRow = snapshot.rows.find((r) => r.asset.symbol === "CRM")!;
    expect(crmRow.displayedLiquidityUsd).toBe(100);
    expect(crmRow.poolCount).toBe(1);
  });

  it("does not fabricate a price when a symbol is absent from the bulk response, and leaves that row's liquidity data intact", async () => {
    const partialPriceFixture = {
      quotes: [priceQuote("CRM", "209.17", "220"), priceQuote("P", "104.88", "111.83")],
      // CIEN deliberately missing.
    };
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: threeAssetDexScreenerFetchImpl() },
      robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImpl(partialPriceFixture) },
    });

    expect(snapshot.price).toEqual({
      available: true,
      generatedAt: snapshot.generatedAt,
      symbolsMatched: 2,
      symbolsMissing: 1,
      missingSymbols: ["CIEN"],
      symbolsInvalid: 0,
      invalidSymbols: [],
      oldestQuoteGeneratedAt: "2026-08-22T19:15:25.104646145Z",
      newestQuoteGeneratedAt: "2026-08-22T19:15:25.104646145Z",
    });

    const cienRow = snapshot.rows.find((r) => r.asset.symbol === "CIEN")!;
    expect(cienRow.robinhoodReferencePriceUsd).toBeNull();
    expect(cienRow.premiumDiscountPct).toBeNull();
    // CIEN's liquidity metrics are untouched by the missing price match.
    expect(cienRow.displayedLiquidityUsd).toBe(300);
    expect(cienRow.poolCount).toBe(1);

    const crmRow = snapshot.rows.find((r) => r.asset.symbol === "CRM")!;
    expect(crmRow.robinhoodReferencePriceUsd).not.toBeNull();
  });

  it("computes a reference price for a zero-pool asset without a fabricated DEX comparison", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CRM]: { status: 200, body: [] },
          [P]: { status: 200, body: [] },
          [CIEN]: { status: 200, body: [] },
        }),
      },
      robinhoodPrice: defaultPriceOptions(),
    });

    const pRow = snapshot.rows.find((r) => r.asset.symbol === "P")!;
    expect(pRow.poolCount).toBe(0);
    expect(pRow.displayedLiquidityUsd).toBeNull();
    // Reference price is still computed from Robinhood's quote alone...
    expect(pRow.robinhoodReferencePriceUsd).not.toBeNull();
    // ...but there is no DEX price to compare it against, and no
    // premium/discount is fabricated from an absent DEX price.
    expect(pRow.dexLiquidityWeightedPriceUsd).toBeNull();
    expect(pRow.premiumDiscountPct).toBeNull();
  });

  it("keeps the Dexscreener and Robinhood-price fetches independent: a slow/failing price fetch does not block or alter liquidity results", async () => {
    const dexScreenerFetch = vi.fn(threeAssetDexScreenerFetchImpl());
    const priceFetch = vi.fn(async () => {
      throw new Error("simulated price provider outage");
    });

    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexScreenerFetch },
      robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: priceFetch },
    });

    expect(dexScreenerFetch).toHaveBeenCalledTimes(3);
    expect(priceFetch).toHaveBeenCalledTimes(1);
    expect(snapshot.assetsSucceeded).toBe(3);
    expect(snapshot.price.available).toBe(false);
  });

  it("sorts rows with null displayedLiquidityUsd deterministically regardless of price availability", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CRM]: { status: 200, body: [] },
          [P]: { status: 200, body: [] },
          [CIEN]: { status: 200, body: [pairFor(CIEN, 50, "0x00000000000000000000000000000000000000cc")] },
        }),
      },
      robinhoodPrice: defaultPriceOptions(),
    });

    // Price presence must not change liquidity-based ordering: CIEN has
    // liquidity so it sorts first; CRM/P are both null-liquidity and fall
    // back to symbol-ascending, even though both have a reference price.
    expect(snapshot.rows.map((r) => r.asset.symbol)).toEqual(["CIEN", "CRM", "P"]);
  });
});

describe("buildMarketLiquiditySnapshot — hardening: headline price is median-based, not liquidity-weighted", () => {
  it("premiumDiscountPct and dexMedianPriceUsd are derived from the median, which can genuinely diverge from the liquidity-weighted price", async () => {
    // CRM gets three pools with deliberately different prices/liquidity
    // so that median and liquidity-weighted diverge: prices 1, 2, 100
    // with liquidity 10, 10, 100_000 — the liquidity-weighted average is
    // dragged almost all the way to 100 by the huge-liquidity pool,
    // while the median (2) is resistant to that single pool's pull.
    const crmPools = [
      pairFor(CRM, 10, "0x00000000000000000000000000000000000000a1"),
      { ...pairFor(CRM, 10, "0x00000000000000000000000000000000000000a2"), priceUsd: "2.0", priceNative: "2.0" },
      { ...pairFor(CRM, 100_000, "0x00000000000000000000000000000000000000a3"), priceUsd: "100.0", priceNative: "100.0" },
    ];

    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CRM]: { status: 200, body: crmPools },
          [P]: { status: 200, body: [] },
          [CIEN]: { status: 200, body: [] },
        }),
      },
      robinhoodPrice: defaultPriceOptions(),
    });

    const crmRow = snapshot.rows.find((r) => r.asset.symbol === "CRM")!;

    // Sanity: the three raw prices are 1, 2, 100 — median is 2, but the
    // liquidity-weighted average is pulled far above 2 by the 100_000-
    // liquidity pool priced at 100.
    expect(crmRow.dexMedianPriceUsd).toBe(2);
    expect(crmRow.dexLiquidityWeightedPriceUsd).toBeGreaterThan(90);
    expect(crmRow.dexLiquidityWeightedPriceUsd).not.toBe(crmRow.dexMedianPriceUsd);

    // The headline premiumDiscountPct must track the median, not the
    // liquidity-weighted price.
    const referencePriceUsd = crmRow.robinhoodReferencePriceUsd!;
    const expectedHeadlinePct = ((2 - referencePriceUsd) / referencePriceUsd) * 100;
    expect(crmRow.premiumDiscountPct).toBeCloseTo(expectedHeadlinePct, 6);

    // It must NOT match what the old liquidity-weighted-based headline
    // would have computed — proves the basis genuinely changed, not
    // just that a field was renamed.
    const oldLiquidityWeightedBasedPct =
      ((crmRow.dexLiquidityWeightedPriceUsd! - referencePriceUsd) / referencePriceUsd) * 100;
    expect(crmRow.premiumDiscountPct).not.toBeCloseTo(oldLiquidityWeightedBasedPct, 1);

    // dexLiquidityWeightedPriceUsd itself remains populated, unfiltered,
    // exactly as Phase 5 originally computed it — a diagnostic, not
    // deleted or hidden by the headline-basis change.
    expect(crmRow.dexLiquidityWeightedPriceUsd).not.toBeNull();
  });
});

describe("buildMarketLiquiditySnapshot — hardening: invalid reference quotes never crash the snapshot", () => {
  it("a crossed-market quote for one symbol is tracked as invalid, leaves that row's price fields null, and does not affect other assets", async () => {
    const crossedPriceFixture = {
      quotes: [
        // CRM's quote is crossed: bid > ask.
        { ...priceQuote("CRM", "220", "213") },
        priceQuote("P", "104.88", "111.83"),
        priceQuote("CIEN", "395.79", "402"),
      ],
    };

    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CRM]: { status: 200, body: [pairFor(CRM, 100, "0x00000000000000000000000000000000000000aa")] },
          [P]: { status: 200, body: [pairFor(P, 200, "0x00000000000000000000000000000000000000bb")] },
          [CIEN]: { status: 200, body: [pairFor(CIEN, 300, "0x00000000000000000000000000000000000000cc")] },
        }),
      },
      robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImpl(crossedPriceFixture) },
    });

    // The snapshot completes successfully — a crossed quote never
    // throws out of buildMarketLiquiditySnapshot.
    expect(snapshot.assetsSucceeded).toBe(3);
    expect(snapshot.assetsFailed).toBe(0);

    expect(snapshot.price.symbolsInvalid).toBe(1);
    expect(snapshot.price.invalidSymbols).toEqual(["CRM"]);
    // Never conflated with "missing" — CRM's quote was present, just invalid.
    expect(snapshot.price.symbolsMissing).toBe(0);
    expect(snapshot.price.missingSymbols).toEqual([]);
    expect(snapshot.price.symbolsMatched).toBe(2);

    const crmRow = snapshot.rows.find((r) => r.asset.symbol === "CRM")!;
    expect(crmRow.robinhoodReferencePriceUsd).toBeNull();
    expect(crmRow.dexLiquidityWeightedPriceUsd).toBeNull();
    expect(crmRow.dexMedianPriceUsd).toBeNull();
    expect(crmRow.premiumDiscountPct).toBeNull();
    // Never fabricated as zero.
    expect(crmRow.robinhoodReferencePriceUsd).not.toBe(0);
    // CRM's liquidity metrics (Phase 3/4) are completely untouched.
    expect(crmRow.displayedLiquidityUsd).toBe(100);
    expect(crmRow.poolCount).toBe(1);

    // The other two assets are entirely unaffected.
    const pRow = snapshot.rows.find((r) => r.asset.symbol === "P")!;
    expect(pRow.robinhoodReferencePriceUsd).not.toBeNull();
    const cienRow = snapshot.rows.find((r) => r.asset.symbol === "CIEN")!;
    expect(cienRow.robinhoodReferencePriceUsd).not.toBeNull();
  });

  it("an invalid multiplier (registry data problem, not a quote problem) is also tracked as invalid, not missing", async () => {
    const registryWithBadMultiplier = {
      assets: threeAssetRegistry.assets.map((a) =>
        a.tokenSymbol === "P" ? { ...a, currentMultiplier: "0" } : a,
      ),
    };

    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl(registryWithBadMultiplier) },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CRM]: { status: 200, body: [pairFor(CRM, 100, "0x00000000000000000000000000000000000000aa")] },
          [P]: { status: 200, body: [pairFor(P, 200, "0x00000000000000000000000000000000000000bb")] },
          [CIEN]: { status: 200, body: [pairFor(CIEN, 300, "0x00000000000000000000000000000000000000cc")] },
        }),
      },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(snapshot.assetsSucceeded).toBe(3);
    expect(snapshot.price.invalidSymbols).toEqual(["P"]);
    expect(snapshot.price.symbolsInvalid).toBe(1);

    const pRow = snapshot.rows.find((r) => r.asset.symbol === "P")!;
    expect(pRow.robinhoodReferencePriceUsd).toBeNull();
    // P's liquidity data is untouched despite the bad multiplier.
    expect(pRow.displayedLiquidityUsd).toBe(200);
  });
});

describe("buildMarketLiquiditySnapshot — hardening: bulk missing-symbol observability", () => {
  it("reports zero missing symbols when every canonical symbol is present in the bulk response", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: routedDexScreenerFetchImpl({}) },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(snapshot.price.symbolsMissing).toBe(0);
    expect(snapshot.price.missingSymbols).toEqual([]);
  });

  it("reports exactly one missing symbol by canonical registry name", async () => {
    const missingCienFixture = {
      quotes: [priceQuote("CRM", "209.17", "220"), priceQuote("P", "104.88", "111.83")],
    };
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: routedDexScreenerFetchImpl({}) },
      robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImpl(missingCienFixture) },
    });

    expect(snapshot.price.symbolsMissing).toBe(1);
    expect(snapshot.price.missingSymbols).toEqual(["CIEN"]);
  });

  it("reports multiple missing symbols, deterministically sorted, regardless of registry order", async () => {
    const onlyPFixture = { quotes: [priceQuote("P", "104.88", "111.83")] };
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: routedDexScreenerFetchImpl({}) },
      robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImpl(onlyPFixture) },
    });

    // Registry order is CRM, P, CIEN — missing set is {CRM, CIEN}, and
    // must come back sorted ascending (CIEN, CRM), not registry order.
    expect(snapshot.price.symbolsMissing).toBe(2);
    expect(snapshot.price.missingSymbols).toEqual(["CIEN", "CRM"]);
  });

  it("never converts a missing symbol's price into a fabricated zero, and never touches its liquidity data", async () => {
    const missingCienFixture = {
      quotes: [priceQuote("CRM", "209.17", "220"), priceQuote("P", "104.88", "111.83")],
    };
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: {
        baseUrl: DEXSCREENER_BASE_URL,
        fetchImpl: routedDexScreenerFetchImpl({
          [CIEN]: { status: 200, body: [pairFor(CIEN, 300, "0x00000000000000000000000000000000000000cc")] },
        }),
      },
      robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImpl(missingCienFixture) },
    });

    // Liquidity snapshot never fails because of a missing price symbol.
    expect(snapshot.assetsSucceeded).toBe(3);
    expect(snapshot.assetsFailed).toBe(0);

    const cienRow = snapshot.rows.find((r) => r.asset.symbol === "CIEN")!;
    expect(cienRow.robinhoodReferencePriceUsd).toBeNull();
    expect(cienRow.robinhoodReferencePriceUsd).not.toBe(0);
    expect(cienRow.displayedLiquidityUsd).toBe(300);
    expect(cienRow.poolCount).toBe(1);
  });
});

describe("buildMarketLiquiditySnapshot — hardening: price freshness metadata", () => {
  it("reports oldest/newest quote generatedAt as identical when every quote in the bulk response shares one timestamp", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: routedDexScreenerFetchImpl({}) },
      robinhoodPrice: defaultPriceOptions(),
    });

    expect(snapshot.price.oldestQuoteGeneratedAt).toBe("2026-08-22T19:15:25.104646145Z");
    expect(snapshot.price.newestQuoteGeneratedAt).toBe("2026-08-22T19:15:25.104646145Z");
  });

  it("reports genuinely distinct oldest/newest timestamps when bulk quotes vary", async () => {
    const variedTimestampFixture = {
      quotes: [
        priceQuote("CRM", "209.17", "220"), // default generatedAt (middle)
        { ...priceQuote("P", "104.88", "111.83"), generatedAt: "2026-08-22T19:10:00.000000000Z" }, // oldest
        { ...priceQuote("CIEN", "395.79", "402"), generatedAt: "2026-08-22T19:20:00.000000000Z" }, // newest
      ],
    };
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: routedDexScreenerFetchImpl({}) },
      robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImpl(variedTimestampFixture) },
    });

    expect(snapshot.price.oldestQuoteGeneratedAt).toBe("2026-08-22T19:10:00.000000000Z");
    expect(snapshot.price.newestQuoteGeneratedAt).toBe("2026-08-22T19:20:00.000000000Z");
  });

  it("reports null oldest/newest timestamps when the bulk price fetch is unavailable", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: routedDexScreenerFetchImpl({}) },
      robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImpl(undefined, 500) },
    });

    expect(snapshot.price.oldestQuoteGeneratedAt).toBeNull();
    expect(snapshot.price.newestQuoteGeneratedAt).toBeNull();
  });
});
