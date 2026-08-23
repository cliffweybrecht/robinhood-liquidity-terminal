import type { Address, Hex } from "viem";
import type { Coverage } from "@/domain/liquidity";

export type PriceDerivation =
  | "CANONICAL_AS_BASE"
  | "CANONICAL_AS_QUOTE_DERIVED"
  | "UNAVAILABLE";

/**
 * One pool's contribution to the asset's DEX price picture. Preserved
 * even when `derivation === "UNAVAILABLE"` (canonicalAssetPriceUsd
 * `null`) — price methodology stays fully inspectable, never hidden.
 */
export interface PoolPriceObservation {
  readonly pairAddress: Hex;
  readonly dexId: string;
  /** From `LiquidityPool.canonicalAssetSide` — never inferred from symbol/name. */
  readonly canonicalAssetSide: "base" | "quote";
  readonly canonicalAssetPriceUsd: number | null;
  readonly derivation: PriceDerivation;
  readonly liquidityUsd: number | null;
  readonly dexScreenerUrl: string | null;
}

/**
 * Multiple representative DEX price methodologies for one canonical
 * asset — deliberately plural. See README "Which DEX price should
 * represent the asset?" for why no single number is treated as
 * unquestionably correct.
 */
export interface DexPriceSummary {
  /** Canonical price from the accepted, usable-price pool with the greatest non-null liquidityUsd. */
  readonly largestPoolPriceUsd: number | null;
  /** sum(price_i * liquidityUsd_i) / sum(liquidityUsd_i), over pools with usable price AND liquidityUsd > 0. */
  readonly liquidityWeightedPriceUsd: number | null;
  /** Median of all usable canonical pool prices. */
  readonly medianPriceUsd: number | null;

  readonly minPriceUsd: number | null;
  readonly maxPriceUsd: number | null;
  /** (max - min) / median * 100, only when median > 0. */
  readonly priceDispersionPct: number | null;

  /** Pools with a non-null canonicalAssetPriceUsd (of totalPoolCount). */
  readonly usablePricePoolCount: number;
  readonly totalPoolCount: number;
  /** Pools actually contributing to liquidityWeightedPriceUsd (usable price AND liquidityUsd > 0). */
  readonly weightedPricePoolCount: number;

  /** poolsReporting = usablePricePoolCount, poolsMissing = totalPoolCount - usablePricePoolCount. */
  readonly priceCoverage: Coverage;
  /** poolsReporting = weightedPricePoolCount, poolsMissing = usablePricePoolCount - weightedPricePoolCount (relative to price-usable pools, not all pools — a pool with no usable price was never eligible to be weighted in the first place). */
  readonly weightedPriceCoverage: Coverage;

  /** Deterministically ordered (liquidity desc, nulls last, pairAddress tie-break) — every pool, usable or not. */
  readonly pools: readonly PoolPriceObservation[];
}

/**
 * Robinhood's reference price, converted to a token-equivalent USD
 * value. `referencePriceUsd = mid(bid, ask) * currentMultiplier` — see
 * README "Reference-price semantics" for the documented + empirically
 * verified basis for this formula.
 */
export interface RobinhoodReferencePrice {
  readonly rawUnderlyingBidUsd: number;
  readonly rawUnderlyingAskUsd: number;
  /** (bid + ask) / 2 — Robinhood returns a spread, not a single price; the mid is this system's synthesis of it into one reference number. */
  readonly rawUnderlyingMidUsd: number;
  /** Preserved as Phase 1's original decimal string (18dp) for full precision/provenance, alongside the parsed number actually used in arithmetic. */
  readonly currentMultiplier: string;
  /** Token-equivalent reference price: rawUnderlyingMidUsd * Number(currentMultiplier). */
  readonly referencePriceUsd: number;
  readonly currency: string;
  readonly isTradingHalt: boolean;
  /** Robinhood's own ISO-8601 timestamp for this quote — distinct from when this application observed it. */
  readonly generatedAt: string;
  readonly source: "robinhood";
}

export interface AssetPriceComparison {
  readonly asset: {
    readonly symbol: string;
    readonly name: string;
    readonly contractAddress: Address;
  };

  readonly robinhood: RobinhoodReferencePrice;
  readonly dex: DexPriceSummary;

  readonly comparison: {
    readonly largestPoolPremiumDiscountPct: number | null;
    readonly liquidityWeightedPremiumDiscountPct: number | null;
    readonly medianPremiumDiscountPct: number | null;
  };

  /**
   * When THIS comparison was assembled — distinct from
   * `robinhood.generatedAt` (Robinhood's own quote timestamp) and from
   * whenever each individual Dexscreener pool observation was fetched.
   * The two data sources are never claimed to be synchronized.
   */
  readonly generatedAt: string;
}
