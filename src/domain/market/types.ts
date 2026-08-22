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
}
