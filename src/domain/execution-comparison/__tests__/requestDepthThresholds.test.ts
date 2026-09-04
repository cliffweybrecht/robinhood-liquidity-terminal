import { describe, expect, it } from "vitest";
import { parseDepthThresholdsRequestShape } from "../requestDepthThresholds";
import { NATIVE_ETH } from "../types";
import { WETH } from "./fixtures";

describe("parseDepthThresholdsRequestShape", () => {
  it("accepts an empty/omitted body — all fields optional", () => {
    expect(parseDepthThresholdsRequestShape(undefined)).toEqual({ ok: true, value: {} });
    expect(parseDepthThresholdsRequestShape(null)).toEqual({ ok: true, value: {} });
    expect(parseDepthThresholdsRequestShape({})).toEqual({ ok: true, value: {} });
  });

  it("rejects a non-object body", () => {
    expect(parseDepthThresholdsRequestShape("nope")).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
    expect(parseDepthThresholdsRequestShape(42)).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
    expect(parseDepthThresholdsRequestShape([])).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
  });

  it("accepts a valid tokenOut address", () => {
    expect(parseDepthThresholdsRequestShape({ tokenOut: WETH })).toEqual({ ok: true, value: { tokenOut: WETH } });
  });

  it("accepts the NATIVE_ETH sentinel for tokenOut", () => {
    expect(parseDepthThresholdsRequestShape({ tokenOut: NATIVE_ETH })).toEqual({ ok: true, value: { tokenOut: NATIVE_ETH } });
  });

  it("rejects a malformed tokenOut address", () => {
    expect(parseDepthThresholdsRequestShape({ tokenOut: "not-an-address" })).toMatchObject({ ok: false, error: { code: "INVALID_TOKEN_OUT" } });
  });

  it("rejects a non-string tokenOut", () => {
    expect(parseDepthThresholdsRequestShape({ tokenOut: 42 })).toMatchObject({ ok: false, error: { code: "INVALID_TOKEN_OUT" } });
  });

  it("accepts a valid hookData map, lowercasing pool address keys", () => {
    const result = parseDepthThresholdsRequestShape({ hookData: { [WETH]: "0xdead" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hookData?.get(WETH.toLowerCase())).toBe("0xdead");
    }
  });

  it("rejects a hookData key that is not a valid address", () => {
    expect(parseDepthThresholdsRequestShape({ hookData: { notAnAddress: "0xdead" } })).toMatchObject({ ok: false, error: { code: "INVALID_HOOK_DATA" } });
  });

  it("rejects a hookData value that is not 0x-prefixed hex", () => {
    expect(parseDepthThresholdsRequestShape({ hookData: { [WETH]: "not-hex" } })).toMatchObject({ ok: false, error: { code: "INVALID_HOOK_DATA" } });
  });

  it("rejects a non-object hookData", () => {
    expect(parseDepthThresholdsRequestShape({ hookData: "nope" })).toMatchObject({ ok: false, error: { code: "INVALID_HOOK_DATA" } });
    expect(parseDepthThresholdsRequestShape({ hookData: [] })).toMatchObject({ ok: false, error: { code: "INVALID_HOOK_DATA" } });
  });

  it("accepts both tokenOut and hookData together", () => {
    const result = parseDepthThresholdsRequestShape({ tokenOut: WETH, hookData: { [WETH]: "0xdead" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tokenOut).toBe(WETH);
      expect(result.value.hookData?.get(WETH.toLowerCase())).toBe("0xdead");
    }
  });

});

describe("forbidden authority-bearing fields FAIL CLOSED (adversarial pre-commit pass, Issue 1)", () => {
  it("rejects a request body containing amountsIn, HTTP 400 semantics via AMOUNTS_IN_NOT_ALLOWED — never silently ignored", () => {
    expect(parseDepthThresholdsRequestShape({ amountsIn: ["1", "10"] })).toMatchObject({ ok: false, error: { code: "AMOUNTS_IN_NOT_ALLOWED" } });
  });

  it("rejects a request body containing thresholds, HTTP 400 semantics via THRESHOLDS_NOT_ALLOWED — never silently ignored", () => {
    expect(parseDepthThresholdsRequestShape({ thresholds: [1000] })).toMatchObject({ ok: false, error: { code: "THRESHOLDS_NOT_ALLOWED" } });
  });

  it("rejects a request body containing BOTH amountsIn and thresholds", () => {
    const result = parseDepthThresholdsRequestShape({ amountsIn: ["1"], thresholds: [1000] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["AMOUNTS_IN_NOT_ALLOWED", "THRESHOLDS_NOT_ALLOWED"]).toContain(result.error.code);
    }
  });

  it("rejects amountsIn/thresholds even when combined with an otherwise-valid tokenOut — the forbidden field is checked before tokenOut/hookData parsing", () => {
    const result = parseDepthThresholdsRequestShape({ tokenOut: WETH, thresholds: [1000] });
    expect(result).toMatchObject({ ok: false, error: { code: "THRESHOLDS_NOT_ALLOWED" } });
  });

  it("omitted amountsIn/thresholds -> a normal request, unaffected", () => {
    expect(parseDepthThresholdsRequestShape({})).toEqual({ ok: true, value: {} });
    expect(parseDepthThresholdsRequestShape({ tokenOut: WETH })).toEqual({ ok: true, value: { tokenOut: WETH } });
  });

  it("a normal tokenOut/hookData request remains valid and unaffected by this fix", () => {
    const result = parseDepthThresholdsRequestShape({ tokenOut: WETH, hookData: { [WETH]: "0xdead" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tokenOut).toBe(WETH);
      expect(result.value.hookData?.get(WETH.toLowerCase())).toBe("0xdead");
    }
  });
});
