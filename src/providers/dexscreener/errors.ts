import type { ZodIssue } from "zod";

/**
 * Typed failure modes for the Dexscreener token-pairs provider boundary.
 * Mirrors `src/providers/robinhood/errors.ts` — same rationale: distinct
 * error types instead of message-string branching, none ever collapsed
 * into an empty array. An empty array is only ever returned when
 * Dexscreener genuinely reports zero pools (see `client.ts`).
 */
export type DexScreenerProviderErrorCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "SCHEMA_VALIDATION_ERROR";

export abstract class DexScreenerProviderError extends Error {
  abstract readonly code: DexScreenerProviderErrorCode;
}

export class DexScreenerNetworkError extends DexScreenerProviderError {
  readonly code = "NETWORK_ERROR" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DexScreenerNetworkError";
  }
}

export class DexScreenerTimeoutError extends DexScreenerProviderError {
  readonly code = "TIMEOUT" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DexScreenerTimeoutError";
  }
}

export class DexScreenerHttpError extends DexScreenerProviderError {
  readonly code = "HTTP_ERROR" as const;
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string) {
    super(`Dexscreener API responded with HTTP ${status} ${statusText}`);
    this.name = "DexScreenerHttpError";
    this.status = status;
    this.statusText = statusText;
  }
}

export class DexScreenerInvalidJsonError extends DexScreenerProviderError {
  readonly code = "INVALID_JSON" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DexScreenerInvalidJsonError";
  }
}

export class DexScreenerSchemaValidationError extends DexScreenerProviderError {
  readonly code = "SCHEMA_VALIDATION_ERROR" as const;
  readonly issues: readonly ZodIssue[];

  constructor(message: string, issues: readonly ZodIssue[]) {
    super(message);
    this.name = "DexScreenerSchemaValidationError";
    this.issues = issues;
  }
}
