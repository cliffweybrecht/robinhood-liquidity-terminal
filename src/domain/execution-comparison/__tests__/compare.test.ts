import { describe, expect, it } from "vitest";
import { NATIVE_ETH } from "../types";
import { defaultAmountIn, resolveSelectedTokenOutForTesting, sameTokenOut } from "../compare";
import { MissingTokenDecimalsError, UnknownOutputGroupError, NoVerifiedGroupsError, VerificationDegradedError } from "../errors";
import { USDG, WETH } from "./fixtures";
import type { ComparableExecutionGroup } from "../types";

function group(tokenOut: ComparableExecutionGroup["tokenOut"], candidateCount: number): ComparableExecutionGroup {
  return { tokenOut, candidateCount, v3Count: candidateCount, v4Count: 0 };
}

describe("resolveSelectedTokenOut (default group selection)", () => {
  it("omitted tokenOut -> selects groups[0] (the caller-provided, already-deterministically-ordered list)", () => {
    const groups = [group(WETH, 15), group(USDG, 13)];
    expect(resolveSelectedTokenOutForTesting("NVDA", groups, undefined)).toBe(WETH);
  });

  it("explicit tokenOut matching an authoritative group is accepted", () => {
    const groups = [group(WETH, 15), group(USDG, 13)];
    expect(resolveSelectedTokenOutForTesting("NVDA", groups, USDG)).toBe(USDG);
  });

  it("explicit tokenOut match is case-insensitive", () => {
    const groups = [group(USDG, 13)];
    expect(resolveSelectedTokenOutForTesting("NVDA", groups, USDG.toLowerCase() as typeof USDG)).toBe(USDG);
  });

  it("explicit NATIVE_ETH is accepted when a native group exists", () => {
    const groups = [group(NATIVE_ETH, 1)];
    expect(resolveSelectedTokenOutForTesting("NVDA", groups, NATIVE_ETH)).toBe(NATIVE_ETH);
  });

  it("throws UnknownOutputGroupError for a tokenOut with no matching authoritative group", () => {
    const groups = [group(WETH, 15)];
    expect(() => resolveSelectedTokenOutForTesting("NVDA", groups, USDG)).toThrow(UnknownOutputGroupError);
  });

  it("NATIVE_ETH never accidentally matches a real address group or vice versa", () => {
    const groups = [group(WETH, 15)];
    expect(() => resolveSelectedTokenOutForTesting("NVDA", groups, NATIVE_ETH)).toThrow(UnknownOutputGroupError);
  });

  it("throws NoVerifiedGroupsError when no groups exist at all and none was requested", () => {
    expect(() => resolveSelectedTokenOutForTesting("NVDA", [], undefined)).toThrow(NoVerifiedGroupsError);
  });

  it("defaults to HEALTHY semantics when verificationHealth is omitted — preserves NoVerifiedGroupsError for existing callers", () => {
    expect(() => resolveSelectedTokenOutForTesting("NVDA", [], undefined)).toThrow(NoVerifiedGroupsError);
    expect(() => resolveSelectedTokenOutForTesting("NVDA", [], undefined)).not.toThrow(VerificationDegradedError);
  });

  it("throws VerificationDegradedError instead of NoVerifiedGroupsError when zero groups exist AND verification is DEGRADED", () => {
    expect(() => resolveSelectedTokenOutForTesting("NVDA", [], undefined, "DEGRADED")).toThrow(VerificationDegradedError);
  });

  it("VerificationDegradedError also applies on the explicit-tokenOut path, not just the default-group path", () => {
    expect(() => resolveSelectedTokenOutForTesting("NVDA", [], WETH, "DEGRADED")).toThrow(VerificationDegradedError);
  });

  it("zero groups + HEALTHY still throws the ordinary NoVerifiedGroupsError, never VerificationDegradedError", () => {
    expect(() => resolveSelectedTokenOutForTesting("NVDA", [], undefined, "HEALTHY")).toThrow(NoVerifiedGroupsError);
  });

  it("DEGRADED health with at least one group present is unaffected — default/explicit selection proceeds normally", () => {
    const groups = [group(WETH, 15)];
    expect(resolveSelectedTokenOutForTesting("NVDA", groups, undefined, "DEGRADED")).toBe(WETH);
    expect(resolveSelectedTokenOutForTesting("NVDA", groups, WETH, "DEGRADED")).toBe(WETH);
  });
});

describe("sameTokenOut", () => {
  it("compares real addresses case-insensitively", () => {
    expect(sameTokenOut(WETH, WETH.toLowerCase() as typeof WETH)).toBe(true);
  });

  it("different addresses are not equal", () => {
    expect(sameTokenOut(WETH, USDG)).toBe(false);
  });

  it("NATIVE_ETH only equals itself, never any address", () => {
    expect(sameTokenOut(NATIVE_ETH, NATIVE_ETH)).toBe(true);
    expect(sameTokenOut(NATIVE_ETH, WETH)).toBe(false);
    expect(sameTokenOut(WETH, NATIVE_ETH)).toBe(false);
  });
});

describe("defaultAmountIn — exactly 1 canonical token unit, never USD/reference-price derived", () => {
  it("returns 10^decimals for an 18-decimal asset", () => {
    expect(defaultAmountIn("NVDA", 18)).toBe(1_000_000_000_000_000_000n);
  });

  it("returns 10^decimals for a 6-decimal asset", () => {
    expect(defaultAmountIn("USDG", 6)).toBe(1_000_000n);
  });

  it("returns 1n for a 0-decimal asset", () => {
    expect(defaultAmountIn("X", 0)).toBe(1n);
  });

  it("throws MissingTokenDecimalsError when tokenDecimals is null, rather than assuming a default", () => {
    expect(() => defaultAmountIn("NVDA", null)).toThrow(MissingTokenDecimalsError);
  });
});
