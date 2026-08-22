import type { MarketLiquidityRow } from "@/domain/market";

export type SortableColumn =
  | "displayedLiquidityUsd"
  | "usdGLiquidityUsd"
  | "observedVolume24h"
  | "poolCount"
  | "dexCount"
  | "top3ConcentrationPct";

export type SortDirection = "asc" | "desc";

/**
 * Client-side, no-network filter by symbol/name substring
 * (case-insensitive). An empty/whitespace-only query returns every row.
 */
export function filterMarketRows(
  rows: readonly MarketLiquidityRow[],
  query: string,
): MarketLiquidityRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (row) =>
      row.asset.symbol.toLowerCase().includes(q) || row.asset.name.toLowerCase().includes(q),
  );
}

/**
 * Client-side numeric sort by a chosen column. Rows whose value for
 * `column` is `null` always sort last, regardless of `direction` —
 * "missing data" is deprioritized in both directions rather than
 * flipping to the top on ascending sort. Ties (including all-null) break
 * by symbol ascending, for determinism independent of row order.
 */
export function sortMarketRowsByColumn(
  rows: readonly MarketLiquidityRow[],
  column: SortableColumn,
  direction: SortDirection,
): MarketLiquidityRow[] {
  const sign = direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    const av = a[column];
    const bv = b[column];

    if (av === null && bv === null) {
      return a.asset.symbol.localeCompare(b.asset.symbol);
    }
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return sign * (av - bv);
    return a.asset.symbol.localeCompare(b.asset.symbol);
  });
}
