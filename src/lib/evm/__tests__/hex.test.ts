import { describe, expect, it } from "vitest";
import { hexQuantityToBigInt, isHexBytes, isHexQuantity } from "../hex";

describe("isHexBytes", () => {
  it("accepts '0x' as valid zero-length bytes", () => {
    expect(isHexBytes("0x")).toBe(true);
  });

  it("accepts a single valid byte", () => {
    expect(isHexBytes("0x00")).toBe(true);
    expect(isHexBytes("0xff")).toBe(true);
  });

  it("accepts multi-byte values, upper and lower case", () => {
    expect(isHexBytes("0xabcd1234")).toBe(true);
    expect(isHexBytes("0xABCD1234")).toBe(true);
  });

  it("rejects an odd number of hex digits (not byte-aligned)", () => {
    expect(isHexBytes("0x0")).toBe(false);
    expect(isHexBytes("0xabc")).toBe(false);
    expect(isHexBytes("0x123")).toBe(false);
  });

  it("rejects a missing 0x prefix", () => {
    expect(isHexBytes("ff")).toBe(false);
    expect(isHexBytes("")).toBe(false);
  });

  it("rejects an uppercase 0X prefix", () => {
    expect(isHexBytes("0Xff")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isHexBytes("0xzz")).toBe(false);
    expect(isHexBytes("0x12g4")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isHexBytes(null)).toBe(false);
    expect(isHexBytes(undefined)).toBe(false);
    expect(isHexBytes(123)).toBe(false);
    expect(isHexBytes(true)).toBe(false);
    expect(isHexBytes({})).toBe(false);
    expect(isHexBytes(["0x00"])).toBe(false);
  });
});

describe("isHexQuantity", () => {
  it("accepts a minimal quantity", () => {
    expect(isHexQuantity("0x0")).toBe(true);
  });

  it("accepts an odd number of hex digits (quantities need not be byte-aligned)", () => {
    expect(isHexQuantity("0x123")).toBe(true);
  });

  it("accepts an even number of hex digits too", () => {
    expect(isHexQuantity("0x1237")).toBe(true);
  });

  it("accepts upper and lower case hex digits", () => {
    expect(isHexQuantity("0xABCDEF")).toBe(true);
    expect(isHexQuantity("0xabcdef")).toBe(true);
  });

  it("rejects '0x' with no digits at all", () => {
    expect(isHexQuantity("0x")).toBe(false);
  });

  it("rejects a missing 0x prefix", () => {
    expect(isHexQuantity("1237")).toBe(false);
    expect(isHexQuantity("")).toBe(false);
  });

  it("rejects an uppercase 0X prefix", () => {
    expect(isHexQuantity("0X1237")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isHexQuantity("0x123g")).toBe(false);
  });

  it("rejects decimal-looking strings without 0x", () => {
    expect(isHexQuantity("4663")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isHexQuantity(null)).toBe(false);
    expect(isHexQuantity(undefined)).toBe(false);
    expect(isHexQuantity(4663)).toBe(false);
    expect(isHexQuantity({})).toBe(false);
  });
});

describe("hexQuantityToBigInt", () => {
  it("parses the Robinhood Chain ID quantity correctly", () => {
    expect(hexQuantityToBigInt("0x1237")).toBe(4663n);
  });

  it("parses zero", () => {
    expect(hexQuantityToBigInt("0x0")).toBe(0n);
  });

  it("parses a very large quantity without precision loss (beyond Number.MAX_SAFE_INTEGER)", () => {
    // 2^64 - 1, far beyond Number.MAX_SAFE_INTEGER (2^53 - 1).
    const result = hexQuantityToBigInt("0xffffffffffffffff");
    expect(result).toBe(18446744073709551615n);
    expect(result.toString()).toBe("18446744073709551615");
    // A naive Number() conversion loses precision here — this is exactly
    // why chain quantities are parsed to bigint, never a JS number.
    expect(Number(result).toString()).not.toBe(result.toString());
  });

  it("throws a plain Error for a non-quantity string", () => {
    expect(() => hexQuantityToBigInt("not-hex")).toThrow();
    expect(() => hexQuantityToBigInt("0x")).toThrow();
    expect(() => hexQuantityToBigInt("1237")).toThrow();
  });
});
