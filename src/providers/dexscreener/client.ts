import {
  fetchWithTimeout,
  HttpNetworkError,
  HttpTimeoutError,
} from "@/lib/http/fetchWithTimeout";
import {
  dexScreenerPairsResponseSchema,
  type DexScreenerPairsResponse,
} from "./schema";
import {
  DexScreenerHttpError,
  DexScreenerInvalidJsonError,
  DexScreenerNetworkError,
  DexScreenerSchemaValidationError,
  DexScreenerTimeoutError,
} from "./errors";

const DEFAULT_BASE_URL = "https://api.dexscreener.com";
const DEFAULT_TIMEOUT_MS = 8000;

export interface FetchDexScreenerPairsOptions {
  /** Overrides DEXSCREENER_API_BASE_URL / the built-in default. */
  baseUrl?: string;
  /** Overrides DEXSCREENER_API_TIMEOUT_MS / the built-in default. */
  timeoutMs?: number;
  /** Injectable fetch implementation, primarily for deterministic tests. */
  fetchImpl?: typeof fetch;
}

function resolveBaseUrl(options: FetchDexScreenerPairsOptions): string {
  return (
    options.baseUrl ?? process.env.DEXSCREENER_API_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveTimeoutMs(options: FetchDexScreenerPairsOptions): number {
  if (options.timeoutMs !== undefined) return options.timeoutMs;
  const fromEnv = Number(process.env.DEXSCREENER_API_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

/**
 * Fetches and validates raw Dexscreener pair records for `tokenAddress`
 * on `chainId`.
 *
 * This is a **low-level, provider-only** function: it does not verify
 * that `tokenAddress` is a canonical Robinhood Stock Token, and it
 * accepts arbitrary `chainId`/`tokenAddress` input for reuse and
 * testability. It exists so `src/domain/pool/service.ts` (and tests) can
 * fetch raw pool data directly — callers needing the canonical-identity
 * guarantee must go through the domain layer's public API instead.
 *
 * A response of `[]` (the token has no pools, per Dexscreener) is a
 * successful result, not an error — Dexscreener returns HTTP 200 with an
 * empty array for a token with no pools, an unrecognized chain ID, or
 * even a malformed token address, so this function cannot and does not
 * try to distinguish those cases from genuine emptiness. Canonical
 * identity and chain-ID correctness are re-validated per-pool in the
 * domain layer instead (see `src/domain/pool/normalize.ts`).
 */
export async function fetchDexScreenerPairs(
  chainId: string,
  tokenAddress: string,
  options: FetchDexScreenerPairsOptions = {},
): Promise<DexScreenerPairsResponse> {
  const baseUrl = resolveBaseUrl(options);
  const timeoutMs = resolveTimeoutMs(options);
  const url = `${baseUrl}/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      timeoutMs,
      fetchImpl: options.fetchImpl,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (err instanceof HttpTimeoutError) {
      throw new DexScreenerTimeoutError(
        `Timed out fetching Dexscreener pools after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    if (err instanceof HttpNetworkError) {
      throw new DexScreenerNetworkError(
        "Network error fetching Dexscreener pools",
        { cause: err },
      );
    }
    throw err;
  }

  if (!response.ok) {
    throw new DexScreenerHttpError(response.status, response.statusText);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new DexScreenerInvalidJsonError(
      "Dexscreener response was not valid JSON",
      { cause: err },
    );
  }

  const parsed = dexScreenerPairsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new DexScreenerSchemaValidationError(
      "Dexscreener response did not match the expected schema",
      parsed.error.issues,
    );
  }

  return parsed.data;
}
