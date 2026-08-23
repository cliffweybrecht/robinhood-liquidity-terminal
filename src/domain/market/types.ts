import type { Address } from "viem";

/**
 * Stable failure categories for a per-asset snapshot failure. Chosen to
 * be precise enough to be actionable without leaking raw stack traces
 * through the public API — see `classifyFailure` in `snapshot.ts`.
 */
export type MarketSnapshotFailureCategory =
  | "DEXSCREENER_TIMEOUT"
  | "DEXSCREENER_NETWORK"
  | "DEXSCREENER_HTTP"
  | "DEXSCREENER_INVALID_RESPONSE"
  | "DEXSCREENER_SCHEMA_INVALID"
  | "POOL_INTEGRITY_CONFLICT"
  | "UNEXPECTED";

export interface MarketSnapshotFailure {
  readonly symbol: string;
  readonly contractAddress: Address;
  readonly category: MarketSnapshotFailureCategory;
  /** Human-readable detail for debugging — never a raw stack trace. */
  readonly message: string;
}

/**
 * One leaderboard row: a projection of a Phase 3 `AssetLiquidityProfile`
 * (see `project.ts`) plus the asset's logo. Never independently
 * recomputed from pools — always derived from the same
 * `buildAssetLiquidityProfile` output Phase 3's single-asset API uses.
 */
export interface MarketLiquidityRow {
  readonly asset: {
    readonly symbol: string;
    readonly name: string;
    readonly contractAddress: Address;
    readonly logoUrl: string | null;
  };

  readonly displayedLiquidityUsd: number | null;
  readonly usdGLiquidityUsd: number | null;

  readonly poolCount: number;
  readonly dexCount: number;

  readonly observedVolume24h: number | null;
  readonly buys24h: number | null;
  readonly sells24h: number | null;

  readonly largestPoolLiquidityUsd: number | null;

  readonly top1ConcentrationPct: number | null;
  readonly top3ConcentrationPct: number | null;
  readonly top5ConcentrationPct: number | null;

  readonly liquidityCoverageComplete: boolean;
  readonly volume24hCoverageComplete: boolean;

  /**
   * Phase 5 price fields — always present as keys (consistent with
   * every other nullable metric in this codebase), but only populated
   * (non-null) when the snapshot's bulk Robinhood price fetch succeeded,
   * returned a quote for this asset's exact canonical symbol, AND that
   * quote passed domain validation (see `InvalidReferenceQuoteError`/
   * `CrossedReferenceMarketError` in `@/domain/price`). `null` here
   * means "not available this cycle," never a fabricated `0` — see
   * `MarketLiquiditySnapshot.price` for *why* it might be unavailable
   * (whole-snapshot price outage, this symbol missing from the bulk
   * response, or a present-but-invalid quote — three distinct reasons,
   * tracked separately on `MarketPriceMeta`, never conflated). A `null`
   * price never implies the liquidity fields above are also invalid —
   * the two are fetched and computed independently.
   *
   * Hardening pass: `premiumDiscountPct` is the **headline** signal and
   * is derived from `dexMedianPriceUsd`, not `dexLiquidityWeightedPriceUsd`
   * — see README "Outlier resistance — hardening decision" for the live
   * evidence behind this choice. `dexLiquidityWeightedPriceUsd` remains
   * populated as a raw diagnostic (unfiltered, exactly as Phase 5
   * originally computed it) but no longer drives this row's single
   * premium/discount number, since one garbage-but-positive-liquidity
   * pool can disproportionately move a liquidity-weighted average in a
   * way it cannot move a median.
   */
  readonly robinhoodReferencePriceUsd: number | null;
  readonly dexLiquidityWeightedPriceUsd: number | null;
  /** Headline DEX price basis — median of all usable per-pool prices. See `premiumDiscountPct` doc above. */
  readonly dexMedianPriceUsd: number | null;
  /** `(dexMedianPriceUsd - robinhoodReferencePriceUsd) / robinhoodReferencePriceUsd * 100` — the headline premium/discount signal. */
  readonly premiumDiscountPct: number | null;
  readonly priceDispersionPct: number | null;
  /** `null` when price data is unavailable for this row at all (see above); otherwise mirrors `DexPriceSummary.priceCoverage.complete`. */
  readonly priceCoverageComplete: boolean | null;
}

