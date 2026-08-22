import type { Address, Hex } from "viem";

export type PoolProvider = "dexscreener";
export type CanonicalAssetSide = "base" | "quote";

export interface PoolToken {
  readonly address: Address;
  readonly name: string;
  readonly symbol: string;
}

/**
 * A validated, normalized DEX liquidity pool known to contain a
 * canonical Robinhood Stock Token on one side. This is **displayed**
 * liquidity/volume data as reported by the provider — not executable
 * liquidity (see README: that distinction is a later phase).
 */
export interface LiquidityPool {
  readonly provider: PoolProvider;
  readonly chainId: string;
  readonly dexId: string;

  /**
   * Pool/pair identifier as reported by the provider. For most DEXes
   * this is a 20-byte deployed contract address; for Uniswap v4 pools
   * it is a 32-byte PoolId (v4 pools are managed by a singleton
   * PoolManager contract and have no individually deployed contract) —
   * this is why it's typed as the wider `Hex` rather than `Address`.
   * See `src/domain/pool/address.ts`.
   */
  readonly pairAddress: Hex;

  /** Always the Phase 1 canonical registry's checksummed address — never Dexscreener's copy of it. */
  readonly canonicalAssetAddress: Address;
  /** Always the Phase 1 canonical registry's symbol — never Dexscreener's token label. */
  readonly canonicalAssetSymbol: string;
  readonly canonicalAssetSide: CanonicalAssetSide;

  /** Raw provider-reported token info for both legs, preserved for display/provenance — not identity-verified beyond address shape. */
  readonly baseToken: PoolToken;
  readonly quoteToken: PoolToken;

  readonly priceUsd: number | null;
  readonly priceNative: number | null;

  readonly liquidityUsd: number | null;
  readonly liquidityBase: number | null;
  readonly liquidityQuote: number | null;

  readonly volume5m: number | null;
  readonly volume1h: number | null;
  readonly volume6h: number | null;
  readonly volume24h: number | null;

  readonly buys5m: number | null;
  readonly sells5m: number | null;
  readonly buys1h: number | null;
  readonly sells1h: number | null;
  readonly buys6h: number | null;
  readonly sells6h: number | null;
  readonly buys24h: number | null;
  readonly sells24h: number | null;

  readonly priceChange5m: number | null;
  readonly priceChange1h: number | null;
  readonly priceChange6h: number | null;
  readonly priceChange24h: number | null;

  readonly fdv: number | null;
  readonly marketCap: number | null;

  readonly pairCreatedAt: number | null;

  readonly dexScreenerUrl: string | null;

  readonly labels: readonly string[];
}
