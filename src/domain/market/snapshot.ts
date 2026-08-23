import { getRobinhoodAssets, type FetchRobinhoodAssetsOptions } from "@/domain/asset";
import { buildAssetLiquidityProfile } from "@/domain/liquidity";
import { getDexScreenerPoolsForAsset } from "@/domain/pool";
import type { LiquidityPool } from "@/domain/pool";
import {
  buildDexPriceSummary,
  buildRobinhoodReferencePrice,
  calculatePremiumDiscountPct,
  PriceComparisonError,
} from "@/domain/price";
import { createLimiter } from "@/lib/concurrency/limiter";
import type { FetchDexScreenerPairsOptions } from "@/providers/dexscreener";
import {
  fetchAllRobinhoodPrices,
  type FetchRobinhoodPriceOptions,
  type RobinhoodPriceQuote,
} from "@/providers/robinhood-price";
import { classifyFailure } from "./classify";
import { projectLiquidityProfileToMarketRow, sortMarketRows } from "./project";
import type {
  MarketLiquidityRow,
  MarketLiquiditySnapshot,
  MarketPriceMeta,
  MarketSnapshotFailure,
} from "./types";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_REQUEST_INTERVAL_MS = 1000;

function resolvePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

export interface BuildMarketLiquiditySnapshotOptions {
  /** Overrides DEXSCREENER_BULK_CONCURRENCY / the built-in default. */
  concurrency?: number;
  /** Overrides DEXSCREENER_REQUEST_INTERVAL_MS / the built-in default. */
  requestIntervalMs?: number;
  robinhood?: FetchRobinhoodAssetsOptions;
  dexScreener?: FetchDexScreenerPairsOptions;
  robinhoodPrice?: FetchRobinhoodPriceOptions;
}

interface PerAssetResult {
  readonly row: MarketLiquidityRow;
  readonly pools: readonly LiquidityPool[];
}

/**
 * Builds a market-wide displayed-liquidity snapshot across every
 * canonical Robinhood asset, with Robinhood reference-price comparison
 * layered on top.
 *
 * Orchestration only — the actual per-asset math is Phase 3's
 * `buildAssetLiquidityProfile` and Phase 5's `buildDexPriceSummary`/
 * `buildRobinhoodReferencePrice`/`calculatePremiumDiscountPct`, all
 * called here unchanged. This function's job: fetch the canonical
 * registry once, fetch each asset's pools under bounded concurrency +
 * rate-limited spacing (never `Promise.all` unconstrained), fetch
 * Robinhood's reference prices via **one bulk call** (live-confirmed to
 * return all ~194 quotes in ~2.6s — no per-symbol limiter needed for
 * this provider), and collect liquidity successes/failures separately
 * from price availability — one broken asset, or even a total price
 * outage, never aborts the liquidity snapshot.
 *
 * Deliberately calls `getDexScreenerPoolsForAsset(asset)` per asset, not
 * `getDexScreenerPoolsBySymbol`/`getRobinhoodAssetBySymbol` — those
 * would each re-resolve the canonical registry, turning one snapshot
 * into ~194 additional Robinhood requests.
 *
 * Hardening pass: a bulk quote that's present for a symbol but fails
 * `buildRobinhoodReferencePrice`'s domain validation (crossed market,
 * non-finite/negative bid/ask, invalid multiplier) is caught here and
 * treated the same as "no usable price for this row" — tracked
 * separately as `symbolsInvalid`/`invalidSymbols`, never conflated with
 * `symbolsMissing`/`missingSymbols` (a genuinely absent symbol) or
 * silently swallowed with no signal. One invalid quote never aborts the
 * snapshot for the other ~193 assets, matching the existing partial-
 * failure model for liquidity itself.
 */
