import {
  fetchDexScreenerPairs,
  type FetchDexScreenerPairsOptions,
} from "@/providers/dexscreener";
import {
  getRobinhoodAssetByAddress,
  getRobinhoodAssetBySymbol,
  type CanonicalRobinhoodAsset,
  type FetchRobinhoodAssetsOptions,
} from "@/domain/asset";
import { normalizePools, type NormalizePoolsResult } from "./normalize";

/** Dexscreener's chain identifier for Robinhood Chain. */
export const DEXSCREENER_ROBINHOOD_CHAIN_ID = "robinhood";

export interface GetDexScreenerPoolsOptions {
  dexScreener?: FetchDexScreenerPairsOptions;
  robinhood?: FetchRobinhoodAssetsOptions;
}

export interface AssetPoolDiscoveryResult extends NormalizePoolsResult {
  readonly asset: CanonicalRobinhoodAsset;
}

/**
 * Fetches and normalizes Dexscreener pools for an already-resolved
 * canonical Robinhood asset. This is the core operation; the
 * symbol/address variants below only add canonical resolution in front
 * of it. `poolCount` for API purposes is `result.pools.length` — the
 * count of accepted, unique, validated pools (not raw provider records).
 */
export async function getDexScreenerPoolsForAsset(
  asset: CanonicalRobinhoodAsset,
  options: GetDexScreenerPoolsOptions = {},
): Promise<AssetPoolDiscoveryResult> {
  const rawPairs = await fetchDexScreenerPairs(
    DEXSCREENER_ROBINHOOD_CHAIN_ID,
    asset.contractAddress,
    options.dexScreener,
  );
  const result = normalizePools(rawPairs, asset, DEXSCREENER_ROBINHOOD_CHAIN_ID);
  return { asset, ...result };
}

/**
 * Resolves `symbol` through the Phase 1 canonical registry, then
 * discovers its Dexscreener pools. Inherits Phase 1's lookup errors
 * (`AssetNotFoundError`, `AmbiguousSymbolError`) unchanged — an
 * unresolvable or ambiguous symbol never reaches Dexscreener.
 */
export async function getDexScreenerPoolsBySymbol(
  symbol: string,
  options: GetDexScreenerPoolsOptions = {},
): Promise<AssetPoolDiscoveryResult> {
  const asset = await getRobinhoodAssetBySymbol(symbol, options.robinhood);
  return getDexScreenerPoolsForAsset(asset, options);
}

/**
 * Resolves `address` through the Phase 1 canonical registry, then
 * discovers its Dexscreener pools. Inherits Phase 1's lookup errors
 * (`InvalidAddressInputError`, `AssetNotFoundError`) unchanged — an
 * address that isn't a canonical Robinhood Stock Token never reaches
 * Dexscreener through this function. (The lower-level
 * `fetchDexScreenerPairs` in `src/providers/dexscreener` does accept
 * arbitrary addresses, for reuse/testability — that's intentionally
 * separate from this canonical-gated public API.)
 */
export async function getDexScreenerPoolsByAddress(
  address: string,
  options: GetDexScreenerPoolsOptions = {},
): Promise<AssetPoolDiscoveryResult> {
  const asset = await getRobinhoodAssetByAddress(address, options.robinhood);
  return getDexScreenerPoolsForAsset(asset, options);
}
