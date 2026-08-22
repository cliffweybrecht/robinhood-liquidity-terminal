import {
  fetchWithTimeout,
  HttpNetworkError,
  HttpTimeoutError,
} from "@/lib/http/fetchWithTimeout";
import {
  robinhoodAssetsResponseSchema,
  type RobinhoodAssetsResponse,
} from "./schema";
import {
  RobinhoodHttpError,
  RobinhoodInvalidJsonError,
  RobinhoodNetworkError,
  RobinhoodSchemaValidationError,
  RobinhoodTimeoutError,
} from "./errors";

const DEFAULT_BASE_URL = "https://api.robinhood.com";
const DEFAULT_TIMEOUT_MS = 8000;
const ASSETS_PATH = "/rhj/assets";

export interface FetchRobinhoodAssetsOptions {
  /** Overrides ROBINHOOD_API_BASE_URL / the built-in default. */
  baseUrl?: string;
  /** Overrides ROBINHOOD_API_TIMEOUT_MS / the built-in default. */
  timeoutMs?: number;
  /** Injectable fetch implementation, primarily for deterministic tests. */
  fetchImpl?: typeof fetch;
}

function resolveBaseUrl(options: FetchRobinhoodAssetsOptions): string {
  return (
    options.baseUrl ?? process.env.ROBINHOOD_API_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveTimeoutMs(options: FetchRobinhoodAssetsOptions): number {
  if (options.timeoutMs !== undefined) return options.timeoutMs;
  const fromEnv = Number(process.env.ROBINHOOD_API_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

/**
 * Fetches and validates the canonical Robinhood asset registry response.
 *
 * Every failure mode is surfaced as a distinct, typed error — network
 * failure, timeout, non-2xx HTTP status, invalid JSON, and schema-invalid
 * payloads are never collapsed into an empty result or a generic Error.
 */
export async function fetchRobinhoodAssets(
  options: FetchRobinhoodAssetsOptions = {},
): Promise<RobinhoodAssetsResponse> {
  const baseUrl = resolveBaseUrl(options);
  const timeoutMs = resolveTimeoutMs(options);
  const url = `${baseUrl}${ASSETS_PATH}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      timeoutMs,
      fetchImpl: options.fetchImpl,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (err instanceof HttpTimeoutError) {
      throw new RobinhoodTimeoutError(
        `Timed out fetching Robinhood asset registry after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    if (err instanceof HttpNetworkError) {
      throw new RobinhoodNetworkError(
        "Network error fetching Robinhood asset registry",
        { cause: err },
      );
    }
    throw err;
  }

  if (!response.ok) {
    throw new RobinhoodHttpError(response.status, response.statusText);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new RobinhoodInvalidJsonError(
      "Robinhood asset registry response was not valid JSON",
      { cause: err },
    );
  }

  const parsed = robinhoodAssetsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new RobinhoodSchemaValidationError(
      "Robinhood asset registry response did not match the expected schema",
      parsed.error.issues,
    );
  }

  return parsed.data;
}
