import { getAddress, type Address } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type {
  ActivityCoverage,
  AssetLiquidityActivity,
  AssetLiquidityCoverage,
  AssetLiquidityProfile,
  Coverage,
  DexComposition,
  LargestPool,
  QuoteAssetComposition,
} from "./types";

/**
 * Robinhood Chain's canonical USDG contract. USDG participation is
 * decided by comparing this exact address (case-insensitively) against
 * a pool's non-canonical-asset side — never by the token's reported
 * symbol, for the same reason canonical asset identity never is (see
 * README "Why ticker matching is never used for identity").
 */
export const CANONICAL_USDG_ADDRESS: Address = getAddress(
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
);

export interface AssetIdentityForProfile {
  readonly symbol: string;
  readonly name: string;
  readonly contractAddress: Address;
}

/**
 * Sums a nullable numeric metric across pools. Returns `null` — not
 * `0` — when zero pools report a non-null value for it, so "no data"
 * stays distinguishable from "the data says zero". See README
 * "Null vs. zero handling".
 */
function sumNullable(
  pools: readonly LiquidityPool[],
  select: (pool: LiquidityPool) => number | null,
): number | null {
  const values = pools.map(select).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0);
}

function coverageFor(
  pools: readonly LiquidityPool[],
  select: (pool: LiquidityPool) => number | null,
): Coverage {
  const poolsReporting = pools.filter((p) => select(p) !== null).length;
  const poolsMissing = pools.length - poolsReporting;
  return { poolsReporting, poolsMissing, complete: poolsMissing === 0 };
}

function otherSide(pool: LiquidityPool) {
  return pool.canonicalAssetSide === "base" ? pool.quoteToken : pool.baseToken;
}

/**
 * `topN / total * 100`, defined as `null` — never `NaN`/`Infinity` — when
 * there is no positive total to divide by (no pool reports liquidity, or
 * the reporting pools sum to exactly zero). `n` beyond the number of
 * ranked pools is safe (sums whatever exists, matching "fewer than N
 * pools" semantics rather than erroring).
 */
function topNShare(sortedDescByLiquidity: readonly number[], total: number, n: number): number | null {
  if (total <= 0) return null;
  const top = sortedDescByLiquidity.slice(0, n).reduce((a, b) => a + b, 0);
  return (top / total) * 100;
}

function computeConcentration(pools: readonly LiquidityPool[]) {
  const ranked = rankByLiquidityDesc(pools);
  const total = ranked.reduce((sum, p) => sum + p.liquidityUsd, 0);
  const values = ranked.map((p) => p.liquidityUsd);

  return {
    top1Pct: topNShare(values, total, 1),
    top3Pct: topNShare(values, total, 3),
    top5Pct: topNShare(values, total, 5),
  };
}

/** Pools with a non-null `liquidityUsd`, sorted descending; ties broken by `pairAddress` ascending for determinism. */
function rankByLiquidityDesc(
  pools: readonly LiquidityPool[],
): readonly (LiquidityPool & { liquidityUsd: number })[] {
  const withLiquidity = pools.filter(
    (p): p is LiquidityPool & { liquidityUsd: number } => p.liquidityUsd !== null,
  );
  return [...withLiquidity].sort(
    (a, b) => b.liquidityUsd - a.liquidityUsd || a.pairAddress.localeCompare(b.pairAddress),
  );
}

function computeLargestPool(
  pools: readonly LiquidityPool[],
  displayedLiquidityUsd: number | null,
): LargestPool | null {
  const ranked = rankByLiquidityDesc(pools);
  const top = ranked[0];
  if (!top) return null;

  const shareOfDisplayedLiquidityPct =
    displayedLiquidityUsd !== null && displayedLiquidityUsd > 0
      ? (top.liquidityUsd / displayedLiquidityUsd) * 100
      : null;

  return {
    dexId: top.dexId,
    pairAddress: top.pairAddress,
    liquidityUsd: top.liquidityUsd,
    shareOfDisplayedLiquidityPct,
  };
}

/** Sorts composition rows by `displayedLiquidityUsd` descending (nulls last), tie-broken ascending by `tieBreakKey`. */
function sortComposition<T extends { displayedLiquidityUsd: number | null }>(
  items: readonly T[],
  tieBreakKey: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => {
    if (a.displayedLiquidityUsd === null && b.displayedLiquidityUsd === null) {
      return tieBreakKey(a).localeCompare(tieBreakKey(b));
    }
    if (a.displayedLiquidityUsd === null) return 1;
    if (b.displayedLiquidityUsd === null) return -1;
    if (a.displayedLiquidityUsd !== b.displayedLiquidityUsd) {
      return b.displayedLiquidityUsd - a.displayedLiquidityUsd;
    }
    return tieBreakKey(a).localeCompare(tieBreakKey(b));
  });
}

