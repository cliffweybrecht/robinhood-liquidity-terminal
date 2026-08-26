import { describe, expect, it } from "vitest";
import { computeExecutionPrice, computePriceImpactBps, computeSpotPrice } from "../analytics";

const Q96 = 1n << 96n;

describe("computeSpotPrice", () => {
  it("token0 -> token1, equal decimals, sqrtPriceX96 == 2^96 (price == 1)", () => {
    const spot = computeSpotPrice(Q96, true, 18, 18);
    expect(spot.numerator * 1n).toBe(spot.denominator * 1n);
    expect(spot.denominator > 0n).toBe(true);
  });

  it("token1 -> token0, equal decimals, sqrtPriceX96 == 2^96 (price == 1, reciprocal of 1 is 1)", () => {
    const spot = computeSpotPrice(Q96, false, 18, 18);
    expect(spot.numerator).toBe(spot.denominator);
  });

  it("token0 -> token1 and token1 -> token0 are exact reciprocals of each other (same sqrtPriceX96, equal decimals)", () => {
    const sqrtPriceX96 = 2n * Q96; // raw price = 4
    const forward = computeSpotPrice(sqrtPriceX96, true, 18, 18);
    const reverse = computeSpotPrice(sqrtPriceX96, false, 18, 18);
    // forward.num/forward.den == reverse.den/reverse.num, cross-multiplied:
    expect(forward.numerator * reverse.numerator).toBe(forward.denominator * reverse.denominator);
  });

  it("token0 -> token1, sqrtPriceX96 == 2*2^96 (raw price == 4), equal decimals", () => {
    const spot = computeSpotPrice(2n * Q96, true, 18, 18);
    expect(spot.numerator).toBe(4n * spot.denominator);
  });

  it("unequal decimals, decimalsIn > decimalsOut (positive exponent path, numerator scaled)", () => {
    const spot = computeSpotPrice(Q96, true, 18, 6); // price==1 raw, decimalsIn-decimalsOut=12
    expect(spot.numerator).toBe((1n << 192n) * 10n ** 12n);
    expect(spot.denominator).toBe(1n << 192n);
  });

  it("unequal decimals, decimalsIn < decimalsOut (negative exponent path, denominator scaled)", () => {
    const spot = computeSpotPrice(Q96, true, 6, 18); // price==1 raw, decimalsIn-decimalsOut=-12
    expect(spot.numerator).toBe(1n << 192n);
    expect(spot.denominator).toBe((1n << 192n) * 10n ** 12n);
  });

  it("denominator is always > 0", () => {
    const a = computeSpotPrice(123456789n, true, 18, 6);
    const b = computeSpotPrice(123456789n, false, 6, 18);
    expect(a.denominator > 0n).toBe(true);
    expect(b.denominator > 0n).toBe(true);
  });

  it("independent (floating-point, test-only) sanity cross-check for a realistic large sqrtPriceX96 — catches gross errors (wrong exponent direction, wrong squaring) without relying on the exact bigint formula being self-consistent with itself", () => {
    // This real value + expected result were independently derived and
    // cross-checked (via a second, structurally different bigint
    // computation path) during Phase 6E.2 architecture research —
    // documented in phase-6e2-architecture-review.txt section 16.3,
    // agreeing to 50 significant decimal digits. Re-verifying that exact
    // agreement here would just re-implement the same bigint arithmetic
    // under test, so this test instead uses an intentionally DIFFERENT,
    // lower-precision method (floating point — never used in the
    // production formula itself) purely as a rough sanity bound.
    const sqrtPriceX96 = 5418750556201755922889773763153732n;
    const spot = computeSpotPrice(sqrtPriceX96, true, 18, 6);
    const approxSqrt = Number(sqrtPriceX96) / Number(1n << 96n);
    const approxPriceRaw = approxSqrt * approxSqrt;
    const approxPriceHuman = approxPriceRaw * 10 ** 12; // decimalsIn-decimalsOut=12
    const viaFormula = Number(spot.numerator) / Number(spot.denominator);
    const relativeError = Math.abs(viaFormula - approxPriceHuman) / approxPriceHuman;
    expect(relativeError < 1e-6).toBe(true);
  });
});

