import { z } from "zod";

/**
 * Zod schemas for the Dexscreener token-pairs endpoint
 * (`GET https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}`).
 *
 * These describe the *actual observed* live response shape (verified
 * against `.../robinhood/{NVDA contract address}`), not the conceptual
 * shape from product docs. Confirmed deviations:
 *
 *  - The top-level response is a bare JSON array, not `{ pairs: [...] }`.
 *  - `priceNative`/`priceUsd` are numeric *strings* (e.g. `"215.18"`),
 *    not JSON numbers.
 *  - `pairAddress` is a 20-byte deployed contract address for most
 *    DEXes, but Uniswap v4 pools report a 32-byte PoolId instead (v4
 *    pools are managed by a singleton PoolManager contract rather than
 *    individually deployed per-pool contracts). The `labels` field is
 *    NOT a reliable discriminator for which form a pool uses — one live
 *    pool carried the label "v4" but used a 20-byte address — so both
 *    lengths are accepted here based on their actual shape, not on
 *    `labels`. See `src/domain/pool/address.ts`.
 *  - `priceChange`'s per-timeframe sub-fields (`m5`/`h1`/`h6`/`h24`) are
 *    inconsistently present — some pools report only `h24`.
 *  - Dexscreener returns HTTP 200 with `[]` for a token with no pools,
 *    an unrecognized chain ID, *or* a malformed token address — it never
 *    errors on bad input. An empty array is a legitimate result, not a
 *    signal of any of those problems.
 */

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
// Uniswap v4 pools are identified by a bytes32 PoolId, not a per-pool
// deployed contract address — see module doc comment above.
const HEX_POOL_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const NUMERIC_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

const dexScreenerPairAddressSchema = z
  .string()
  .refine(
    (value) => HEX_ADDRESS_PATTERN.test(value) || HEX_POOL_ID_PATTERN.test(value),
    "pairAddress must be a 20-byte contract address or a 32-byte pool ID",
  );

const dexScreenerTokenSchema = z.object({
  address: z
    .string()
    .regex(HEX_ADDRESS_PATTERN, "token address must be a 0x-prefixed 40-hex-character address"),
  name: z.string(),
  symbol: z.string(),
});

const dexScreenerTxnsWindowSchema = z.object({
  buys: z.number(),
  sells: z.number(),
});

const dexScreenerTxnsSchema = z
  .object({
    m5: dexScreenerTxnsWindowSchema.optional(),
    h1: dexScreenerTxnsWindowSchema.optional(),
    h6: dexScreenerTxnsWindowSchema.optional(),
    h24: dexScreenerTxnsWindowSchema.optional(),
  })
  .optional();

const dexScreenerWindowNumberSchema = z
  .object({
    m5: z.number().optional(),
    h1: z.number().optional(),
    h6: z.number().optional(),
    h24: z.number().optional(),
  })
  .optional();

const dexScreenerLiquiditySchema = z
  .object({
    usd: z.number().nullish(),
    base: z.number().nullish(),
    quote: z.number().nullish(),
  })
  .nullish();

export const dexScreenerPairSchema = z.object({
  chainId: z.string().min(1),
  dexId: z.string().min(1),
  url: z.string().min(1),
  pairAddress: dexScreenerPairAddressSchema,
  labels: z.array(z.string()).nullish(),
  baseToken: dexScreenerTokenSchema,
  quoteToken: dexScreenerTokenSchema.nullish(),
  priceNative: z.string().regex(NUMERIC_STRING_PATTERN),
  priceUsd: z.string().regex(NUMERIC_STRING_PATTERN).nullish(),
  txns: dexScreenerTxnsSchema,
  volume: dexScreenerWindowNumberSchema,
  priceChange: dexScreenerWindowNumberSchema,
  liquidity: dexScreenerLiquiditySchema,
  fdv: z.number().nullish(),
  marketCap: z.number().nullish(),
  pairCreatedAt: z.number().nullish(),
});

export const dexScreenerPairsResponseSchema = z.array(dexScreenerPairSchema);

export type DexScreenerToken = z.infer<typeof dexScreenerTokenSchema>;
export type DexScreenerPair = z.infer<typeof dexScreenerPairSchema>;
export type DexScreenerPairsResponse = z.infer<
  typeof dexScreenerPairsResponseSchema
>;
