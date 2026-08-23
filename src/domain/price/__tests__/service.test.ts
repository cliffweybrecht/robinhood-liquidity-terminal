import { describe, expect, it, vi } from "vitest";
import robinhoodValidFixture from "@/test/fixtures/robinhood-assets-valid.json";
import dexScreenerValidFixture from "@/test/fixtures/dexscreener-nvda-valid.json";
import { AssetNotFoundError, InvalidAddressInputError } from "@/domain/asset";
import { DexScreenerHttpError } from "@/providers/dexscreener/errors";
import { RobinhoodPriceHttpError } from "@/providers/robinhood-price";
import { RobinhoodReferencePriceNotFoundError } from "../errors";
import {
  getAssetPriceComparisonByAddress,
  getAssetPriceComparisonBySymbol,
} from "../service";

const ROBINHOOD_BASE_URL = "https://robinhood.example.test";
const DEXSCREENER_BASE_URL = "https://dexscreener.example.test";
const ROBINHOOD_PRICE_BASE_URL = "https://robinhood-price.example.test";

// The CRM fixture asset's canonical address/symbol, matched against the
// Dexscreener + price fixtures below via overrides.
const CRM_ADDRESS = "0xd95B44124e475743a7589e68F3D74008A5536D44";

function robinhoodFetchImpl(): typeof fetch {
  return async () => new Response(JSON.stringify(robinhoodValidFixture), { status: 200 });
}

function dexScreenerFetchImplFor(body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status: 200 });
}

function robinhoodPriceFetchImplFor(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

const crmPriceFixture = {
  quotes: [
    {
      tokenSymbol: "CRM",
      bid: "209.17",
      ask: "220",
      currency: "USD",
      isTradingHalt: false,
      generatedAt: "2026-08-22T19:21:00.925591366Z",
    },
  ],
};

function optionsFor(dexBody: unknown, priceBody: unknown) {
  return {
    robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
    dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexScreenerFetchImplFor(dexBody) },
    robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImplFor(priceBody) },
  };
}

function crmDexFixture() {
  return dexScreenerValidFixture.map((p) => ({ ...p, baseToken: { ...p.baseToken, address: CRM_ADDRESS } }));
}

describe("getAssetPriceComparisonBySymbol", () => {
  it("resolves the symbol through Phase 1, discovers pools, fetches the reference price, and builds a full comparison", async () => {
    const comparison = await getAssetPriceComparisonBySymbol(
      "crm",
      optionsFor(crmDexFixture(), crmPriceFixture),
    );

    expect(comparison.asset.symbol).toBe("CRM");
    expect(comparison.robinhood.referencePriceUsd).toBeCloseTo((209.17 + 220) / 2);
    expect(comparison.dex.totalPoolCount).toBe(crmDexFixture().length);
  });

  it("propagates AssetNotFoundError for an unknown symbol without calling Dexscreener or the price endpoint", async () => {
    const dexFetch = vi.fn();
    const priceFetch = vi.fn();

    await expect(
      getAssetPriceComparisonBySymbol("NOPE", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
        robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: priceFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(AssetNotFoundError);
    expect(dexFetch).not.toHaveBeenCalled();
    expect(priceFetch).not.toHaveBeenCalled();
  });

  it("propagates AmbiguousSymbolError inherited from Phase 1 without calling downstream providers", async () => {
    const ambiguousFixture = {
      assets: [
        {
          id: "0x1",
          tokenSymbol: "aapl",
          tokenName: "Asset A",
          deployments: [{ contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44", chainId: 4663 }],
          currentMultiplier: "1",
          status: "ASSET_STATUS_ACTIVE",
        },
        {
          id: "0x2",
          tokenSymbol: "AAPL",
          tokenName: "Asset B",
          deployments: [{ contractAddress: "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D", chainId: 4663 }],
          currentMultiplier: "1",
          status: "ASSET_STATUS_ACTIVE",
        },
      ],
    };
    const dexFetch = vi.fn();
    const priceFetch = vi.fn();

    await expect(
      getAssetPriceComparisonBySymbol("AAPL", {
        robinhood: {
          baseUrl: ROBINHOOD_BASE_URL,
          fetchImpl: async () => new Response(JSON.stringify(ambiguousFixture), { status: 200 }),
        },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
        robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: priceFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(/ambiguous/i);
    expect(dexFetch).not.toHaveBeenCalled();
    expect(priceFetch).not.toHaveBeenCalled();
  });

  it("propagates Dexscreener provider failures", async () => {
    await expect(
      getAssetPriceComparisonBySymbol("crm", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: {
          baseUrl: DEXSCREENER_BASE_URL,
          fetchImpl: async () => new Response("error", { status: 503, statusText: "Service Unavailable" }),
        },
        robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: robinhoodPriceFetchImplFor(crmPriceFixture) },
      }),
    ).rejects.toThrow(DexScreenerHttpError);
  });

  it("propagates a Robinhood price HTTP failure", async () => {
    await expect(
      getAssetPriceComparisonBySymbol("crm", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexScreenerFetchImplFor(crmDexFixture()) },
        robinhoodPrice: {
          baseUrl: ROBINHOOD_PRICE_BASE_URL,
          fetchImpl: async () => new Response("error", { status: 503, statusText: "Service Unavailable" }),
        },
      }),
    ).rejects.toThrow(RobinhoodPriceHttpError);
  });

  it("throws RobinhoodReferencePriceNotFoundError when the price response doesn't include this symbol", async () => {
    await expect(
      getAssetPriceComparisonBySymbol(
        "crm",
        optionsFor(crmDexFixture(), { quotes: [{ ...crmPriceFixture.quotes[0], tokenSymbol: "SOMETHING_ELSE" }] }),
      ),
    ).rejects.toThrow(RobinhoodReferencePriceNotFoundError);
  });
});

describe("getAssetPriceComparisonByAddress", () => {
  it("resolves a canonical address through Phase 1 before aggregating", async () => {
    const comparison = await getAssetPriceComparisonByAddress(
      CRM_ADDRESS.toLowerCase(),
      optionsFor(crmDexFixture(), crmPriceFixture),
    );
    expect(comparison.asset.symbol).toBe("CRM");
  });

  it("rejects malformed address input via Phase 1 without calling downstream providers", async () => {
    const dexFetch = vi.fn();
    const priceFetch = vi.fn();

    await expect(
      getAssetPriceComparisonByAddress("not-an-address", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
        robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: priceFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(InvalidAddressInputError);
    expect(dexFetch).not.toHaveBeenCalled();
    expect(priceFetch).not.toHaveBeenCalled();
  });

  it("rejects a well-formed but non-canonical address without calling downstream providers", async () => {
    const dexFetch = vi.fn();
    const priceFetch = vi.fn();

    await expect(
      getAssetPriceComparisonByAddress("0x00000000000000000000000000000000000000ad", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
        robinhoodPrice: { baseUrl: ROBINHOOD_PRICE_BASE_URL, fetchImpl: priceFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(AssetNotFoundError);
    expect(dexFetch).not.toHaveBeenCalled();
    expect(priceFetch).not.toHaveBeenCalled();
  });
});