describe("computeExecutionPrice", () => {
  it("standard case: tokenOut per tokenIn, equal decimals", () => {
    const exec = computeExecutionPrice(1_000_000_000_000_000_000n, 2_000_000_000_000_000_000n, 18, 18);
    expect(exec.numerator).toBe(2n * exec.denominator); // 2 tokenOut per tokenIn
  });

  it("unequal decimals: amountOut in 6dp, amountIn in 18dp", () => {
    const amountIn = 1_000_000_000_000_000_000n; // 1.0, 18dp
    const amountOut = 213669465n; // 213.669465, 6dp
    const exec = computeExecutionPrice(amountIn, amountOut, 18, 6);
    expect(exec.numerator).toBe(amountOut * 10n ** 18n);
    expect(exec.denominator).toBe(amountIn * 10n ** 6n);
  });

  it("amountOut === 0 -> executionPrice numerator is exactly 0 (well-defined, not an error)", () => {
    const exec = computeExecutionPrice(1_000_000_000_000_000_000n, 0n, 18, 6);
    expect(exec.numerator).toBe(0n);
    expect(exec.denominator > 0n).toBe(true);
  });

  it("tiny amounts (1 wei in, 1 wei out)", () => {
    const exec = computeExecutionPrice(1n, 1n, 18, 18);
    expect(exec.numerator).toBe(exec.denominator);
  });

  it("huge bigint amounts do not lose precision (far beyond Number.MAX_SAFE_INTEGER)", () => {
    const amountIn = 10n ** 30n;
    const amountOut = 3n * 10n ** 30n;
    const exec = computeExecutionPrice(amountIn, amountOut, 18, 18);
    expect(exec.numerator).toBe(3n * exec.denominator);
  });
});

describe("computePriceImpactBps", () => {
  it("zero impact when execution exactly equals spot", () => {
    const spot = { numerator: 5n, denominator: 1n };
    const execution = { numerator: 5n, denominator: 1n };
    const impact = computePriceImpactBps(spot, execution);
    expect(impact.numerator).toBe(0n);
  });

  it("positive impact when execution is worse than spot (fewer tokenOut per tokenIn)", () => {
    const spot = { numerator: 100n, denominator: 1n };
    const execution = { numerator: 99n, denominator: 1n }; // 1% worse
    const impact = computePriceImpactBps(spot, execution);
    expect(impact.numerator > 0n).toBe(true);
    expect(impact.numerator / impact.denominator).toBe(100n); // 1% == 100bps, exact
  });

  it("near-zero positive impact", () => {
    const spot = { numerator: 1_000_000n, denominator: 1n };
    const execution = { numerator: 999_995n, denominator: 1n }; // 0.0005% worse
    const impact = computePriceImpactBps(spot, execution);
    expect(impact.numerator > 0n).toBe(true);
    // 0.0005% == 0.05bps -> less than 1bps when truncated
    expect(impact.numerator / impact.denominator).toBe(0n);
  });

  it("large positive impact", () => {
    const spot = { numerator: 100n, denominator: 1n };
    const execution = { numerator: 1n, denominator: 1n }; // 99% worse
    const impact = computePriceImpactBps(spot, execution);
    expect(impact.numerator / impact.denominator).toBe(9900n);
  });

  it("negative impact (price improvement) is NOT clamped to zero", () => {
    const spot = { numerator: 100n, denominator: 1n };
    const execution = { numerator: 101n, denominator: 1n }; // 1% BETTER than spot
    const impact = computePriceImpactBps(spot, execution);
    expect(impact.numerator < 0n).toBe(true);
    expect(impact.numerator / impact.denominator).toBe(-100n);
  });

  it("amountOut === 0 combined with a realistic spot price yields exactly +10000 bps (100% impact, not an error)", () => {
    const spot = computeSpotPrice(1_000_000_000_000_000_000_000_000n, true, 18, 6);
    const execution = computeExecutionPrice(1_000_000_000_000_000_000n, 0n, 18, 6);
    const impact = computePriceImpactBps(spot, execution);
    expect(impact.numerator > 0n).toBe(true);
    const quotient = impact.numerator / impact.denominator;
    const remainder = impact.numerator % impact.denominator;
    expect(quotient).toBe(10000n);
    expect(remainder).toBe(0n);
  });

  it("amountOut === 0 impact is exactly +10000 bps when spot price is nonzero (minimal synthetic vector)", () => {
    const spot = { numerator: 7n, denominator: 3n };
    const execution = { numerator: 0n, denominator: 5n };
    const impact = computePriceImpactBps(spot, execution);
    expect(impact.numerator > 0n).toBe(true);
    const quotient = impact.numerator / impact.denominator;
    const remainder = impact.numerator % impact.denominator;
    expect(quotient).toBe(10000n);
    expect(remainder).toBe(0n);
  });

  it("denominator is always positive given a positive spot numerator and positive execution denominator", () => {
    const spot = { numerator: 7n, denominator: 3n };
    const execution = { numerator: 2n, denominator: 5n };
    const impact = computePriceImpactBps(spot, execution);
    expect(impact.denominator > 0n).toBe(true);
  });
});
