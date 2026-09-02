import { describe, expect, it } from "vitest";
import { parseCompareRequestShape, resolveAmountIn } from "../request";
import { NATIVE_ETH } from "../types";
import { WETH } from "./fixtures";

describe("parseCompareRequestShape", () => {
  it("accepts an empty/omitted body — all fields optional", () => {
    expect(parseCompareRequestShape(undefined)).toEqual({ ok: true, value: {} });
    expect(parseCompareRequestShape(null)).toEqual({ ok: true, value: {} });
    expect(parseCompareRequestShape({})).toEqual({ ok: true, value: {} });
  });

  it("rejects a non-object body", () => {
    expect(parseCompareRequestShape("nope")).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
    expect(parseCompareRequestShape(42)).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
    expect(parseCompareRequestShape([])).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
  });

  it("accepts a valid tokenOut address", () => {
    const result = parseCompareRequestShape({ tokenOut: WETH });
    expect(result).toEqual({ ok: true, value: { tokenOut: WETH } });
  });

  it("accepts the NATIVE_ETH sentinel for tokenOut", () => {
    const result = parseCompareRequestShape({ tokenOut: NATIVE_ETH });
    expect(result).toEqual({ ok: true, value: { tokenOut: NATIVE_ETH } });
  });

  it("rejects a malformed tokenOut address", () => {
    expect(parseCompareRequestShape({ tokenOut: "not-an-address" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_TOKEN_OUT" },
    });
  });

  it("rejects a non-string tokenOut", () => {
    expect(parseCompareRequestShape({ tokenOut: 123 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_TOKEN_OUT" },
    });
  });

  it("passes a string amountIn through unparsed (numeric validation happens later, after tokenDecimals is known)", () => {
    const result = parseCompareRequestShape({ amountIn: "1.5" });
    expect(result).toEqual({ ok: true, value: { amountInRaw: "1.5" } });
  });

  it("rejects a non-string amountIn", () => {
    expect(parseCompareRequestShape({ amountIn: 1.5 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_AMOUNT_IN" },
    });
  });

  it("accepts a well-formed hookData map keyed by valid pool addresses with hex values", () => {
    const poolAddr = "0x1111111111111111111111111111111111111111";
    const result = parseCompareRequestShape({ hookData: { [poolAddr]: "0xabcd" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.hookData?.get(poolAddr.toLowerCase())).toBe("0xabcd");
  });

  it("rejects hookData with an invalid pool address key", () => {
    expect(parseCompareRequestShape({ hookData: { "not-an-address": "0xabcd" } })).toMatchObject({
      ok: false,
      error: { code: "INVALID_HOOK_DATA" },
    });
  });

  it("rejects hookData with a non-hex value", () => {
    const poolAddr = "0x1111111111111111111111111111111111111111";
    expect(parseCompareRequestShape({ hookData: { [poolAddr]: "not-hex" } })).toMatchObject({
      ok: false,
      error: { code: "INVALID_HOOK_DATA" },
    });
  });

  it("rejects hookData that is an array instead of an object", () => {
    expect(parseCompareRequestShape({ hookData: [] })).toMatchObject({
      ok: false,
      error: { code: "INVALID_HOOK_DATA" },
    });
  });
});

describe("resolveAmountIn", () => {
  it("omitted amountIn -> ok, undefined value (caller applies server default)", () => {
    expect(resolveAmountIn(undefined, 18)).toEqual({ ok: true, value: undefined });
  });

  it("a valid positive decimal string parses to the exact bigint", () => {
    expect(resolveAmountIn("1", 18)).toEqual({ ok: true, value: 1_000_000_000_000_000_000n });
    expect(resolveAmountIn("1.5", 18)).toEqual({ ok: true, value: 1_500_000_000_000_000_000n });
  });

  it("rejects zero", () => {
    expect(resolveAmountIn("0", 18)).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT_IN" } });
  });

  it("rejects a negative amount", () => {
    expect(resolveAmountIn("-1", 18)).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT_IN" } });
  });

  it("rejects malformed input (scientific notation)", () => {
    expect(resolveAmountIn("1e18", 18)).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT_IN" } });
  });

  it("rejects excess precision beyond the token's own decimals", () => {
    expect(resolveAmountIn("1.1234567", 6)).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT_IN" } });
  });
});
