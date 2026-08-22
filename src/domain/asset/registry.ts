import type { RobinhoodAsset } from "@/providers/robinhood/schema";
import { isValidEvmAddress, toChecksummedAddress } from "./address";
import {
  DuplicateContractAddressError,
  InvalidContractAddressError,
  NoChainDeploymentError,
} from "./errors";
import type { AssetStatus, CanonicalRobinhoodAsset } from "./types";

/** Robinhood Chain's EIP-155 chain ID. */
export const ROBINHOOD_CHAIN_ID = 4663;

export interface AssetRegistry {
  /** All canonical assets, in the order returned by the provider. */
  readonly assets: readonly CanonicalRobinhoodAsset[];
  /** Symbol (uppercased) -> asset, for symbols that resolve unambiguously. */
  readonly bySymbol: ReadonlyMap<string, CanonicalRobinhoodAsset>;
  /** Symbols (uppercased) shared by more than one asset — not present in `bySymbol`. */
  readonly ambiguousSymbols: ReadonlySet<string>;
  /** Contract address (lowercased) -> asset. */
  readonly byAddress: ReadonlyMap<string, CanonicalRobinhoodAsset>;
}

function normalizeStatus(raw: RobinhoodAsset["status"]): AssetStatus {
  return raw === "ASSET_STATUS_ACTIVE" ? "ACTIVE" : "INACTIVE";
}

/**
 * Normalizes raw provider assets into the canonical, chain-scoped asset
 * registry. Pure and synchronous: it makes no network calls, so it can be
 * exercised directly with hand-written fixtures in tests, independent of
 * whether those fixtures would also pass Zod validation at the HTTP
 * boundary (defense in depth — this function does not trust its caller
 * ran that validation).
 *
 * Fails closed:
 *  - an asset with a deployment on `chainId` but a malformed contract
 *    address throws, rather than being silently dropped or included;
 *  - two assets claiming the same canonical contract address throws,
 *    since address uniqueness is the identity invariant the rest of the
 *    application relies on;
 *  - zero assets with any deployment on `chainId` throws, rather than
 *    returning an empty registry indistinguishable from "not fetched yet".
 */
export function buildAssetRegistry(
  rawAssets: readonly RobinhoodAsset[],
  chainId: number = ROBINHOOD_CHAIN_ID,
): AssetRegistry {
  const assets: CanonicalRobinhoodAsset[] = [];

  for (const raw of rawAssets) {
    const deployment = raw.deployments.find((d) => d.chainId === chainId);
    if (!deployment) continue;

    if (!isValidEvmAddress(deployment.contractAddress)) {
      throw new InvalidContractAddressError(raw.id, deployment.contractAddress);
    }

    assets.push({
      id: raw.id,
      symbol: raw.tokenSymbol,
      name: raw.tokenName,
      contractAddress: toChecksummedAddress(deployment.contractAddress),
      chainId,
      logoUrl: raw.logoUrl ?? null,
      currentMultiplier: raw.currentMultiplier,
      tokenDecimals: raw.tokenDecimals ?? null,
      status: normalizeStatus(raw.status),
    });
  }

  if (assets.length === 0) {
    throw new NoChainDeploymentError(chainId);
  }

  const byAddress = new Map<string, CanonicalRobinhoodAsset>();
  for (const asset of assets) {
    const key = asset.contractAddress.toLowerCase();
    const existing = byAddress.get(key);
    if (existing) {
      throw new DuplicateContractAddressError(asset.contractAddress, [
        existing.id,
        asset.id,
      ]);
    }
    byAddress.set(key, asset);
  }

  const bySymbol = new Map<string, CanonicalRobinhoodAsset>();
  const ambiguousSymbols = new Set<string>();
  for (const asset of assets) {
    const key = asset.symbol.toUpperCase();
    if (ambiguousSymbols.has(key)) continue;
    if (bySymbol.has(key)) {
      bySymbol.delete(key);
      ambiguousSymbols.add(key);
      continue;
    }
    bySymbol.set(key, asset);
  }

  return { assets, bySymbol, ambiguousSymbols, byAddress };
}
