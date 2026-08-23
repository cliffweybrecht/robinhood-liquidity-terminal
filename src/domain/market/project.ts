import type { AssetLiquidityProfile } from "@/domain/liquidity";
import type { MarketLiquidityRow } from "./types";

/**
 * Projects an already-computed Phase 3 `AssetLiquidityProfile` into a
 * leaderboard row. Pure field selection only — no arithmetic, no
 * re-derivation of any metric. `logoUrl` comes from the Phase 1
 * canonical asset record (not part of `AssetLiquidityProfile.asset`,
 * which intentionally only carries symbol/name/contractAddress).
 *
 * Price fields (Phase 5) default to `null` here — this function has no
 * involvement with Robinhood price data at all. `snapshot.ts` fills
 * them in afterward, per-row, only when the bulk price fetch succeeded
 * and matched this asset's symbol — see `MarketPriceMeta`.
 */
export function projectLiquidityProfileToMarketRow(
  profile: AssetLiquidityProfile,
  logoUrl: string | null,
): MarketLiquidityRow {
  return {
    asset: {
      symbol: profile.asset.symbol,
      name: profile.asset.name,
      contractAddress: profile.asset.contractAddress,
      logoUrl,
    },
    displayedLiquidityUsd: profile.displayedLiquidityUsd,
    usdGLiquidityUsd: profile.usdGLiquidityUsd,
    poolCount: profile.poolCount,
    dexCount: profile.dexCount,
    observedVolume24h: profile.activity.volume24h,
    buys24h: profile.activity.buys24h,
    sells24h: profile.activity.sells24h,
    largestPoolLiquidityUsd: profile.largestPool?.liquidityUsd ?? null,
    top1ConcentrationPct: profile.concentration.top1Pct,
    top3ConcentrationPct: profile.concentration.top3Pct,
    top5ConcentrationPct: profile.concentration.top5Pct,
    liquidityCoverageComplete: profile.coverage.liquidity.complete,
    volume24hCoverageComplete: profile.coverage.activity.volume24h.complete,
    robinhoodReferencePriceUsd: null,
    dexLiquidityWeightedPriceUsd: null,
    dexMedianPriceUsd: null,
    premiumDiscountPct: null,
    priceDispersionPct: null,
    priceCoverageComplete: null,
  };
}

/**
 * Default snapshot ordering: displayed liquidity descending, rows with
 * null liquidity sorted after every non-null row, symbol ascending as
 * the deterministic tie-breaker. The UI may re-sort by other columns
 * client-side (see `src/app/_lib/marketTable.ts`) — this is only the
 * canonical order the API returns.
 */
export function sortMarketRows(rows: readonly MarketLiquidityRow[]): MarketLiquidityRow[] {
  return [...rows].sort((a, b) => {
    if (a.displayedLiquidityUsd === null && b.displayedLiquidityUsd === null) {
      return a.asset.symbol.localeCompare(b.asset.symbol);
    }
    if (a.displayedLiquidityUsd === null) return 1;
    if (b.displayedLiquidityUsd === null) return -1;
    if (a.displayedLiquidityUsd !== b.displayedLiquidityUsd) {
      return b.displayedLiquidityUsd - a.displayedLiquidityUsd;
    }
    return a.asset.symbol.localeCompare(b.asset.symbol);
  });
}
