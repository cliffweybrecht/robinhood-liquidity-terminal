import {
  getRobinhoodAssetByAddress,
  getRobinhoodAssetBySymbol,
  type CanonicalRobinhoodAsset,
} from "@/domain/asset";
import { getDexScreenerPoolsForAsset, type GetDexScreenerPoolsOptions } from "@/domain/pool";
import type { LiquidityPool } from "@/domain/pool";
import {
  fetchRobinhoodPriceForSymbol,
  type FetchRobinhoodPriceOptions,
} from "@/providers/robinhood-price";
import { buildAssetPriceComparison, buildRobinhoodReferencePrice } from "./compare";
import { RobinhoodReferencePriceNotFoundError } from "./errors";
import type { AssetPriceComparison } from "./types";

export interface GetAssetPriceComparisonOptions extends GetDexScreenerPoolsOptions {
  robinhoodPrice?: FetchRobinhoodPriceOptions;
}

/**
 * Builds a price comparison for an already-resolved canonical asset and
 * already-fetched pool list. This is the core operation — the
 * symbol/address variants below add resolution + pool-fetching in
 * front of it, and the per-asset UI page uses this directly to reuse
 * pools it already fetched for the Phase 3 liquidity profile, avoiding
 * a second Dexscreener round-trip for the same asset (see
 * `src/app/assets/[symbol]/page.tsx`).
 */
export async function getAssetPriceComparisonForAsset(
  asset: CanonicalRobinhoodAsset,
  pools: readonly LiquidityPool[],
  options: { robinhoodPrice?: FetchRobinhoodPriceOptions } = {},
): Promise<AssetPriceComparison> {
  const priceResponse = await fetchRobinhoodPriceForSymbol(asset.symbol, options.robinhoodPrice);
  const quote = priceResponse.quotes.find((q) => q.tokenSymbol === asset.symbol);
  if (!quote) {
    throw new RobinhoodReferencePriceNotFoundError(asset.symbol);
  }
  const referencePrice = buildRobinhoodReferencePrice(quote, asset.currentMultiplier);
  return buildAssetPriceComparison(asset, pools, referencePrice);
}

/**
 * Resolves `symbol` through the Phase 1 canonical registry, discovers
 * its Phase 2 pools, fetches Robinhood's reference price for that exact
 * canonical symbol (never a Dexscreener-reported label), and builds the
 * full price comparison. Inherits Phase 1's `AssetNotFoundError`/
 * `AmbiguousSymbolError` and Phase 2's provider/integrity errors
 * unchanged — an unresolvable symbol never reaches either downstream
 * provider.
 */
export async function getAssetPriceComparisonBySymbol(
  symbol: string,
  options: GetAssetPriceComparisonOptions = {},
): Promise<AssetPriceComparison> {
  const asset = await getRobinhoodAssetBySymbol(symbol, options.robinhood);
  const { pools } = await getDexScreenerPoolsForAsset(asset, options);
  return getAssetPriceComparisonForAsset(asset, pools, options);
}

/**
 * Resolves `address` through the Phase 1 canonical registry before
 * doing anything else — an address that isn't a canonical Robinhood
 * Stock Token never reaches Dexscreener or the Robinhood price
 * endpoint through this function.
 */
export async function getAssetPriceComparisonByAddress(
  address: string,
  options: GetAssetPriceComparisonOptions = {},
): Promise<AssetPriceComparison> {
  const asset = await getRobinhoodAssetByAddress(address, options.robinhood);
  const { pools } = await getDexScreenerPoolsForAsset(asset, options);
  return getAssetPriceComparisonForAsset(asset, pools, options);
}
