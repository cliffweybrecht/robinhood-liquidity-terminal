import { DuplicatePoolConflictError } from "@/domain/pool";
import {
  DexScreenerHttpError,
  DexScreenerInvalidJsonError,
  DexScreenerNetworkError,
  DexScreenerSchemaValidationError,
  DexScreenerTimeoutError,
} from "@/providers/dexscreener";
import type { MarketSnapshotFailureCategory } from "./types";

export interface ClassifiedFailure {
  readonly category: MarketSnapshotFailureCategory;
  readonly message: string;
}

/**
 * Maps a per-asset pipeline error (thrown from pool discovery or
 * Phase 3 aggregation) into a stable category for the public snapshot
 * API — never a raw stack trace. Unrecognized errors fall back to
 * `UNEXPECTED`, still exposing the error's own message (Error subclasses
 * throughout this codebase carry deliberately-written, non-sensitive
 * messages — see Phase 1-3 error types).
 */
export function classifyFailure(err: unknown): ClassifiedFailure {
  if (err instanceof DexScreenerTimeoutError) {
    return { category: "DEXSCREENER_TIMEOUT", message: err.message };
  }
  if (err instanceof DexScreenerNetworkError) {
    return { category: "DEXSCREENER_NETWORK", message: err.message };
  }
  if (err instanceof DexScreenerHttpError) {
    return { category: "DEXSCREENER_HTTP", message: err.message };
  }
  if (err instanceof DexScreenerInvalidJsonError) {
    return { category: "DEXSCREENER_INVALID_RESPONSE", message: err.message };
  }
  if (err instanceof DexScreenerSchemaValidationError) {
    return { category: "DEXSCREENER_SCHEMA_INVALID", message: err.message };
  }
  if (err instanceof DuplicatePoolConflictError) {
    return { category: "POOL_INTEGRITY_CONFLICT", message: err.message };
  }

  const message = err instanceof Error ? err.message : "Unknown error";
  return { category: "UNEXPECTED", message };
}
