import type { ZodIssue } from "zod";

/**
 * Typed failure modes for the Robinhood price provider boundary.
 * Mirrors `src/providers/robinhood/errors.ts` / `src/providers/dexscreener/errors.ts`
 * — distinct error types, never message-string branching, never
 * collapsed into a fabricated result.
 */
export type RobinhoodPriceProviderErrorCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "SCHEMA_VALIDATION_ERROR";

export abstract class RobinhoodPriceProviderError extends Error {
  abstract readonly code: RobinhoodPriceProviderErrorCode;
}

export class RobinhoodPriceNetworkError extends RobinhoodPriceProviderError {
  readonly code = "NETWORK_ERROR" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RobinhoodPriceNetworkError";
  }
}

export class RobinhoodPriceTimeoutError extends RobinhoodPriceProviderError {
  readonly code = "TIMEOUT" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RobinhoodPriceTimeoutError";
  }
}

export class RobinhoodPriceHttpError extends RobinhoodPriceProviderError {
  readonly code = "HTTP_ERROR" as const;
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string) {
    super(`Robinhood price API responded with HTTP ${status} ${statusText}`);
    this.name = "RobinhoodPriceHttpError";
    this.status = status;
    this.statusText = statusText;
  }
}

export class RobinhoodPriceInvalidJsonError extends RobinhoodPriceProviderError {
  readonly code = "INVALID_JSON" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RobinhoodPriceInvalidJsonError";
  }
}

export class RobinhoodPriceSchemaValidationError extends RobinhoodPriceProviderError {
  readonly code = "SCHEMA_VALIDATION_ERROR" as const;
  readonly issues: readonly ZodIssue[];

  constructor(message: string, issues: readonly ZodIssue[]) {
    super(message);
    this.name = "RobinhoodPriceSchemaValidationError";
    this.issues = issues;
  }
}
