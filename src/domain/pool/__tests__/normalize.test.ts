import { describe, expect, it } from "vitest";
import type { DexScreenerPair } from "@/providers/dexscreener/schema";
import { DuplicatePoolConflictError } from "../errors";
import { dedupePools, normalizePool, normalizePools } from "../normalize";
import type { CanonicalAssetIdentity } from "../normalize";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const CHAIN_ID = "robinhood";

const canonicalAsset: CanonicalAssetIdentity = { contractAddress: NVDA, symbol: "NVDA" };

function pair(overrides: Partial<DexScreenerPair> = {}): DexScreenerPair {
  return {
    chainId: CHAIN_ID,
    dexId: "uniswap",
    url: "https://dexscreener.com/robinhood/0xpair",
    pairAddress: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3",
    labels: ["v3"],
    baseToken: { address: NVDA, name: "NVIDIA • Robinhood Token", symbol: "NVDA" },
    quoteToken: { address: USDG, name: "Global Dollar", symbol: "USDG" },
    priceNative: "215.1838",
    priceUsd: "215.18",
    txns: {
      m5: { buys: 26, sells: 19 },
      h1: { buys: 340, sells: 353 },
      h6: { buys: 1391, sells: 1043 },
      h24: { buys: 10166, sells: 9316 },
    },
    volume: { m5: 13319.76, h1: 366849.22, h6: 1210948.77, h24: 13386716.29 },
    priceChange: { h1: -0.3, h6: -0.11, h24: -1.13 },
    liquidity: { usd: 2762395.14, base: 4390.08415, quote: 1817719 },
    fdv: 5824092,
    marketCap: 4740142,
    pairCreatedAt: 1784631726000,
    ...overrides,
  };
}

