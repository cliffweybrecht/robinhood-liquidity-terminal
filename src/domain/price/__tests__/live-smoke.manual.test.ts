import { describe, expect, it } from "vitest";
import { getAssetPriceComparisonBySymbol } from "../service";

/**
 * Manual live-network smoke test for Phase 5. Skipped by default —
 * every other test in this project runs fully deterministic with zero
 * live network calls (see `fetchImpl` injection throughout). This file
 * is the one deliberate exception, run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run src/domain/price/__tests__/live-smoke.manual.test.ts
 *
 * It hits the real Robinhood and Dexscreener APIs for NVDA, AAPL, and
 * MSFT, prints every metric the Phase 5 spec calls for, and asserts the
 * cross-field invariants that must always hold (weighted price between
 * min/max, median between min/max, largest-pool price matches an
 * actual pool in the set, premium/discount sign consistency).
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

describe.skipIf(!RUN_LIVE)("Phase 5 live smoke test", () => {
  it.each(["NVDA", "AAPL", "MSFT"])("reports and sanity-checks %s", async (symbol) => {
    const comparison = await getAssetPriceComparisonBySymbol(symbol);

    console.log(`\n=== ${symbol} ===`);
    console.log(JSON.stringify(comparison, null, 2));

    const { robinhood, dex, comparison: cmp } = comparison;

    // --- Invariant 1: weighted price is within [min, max] ---
    if (dex.liquidityWeightedPriceUsd !== null && dex.minPriceUsd !== null && dex.maxPriceUsd !== null) {
      expect(dex.liquidityWeightedPriceUsd).toBeGreaterThanOrEqual(dex.minPriceUsd);
      expect(dex.liquidityWeightedPriceUsd).toBeLessThanOrEqual(dex.maxPriceUsd);
    }

    // --- Invariant 2: median price is within [min, max] ---
    if (dex.medianPriceUsd !== null && dex.minPriceUsd !== null && dex.maxPriceUsd !== null) {
      expect(dex.medianPriceUsd).toBeGreaterThanOrEqual(dex.minPriceUsd);
      expect(dex.medianPriceUsd).toBeLessThanOrEqual(dex.maxPriceUsd);
    }

    // --- Invariant 3: largest-pool price matches the actual largest
    // qualifying (non-null-price) pool by liquidity ---
    const usablePools = dex.pools.filter((p) => p.canonicalAssetPriceUsd !== null);
    if (usablePools.length > 0 && dex.largestPoolPriceUsd !== null) {
      const sorted = [...usablePools].sort((a, b) => {
        const aLiq = a.liquidityUsd ?? -1;
        const bLiq = b.liquidityUsd ?? -1;
        return bLiq - aLiq;
      });
      expect(sorted[0]!.canonicalAssetPriceUsd).toBeCloseTo(dex.largestPoolPriceUsd, 6);
    }

    // --- Invariant 4: premium/discount sign correctness ---
    if (cmp.liquidityWeightedPremiumDiscountPct !== null && dex.liquidityWeightedPriceUsd !== null) {
      const expectedSign = Math.sign(dex.liquidityWeightedPriceUsd - robinhood.referencePriceUsd);
      const actualSign = Math.sign(cmp.liquidityWeightedPremiumDiscountPct);
      // Zero-vs-zero and tiny floating differences aside, signs must agree.
      if (expectedSign !== 0) {
        expect(actualSign).toBe(expectedSign);
      }
    }

    // --- Invariant 5: never NaN/Infinity anywhere numeric ---
    const numericFields = [
      robinhood.referencePriceUsd,
      robinhood.rawUnderlyingMidUsd,
      dex.liquidityWeightedPriceUsd,
      dex.medianPriceUsd,
      dex.largestPoolPriceUsd,
      dex.minPriceUsd,
      dex.maxPriceUsd,
      dex.priceDispersionPct,
      cmp.largestPoolPremiumDiscountPct,
      cmp.liquidityWeightedPremiumDiscountPct,
      cmp.medianPremiumDiscountPct,
    ];
    for (const value of numericFields) {
      if (value !== null) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }

    // --- Invariant 6: coverage counts are internally consistent ---
    expect(dex.priceCoverage.poolsReporting + dex.priceCoverage.poolsMissing).toBe(dex.totalPoolCount);
    expect(dex.usablePricePoolCount).toBe(dex.priceCoverage.poolsReporting);
  }, 30000);
});
