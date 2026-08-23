import { z } from "zod";

/**
 * Zod schemas for the Robinhood price endpoint
 * (`GET https://api.robinhood.com/rhj/prices/{symbol}` and, undocumented
 * but live-confirmed, `GET https://api.robinhood.com/rhj/prices` with no
 * symbol — see client.ts). Both return the identical `{ quotes: [...] }`
 * envelope; the no-symbol form returns one quote per canonical asset
 * (194/194 confirmed live) instead of a single-element array.
 *
 * Confirmed live, not assumed:
 *  - There is no single "price" field. `bid`/`ask` are decimal *strings*,
 *    and per Robinhood's own docs are "the raw underlying-equity bid/ask
 *    passed through as-is — not multiplier-adjusted." Converting to a
 *    token-equivalent USD price requires multiplying by the canonical
 *    asset's `currentMultiplier` from Phase 1 — see
 *    `src/domain/price/compare.ts`.
 *  - Symbol lookup on the single-symbol form is case-sensitive
 *    (lowercase 404s) — irrelevant here since callers always pass the
 *    canonical registry's own `symbol` casing.
 *  - An unknown symbol on the single-symbol form returns HTTP 404 with a
 *    gRPC-style `{code, message, details}` body, not this schema's shape
 *    — handled as a non-2xx response by the HTTP client, not parsed here.
 *  - Fields observed but not depended on downstream (kept lenient/
 *    optional rather than omitted, since they may be useful context):
 *    `dailyTradingVolume`, `dailyHigh`, `dailyLow`, `mintBurnTokenVolume`,
 *    `mintBurnUsdVolume`, `deployments[]`.
 */

const NUMERIC_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

const robinhoodPriceDeploymentSchema = z.object({
  contractAddress: z.string(),
  chainId: z.number().int(),
});

export const robinhoodPriceQuoteSchema = z.object({
  tokenSymbol: z.string().min(1),
  deployments: z.array(robinhoodPriceDeploymentSchema).optional(),
  bid: z.string().regex(NUMERIC_STRING_PATTERN, "bid must be a numeric string"),
  ask: z.string().regex(NUMERIC_STRING_PATTERN, "ask must be a numeric string"),
  currency: z.string().min(1),
  dailyTradingVolume: z.string().regex(NUMERIC_STRING_PATTERN).optional(),
  isTradingHalt: z.boolean(),
  generatedAt: z.string().min(1),
  dailyHigh: z.string().regex(NUMERIC_STRING_PATTERN).optional(),
  dailyLow: z.string().regex(NUMERIC_STRING_PATTERN).optional(),
  mintBurnTokenVolume: z.string().regex(NUMERIC_STRING_PATTERN).optional(),
  mintBurnUsdVolume: z.string().regex(NUMERIC_STRING_PATTERN).optional(),
});

export const robinhoodPricesResponseSchema = z.object({
  quotes: z.array(robinhoodPriceQuoteSchema),
});

export type RobinhoodPriceQuote = z.infer<typeof robinhoodPriceQuoteSchema>;
export type RobinhoodPricesResponse = z.infer<typeof robinhoodPricesResponseSchema>;
