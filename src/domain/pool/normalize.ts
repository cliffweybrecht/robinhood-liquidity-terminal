import { getAddress, isAddress } from "viem";
import type { Hex } from "viem";
import type { DexScreenerPair, DexScreenerToken } from "@/providers/dexscreener";
import { isValidPairIdentifier } from "./address";
import { DuplicatePoolConflictError } from "./errors";
import type { CanonicalAssetSide, LiquidityPool, PoolToken } from "./types";

export type PoolRejectionReason =
  | "WRONG_CHAIN"
  | "INVALID_PAIR_ADDRESS"
  | "INVALID_BASE_TOKEN_ADDRESS"
  | "INVALID_QUOTE_TOKEN_ADDRESS"
  | "MISSING_QUOTE_TOKEN"
  | "DOES_NOT_CONTAIN_CANONICAL_ASSET"
  | "BOTH_SIDES_MATCH_CANONICAL_ASSET";

export interface PoolRejection {
  readonly reason: PoolRejectionReason;
  readonly dexId: string;
  readonly pairAddress: string;
}

export type PoolNormalizationResult =
  | { readonly accepted: true; readonly pool: LiquidityPool }
  | { readonly accepted: false; readonly rejection: PoolRejection };

export interface CanonicalAssetIdentity {
  readonly contractAddress: string;
  readonly symbol: string;
}

function toNullableNumber(value: number | null | undefined): number | null {
  return value ?? null;
}

/**
 * Dexscreener represents priceNative/priceUsd as numeric strings. The
 * Zod schema already guarantees numeric-string shape for values that
 * reach this function via the HTTP client, but this function is also
 * called directly with hand-written fixtures in tests (defense in
 * depth), so an unparseable string is treated as "we don't trust this
 * value" and mapped to null rather than propagating NaN.
 */
