import { describe, expect, it, vi } from "vitest";
import robinhoodValidFixture from "@/test/fixtures/robinhood-assets-valid.json";
import dexScreenerValidFixture from "@/test/fixtures/dexscreener-nvda-valid.json";
import dexScreenerEmptyFixture from "@/test/fixtures/dexscreener-empty.json";
import {
  AmbiguousSymbolError,
  AssetNotFoundError,
  InvalidAddressInputError,
  ROBINHOOD_CHAIN_ID,
  type CanonicalRobinhoodAsset,
} from "@/domain/asset";
import { DexScreenerHttpError } from "@/providers/dexscreener/errors";
import {
  getDexScreenerPoolsByAddress,
  getDexScreenerPoolsBySymbol,
  getDexScreenerPoolsForAsset,
} from "../service";

const ROBINHOOD_BASE_URL = "https://robinhood.example.test";
const DEXSCREENER_BASE_URL = "https://dexscreener.example.test";

// The CRM fixture asset's canonical address, matched against the
// Dexscreener fixture below via override on baseToken.address so the
// two fixtures line up regardless of which symbol each represents.
const CRM_ADDRESS = "0xd95B44124e475743a7589e68F3D74008A5536D44";

function robinhoodFetchImpl(): typeof fetch {
  return async () => new Response(JSON.stringify(robinhoodValidFixture), { status: 200 });
}

function dexScreenerFetchImplFor(body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status: 200 });
}

function optionsFor(dexBody: unknown, dexTimeoutMs?: number) {
  return {
    robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
    dexScreener: {
      baseUrl: DEXSCREENER_BASE_URL,
      timeoutMs: dexTimeoutMs,
      fetchImpl: dexScreenerFetchImplFor(dexBody),
    },
  };
}

const testAsset: CanonicalRobinhoodAsset = {
  id: "0x1",
  symbol: "CRM",
  name: "Salesforce • Robinhood Token",
  contractAddress: CRM_ADDRESS,
  chainId: ROBINHOOD_CHAIN_ID,
  logoUrl: null,
  currentMultiplier: "1.000000000000000000",
  tokenDecimals: 18,
  status: "ACTIVE",
};

describe("getDexScreenerPoolsForAsset", () => {
  it("fetches and normalizes pools for an already-resolved canonical asset", async () => {
    const asset = testAsset;
    const dexFixture = dexScreenerValidFixture.map((p) => ({
      ...p,
      baseToken: { ...p.baseToken, address: CRM_ADDRESS },
    }));

    const result = await getDexScreenerPoolsForAsset(asset, {
      dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexScreenerFetchImplFor(dexFixture) },
    });

    expect(result.asset).toBe(asset);
    expect(result.pools.length).toBeGreaterThan(0);
    expect(result.pools.every((p) => p.canonicalAssetAddress === CRM_ADDRESS)).toBe(true);
  });
});

describe("getDexScreenerPoolsBySymbol", () => {
  it("resolves the symbol through Phase 1, then discovers pools", async () => {
    const dexFixture = dexScreenerValidFixture.map((p) => ({
      ...p,
      baseToken: { ...p.baseToken, address: CRM_ADDRESS },
    }));

    const result = await getDexScreenerPoolsBySymbol("crm", optionsFor(dexFixture));

    expect(result.asset.symbol).toBe("CRM");
    expect(result.pools.length).toBeGreaterThan(0);
  });

  it("returns an empty pool list for a valid symbol with zero Dexscreener pools", async () => {
    const result = await getDexScreenerPoolsBySymbol("crm", optionsFor(dexScreenerEmptyFixture));

    expect(result.pools).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("propagates AssetNotFoundError for an unknown symbol without calling Dexscreener", async () => {
    const dexFetch = vi.fn();

    await expect(
      getDexScreenerPoolsBySymbol("NOPE", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(AssetNotFoundError);
    expect(dexFetch).not.toHaveBeenCalled();
  });

  it("propagates AmbiguousSymbolError inherited from Phase 1 without calling Dexscreener", async () => {
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

    await expect(
      getDexScreenerPoolsBySymbol("AAPL", {
        robinhood: {
          baseUrl: ROBINHOOD_BASE_URL,
          fetchImpl: async () => new Response(JSON.stringify(ambiguousFixture), { status: 200 }),
        },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(AmbiguousSymbolError);
    expect(dexFetch).not.toHaveBeenCalled();
  });

  it("propagates Dexscreener provider failures", async () => {
    await expect(
      getDexScreenerPoolsBySymbol("crm", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: {
          baseUrl: DEXSCREENER_BASE_URL,
          fetchImpl: async () => new Response("error", { status: 503, statusText: "Service Unavailable" }),
        },
      }),
    ).rejects.toThrow(DexScreenerHttpError);
  });
});

describe("getDexScreenerPoolsByAddress", () => {
  it("resolves a canonical address through Phase 1, then discovers pools", async () => {
    const dexFixture = dexScreenerValidFixture.map((p) => ({
      ...p,
      baseToken: { ...p.baseToken, address: CRM_ADDRESS },
    }));

    const result = await getDexScreenerPoolsByAddress(
      CRM_ADDRESS.toLowerCase(),
      optionsFor(dexFixture),
    );

    expect(result.asset.symbol).toBe("CRM");
  });

  it("rejects malformed address input via Phase 1 without calling Dexscreener", async () => {
    const dexFetch = vi.fn();

    await expect(
      getDexScreenerPoolsByAddress("not-an-address", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(InvalidAddressInputError);
    expect(dexFetch).not.toHaveBeenCalled();
  });

  it("rejects a well-formed but non-canonical address without calling Dexscreener", async () => {
    const dexFetch = vi.fn();

    await expect(
      getDexScreenerPoolsByAddress("0x00000000000000000000000000000000000000ad", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(AssetNotFoundError);
    expect(dexFetch).not.toHaveBeenCalled();
  });
});
