import { getRobinhoodAssets, type FetchRobinhoodAssetsOptions } from "@/domain/asset";
import { buildAssetLiquidityProfile } from "@/domain/liquidity";
import { getDexScreenerPoolsForAsset } from "@/domain/pool";
import { createLimiter } from "@/lib/concurrency/limiter";
import type { FetchDexScreenerPairsOptions } from "@/providers/dexscreener";
import { classifyFailure } from "./classify";
import { projectLiquidityProfileToMarketRow, sortMarketRows } from "./project";
import type { MarketLiquidityRow, MarketLiquiditySnapshot, MarketSnapshotFailure } from "./types";

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
}

/**
 * Builds a market-wide displayed-liquidity snapshot across every
 * canonical Robinhood asset.
 *
 * Orchestration only — the actual per-asset liquidity math is Phase 3's
 * `buildAssetLiquidityProfile`, called here unchanged. This function's
 * job is exactly: fetch the canonical registry once, fetch each asset's
 * pools under bounded concurrency + rate-limited spacing (never
 * `Promise.all` over all assets unconstrained), reuse the Phase 3
 * aggregation, and collect successes/failures separately — one broken
 * asset never aborts the snapshot.
 *
 * Deliberately calls `getDexScreenerPoolsForAsset(asset)` per asset, not
 * `getDexScreenerPoolsBySymbol`/`getRobinhoodAssetBySymbol` — those
 * would each re-resolve the canonical registry, turning one snapshot
 * into ~194 additional Robinhood requests.
 */
export async function buildMarketLiquiditySnapshot(
  options: BuildMarketLiquiditySnapshotOptions = {},
): Promise<MarketLiquiditySnapshot> {
  const refreshStartedAt = new Date();

  const registry = await getRobinhoodAssets(options.robinhood);
  const assets = registry.assets;

  const concurrency =
    options.concurrency ?? resolvePositiveIntEnv("DEXSCREENER_BULK_CONCURRENCY", DEFAULT_CONCURRENCY);
  const intervalMs =
    options.requestIntervalMs ??
    resolvePositiveIntEnv("DEXSCREENER_REQUEST_INTERVAL_MS", DEFAULT_REQUEST_INTERVAL_MS);
  const limiter = createLimiter({ concurrency, intervalMs });

  const settled = await Promise.allSettled(
    assets.map((asset) =>
      limiter.schedule(async () => {
        const { pools } = await getDexScreenerPoolsForAsset(asset, {
          dexScreener: options.dexScreener,
        });
        const profile = buildAssetLiquidityProfile(asset, pools);
        return projectLiquidityProfileToMarketRow(profile, asset.logoUrl);
      }),
    ),
  );

  const rows: MarketLiquidityRow[] = [];
  const failures: MarketSnapshotFailure[] = [];

  settled.forEach((result, i) => {
    const asset = assets[i]!;
    if (result.status === "fulfilled") {
      rows.push(result.value);
    } else {
      const { category, message } = classifyFailure(result.reason);
      failures.push({ symbol: asset.symbol, contractAddress: asset.contractAddress, category, message });
    }
  });

  const generatedAt = new Date();
  const assetsRequested = assets.length;
  const assetsSucceeded = rows.length;
  const assetsFailed = failures.length;

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
  };
}