export async function buildMarketLiquiditySnapshot(
  options: BuildMarketLiquiditySnapshotOptions = {},
): Promise<MarketLiquiditySnapshot> {
  const refreshStartedAt = new Date();

  const registry = await getRobinhoodAssets(options.robinhood);
  const assets = registry.assets;

  // Started now, alongside the (much slower) rate-limited Dexscreener
  // loop below — one cheap call, not part of the per-asset rate-limited
  // work. Its own failure must never fail the liquidity snapshot: every
  // outcome (success or failure) is captured, never thrown further.
  const bulkPricesPromise: Promise<
    { readonly ok: true; readonly quotes: readonly RobinhoodPriceQuote[] } | { readonly ok: false }
  > = fetchAllRobinhoodPrices(options.robinhoodPrice).then(
    (response) => ({ ok: true, quotes: response.quotes }),
    () => ({ ok: false }),
  );

  const concurrency =
    options.concurrency ?? resolvePositiveIntEnv("DEXSCREENER_BULK_CONCURRENCY", DEFAULT_CONCURRENCY);
  const intervalMs =
    options.requestIntervalMs ??
    resolvePositiveIntEnv("DEXSCREENER_REQUEST_INTERVAL_MS", DEFAULT_REQUEST_INTERVAL_MS);
  const limiter = createLimiter({ concurrency, intervalMs });

  const settled = await Promise.allSettled(
    assets.map((asset) =>
      limiter.schedule(async (): Promise<PerAssetResult> => {
        const { pools } = await getDexScreenerPoolsForAsset(asset, {
          dexScreener: options.dexScreener,
        });
        const profile = buildAssetLiquidityProfile(asset, pools);
        const row = projectLiquidityProfileToMarketRow(profile, asset.logoUrl);
        return { row, pools };
      }),
    ),
  );

  const bulkPrices = await bulkPricesPromise;
  const priceQuoteBySymbol = new Map<string, RobinhoodPriceQuote>();
  if (bulkPrices.ok) {
    for (const quote of bulkPrices.quotes) priceQuoteBySymbol.set(quote.tokenSymbol, quote);
  }

  // Robinhood's own per-quote timestamps, not this application's —
  // computed only when the bulk fetch succeeded and returned at least
  // one quote. See README "Price freshness" for what was actually
  // observed live (whether these vary across a bulk response or not).
  let oldestQuoteGeneratedAt: string | null = null;
  let newestQuoteGeneratedAt: string | null = null;
  if (bulkPrices.ok) {
    for (const quote of bulkPrices.quotes) {
      const t = Date.parse(quote.generatedAt);
      if (!Number.isFinite(t)) continue;
      if (oldestQuoteGeneratedAt === null || t < Date.parse(oldestQuoteGeneratedAt)) {
        oldestQuoteGeneratedAt = quote.generatedAt;
      }
      if (newestQuoteGeneratedAt === null || t > Date.parse(newestQuoteGeneratedAt)) {
        newestQuoteGeneratedAt = quote.generatedAt;
      }
    }
  }

  const rows: MarketLiquidityRow[] = [];
  const failures: MarketSnapshotFailure[] = [];
  let symbolsMatched = 0;
  const missingSymbols: string[] = [];
  const invalidSymbols: string[] = [];

  settled.forEach((result, i) => {
    const asset = assets[i]!;
    if (result.status !== "fulfilled") {
      const { category, message } = classifyFailure(result.reason);
      failures.push({ symbol: asset.symbol, contractAddress: asset.contractAddress, category, message });
      return;
    }

    let row = result.value.row;

    if (bulkPrices.ok) {
      const quote = priceQuoteBySymbol.get(asset.symbol);
      if (quote) {
        let referencePrice;
        try {
          referencePrice = buildRobinhoodReferencePrice(quote, asset.currentMultiplier);
        } catch (err) {
          if (!(err instanceof PriceComparisonError)) throw err;
          invalidSymbols.push(asset.symbol);
          rows.push(row);
          return;
        }
        symbolsMatched++;
        const dexSummary = buildDexPriceSummary(result.value.pools);
        row = {
          ...row,
          robinhoodReferencePriceUsd: referencePrice.referencePriceUsd,
          dexLiquidityWeightedPriceUsd: dexSummary.liquidityWeightedPriceUsd,
          dexMedianPriceUsd: dexSummary.medianPriceUsd,
          premiumDiscountPct: calculatePremiumDiscountPct(
            dexSummary.medianPriceUsd,
            referencePrice.referencePriceUsd,
          ),
          priceDispersionPct: dexSummary.priceDispersionPct,
          priceCoverageComplete: dexSummary.priceCoverage.complete,
        };
      } else {
        missingSymbols.push(asset.symbol);
      }
    }

    rows.push(row);
  });

  missingSymbols.sort((a, b) => a.localeCompare(b));
  invalidSymbols.sort((a, b) => a.localeCompare(b));

  const generatedAt = new Date();
  const assetsRequested = assets.length;
  const assetsSucceeded = rows.length;
  const assetsFailed = failures.length;

  const price: MarketPriceMeta = {
    available: bulkPrices.ok,
    generatedAt: bulkPrices.ok ? generatedAt.toISOString() : null,
    symbolsMatched,
    symbolsMissing: missingSymbols.length,
    missingSymbols,
    symbolsInvalid: invalidSymbols.length,
    invalidSymbols,
    oldestQuoteGeneratedAt,
    newestQuoteGeneratedAt,
  };

  return {
    refreshStartedAt: refreshStartedAt.toISOString(),
    generatedAt: generatedAt.toISOString(),
    refreshDurationMs: generatedAt.getTime() - refreshStartedAt.getTime(),
    assetsRequested,
    assetsSucceeded,
    assetsFailed,
    completeness: {
      complete: assetsFailed === 0,
      successPct: assetsRequested > 0 ? (assetsSucceeded / assetsRequested) * 100 : 100,
    },
    rows: sortMarketRows(rows),
    failures,
    price,
  };
}
