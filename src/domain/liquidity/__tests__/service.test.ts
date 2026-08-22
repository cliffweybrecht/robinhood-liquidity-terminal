import { describe, expect, it, vi } from "vitest";
import robinhoodValidFixture from "@/test/fixtures/robinhood-assets-valid.json";
import dexScreenerValidFixture from "@/test/fixtures/dexscreener-nvda-valid.json";
import dexScreenerEmptyFixture from "@/test/fixtures/dexscreener-empty.json";
import { AssetNotFoundError, InvalidAddressInputError } from "@/domain/asset";
import { DuplicatePoolConflictError } from "@/domain/pool";
import { DexScreenerHttpError } from "@/providers/dexscreener/errors";
import { getAssetLiquidityProfileByAddress, getAssetLiquidityProfileBySymbol } from "../service";

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

function optionsFor(dexBody: unknown) {
  return {
    robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
    dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexScreenerFetchImplFor(dexBody) },
  };
}

describe("getAssetLiquidityProfileBySymbol", () => {
  it("resolves the symbol through Phase 1, discovers pools, and returns an aggregated profile", async () => {
    const dexFixture = dexScreenerValidFixture.map((p) => ({
      ...p,
      baseToken: { ...p.baseToken, address: CRM_ADDRESS },
    }));

    const profile = await getAssetLiquidityProfileBySymbol("crm", optionsFor(dexFixture));

    expect(profile.asset.symbol).toBe("CRM");
    expect(profile.poolCount).toBe(dexFixture.length);
    expect(profile.pools).toHaveLength(dexFixture.length);
    expect(profile.displayedLiquidityUsd).not.toBeNull();
  });

  it("returns a valid zero-pool profile for a symbol with no Dexscreener pools", async () => {
    const profile = await getAssetLiquidityProfileBySymbol("crm", optionsFor(dexScreenerEmptyFixture));

    expect(profile.poolCount).toBe(0);
    expect(profile.displayedLiquidityUsd).toBeNull();
    expect(profile.pools).toEqual([]);
  });

  it("propagates AssetNotFoundError for an unknown symbol without calling Dexscreener", async () => {
    const dexFetch = vi.fn();

    await expect(
      getAssetLiquidityProfileBySymbol("NOPE", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(AssetNotFoundError);
    expect(dexFetch).not.toHaveBeenCalled();
  });

  it("propagates Dexscreener provider failures", async () => {
    await expect(
      getAssetLiquidityProfileBySymbol("crm", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: {
          baseUrl: DEXSCREENER_BASE_URL,
          fetchImpl: async () => new Response("error", { status: 503, statusText: "Service Unavailable" }),
        },
      }),
    ).rejects.toThrow(DexScreenerHttpError);
  });

  it("propagates a duplicate conflicting pool record as an error, not a silently-picked profile", async () => {
    const base = dexScreenerValidFixture[0]!;
    const conflicting = [
      { ...base, baseToken: { ...base.baseToken, address: CRM_ADDRESS }, liquidity: { usd: 100, base: 1, quote: 1 } },
      { ...base, baseToken: { ...base.baseToken, address: CRM_ADDRESS }, liquidity: { usd: 999, base: 1, quote: 1 } },
    ];

    await expect(
      getAssetLiquidityProfileBySymbol("crm", optionsFor(conflicting)),
    ).rejects.toThrow(DuplicatePoolConflictError);
  });
});

describe("getAssetLiquidityProfileByAddress", () => {
  it("resolves a canonical address through Phase 1 before aggregating", async () => {
    const dexFixture = dexScreenerValidFixture.map((p) => ({
      ...p,
      baseToken: { ...p.baseToken, address: CRM_ADDRESS },
    }));

    const profile = await getAssetLiquidityProfileByAddress(CRM_ADDRESS.toLowerCase(), optionsFor(dexFixture));

    expect(profile.asset.symbol).toBe("CRM");
  });

  it("rejects malformed address input via Phase 1 without calling Dexscreener", async () => {
    const dexFetch = vi.fn();

    await expect(
      getAssetLiquidityProfileByAddress("not-an-address", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(InvalidAddressInputError);
    expect(dexFetch).not.toHaveBeenCalled();
  });

  it("rejects a well-formed but non-canonical address without calling Dexscreener", async () => {
    const dexFetch = vi.fn();

    await expect(
      getAssetLiquidityProfileByAddress("0x00000000000000000000000000000000000000ad", {
        robinhood: { baseUrl: ROBINHOOD_BASE_URL, fetchImpl: robinhoodFetchImpl() },
        dexScreener: { baseUrl: DEXSCREENER_BASE_URL, fetchImpl: dexFetch as unknown as typeof fetch },
      }),
    ).rejects.toThrow(AssetNotFoundError);
    expect(dexFetch).not.toHaveBeenCalled();
  });
});
