"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { MarketLiquidityRow } from "@/domain/market";
import {
  filterMarketRows,
  sortMarketRowsByColumn,
  type SortableColumn,
  type SortDirection,
} from "@/app/_lib/marketTable";

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function formatPct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

interface ColumnDef {
  readonly key: SortableColumn;
  readonly label: string;
  readonly format: (row: MarketLiquidityRow) => string;
  readonly incomplete?: (row: MarketLiquidityRow) => boolean;
}

const COLUMNS: readonly ColumnDef[] = [
  {
    key: "displayedLiquidityUsd",
    label: "Displayed Liquidity",
    format: (r) => formatUsd(r.displayedLiquidityUsd),
    incomplete: (r) => !r.liquidityCoverageComplete,
  },
  { key: "usdGLiquidityUsd", label: "USDG Liquidity", format: (r) => formatUsd(r.usdGLiquidityUsd) },
  {
    key: "observedVolume24h",
    label: "Observed 24h Volume",
    format: (r) => formatUsd(r.observedVolume24h),
    incomplete: (r) => !r.volume24hCoverageComplete,
  },
  { key: "poolCount", label: "Pools", format: (r) => formatCount(r.poolCount) },
  { key: "dexCount", label: "DEXes", format: (r) => formatCount(r.dexCount) },
  {
    key: "top3ConcentrationPct",
    label: "Top-3 Concentration",
    format: (r) => formatPct(r.top3ConcentrationPct),
  },
];

export function MarketLeaderboard({ rows }: { rows: readonly MarketLiquidityRow[] }) {
  const [query, setQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<SortableColumn>("displayedLiquidityUsd");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const visibleRows = useMemo(() => {
    // Pure, no-network: filtering/sorting run entirely on the rows
    // already fetched server-side. Typing in the search box never
    // triggers a request.
    return sortMarketRowsByColumn(filterMarketRows(rows, query), sortColumn, sortDirection);
  }, [rows, query, sortColumn, sortDirection]);

  function toggleSort(column: SortableColumn) {
    if (column === sortColumn) {
      setSortDirection((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  }

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search symbol or name…"
        className="w-full max-w-xs rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
      />

      <div className="mt-4 max-h-[70vh] overflow-auto rounded border border-neutral-900">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-neutral-950">
            <tr className="border-b border-neutral-800 text-left text-neutral-400">
              <th className="py-2 pl-3 pr-4 font-medium">Stock</th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className="cursor-pointer select-none py-2 pr-4 text-right font-medium hover:text-neutral-200"
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}
                  {sortColumn === col.key ? (sortDirection === "desc" ? " ↓" : " ↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={row.asset.contractAddress}
                className="border-b border-neutral-900 hover:bg-neutral-900/50"
              >
                <td className="py-2 pl-3 pr-4">
                  <Link
                    href={`/assets/${row.asset.symbol}`}
                    className="font-mono text-blue-400 hover:underline"
                  >
                    {row.asset.symbol}
                  </Link>
                </td>
                {COLUMNS.map((col) => (
                  <td key={col.key} className="py-2 pr-4 text-right tabular-nums">
                    {col.format(row)}
                    {col.incomplete?.(row) && (
                      <span
                        className="ml-1 text-amber-500"
                        title="Partial data — not all pools reported this metric"
                      >
                        †
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {visibleRows.length === 0 && (
          <p className="p-4 text-sm text-neutral-500">No assets match &ldquo;{query}&rdquo;.</p>
        )}
      </div>
    </div>
  );
}
