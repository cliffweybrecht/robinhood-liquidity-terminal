import type { Address, Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";

/**
 * Presence/completeness bookkeeping for one aggregated numeric metric.
 * `poolsReporting`/`poolsMissing` always sum to the pool count the
 * aggregation ran over. `complete` is `poolsMissing === 0` — vacuously
 * true when there are zero pools, since nothing is missing from nothing.
 * This is what lets a caller distinguish "no accepted pools" from
 * "accepted pools, but none reported this metric" from "some did, some
 * didn't" — see README "Coverage semantics".
 */
export interface Coverage {
  readonly poolsReporting: number;
  readonly poolsMissing: number;
  readonly complete: boolean;
}

export interface ActivityCoverage {
  readonly volume5m: Coverage;
  readonly volume1h: Coverage;
  readonly volume6h: Coverage;
  readonly volume24h: Coverage;
  /** One coverage entry per timeframe covers both buys and sells — Phase 2 normalizes them from the same optional provider object, so one is null iff the other is. */
  readonly txns5m: Coverage;
  readonly txns1h: Coverage;
  readonly txns6h: Coverage;
  readonly txns24h: Coverage;
}

export interface AssetLiquidityCoverage {
  readonly liquidity: Coverage;
  readonly activity: ActivityCoverage;
}

export interface LargestPool {
  readonly dexId: string;
  readonly pairAddress: Hex;
  /** Never null — a pool can only be "largest" if it reports a liquidityUsd value; see aggregate.ts. */
  readonly liquidityUsd: number;
  readonly shareOfDisplayedLiquidityPct: number | null;
}

/**
 * One quote/composition asset (the non-canonical side of a pool),
 * aggregated by exact contract address — never by symbol. See
 * aggregate.ts for the deterministic rule used when pools disagree on
 * what symbol that address should display.
 */
export interface QuoteAssetComposition {
  readonly address: Address;
  /** Deterministic representative label — see `symbolConflict`. */
  readonly symbol: string;
  /** True when pools in this group reported materially different (not just case/whitespace) symbols for this address — never silently resolved. */
  readonly symbolConflict: boolean;
  readonly displayedLiquidityUsd: number | null;
  readonly shareOfDisplayedLiquidityPct: number | null;
  readonly poolCount: number;
}

export interface DexComposition {
  readonly dexId: string;
  readonly displayedLiquidityUsd: number | null;
  readonly shareOfDisplayedLiquidityPct: number | null;
  readonly poolCount: number;
}

export interface AssetLiquidityActivity {
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
}

/**
 * Displayed-liquidity structure for one canonical Robinhood Stock Token,
 * aggregated from its Phase 2 accepted/deduplicated pools. This is
 * **displayed** market data only — see README "Displayed vs. executable
 * liquidity". Nothing here represents actual swap/buy capacity.
 */
export interface AssetLiquidityProfile {
  readonly asset: {
    readonly symbol: string;
    readonly name: string;
    readonly contractAddress: Address;
  };

  readonly displayedLiquidityUsd: number | null;
  readonly usdGLiquidityUsd: number | null;

  readonly poolCount: number;
  readonly dexCount: number;

  readonly largestPool: LargestPool | null;

  readonly concentration: {
    readonly top1Pct: number | null;
    readonly top3Pct: number | null;
    readonly top5Pct: number | null;
  };

  readonly quoteAssets: readonly QuoteAssetComposition[];
  readonly dexes: readonly DexComposition[];

  readonly activity: AssetLiquidityActivity;

  readonly coverage: AssetLiquidityCoverage;

  readonly pools: readonly LiquidityPool[];
}
