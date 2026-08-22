import { describe, expect, it, vi } from "vitest";
import { buildMarketLiquiditySnapshot } from "../snapshot";

const ROBINHOOD_BASE_URL = "https://robinhood.example.test";
const DEXSCREENER_BASE_URL = "https://dexscreener.example.test";

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
    });

    expect(robinhoodFetch).toHaveBeenCalledTimes(1);
  });

  it("reports refreshStartedAt, generatedAt, and a non-negative refreshDurationMs", async () => {
    const snapshot = await buildMarketLiquiditySnapshot({
      concurrency: 3,
      requestIntervalMs: 0,
      robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: routedDexScreenerFetchImpl({}) },
    });

    expect(new Date(snapshot.refreshStartedAt).getTime()).not.toBeNaN();
    expect(new Date(snapshot.generatedAt).getTime()).not.toBeNaN();
    expect(snapshot.refreshDurationMs).toBeGreaterThanOrEqual(0);
    expect(new Date(snapshot.generatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(snapshot.refreshStartedAt).getTime(),
    );
  });
});
