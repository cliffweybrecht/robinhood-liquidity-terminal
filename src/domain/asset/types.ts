import type { Address } from "viem";

export type AssetStatus = "ACTIVE" | "INACTIVE";

/**
 * A Robinhood Stock Token whose identity has been established via the
 * canonical Robinhood asset registry and confirmed to have a deployment
 * on Robinhood Chain. `contractAddress` is the authoritative identity for
 * this asset — never the symbol or name (see README for rationale).
 */
export interface CanonicalRobinhoodAsset {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly contractAddress: Address;
  readonly chainId: number;
  readonly logoUrl: string | null;
  readonly currentMultiplier: string;
  readonly tokenDecimals: number | null;
  readonly status: AssetStatus;
}