function parseNullableNumericString(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toPoolToken(raw: DexScreenerToken): PoolToken | null {
  if (!isAddress(raw.address)) return null;
  return { address: getAddress(raw.address), name: raw.name, symbol: raw.symbol };
}

function normalizePairAddress(value: string): Hex {
  // Only 20-byte addresses have an EIP-55 checksum; 32-byte Uniswap v4
  // PoolIds have no such standard, so lowercase is the canonical form.
  return (isAddress(value) ? getAddress(value) : value.toLowerCase()) as Hex;
}

/**
 * Validates and normalizes a single raw Dexscreener pair record against
 * one canonical Robinhood asset, or reports why it was rejected.
 *
 * Pure and independent of the Zod schema layer at the HTTP boundary —
 * defense in depth, matching `src/domain/asset/registry.ts`: this
 * function does not trust that its caller already validated `raw`, so
 * it can be exercised directly with hand-written fixtures in tests.
 */
export function normalizePool(
  raw: DexScreenerPair,
  canonicalAsset: CanonicalAssetIdentity,
  expectedChainId: string,
): PoolNormalizationResult {
  const reject = (reason: PoolRejectionReason): PoolNormalizationResult => ({
    accepted: false,
    rejection: { reason, dexId: raw.dexId, pairAddress: raw.pairAddress },
  });

  const baseToken = toPoolToken(raw.baseToken);
  if (!baseToken) return reject("INVALID_BASE_TOKEN_ADDRESS");

  if (!raw.quoteToken) return reject("MISSING_QUOTE_TOKEN");
  const quoteToken = toPoolToken(raw.quoteToken);
  if (!quoteToken) return reject("INVALID_QUOTE_TOKEN_ADDRESS");

  if (!isValidPairIdentifier(raw.pairAddress)) return reject("INVALID_PAIR_ADDRESS");

  if (raw.chainId !== expectedChainId) return reject("WRONG_CHAIN");

  const canonicalLower = canonicalAsset.contractAddress.toLowerCase();
  const baseIsCanonical = baseToken.address.toLowerCase() === canonicalLower;
  const quoteIsCanonical = quoteToken.address.toLowerCase() === canonicalLower;

  if (baseIsCanonical && quoteIsCanonical) {
    return reject("BOTH_SIDES_MATCH_CANONICAL_ASSET");
  }
  if (!baseIsCanonical && !quoteIsCanonical) {
    return reject("DOES_NOT_CONTAIN_CANONICAL_ASSET");
  }

  const canonicalAssetSide: CanonicalAssetSide = baseIsCanonical ? "base" : "quote";

  const pool: LiquidityPool = {
    provider: "dexscreener",
    chainId: raw.chainId,
    dexId: raw.dexId,
    pairAddress: normalizePairAddress(raw.pairAddress),
    canonicalAssetAddress: getAddress(canonicalAsset.contractAddress),
    canonicalAssetSymbol: canonicalAsset.symbol,
    canonicalAssetSide,
    baseToken,
    quoteToken,
    priceUsd: parseNullableNumericString(raw.priceUsd),
    priceNative: parseNullableNumericString(raw.priceNative),
    liquidityUsd: toNullableNumber(raw.liquidity?.usd),
    liquidityBase: toNullableNumber(raw.liquidity?.base),
    liquidityQuote: toNullableNumber(raw.liquidity?.quote),
    volume5m: toNullableNumber(raw.volume?.m5),
    volume1h: toNullableNumber(raw.volume?.h1),
    volume6h: toNullableNumber(raw.volume?.h6),
    volume24h: toNullableNumber(raw.volume?.h24),
    buys5m: toNullableNumber(raw.txns?.m5?.buys),
    sells5m: toNullableNumber(raw.txns?.m5?.sells),
    buys1h: toNullableNumber(raw.txns?.h1?.buys),
    sells1h: toNullableNumber(raw.txns?.h1?.sells),
    buys6h: toNullableNumber(raw.txns?.h6?.buys),
    sells6h: toNullableNumber(raw.txns?.h6?.sells),
    buys24h: toNullableNumber(raw.txns?.h24?.buys),
    sells24h: toNullableNumber(raw.txns?.h24?.sells),
    priceChange5m: toNullableNumber(raw.priceChange?.m5),
    priceChange1h: toNullableNumber(raw.priceChange?.h1),
    priceChange6h: toNullableNumber(raw.priceChange?.h6),
    priceChange24h: toNullableNumber(raw.priceChange?.h24),
    fdv: toNullableNumber(raw.fdv),
    marketCap: toNullableNumber(raw.marketCap),
    pairCreatedAt: toNullableNumber(raw.pairCreatedAt),
    dexScreenerUrl: raw.url ?? null,
    labels: raw.labels ?? [],
  };

  return { accepted: true, pool };
}

function poolDedupeKey(pool: LiquidityPool): string {
  return `${pool.chainId}:${pool.pairAddress.toLowerCase()}`;
}

/**
 * Structural equality for "materially identical" duplicate detection.
 * Compares with `pairAddress` case-folded, matching the case-insensitive
 * dedupe key above — two records that agree on everything except
 * `pairAddress` casing are the same pool, not a conflict.
 */
function materiallyEqual(a: LiquidityPool, b: LiquidityPool): boolean {
  const canonicalize = (pool: LiquidityPool) =>
    JSON.stringify({ ...pool, pairAddress: pool.pairAddress.toLowerCase() });
  return canonicalize(a) === canonicalize(b);
}

/**
 * Deduplicates pools by `chainId` + `pairAddress`. Materially identical
 * duplicate records are silently collapsed to one; duplicate records
 * that disagree on any normalized field throw `DuplicatePoolConflictError`
 * rather than silently picking one — see that error's doc comment.
 */
export function dedupePools(pools: readonly LiquidityPool[]): LiquidityPool[] {
  const byKey = new Map<string, LiquidityPool>();

  for (const pool of pools) {
    const key = poolDedupeKey(pool);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, pool);
      continue;
    }
    if (!materiallyEqual(existing, pool)) {
      throw new DuplicatePoolConflictError(pool.chainId, pool.pairAddress);
    }
  }

  return [...byKey.values()];
}

export interface NormalizePoolsResult {
  readonly pools: readonly LiquidityPool[];
  readonly rejected: readonly PoolRejection[];
}

/**
 * Normalizes a full batch of raw Dexscreener pairs against one
 * canonical asset: validates + normalizes each independently (an
 * individual malformed/non-participating pool is excluded, not a batch
 * failure — see README), then deduplicates the accepted set.
 */
export function normalizePools(
  rawPairs: readonly DexScreenerPair[],
  canonicalAsset: CanonicalAssetIdentity,
  expectedChainId: string,
): NormalizePoolsResult {
  const rejected: PoolRejection[] = [];
  const accepted: LiquidityPool[] = [];

  for (const raw of rawPairs) {
    const result = normalizePool(raw, canonicalAsset, expectedChainId);
    if (result.accepted) {
      accepted.push(result.pool);
    } else {
      rejected.push(result.rejection);
    }
  }

  return { pools: dedupePools(accepted), rejected };
}
