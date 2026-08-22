import { createTtlCache, type TtlCache } from "@/lib/cache/ttlCache";
import { buildMarketLiquiditySnapshot } from "./snapshot";
import type { MarketLiquiditySnapshot } from "./types";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes — see README "Cache strategy" for why.

function resolveTtlMs(): number {
  const raw = process.env.MARKET_SNAPSHOT_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`MARKET_SNAPSHOT_TTL_MS must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

const TTL_MS = resolveTtlMs();

// A plain module-level `const` is NOT reliably a true process-wide
// singleton under Next.js: the home page (`src/app/page.tsx`) and the
// API route (`src/app/api/market/liquidity/route.ts`) are separate
// bundler entry points, and empirically (verified via a live two-request
// test — see README "Cache strategy") each got its OWN independently
// module-evaluated instance of a plain top-level `const`, defeating
// single-flight across them: hitting `/` then `/api/market/liquidity`
// triggered two full ~197s snapshot builds instead of one. `globalThis`
// is the one thing genuinely shared process-wide regardless of which
// bundle first imports this module, so the singleton lives there.
declare global {
  var __marketSnapshotCache: TtlCache<MarketLiquiditySnapshot> | undefined;
}

function getSnapshotCache(): TtlCache<MarketLiquiditySnapshot> {
  globalThis.__marketSnapshotCache ??= createTtlCache<MarketLiquiditySnapshot>({
    ttlMs: TTL_MS,
    produce: () => buildMarketLiquiditySnapshot(),
  });
  return globalThis.__marketSnapshotCache;
}

export interface MarketLiquiditySnapshotWithCacheMeta {
  readonly snapshot: MarketLiquiditySnapshot;
  readonly cache: {
    readonly status: "fresh" | "stale";
    readonly ageMs: number;
    readonly ttlMs: number;
  };
}

/**
 * Returns the current market liquidity snapshot: immediately if a fresh
 * one is cached, otherwise builds a new one and awaits it (single-flight
 * — concurrent callers all join the same in-flight build rather than
 * each triggering their own; see `createTtlCache`). This is what
 * `GET /api/market/liquidity` and the home page both call, and they
 * share one cache instance (see the `globalThis` note above).
 */
export async function getMarketLiquiditySnapshot(): Promise<MarketLiquiditySnapshotWithCacheMeta> {
  const entry = await getSnapshotCache().get();
  const ageMs = Date.now() - entry.generatedAt;
  return {
    snapshot: entry.value,
    cache: {
      status: ageMs <= TTL_MS ? "fresh" : "stale",
      ageMs,
      ttlMs: TTL_MS,
    },
  };
}