/**
 * Snapshot-wide price-integration status. Distinct from per-row price
 * nulls: this tells you *why* rows might be missing price data — the
 * one bulk Robinhood price fetch failed entirely (`available: false`,
 * every row's price fields are null), it succeeded but some canonical
 * symbols weren't present in the response (`symbolsMissing > 0`,
 * `missingSymbols` names them), or a symbol *was* present but its quote
 * failed domain validation — crossed market, non-finite/negative
 * bid/ask, or an invalid multiplier (`symbolsInvalid > 0`,
 * `invalidSymbols` names them; see `@/domain/price`'s
 * `InvalidReferenceQuoteError`/`CrossedReferenceMarketError`). These are
 * three genuinely distinct failure reasons and are never collapsed into
 * one count or one list — "absent from the bulk response" and "present
 * but rejected by domain validation" are different upstream problems. A
 * whole-snapshot price outage, and any number of missing/invalid
 * symbols, never fails the liquidity snapshot itself — see
 * `src/domain/market/snapshot.ts`.
 */
export interface MarketPriceMeta {
  readonly available: boolean;
  /** ISO 8601 — when the bulk price fetch completed; `null` if `available` is false. Application-side completion time, not a Robinhood quote timestamp — see `oldestQuoteGeneratedAt`/`newestQuoteGeneratedAt` below for that. */
  readonly generatedAt: string | null;
  readonly symbolsMatched: number;
  readonly symbolsMissing: number;
  /**
   * Canonical registry symbols (Phase 1's own `symbol` casing — never a
   * Dexscreener-reported label, never fuzzy-matched) that were absent
   * from the bulk Robinhood price response. Deterministically sorted
   * ascending. Empty when `symbolsMissing` is `0` or when
   * `available` is `false` (in that case every symbol is "missing" in
   * effect, but enumerating all ~194 would be redundant with
   * `available: false` itself, so this list is only populated for the
   * partial-miss case).
   */
  readonly missingSymbols: readonly string[];
  /** Count of symbols present in the bulk response whose quote failed domain validation (crossed market / invalid numeric state) — see `invalidSymbols`. */
  readonly symbolsInvalid: number;
  /** Canonical symbols (same sorting/casing rules as `missingSymbols`) whose bulk quote was present but rejected by `buildRobinhoodReferencePrice`'s domain validation. */
  readonly invalidSymbols: readonly string[];
  /**
   * Oldest/newest `generatedAt` timestamp across every quote in the bulk
   * response (Robinhood's own per-quote timestamp, not this
   * application's). `null` when `available` is `false` or the response
   * contained zero quotes. Robinhood's bulk quotes are not guaranteed to
   * share one timestamp — see README "Price freshness" for what was
   * actually observed live. These never imply DEX pool observations
   * were captured at the same time as any Robinhood quote; the two data
   * sources are independently timestamped and independently fetched.
   */
  readonly oldestQuoteGeneratedAt: string | null;
  readonly newestQuoteGeneratedAt: string | null;
}

/**
 * A market-wide displayed-liquidity snapshot: one `buildAssetLiquidityProfile`
 * projection per canonical asset that succeeded, plus explicit records
 * of every asset that failed. This is **displayed** liquidity data
 * captured at one point in time — not executable liquidity, and not
 * historical persistence (see README).
 */
export interface MarketLiquiditySnapshot {
  /** ISO 8601 — when snapshot generation *started*. */
  readonly refreshStartedAt: string;
  /** ISO 8601 — when snapshot generation *completed*. This is what "freshness" is measured from, not `refreshStartedAt`. */
  readonly generatedAt: string;
  /** `generatedAt - refreshStartedAt` in ms — how long this snapshot took to build. Never implied to be instantaneous. */
  readonly refreshDurationMs: number;

  readonly assetsRequested: number;
  readonly assetsSucceeded: number;
  readonly assetsFailed: number;

  readonly completeness: {
    readonly complete: boolean;
    readonly successPct: number;
  };

  /**
   * Deterministically ordered (see `sortMarketRows`) — NOT named
   * `profiles`, deliberately: these are projected leaderboard rows, not
   * full `AssetLiquidityProfile` objects (which remain available
   * per-asset via `GET /api/assets/{symbol}/liquidity`).
   */
  readonly rows: readonly MarketLiquidityRow[];
  readonly failures: readonly MarketSnapshotFailure[];

  readonly price: MarketPriceMeta;
}
