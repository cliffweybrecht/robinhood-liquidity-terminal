import {
  getRobinhoodAssetByAddress,
  getRobinhoodAssetBySymbol,
} from "@/domain/asset";
import {
  getDexScreenerPoolsForAsset,
  type GetDexScreenerPoolsOptions,
} from "@/domain/pool";
import { buildAssetLiquidityProfile } from "./aggregate";
import type { AssetLiquidityProfile } from "./types";

export type GetAssetLiquidityProfileOptions = GetDexScreenerPoolsOptions;

/**
 * Resolves `symbol` through the Phase 1 canonical registry, discovers
 * its Phase 2 pools, then aggregates a Phase 3 liquidity profile.
 * Preserves the full trust chain: symbol -> canonical asset -> validated
 * pools -> aggregation. Inherits Phase 1's `AssetNotFoundError`/
 * `AmbiguousSymbolError` and Phase 2's provider/integrity errors
 * unchanged — an unresolvable symbol never reaches Dexscreener, and a
 * pool integrity conflict never reaches aggregation.
 */
export async function getAssetLiquidityProfileBySymbol(
  symbol: string,
  options: GetAssetLiquidityProfileOptions = {},
): Promise<AssetLiquidityProfile> {
  const asset = await getRobinhoodAssetBySymbol(symbol, options.robinhood);
  const { pools } = await getDexScreenerPoolsForAsset(asset, options);
  return buildAssetLiquidityProfile(asset, pools);
}

/**
 * Resolves `address` through the Phase 1 canonical registry before doing
 * anything else — an address that isn't a canonical Robinhood Stock
 * Token never reaches Dexscreener or aggregation. See
 * `src/domain/pool/service.ts` for the equivalent Phase 2 guarantee this
 * builds on.
 */
export async function getAssetLiquidityProfileByAddress(
  address: string,
  options: GetAssetLiquidityProfileOptions = {},
): Promise<AssetLiquidityProfile> {
  const asset = await getRobinhoodAssetByAddress(address, options.robinhood);
  const { pools } = await getDexScreenerPoolsForAsset(asset, options);
  return buildAssetLiquidityProfile(asset, pools);
}
