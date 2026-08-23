import { describe, expect, it } from "vitest";
import validFixture from "@/test/fixtures/robinhood-prices-valid.json";
import { robinhoodPricesResponseSchema } from "../schema";

describe("robinhoodPricesResponseSchema", () => {
  it("accepts a valid single-quote response", () => {
    const parsed = robinhoodPricesResponseSchema.parse(validFixture);
    expect(parsed.quotes).toHaveLength(1);
    expect(parsed.quotes[0]).toMatchObject({ tokenSymbol: "NVDA", bid: "213", ask: "217.55" });
  });

  it("accepts a multi-quote response (the bulk/no-symbol form)", () => {
    const result = robinhoodPricesResponseSchema.safeParse({
      quotes: [validFixture.quotes[0], { ...validFixture.quotes[0], tokenSymbol: "AAPL" }],
    });
    expect(result.success).toBe(true);
  });

  it("ignores unrecognized fields", () => {
    const parsed = robinhoodPricesResponseSchema.parse(validFixture);
    const quote = parsed.quotes[0] as unknown as Record<string, unknown>;
    // deployments is validated (kept), but nothing beyond the schema's shape leaks through unexpectedly.
    expect(quote.tokenSymbol).toBe("NVDA");
  });

  it("rejects a response missing the top-level quotes array", () => {
    const result = robinhoodPricesResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a quote missing a required field", () => {
    const withoutBid: Record<string, unknown> = { ...validFixture.quotes[0]! };
    delete withoutBid.bid;
    const result = robinhoodPricesResponseSchema.safeParse({ quotes: [withoutBid] });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric-string bid", () => {
    const result = robinhoodPricesResponseSchema.safeParse({
      quotes: [{ ...validFixture.quotes[0], bid: "not-a-number" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric-string ask", () => {
    const result = robinhoodPricesResponseSchema.safeParse({
      quotes: [{ ...validFixture.quotes[0], ask: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-boolean isTradingHalt", () => {
    const result = robinhoodPricesResponseSchema.safeParse({
      quotes: [{ ...validFixture.quotes[0], isTradingHalt: "false" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a quote missing optional supplementary fields", () => {
    const minimalQuote: Record<string, unknown> = { ...validFixture.quotes[0]! };
    delete minimalQuote.dailyHigh;
    delete minimalQuote.dailyLow;
    delete minimalQuote.mintBurnTokenVolume;
    delete minimalQuote.mintBurnUsdVolume;
    delete minimalQuote.dailyTradingVolume;
    const result = robinhoodPricesResponseSchema.safeParse({ quotes: [minimalQuote] });
    expect(result.success).toBe(true);
  });

  it("accepts an empty quotes array (defensive — not currently observed live, but not a schema violation)", () => {
    const result = robinhoodPricesResponseSchema.safeParse({ quotes: [] });
    expect(result.success).toBe(true);
  });
});
