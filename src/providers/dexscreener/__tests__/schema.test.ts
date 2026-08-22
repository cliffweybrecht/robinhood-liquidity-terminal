import { describe, expect, it } from "vitest";
import validFixture from "@/test/fixtures/dexscreener-nvda-valid.json";
import emptyFixture from "@/test/fixtures/dexscreener-empty.json";
import { dexScreenerPairsResponseSchema } from "../schema";

describe("dexScreenerPairsResponseSchema", () => {
  it("accepts a valid multi-pool response (bare array, not wrapped in an object)", () => {
    const parsed = dexScreenerPairsResponseSchema.parse(validFixture);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ dexId: "uniswap", chainId: "robinhood" });
  });

  it("accepts a valid empty array (legitimate zero-pool result)", () => {
    const parsed = dexScreenerPairsResponseSchema.parse(emptyFixture);
    expect(parsed).toEqual([]);
  });

  it("accepts a 20-byte pairAddress (standard AMM pair contract)", () => {
    const result = dexScreenerPairsResponseSchema.safeParse([
      { ...validFixture[0]!, pairAddress: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3" },
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts a 32-byte pairAddress (Uniswap v4 PoolId)", () => {
    const result = dexScreenerPairsResponseSchema.safeParse([
      {
        ...validFixture[0]!,
        pairAddress: "0x401bc4b106c6deac5c66c251743efce2776a7eb0ce49d122d870308a4d209e43",
      },
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects a pairAddress that is neither 20 nor 32 bytes", () => {
    const result = dexScreenerPairsResponseSchema.safeParse([
      { ...validFixture[0]!, pairAddress: "0xDEADBEEF" },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects a malformed baseToken.address", () => {
    const result = dexScreenerPairsResponseSchema.safeParse([
      { ...validFixture[0]!, baseToken: { ...validFixture[0]!.baseToken, address: "not-an-address" } },
    ]);
    expect(result.success).toBe(false);
  });

  it("accepts a null quoteToken (documented as nullable)", () => {
    const result = dexScreenerPairsResponseSchema.safeParse([
      { ...validFixture[0]!, quoteToken: null },
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts a null liquidity object", () => {
    const result = dexScreenerPairsResponseSchema.safeParse([
      { ...validFixture[0]!, liquidity: null },
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts priceChange with only some timeframe keys present", () => {
    const result = dexScreenerPairsResponseSchema.safeParse([
      { ...validFixture[0]!, priceChange: { h24: -1.13 } },
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects a response that is not an array", () => {
    const result = dexScreenerPairsResponseSchema.safeParse({ pairs: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a pair missing a required field", () => {
    const withoutBaseToken: Record<string, unknown> = { ...validFixture[0]! };
    delete withoutBaseToken.baseToken;
    const result = dexScreenerPairsResponseSchema.safeParse([withoutBaseToken]);
    expect(result.success).toBe(false);
  });

  it("rejects priceUsd/priceNative that are not numeric strings", () => {
    const result = dexScreenerPairsResponseSchema.safeParse([
      { ...validFixture[0]!, priceUsd: "not-a-number" },
    ]);
    expect(result.success).toBe(false);
  });
});
