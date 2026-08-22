import {
  fetchRobinhoodAssets,
  type FetchRobinhoodAssetsOptions,
} from "@/providers/robinhood/client";
import { isValidEvmAddress } from "./address";
import {
  AmbiguousSymbolError,
  AssetNotFoundError,
  InvalidAddressInputError,
} from "./errors";
import { buildAssetRegistry, ROBINHOOD_CHAIN_ID, type AssetRegistry } from "./registry";
import type { CanonicalRobinhoodAsset } from "./types";

export type { FetchRobinhoodAssetsOptions };

/**
 * Fetches and normalizes the full canonical Robinhood Chain asset
 * registry. Each call performs a fresh upstream fetch — Phase 1
 * deliberately has no caching layer (see README "Known limitations").
 */
export async function getRobinhoodAssets(
  options?: FetchRobinhoodAssetsOptions,
): Promise<AssetRegistry> {
  const response = await fetchRobinhoodAssets(options);
  return buildAssetRegistry(response.assets, ROBINHOOD_CHAIN_ID);
}

/**
 * Looks up a canonical asset by ticker symbol. Matching is
 * case-insensitive (symbols are normalized to uppercase before lookup).
 * Throws `AmbiguousSymbolError` if the registry currently has more than
 * one canonical asset sharing that symbol — callers needing a guaranteed
 * unique identity should use `getRobinhoodAssetByAddress` instead.
 */
export async function getRobinhoodAssetBySymbol(
  symbol: string,
  options?: FetchRobinhoodAssetsOptions,
): Promise<CanonicalRobinhoodAsset> {
  const registry = await getRobinhoodAssets(options);
  const key = symbol.toUpperCase();

  if (registry.ambiguousSymbols.has(key)) {
    throw new AmbiguousSymbolError(key);
  }

  const asset = registry.bySymbol.get(key);
  if (!asset) {
    throw new AssetNotFoundError(
      `No canonical Robinhood asset found for symbol "${symbol}"`,
    );
  }
  return asset;
}

/**
 * Looks up a canonical asset by contract address. Matching is
 * case-insensitive. Rejects malformed address input immediately, before
 * any network call, with `InvalidAddressInputError`.
 */
export async function getRobinhoodAssetByAddress(
  address: string,
  options?: FetchRobinhoodAssetsOptions,
): Promise<CanonicalRobinhoodAsset> {
  if (!isValidEvmAddress(address)) {
    throw new InvalidAddressInputError(address);
  }

  const registry = await getRobinhoodAssets(options);
  const asset = registry.byAddress.get(address.toLowerCase());
  if (!asset) {
    throw new AssetNotFoundError(
      `No canonical Robinhood asset found for address "${address}"`,
    );
  }
  return asset;
}
