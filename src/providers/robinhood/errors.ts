import type { ZodIssue } from "zod";

/**
 * Typed failure modes for the Robinhood asset registry provider boundary.
 * Each represents a distinct, intentional failure category — callers
 * (the domain layer, the HTTP API route) branch on these rather than on
 * message strings, and none of them are ever silently swallowed into an
 * empty result.
 */
export type RobinhoodProviderErrorCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "SCHEMA_VALIDATION_ERROR";

export abstract class RobinhoodProviderError extends Error {
  abstract readonly code: RobinhoodProviderErrorCode;
}

export class RobinhoodNetworkError extends RobinhoodProviderError {
  readonly code = "NETWORK_ERROR" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RobinhoodNetworkError";
  }
}

export class RobinhoodTimeoutError extends RobinhoodProviderError {
  readonly code = "TIMEOUT" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RobinhoodTimeoutError";
  }
}

export class RobinhoodHttpError extends RobinhoodProviderError {
  readonly code = "HTTP_ERROR" as const;
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string) {
    super(`Robinhood API responded with HTTP ${status} ${statusText}`);
    this.name = "RobinhoodHttpError";
    this.status = status;
    this.statusText = statusText;
  }
}

export class RobinhoodInvalidJsonError extends RobinhoodProviderError {
  readonly code = "INVALID_JSON" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RobinhoodInvalidJsonError";
  }
}

export class RobinhoodSchemaValidationError extends RobinhoodProviderError {
  readonly code = "SCHEMA_VALIDATION_ERROR" as const;
  readonly issues: readonly ZodIssue[];

  constructor(message: string, issues: readonly ZodIssue[]) {
    super(message);
    this.name = "RobinhoodSchemaValidationError";
    this.issues = issues;
  }
}
