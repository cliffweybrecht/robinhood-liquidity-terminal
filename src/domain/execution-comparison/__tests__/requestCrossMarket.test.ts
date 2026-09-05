import { describe, expect, it } from "vitest";
import { parseCrossMarketRequestShape } from "../requestCrossMarket";
import { NATIVE_ETH } from "../types";
import { USDG, WETH } from "./fixtures";

describe("parseCrossMarketRequestShape — body/shape basics", () => {
  it("accepts an empty/omitted body — all fields optional", () => {
    expect(parseCrossMarketRequestShape(undefined)).toEqual({ ok: true, value: {} });
    expect(parseCrossMarketRequestShape(null)).toEqual({ ok: true, value: {} });
    expect(parseCrossMarketRequestShape({})).toEqual({ ok: true, value: {} });
  });

  it("rejects a non-object body", () => {
    expect(parseCrossMarketRequestShape("nope")).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
    expect(parseCrossMarketRequestShape(42)).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
    expect(parseCrossMarketRequestShape([])).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
  });
});

describe("parseCrossMarketRequestShape — tokenOuts: omitted selects all groups", () => {
  it("omitted tokenOuts -> undefined (downstream: select every eligible group)", () => {
    const result = parseCrossMarketRequestShape({});
    expect(result).toEqual({ ok: true, value: {} });
  });
});

describe("parseCrossMarketRequestShape — tokenOuts: format validation (INVALID_TOKEN_OUTS)", () => {
  it("rejects a non-array tokenOuts", () => {
    expect(parseCrossMarketRequestShape({ tokenOuts: WETH })).toMatchObject({ ok: false, error: { code: "INVALID_TOKEN_OUTS" } });
    expect(parseCrossMarketRequestShape({ tokenOuts: { [WETH]: true } })).toMatchObject({ ok: false, error: { code: "INVALID_TOKEN_OUTS" } });
  });

  it("rejects a non-string entry", () => {
    expect(parseCrossMarketRequestShape({ tokenOuts: [WETH, 42] })).toMatchObject({ ok: false, error: { code: "INVALID_TOKEN_OUTS" } });
  });

  it("rejects an entry that is neither NATIVE_ETH nor a valid address", () => {
    expect(parseCrossMarketRequestShape({ tokenOuts: [WETH, "not-an-address"] })).toMatchObject({ ok: false, error: { code: "INVALID_TOKEN_OUTS" } });
  });

  it("accepts a well-formed array of >= 2 valid entries, including NATIVE_ETH", () => {
    expect(parseCrossMarketRequestShape({ tokenOuts: [WETH, NATIVE_ETH] })).toEqual({ ok: true, value: { tokenOuts: [WETH, NATIVE_ETH] } });
    expect(parseCrossMarketRequestShape({ tokenOuts: [WETH, USDG, NATIVE_ETH] })).toEqual({ ok: true, value: { tokenOuts: [WETH, USDG, NATIVE_ETH] } });
  });
});

describe("parseCrossMarketRequestShape — tokenOuts: selection-shape validation (INVALID_MARKET_SELECTION)", () => {
  it("rejects an empty array", () => {
    expect(parseCrossMarketRequestShape({ tokenOuts: [] })).toMatchObject({ ok: false, error: { code: "INVALID_MARKET_SELECTION" } });
  });

  it("rejects a single-entry array — fewer than 2 groups is not a valid explicit selection", () => {
    expect(parseCrossMarketRequestShape({ tokenOuts: [WETH] })).toMatchObject({ ok: false, error: { code: "INVALID_MARKET_SELECTION" } });
    expect(parseCrossMarketRequestShape({ tokenOuts: [NATIVE_ETH] })).toMatchObject({ ok: false, error: { code: "INVALID_MARKET_SELECTION" } });
  });

  it("rejects a case-insensitive duplicate address", () => {
    expect(parseCrossMarketRequestShape({ tokenOuts: [WETH, WETH.toLowerCase()] })).toMatchObject({ ok: false, error: { code: "INVALID_MARKET_SELECTION" } });
  });

  it("rejects a duplicate NATIVE_ETH entry", () => {
    expect(parseCrossMarketRequestShape({ tokenOuts: [NATIVE_ETH, NATIVE_ETH] })).toMatchObject({ ok: false, error: { code: "INVALID_MARKET_SELECTION" } });
  });

  it("a duplicate is rejected even when it appears among 3+ otherwise-distinct entries — never silently deduplicated", () => {
    expect(parseCrossMarketRequestShape({ tokenOuts: [WETH, USDG, WETH.toLowerCase()] })).toMatchObject({ ok: false, error: { code: "INVALID_MARKET_SELECTION" } });
  });
});

describe("parseCrossMarketRequestShape — hookData (identical shape/error semantics to sibling request modules)", () => {
  it("accepts a valid hookData map, lowercasing pool address keys", () => {
    const result = parseCrossMarketRequestShape({ hookData: { [WETH]: "0xdead" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hookData?.get(WETH.toLowerCase())).toBe("0xdead");
    }
  });

  it("rejects a hookData key that is not a valid address", () => {
    expect(parseCrossMarketRequestShape({ hookData: { notAnAddress: "0xdead" } })).toMatchObject({ ok: false, error: { code: "INVALID_HOOK_DATA" } });
  });

  it("rejects a hookData value that is not 0x-prefixed hex", () => {
    expect(parseCrossMarketRequestShape({ hookData: { [WETH]: "not-hex" } })).toMatchObject({ ok: false, error: { code: "INVALID_HOOK_DATA" } });
  });

  it("rejects a non-object hookData", () => {
    expect(parseCrossMarketRequestShape({ hookData: "nope" })).toMatchObject({ ok: false, error: { code: "INVALID_HOOK_DATA" } });
    expect(parseCrossMarketRequestShape({ hookData: [] })).toMatchObject({ ok: false, error: { code: "INVALID_HOOK_DATA" } });
  });

  it("accepts tokenOuts and hookData together", () => {
    const result = parseCrossMarketRequestShape({ tokenOuts: [WETH, USDG], hookData: { [WETH]: "0xdead" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tokenOuts).toEqual([WETH, USDG]);
      expect(result.value.hookData?.get(WETH.toLowerCase())).toBe("0xdead");
    }
  });
});

describe("parseCrossMarketRequestShape — no caller-supplied amounts/ladder/thresholds/block/cap/concurrency surface", () => {
  it("a stray amountsIn/thresholds/blockNumber/cellCap field has no effect either way — this endpoint has no such override surface", () => {
    const result = parseCrossMarketRequestShape({ tokenOuts: [WETH, USDG], amountsIn: ["1"], thresholds: [1000], blockNumber: "123", cellCap: 999 });
    expect(result).toEqual({ ok: true, value: { tokenOuts: [WETH, USDG] } });
  });
});
