import type { LiquidityPool } from "@/domain/pool";
import type { Coverage } from "@/domain/liquidity";
import type { DexPriceSummary, PoolPriceObservation, PriceDerivation } from "./types";

/**
 * Derives the canonical asset's USD price from one pool, using
 * `pool.canonicalAssetSide` — never symbol/name — to decide orientation.
 *
 * VERIFIED against live Robinhood Chain data (see README "Dexscreener
 * price orientation — verified"), not merely mathematically plausible:
 *
 *  - CANONICAL_AS_BASE: `pool.priceUsd` already *is* the canonical
 *    asset's USD price (Dexscreener quotes `priceUsd` as the base
 *    token's price). Confirmed directly: NVDA/AAPL/MSFT base-side pool
 *    prices matched Robinhood's reference price within normal spread.
 *
 *  - CANONICAL_AS_QUOTE_DERIVED: `priceNative` is the base token's
 *    price expressed in quote-token units, so
 *    `canonicalPriceUsd = priceUsd / priceNative`. Confirmed by finding
 *    real COST-as-quote pools (paired against unrelated "HOTDOG" base
 *    tokens) live: the derived price from the largest such pool
 *    (946.82) matched COST's directly-observed base-side price (946.81)
 *    to within 0.01%.
 *
 * Requires `priceNative > 0` for the quote-side case — zero/negative
 * denominators, non-finite results, and null inputs all produce
 * `{priceUsd: null, derivation: "UNAVAILABLE"}` rather than NaN/Infinity
 * or a fabricated value.
 */
export function deriveCanonicalAssetPriceUsd(
  pool: LiquidityPool,
): { priceUsd: number | null; derivation: PriceDerivation } {
  if (pool.canonicalAssetSide === "base") {
    if (pool.priceUsd === null) return { priceUsd: null, derivation: "UNAVAILABLE" };
    return { priceUsd: pool.priceUsd, derivation: "CANONICAL_AS_BASE" };
  }

  if (pool.priceUsd === null || pool.priceNative === null || !(pool.priceNative > 0)) {
    return { priceUsd: null, derivation: "UNAVAILABLE" };
  }
  const derived = pool.priceUsd / pool.priceNative;
  if (!Number.isFinite(derived)) return { priceUsd: null, derivation: "UNAVAILABLE" };
  return { priceUsd: derived, derivation: "CANONICAL_AS_QUOTE_DERIVED" };
}

export function buildPoolPriceObservation(pool: LiquidityPool): PoolPriceObservation {
  const { priceUsd, derivation } = deriveCanonicalAssetPriceUsd(pool);
  return {
    pairAddress: pool.pairAddress,
    dexId: pool.dexId,
    canonicalAssetSide: pool.canonicalAssetSide,
    canonicalAssetPriceUsd: priceUsd,
    derivation,
    liquidityUsd: pool.liquidityUsd,
    dexScreenerUrl: pool.dexScreenerUrl,
  };
}

function sortByLiquidityDesc<T extends { liquidityUsd: number | null; pairAddress: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => {
    if (a.liquidityUsd === null && b.liquidityUsd === null) {
      return a.pairAddress.localeCompare(b.pairAddress);
    }
    if (a.liquidityUsd === null) return 1;
    if (b.liquidityUsd === null) return -1;
    if (a.liquidityUsd !== b.liquidityUsd) return b.liquidityUsd - a.liquidityUsd;
    return a.pairAddress.localeCompare(b.pairAddress);
  });
}

function median(sortedAscending: readonly number[]): number | null {
  if (sortedAscending.length === 0) return null;
  const mid = Math.floor(sortedAscending.length / 2);
  if (sortedAscending.length % 2 === 0) {
    return (sortedAscending[mid - 1]! + sortedAscending[mid]!) / 2;
  }
  return sortedAscending[mid]!;
}

/**
 * Builds the full multi-methodology DEX price picture for one
 * canonical asset from its Phase 2 accepted pools. Pure and
 * synchronous — no provider calls. Never silently drops disagreeing
 * pools: outliers remain visible in `pools` and pull on `min`/`max`/
 * `priceDispersionPct` rather than being deleted.
 */
export function buildDexPriceSummary(pools: readonly LiquidityPool[]): DexPriceSummary {
  const observations = pools.map(buildPoolPriceObservation);

  const usable = observations.filter(
    (o): o is PoolPriceObservation & { canonicalAssetPriceUsd: number } =>
      o.canonicalAssetPriceUsd !== null,
  );
  const totalPoolCount = observations.length;
  const usablePricePoolCount = usable.length;

  const usableSortedByLiquidity = sortByLiquidityDesc(usable.filter((o) => o.liquidityUsd !== null));
  const largestPoolPriceUsd = usableSortedByLiquidity[0]?.canonicalAssetPriceUsd ?? null;

  const weightable = usable.filter((o) => o.liquidityUsd !== null && o.liquidityUsd > 0);
  const weightedPricePoolCount = weightable.length;
  let liquidityWeightedPriceUsd: number | null = null;
  if (weightable.length > 0) {
    const totalLiquidity = weightable.reduce((sum, o) => sum + o.liquidityUsd!, 0);
    const weightedSum = weightable.reduce(
      (sum, o) => sum + o.canonicalAssetPriceUsd * o.liquidityUsd!,
      0,
    );
    liquidityWeightedPriceUsd = totalLiquidity > 0 ? weightedSum / totalLiquidity : null;
  }

  const sortedPrices = usable.map((o) => o.canonicalAssetPriceUsd).sort((a, b) => a - b);
  const medianPriceUsd = median(sortedPrices);
  const minPriceUsd = sortedPrices.length > 0 ? sortedPrices[0]! : null;
  const maxPriceUsd = sortedPrices.length > 0 ? sortedPrices[sortedPrices.length - 1]! : null;

  let priceDispersionPct: number | null = null;
  if (minPriceUsd !== null && maxPriceUsd !== null && medianPriceUsd !== null && medianPriceUsd > 0) {
    const dispersion = ((maxPriceUsd - minPriceUsd) / medianPriceUsd) * 100;
    priceDispersionPct = Number.isFinite(dispersion) ? dispersion : null;
  }

  const priceCoverage: Coverage = {
    poolsReporting: usablePricePoolCount,
    poolsMissing: totalPoolCount - usablePricePoolCount,
    complete: usablePricePoolCount === totalPoolCount,
  };
  const weightedPriceCoverage: Coverage = {
    poolsReporting: weightedPricePoolCount,
    poolsMissing: usablePricePoolCount - weightedPricePoolCount,
    complete: weightedPricePoolCount === usablePricePoolCount,
  };

  return {
    largestPoolPriceUsd,
    liquidityWeightedPriceUsd,
    medianPriceUsd,
    minPriceUsd,
    maxPriceUsd,
    priceDispersionPct,
    usablePricePoolCount,
    totalPoolCount,
    weightedPricePoolCount,
    priceCoverage,
    weightedPriceCoverage,
    pools: sortByLiquidityDesc(observations),
  };
}
