import type { Address } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { RobinhoodPriceQuote } from "@/providers/robinhood-price";
import { buildDexPriceSummary } from "./dex-price";
import { CrossedReferenceMarketError, InvalidReferenceQuoteError } from "./errors";
import type { AssetPriceComparison, RobinhoodReferencePrice } from "./types";

/**
 * Converts a raw Robinhood price quote into a token-equivalent USD
 * reference price.
 *
 * Robinhood's `/rhj/prices` returns the **raw underlying-equity**
 * bid/ask — explicitly documented as "not multiplier-adjusted." This
 * system's reference price is `mid(bid, ask) * currentMultiplier`
 * (Phase 1's `CanonicalRobinhoodAsset.currentMultiplier`, "shares per
 * token").
 *
 * VERIFIED, not assumed: (1) Robinhood's own docs state the formula
 * directly ("Token USD price = Raw underlying equity USD price ×
 * currentMultiplier"); (2) a live asset (CRWD) carries a clean 4.0
 * multiplier explained by a documented 4-for-1 forward split — exactly
 * the mechanism that would require this scaling to keep a token's
 * value consistent across a split. See README "currentMultiplier
 * semantics" for the full evidence trail, including why an earlier,
 * inconclusive near-1.0-multiplier spot check (SGOV) was not treated as
 * counter-evidence to the documented formula.
 *
 * Hardening pass (post-Phase-5-review): the upstream Zod schema only
 * guarantees `bid`/`ask` are numeric-*looking* strings and
 * `currentMultiplier` is an 18dp decimal string — it does not guarantee
 * the parsed numbers are finite, non-negative, or that the quote isn't
 * crossed. This function re-validates at the domain boundary rather
 * than trusting `Number(...)` to produce something computable, and
 * throws a typed `PriceComparisonError` instead of silently
 * fabricating a `NaN`/negative/zero-from-invalid-input reference price:
 *
 *  - `bid`/`ask` must each parse to a finite number `>= 0`.
 *  - `currentMultiplier` must parse to a finite number `> 0` (a
 *    multiplier can be `1` — a no-op — or any positive split/reverse-
 *    split adjustment, but never zero or negative).
 *  - `bid` must not exceed `ask` (a crossed market) — `mid(bid, ask)`
 *    has no defensible meaning as "the market's reference price" when
 *    the two sides are inverted.
 */
export function buildRobinhoodReferencePrice(
  quote: RobinhoodPriceQuote,
  currentMultiplier: string,
): RobinhoodReferencePrice {
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const multiplier = Number(currentMultiplier);

  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    throw new InvalidReferenceQuoteError(
      quote.tokenSymbol,
      `bid/ask did not parse to finite numbers (bid="${quote.bid}", ask="${quote.ask}")`,
    );
  }
  if (bid < 0 || ask < 0) {
    throw new InvalidReferenceQuoteError(
      quote.tokenSymbol,
      `bid/ask must be non-negative (bid=${bid}, ask=${ask})`,
    );
  }
  if (!Number.isFinite(multiplier) || !(multiplier > 0)) {
    throw new InvalidReferenceQuoteError(
      quote.tokenSymbol,
      `currentMultiplier did not parse to a finite, positive number ("${currentMultiplier}")`,
    );
  }
  if (bid > ask) {
    throw new CrossedReferenceMarketError(quote.tokenSymbol, bid, ask);
  }

  const mid = (bid + ask) / 2;
  const referencePriceUsd = mid * multiplier;

  return {
    rawUnderlyingBidUsd: bid,
    rawUnderlyingAskUsd: ask,
    rawUnderlyingMidUsd: mid,
    currentMultiplier,
    referencePriceUsd,
    currency: quote.currency,
    isTradingHalt: quote.isTradingHalt,
    generatedAt: quote.generatedAt,
    source: "robinhood",
  };
}

/**
 * `(dexPriceUsd - referencePriceUsd) / referencePriceUsd * 100`.
 * Positive = DEX premium, negative = DEX discount, `0` = parity.
 * `null` — never `NaN`/`Infinity` — when `dexPriceUsd` is unavailable
 * or `referencePriceUsd` is not strictly positive.
 */
export function calculatePremiumDiscountPct(
  dexPriceUsd: number | null,
  referencePriceUsd: number,
): number | null {
  if (dexPriceUsd === null) return null;
  if (!(referencePriceUsd > 0)) return null;
  const pct = ((dexPriceUsd - referencePriceUsd) / referencePriceUsd) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * Assembles the full price comparison for one canonical asset: DEX
 * price summary (pure, from Phase 2 pools) + Robinhood reference price
 * + premium/discount across all three DEX price methodologies. Pure and
 * synchronous — no provider calls.
 */
export function buildAssetPriceComparison(
  asset: { symbol: string; name: string; contractAddress: Address },
  pools: readonly LiquidityPool[],
  robinhood: RobinhoodReferencePrice,
): AssetPriceComparison {
  const dex = buildDexPriceSummary(pools);

  return {
    asset: {
      symbol: asset.symbol,
      name: asset.name,
      contractAddress: asset.contractAddress,
    },
    robinhood,
    dex,
    comparison: {
      largestPoolPremiumDiscountPct: calculatePremiumDiscountPct(
        dex.largestPoolPriceUsd,
        robinhood.referencePriceUsd,
      ),
      liquidityWeightedPremiumDiscountPct: calculatePremiumDiscountPct(
        dex.liquidityWeightedPriceUsd,
        robinhood.referencePriceUsd,
      ),
      medianPremiumDiscountPct: calculatePremiumDiscountPct(dex.medianPriceUsd, robinhood.referencePriceUsd),
    },
    generatedAt: new Date().toISOString(),
  };
}
