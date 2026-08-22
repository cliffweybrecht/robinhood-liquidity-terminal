import { describe, expect, it } from "vitest";
import type { MarketLiquidityRow } from "@/domain/market";
import { filterMarketRows, sortMarketRowsByColumn } from "../marketTable";

const ADDR = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

function row(overrides: Partial<MarketLiquidityRow> = {}): MarketLiquidityRow {
  return {
    asset: { symbol: "NVDA", name: "NVIDIA • Robinhood Token", contractAddress: ADDR, logoUrl: null },
    displayedLiquidityUsd: 100,
    usdGLiquidityUsd: 100,
    poolCount: 1,
    dexCount: 1,
    observedVolume24h: 100,
    buys24h: 1,
    sells24h: 1,
    largestPoolLiquidityUsd: 100,
    top1ConcentrationPct: 100,
    top3ConcentrationPct: 100,
    top5ConcentrationPct: 100,
    liquidityCoverageComplete: true,
    volume24hCoverageComplete: true,
    ...overrides,
  };
}

describe("filterMarketRows", () => {
  const rows = [
    row({ asset: { ...row().asset, symbol: "NVDA", name: "NVIDIA • Robinhood Token" } }),
    row({ asset: { ...row().asset, symbol: "AAPL", name: "Apple • Robinhood Token" } }),
    row({ asset: { ...row().asset, symbol: "MSFT", name: "Microsoft • Robinhood Token" } }),
  ];

  it("returns every row for an empty query", () => {
    expect(filterMarketRows(rows, "")).toHaveLength(3);
    expect(filterMarketRows(rows, "   ")).toHaveLength(3);
  });

  it("matches by symbol, case-insensitively", () => {
    expect(filterMarketRows(rows, "nvda").map((r) => r.asset.symbol)).toEqual(["NVDA"]);
    expect(filterMarketRows(rows, "NVDA").map((r) => r.asset.symbol)).toEqual(["NVDA"]);
  });

  it("matches by name substring, case-insensitively", () => {
    expect(filterMarketRows(rows, "micro").map((r) => r.asset.symbol)).toEqual(["MSFT"]);
    expect(filterMarketRows(rows, "apple").map((r) => r.asset.symbol)).toEqual(["AAPL"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterMarketRows(rows, "zzz-no-match")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const copy = [...rows];
    filterMarketRows(rows, "nvda");
    expect(rows).toEqual(copy);
  });
});

describe("sortMarketRowsByColumn", () => {
  it("sorts numerically descending by the chosen column", () => {
    const rows = [
      row({ asset: { ...row().asset, symbol: "A" }, poolCount: 5 }),
      row({ asset: { ...row().asset, symbol: "B" }, poolCount: 20 }),
      row({ asset: { ...row().asset, symbol: "C" }, poolCount: 10 }),
    ];
    expect(sortMarketRowsByColumn(rows, "poolCount", "desc").map((r) => r.asset.symbol)).toEqual([
      "B",
      "C",
      "A",
    ]);
  });

  it("sorts numerically ascending by the chosen column", () => {
    const rows = [
      row({ asset: { ...row().asset, symbol: "A" }, dexCount: 5 }),
      row({ asset: { ...row().asset, symbol: "B" }, dexCount: 1 }),
      row({ asset: { ...row().asset, symbol: "C" }, dexCount: 3 }),
    ];
    expect(sortMarketRowsByColumn(rows, "dexCount", "asc").map((r) => r.asset.symbol)).toEqual([
      "B",
      "C",
      "A",
    ]);
  });

  it("does not use lexicographic ordering for numeric columns (9 sorts below 10)", () => {
    const rows = [
      row({ asset: { ...row().asset, symbol: "A" }, poolCount: 9 }),
      row({ asset: { ...row().asset, symbol: "B" }, poolCount: 10 }),
      row({ asset: { ...row().asset, symbol: "C" }, poolCount: 2 }),
    ];
    expect(sortMarketRowsByColumn(rows, "poolCount", "asc").map((r) => r.asset.symbol)).toEqual([
      "C",
      "A",
      "B",
    ]);
  });

  it("sorts null values after every non-null value in descending order", () => {
    const rows = [
      row({ asset: { ...row().asset, symbol: "NULLROW" }, displayedLiquidityUsd: null }),
      row({ asset: { ...row().asset, symbol: "VALROW" }, displayedLiquidityUsd: 50 }),
    ];
    expect(sortMarketRowsByColumn(rows, "displayedLiquidityUsd", "desc").map((r) => r.asset.symbol)).toEqual([
      "VALROW",
      "NULLROW",
    ]);
  });

  it("sorts null values after every non-null value in ascending order too", () => {
    const rows = [
      row({ asset: { ...row().asset, symbol: "NULLROW" }, displayedLiquidityUsd: null }),
      row({ asset: { ...row().asset, symbol: "VALROW" }, displayedLiquidityUsd: 50 }),
    ];
    expect(sortMarketRowsByColumn(rows, "displayedLiquidityUsd", "asc").map((r) => r.asset.symbol)).toEqual([
      "VALROW",
      "NULLROW",
    ]);
  });

  it("breaks ties (including all-null) by symbol ascending", () => {
    const rows = [
      row({ asset: { ...row().asset, symbol: "ZZZ" }, usdGLiquidityUsd: null }),
      row({ asset: { ...row().asset, symbol: "AAA" }, usdGLiquidityUsd: null }),
      row({ asset: { ...row().asset, symbol: "CCC" }, usdGLiquidityUsd: 50 }),
      row({ asset: { ...row().asset, symbol: "BBB" }, usdGLiquidityUsd: 50 }),
    ];
    expect(sortMarketRowsByColumn(rows, "usdGLiquidityUsd", "desc").map((r) => r.asset.symbol)).toEqual([
      "BBB",
      "CCC",
      "AAA",
      "ZZZ",
    ]);
  });

  it("does not mutate the input array", () => {
    const rows = [row({ poolCount: 1 }), row({ poolCount: 2 })];
    const copy = [...rows];
    sortMarketRowsByColumn(rows, "poolCount", "asc");
    expect(rows).toEqual(copy);
  });
});