describe("normalizePool", () => {
  it("accepts a pool where the canonical asset is the base token", () => {
    const result = normalizePool(pair(), canonicalAsset, CHAIN_ID);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.pool.canonicalAssetSide).toBe("base");
      expect(result.pool.canonicalAssetAddress).toBe(NVDA);
      expect(result.pool.canonicalAssetSymbol).toBe("NVDA");
    }
  });

  it("accepts a pool where the canonical asset is the quote token", () => {
    const result = normalizePool(
      pair({
        baseToken: { address: WETH, name: "WETH", symbol: "WETH" },
        quoteToken: { address: NVDA, name: "NVIDIA • Robinhood Token", symbol: "NVDA" },
      }),
      canonicalAsset,
      CHAIN_ID,
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.pool.canonicalAssetSide).toBe("quote");
    }
  });

  it("matches the canonical address case-insensitively", () => {
    const result = normalizePool(
      pair({ baseToken: { address: NVDA.toLowerCase(), name: "NVDA", symbol: "NVDA" } }),
      canonicalAsset,
      CHAIN_ID,
    );
    expect(result.accepted).toBe(true);
  });

  it("rejects a pool that does not contain the canonical asset", () => {
    const result = normalizePool(
      pair({
        baseToken: { address: WETH, name: "WETH", symbol: "WETH" },
        quoteToken: { address: USDG, name: "USDG", symbol: "USDG" },
      }),
      canonicalAsset,
      CHAIN_ID,
    );
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection.reason).toBe("DOES_NOT_CONTAIN_CANONICAL_ASSET");
  });

  it("rejects a pool where both sides match the canonical asset (invariant violation)", () => {
    const result = normalizePool(
      pair({
        baseToken: { address: NVDA, name: "NVDA", symbol: "NVDA" },
        quoteToken: { address: NVDA, name: "NVDA", symbol: "NVDA" },
      }),
      canonicalAsset,
      CHAIN_ID,
    );
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection.reason).toBe("BOTH_SIDES_MATCH_CANONICAL_ASSET");
  });

  it("rejects a pool reporting the wrong chain", () => {
    const result = normalizePool(pair({ chainId: "ethereum" }), canonicalAsset, CHAIN_ID);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection.reason).toBe("WRONG_CHAIN");
  });

  it("rejects a malformed pairAddress independent of Zod validation", () => {
    const result = normalizePool(pair({ pairAddress: "0xDEADBEEF" }), canonicalAsset, CHAIN_ID);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection.reason).toBe("INVALID_PAIR_ADDRESS");
  });

  it("accepts a 32-byte Uniswap v4 PoolId as pairAddress", () => {
    const result = normalizePool(
      pair({ pairAddress: "0x401bc4b106c6deac5c66c251743efce2776a7eb0ce49d122d870308a4d209e43" }),
      canonicalAsset,
      CHAIN_ID,
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.pool.pairAddress).toBe(
        "0x401bc4b106c6deac5c66c251743efce2776a7eb0ce49d122d870308a4d209e43",
      );
    }
  });

  it("rejects a malformed baseToken address", () => {
    const result = normalizePool(
      pair({ baseToken: { address: "not-an-address", name: "NVDA", symbol: "NVDA" } }),
      canonicalAsset,
      CHAIN_ID,
    );
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection.reason).toBe("INVALID_BASE_TOKEN_ADDRESS");
  });

  it("rejects a malformed quoteToken address", () => {
    const result = normalizePool(
      pair({ quoteToken: { address: "not-an-address", name: "USDG", symbol: "USDG" } }),
      canonicalAsset,
      CHAIN_ID,
    );
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection.reason).toBe("INVALID_QUOTE_TOKEN_ADDRESS");
  });

  it("rejects a pool with a missing (null) quoteToken", () => {
    const result = normalizePool(pair({ quoteToken: null }), canonicalAsset, CHAIN_ID);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection.reason).toBe("MISSING_QUOTE_TOKEN");
  });

  it("preserves null for missing optional numeric fields", () => {
    const result = normalizePool(
      pair({ liquidity: null, fdv: null, marketCap: null, pairCreatedAt: null, priceChange: {}, volume: {}, txns: {} }),
      canonicalAsset,
      CHAIN_ID,
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.pool.liquidityUsd).toBeNull();
      expect(result.pool.fdv).toBeNull();
      expect(result.pool.marketCap).toBeNull();
      expect(result.pool.pairCreatedAt).toBeNull();
      expect(result.pool.priceChange5m).toBeNull();
      expect(result.pool.volume5m).toBeNull();
      expect(result.pool.buys5m).toBeNull();
      expect(result.pool.sells5m).toBeNull();
    }
  });

  it("preserves zero for genuinely-zero numeric fields (does not conflate with missing)", () => {
    const result = normalizePool(
      pair({
        volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
        txns: { m5: { buys: 0, sells: 0 } },
        priceChange: { m5: 0 },
      }),
      canonicalAsset,
      CHAIN_ID,
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.pool.volume5m).toBe(0);
      expect(result.pool.buys5m).toBe(0);
      expect(result.pool.sells5m).toBe(0);
      expect(result.pool.priceChange5m).toBe(0);
    }
  });

  it("defaults labels to an empty array when null", () => {
    const result = normalizePool(pair({ labels: null }), canonicalAsset, CHAIN_ID);
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.pool.labels).toEqual([]);
  });

  it("parses numeric-string price fields into numbers", () => {
    const result = normalizePool(pair({ priceUsd: "215.18", priceNative: "215.1838" }), canonicalAsset, CHAIN_ID);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.pool.priceUsd).toBe(215.18);
      expect(result.pool.priceNative).toBe(215.1838);
    }
  });
});

describe("normalizePools / dedupePools", () => {
  it("collapses materially identical duplicate records into one pool", () => {
    const result = normalizePools([pair(), pair()], canonicalAsset, CHAIN_ID);
    expect(result.pools).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("throws DuplicatePoolConflictError for duplicate records that disagree", () => {
    expect(() =>
      normalizePools(
        [pair({ liquidity: { usd: 100, base: 1, quote: 1 } }), pair({ liquidity: { usd: 999, base: 1, quote: 1 } })],
        canonicalAsset,
        CHAIN_ID,
      ),
    ).toThrow(DuplicatePoolConflictError);
  });

  it("collects rejected pools separately from accepted ones", () => {
    const result = normalizePools(
      [pair(), pair({ baseToken: { address: WETH, name: "WETH", symbol: "WETH" }, quoteToken: { address: USDG, name: "USDG", symbol: "USDG" } })],
      canonicalAsset,
      CHAIN_ID,
    );
    expect(result.pools).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("DOES_NOT_CONTAIN_CANONICAL_ASSET");
  });

  it("returns an empty pool list for an empty input array (legitimate zero pools)", () => {
    const result = normalizePools([], canonicalAsset, CHAIN_ID);
    expect(result.pools).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe("dedupePools", () => {
  it("keys deduplication on chainId + pairAddress (case-insensitive)", () => {
    const a = normalizePool(pair(), canonicalAsset, CHAIN_ID);
    if (!a.accepted) throw new Error("expected accepted");
    const b = { ...a.pool, pairAddress: a.pool.pairAddress.toLowerCase() as typeof a.pool.pairAddress };
    expect(dedupePools([a.pool, b])).toHaveLength(1);
  });
});
