import { describe, expect, it } from "vitest";
import { MAX_MATRIX_AMOUNTS } from "@/domain/pool-quote";
import { parseCompareMatrixRequestShape, resolveAmountsIn } from "../requestMatrix";
import { NATIVE_ETH } from "../types";
import { WETH } from "./fixtures";

describe("parseCompareMatrixRequestShape", () => {
  it("accepts an empty/omitted body — all fields optional", () => {
    expect(parseCompareMatrixRequestShape(undefined)).toEqual({ ok: true, value: {} });
    expect(parseCompareMatrixRequestShape(null)).toEqual({ ok: true, value: {} });
    expect(parseCompareMatrixRequestShape({})).toEqual({ ok: true, value: {} });
  });

  it("rejects a non-object body", () => {
    expect(parseCompareMatrixRequestShape("nope")).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
    expect(parseCompareMatrixRequestShape(42)).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
    expect(parseCompareMatrixRequestShape([])).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
  });

  it("accepts a valid tokenOut address", () => {
    expect(parseCompareMatrixRequestShape({ tokenOut: WETH })).toEqual({ ok: true, value: { tokenOut: WETH } });
  });

  it("accepts the NATIVE_ETH sentinel for tokenOut", () => {
    expect(parseCompareMatrixRequestShape({ tokenOut: NATIVE_ETH })).toEqual({ ok: true, value: { tokenOut: NATIVE_ETH } });
  });

  it("rejects a malformed tokenOut address", () => {
    expect(parseCompareMatrixRequestShape({ tokenOut: "not-an-address" })).toMatchObject({ ok: false, error: { code: "INVALID_TOKEN_OUT" } });
  });

  it("omitted amountsIn -> ok, undefined (orchestration layer applies the default ladder)", () => {
    const result = parseCompareMatrixRequestShape({});
    expect(result).toEqual({ ok: true, value: {} });
  });

  it("passes amountsIn strings through unparsed (numeric validation happens later, after tokenDecimals is known)", () => {
    const result = parseCompareMatrixRequestShape({ amountsIn: ["1", "10", "100"] });
    expect(result).toEqual({ ok: true, value: { amountsInRaw: ["1", "10", "100"] } });
  });

  it("REJECTS a present-but-empty amountsIn array — omitted is the only way to request the default ladder", () => {
    expect(parseCompareMatrixRequestShape({ amountsIn: [] })).toMatchObject({ ok: false, error: { code: "EMPTY_AMOUNTS_IN" } });
  });

  it("rejects amountsIn.length exceeding MAX_MATRIX_AMOUNTS", () => {
    const tooMany = Array.from({ length: MAX_MATRIX_AMOUNTS + 1 }, (_, i) => String(i + 1));
    expect(parseCompareMatrixRequestShape({ amountsIn: tooMany })).toMatchObject({ ok: false, error: { code: "TOO_MANY_AMOUNTS_IN" } });
  });

  it("accepts amountsIn.length exactly at MAX_MATRIX_AMOUNTS", () => {
    const exact = Array.from({ length: MAX_MATRIX_AMOUNTS }, (_, i) => String(i + 1));
    expect(parseCompareMatrixRequestShape({ amountsIn: exact })).toEqual({ ok: true, value: { amountsInRaw: exact } });
  });

  it("rejects a non-array amountsIn", () => {
    expect(parseCompareMatrixRequestShape({ amountsIn: "1" })).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNTS_IN" } });
  });

  it("rejects an amountsIn entry that is not a string", () => {
    expect(parseCompareMatrixRequestShape({ amountsIn: ["1", 2] })).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNTS_IN" } });
  });

  it("accepts a well-formed hookData map keyed by valid pool addresses with hex values", () => {
    const poolAddr = "0x1111111111111111111111111111111111111111";
    const result = parseCompareMatrixRequestShape({ hookData: { [poolAddr]: "0xabcd" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.hookData?.get(poolAddr.toLowerCase())).toBe("0xabcd");
  });

  it("rejects hookData with an invalid pool address key", () => {
    expect(parseCompareMatrixRequestShape({ hookData: { "not-an-address": "0xabcd" } })).toMatchObject({ ok: false, error: { code: "INVALID_HOOK_DATA" } });
  });
});

describe("resolveAmountsIn", () => {
  it("omitted amountsIn -> ok, undefined value (caller applies the default ladder)", () => {
    expect(resolveAmountsIn(undefined, 18)).toEqual({ ok: true, value: undefined });
  });

  it("every entry parses to its exact bigint, in order", () => {
    expect(resolveAmountsIn(["1", "10", "1.5"], 18)).toEqual({
      ok: true,
      value: [1_000_000_000_000_000_000n, 10_000_000_000_000_000_000n, 1_500_000_000_000_000_000n],
    });
  });

  it("fails closed on the FIRST malformed entry", () => {
    expect(resolveAmountsIn(["1", "0", "10"], 18)).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNTS_IN" } });
  });

  it("rejects excess precision beyond the token's own decimals for any entry", () => {
    expect(resolveAmountsIn(["1", "1.1234567"], 6)).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNTS_IN" } });
  });

  it("preserves caller order, including an intentionally unsorted ladder", () => {
    expect(resolveAmountsIn(["100", "1", "10"], 18)).toEqual({
      ok: true,
      value: [100_000_000_000_000_000_000n, 1_000_000_000_000_000_000n, 10_000_000_000_000_000_000n],
    });
  });
});
