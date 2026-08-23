import {
  fetchWithTimeout,
  HttpNetworkError,
  HttpTimeoutError,
} from "@/lib/http/fetchWithTimeout";
import {
  robinhoodPricesResponseSchema,
  type RobinhoodPricesResponse,
} from "./schema";
import {
  RobinhoodPriceHttpError,
  RobinhoodPriceInvalidJsonError,
  RobinhoodPriceNetworkError,
  RobinhoodPriceSchemaValidationError,
  RobinhoodPriceTimeoutError,
} from "./errors";

// Deliberately reuses ROBINHOOD_API_BASE_URL / ROBINHOOD_API_TIMEOUT_MS
// (from src/providers/robinhood/client.ts) rather than introducing
// duplicate env vars — `/rhj/prices` is the exact same host as
// `/rhj/assets`, with similar single-fetch latency (measured ~1-3s for
// both the single-symbol and the 194-quote bulk form), so a second,
// near-identical config surface would be redundant, not more correct.
const DEFAULT_BASE_URL = "https://api.robinhood.com";
const DEFAULT_TIMEOUT_MS = 8000;
const PRICES_PATH = "/rhj/prices";

export interface FetchRobinhoodPriceOptions {
  /** Overrides ROBINHOOD_API_BASE_URL / the built-in default. */
  baseUrl?: string;
  /** Overrides ROBINHOOD_API_TIMEOUT_MS / the built-in default. */
  timeoutMs?: number;
  /** Injectable fetch implementation, primarily for deterministic tests. */
  fetchImpl?: typeof fetch;
}

function resolveBaseUrl(options: FetchRobinhoodPriceOptions): string {
  return (
    options.baseUrl ?? process.env.ROBINHOOD_API_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveTimeoutMs(options: FetchRobinhoodPriceOptions): number {
  if (options.timeoutMs !== undefined) return options.timeoutMs;
  const fromEnv = Number(process.env.ROBINHOOD_API_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

async function fetchRobinhoodPricesInternal(
  pathSuffix: string,
  options: FetchRobinhoodPriceOptions,
): Promise<RobinhoodPricesResponse> {
  const baseUrl = resolveBaseUrl(options);
  const timeoutMs = resolveTimeoutMs(options);
  const url = `${baseUrl}${PRICES_PATH}${pathSuffix}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      timeoutMs,
      fetchImpl: options.fetchImpl,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (err instanceof HttpTimeoutError) {
      throw new RobinhoodPriceTimeoutError(
        `Timed out fetching Robinhood price(s) after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    if (err instanceof HttpNetworkError) {
      throw new RobinhoodPriceNetworkError(
        "Network error fetching Robinhood price(s)",
        { cause: err },
      );
    }
    throw err;
  }

  if (!response.ok) {
    throw new RobinhoodPriceHttpError(response.status, response.statusText);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new RobinhoodPriceInvalidJsonError(
      "Robinhood price response was not valid JSON",
      { cause: err },
    );
  }

  const parsed = robinhoodPricesResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new RobinhoodPriceSchemaValidationError(
      "Robinhood price response did not match the expected schema",
      parsed.error.issues,
    );
  }

  return parsed.data;
}

/**
 * Fetches Robinhood's price quote for exactly one symbol
 * (`GET /rhj/prices/{symbol}`). Symbol casing must match the canonical
 * registry's own casing — Robinhood's endpoint is case-sensitive.
 */
export async function fetchRobinhoodPriceForSymbol(
  symbol: string,
  options: FetchRobinhoodPriceOptions = {},
): Promise<RobinhoodPricesResponse> {
  return fetchRobinhoodPricesInternal(`/${encodeURIComponent(symbol)}`, options);
}

/**
 * Fetches Robinhood's price quotes for **every** canonical asset in one
 * request (`GET /rhj/prices`, no symbol suffix) — live-confirmed to
 * return all 194 quotes in ~2.6s. Not documented as a distinct "bulk"
 * endpoint, but empirically real; this is what makes market-wide price
 * integration (see `src/domain/market`) safe without any additional
 * rate-limiting infrastructure — one call, not one per asset.
 */
export async function fetchAllRobinhoodPrices(
  options: FetchRobinhoodPriceOptions = {},
): Promise<RobinhoodPricesResponse> {
  return fetchRobinhoodPricesInternal("", options);
}