function computeQuoteAssetComposition(pools: readonly LiquidityPool[]): QuoteAssetComposition[] {
  const groups = new Map<string, { address: Address; pools: LiquidityPool[] }>();

  for (const pool of pools) {
    const other = otherSide(pool);
    const key = other.address.toLowerCase();
    const group = groups.get(key);
    if (group) {
      group.pools.push(pool);
    } else {
      groups.set(key, { address: other.address, pools: [pool] });
    }
  }

  const totalDisplayedLiquidityUsd = sumNullable(pools, (p) => p.liquidityUsd);

  const compositions: QuoteAssetComposition[] = [...groups.values()].map((group) => {
    const groupLiquidity = sumNullable(group.pools, (p) => p.liquidityUsd);
    const share =
      groupLiquidity !== null && totalDisplayedLiquidityUsd !== null && totalDisplayedLiquidityUsd > 0
        ? (groupLiquidity / totalDisplayedLiquidityUsd) * 100
        : null;

    // Deterministic representative symbol: the lexicographically smallest
    // distinct raw symbol observed for this address, independent of pool
    // array order. Symbols differing only by case/whitespace are treated
    // as the same label (not a conflict); anything else is flagged via
    // `symbolConflict` rather than silently discarded.
    const rawSymbols = group.pools.map((p) => otherSide(p).symbol);
    const distinctNormalized = new Set(rawSymbols.map((s) => s.trim().toLowerCase()));
    const symbolConflict = distinctNormalized.size > 1;
    const representativeSymbol = [...new Set(rawSymbols)].sort()[0]!;

    return {
      address: group.address,
      symbol: representativeSymbol,
      symbolConflict,
      displayedLiquidityUsd: groupLiquidity,
      shareOfDisplayedLiquidityPct: share,
      poolCount: group.pools.length,
    };
  });

  return sortComposition(compositions, (c) => c.address);
}

function computeDexComposition(pools: readonly LiquidityPool[]): DexComposition[] {
  const groups = new Map<string, LiquidityPool[]>();

  for (const pool of pools) {
    const list = groups.get(pool.dexId);
    if (list) {
      list.push(pool);
    } else {
      groups.set(pool.dexId, [pool]);
    }
  }

  const totalDisplayedLiquidityUsd = sumNullable(pools, (p) => p.liquidityUsd);

  const compositions: DexComposition[] = [...groups.entries()].map(([dexId, groupPools]) => {
    const groupLiquidity = sumNullable(groupPools, (p) => p.liquidityUsd);
    const share =
      groupLiquidity !== null && totalDisplayedLiquidityUsd !== null && totalDisplayedLiquidityUsd > 0
        ? (groupLiquidity / totalDisplayedLiquidityUsd) * 100
        : null;

    return {
      dexId,
      displayedLiquidityUsd: groupLiquidity,
      shareOfDisplayedLiquidityPct: share,
      poolCount: groupPools.length,
    };
  });

  return sortComposition(compositions, (c) => c.dexId);
}

function computeActivity(pools: readonly LiquidityPool[]): AssetLiquidityActivity {
  return {
    volume5m: sumNullable(pools, (p) => p.volume5m),
    volume1h: sumNullable(pools, (p) => p.volume1h),
    volume6h: sumNullable(pools, (p) => p.volume6h),
    volume24h: sumNullable(pools, (p) => p.volume24h),
    buys5m: sumNullable(pools, (p) => p.buys5m),
    sells5m: sumNullable(pools, (p) => p.sells5m),
    buys1h: sumNullable(pools, (p) => p.buys1h),
    sells1h: sumNullable(pools, (p) => p.sells1h),
    buys6h: sumNullable(pools, (p) => p.buys6h),
    sells6h: sumNullable(pools, (p) => p.sells6h),
    buys24h: sumNullable(pools, (p) => p.buys24h),
    sells24h: sumNullable(pools, (p) => p.sells24h),
  };
}

function computeCoverage(pools: readonly LiquidityPool[]): AssetLiquidityCoverage {
  const activity: ActivityCoverage = {
    volume5m: coverageFor(pools, (p) => p.volume5m),
    volume1h: coverageFor(pools, (p) => p.volume1h),
    volume6h: coverageFor(pools, (p) => p.volume6h),
    volume24h: coverageFor(pools, (p) => p.volume24h),
    txns5m: coverageFor(pools, (p) => p.buys5m),
    txns1h: coverageFor(pools, (p) => p.buys1h),
    txns6h: coverageFor(pools, (p) => p.buys6h),
    txns24h: coverageFor(pools, (p) => p.buys24h),
  };

  return {
    liquidity: coverageFor(pools, (p) => p.liquidityUsd),
    activity,
  };
}

/**
 * Builds a displayed-liquidity structure profile for one canonical asset
 * from its already-validated, deduplicated Phase 2 pools. Pure and
 * synchronous — no provider calls, no I/O. `poolCount`/`dexCount` count
 * every pool passed in regardless of whether it reports `liquidityUsd`;
 * every liquidity/volume/txn aggregate independently preserves null
 * (missing) vs. zero (reported as zero) — see README "Aggregation
 * semantics" for the full rules this function implements.
 */
export function buildAssetLiquidityProfile(
  asset: AssetIdentityForProfile,
  pools: readonly LiquidityPool[],
): AssetLiquidityProfile {
  const displayedLiquidityUsd = sumNullable(pools, (p) => p.liquidityUsd);

  const usdgLower = CANONICAL_USDG_ADDRESS.toLowerCase();
  const usdgPools = pools.filter((pool) => otherSide(pool).address.toLowerCase() === usdgLower);
  const usdGLiquidityUsd = sumNullable(usdgPools, (p) => p.liquidityUsd);

  return {
    asset: {
      symbol: asset.symbol,
      name: asset.name,
      contractAddress: asset.contractAddress,
    },
    displayedLiquidityUsd,
    usdGLiquidityUsd,
    poolCount: pools.length,
    dexCount: new Set(pools.map((p) => p.dexId)).size,
    largestPool: computeLargestPool(pools, displayedLiquidityUsd),
    concentration: computeConcentration(pools),
    quoteAssets: computeQuoteAssetComposition(pools),
    dexes: computeDexComposition(pools),
    activity: computeActivity(pools),
    coverage: computeCoverage(pools),
    pools,
  };
}
