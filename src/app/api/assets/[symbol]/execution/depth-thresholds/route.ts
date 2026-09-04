import { NextResponse } from "next/server";
import {
  AmbiguousSymbolError,
  AssetNotFoundError,
  AssetRegistryError,
} from "@/domain/asset";
import { PoolDiscoveryError } from "@/domain/pool";
import { DexScreenerProviderError } from "@/providers/dexscreener";
import { PoolVerificationError } from "@/domain/pool-verification";
import { QuotePreconditionError } from "@/domain/pool-quote";
import { RobinhoodRpcError } from "@/providers/robinhood-rpc";
import {
  compareAssetExecutionDepthThresholdsFromSnapshot,
  ExecutionComparisonError,
  getVerifiedExecutionSnapshot,
  parseDepthThresholdsRequestShape,
  toAssetExecutableDepthDto,
} from "@/domain/execution-comparison";

export const dynamic = "force-dynamic";

interface ErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json<ErrorBody>({ error: { code, message } }, { status });
}

/**
 * Same per-asset error-mapping convention as `.../execution/compare/
 * route.ts` and `.../execution/compare-matrix/route.ts` (both
 * unmodified by this endpoint). `ExecutionComparisonError` is this
 * module's own error hierarchy: `UNKNOWN_OUTPUT_GROUP` is the caller's
 * fault -> 400; `NO_VERIFIED_GROUPS` means there is nothing to compare
 * right now -> 404; `MISSING_TOKEN_DECIMALS` is an upstream registry
 * gap -> 500; `VERIFICATION_DEGRADED` means verification did not reach
 * a settled outcome for every candidate this attempt -> 503, a
 * transient condition worth retrying, never 404.
 * `DEPTH_THRESHOLDS_TOO_LARGE` — this orchestration layer's own
 * fast-path rejection for an oversized depth-threshold request
 * (computed against the EXECUTABLE candidate count, never the raw one
 * — see `compareDepthThresholds.ts`) -> 400, the caller asked for
 * something the server will not attempt (in practice this can only be
 * triggered by the current verified candidate count for a group, since
 * the ladder length is server-fixed at 12 — never caller-controlled).
 * Oversized requests are ALWAYS rejected, never silently truncated.
 * `QuotePreconditionError` (from `@/domain/pool-quote`) reaching this
 * route at all — including the pool-quote layer's OWN
 * `DepthThresholdsTooLargeError`/`EmptyThresholdsError` — would mean
 * this module's own orchestration constructed an invalid call or its
 * own fast-path pre-check has a bug — an internal invariant violation,
 * never a client input problem -> 500.
 */
function toErrorResponse(err: unknown) {
  if (err instanceof AssetNotFoundError) {
    return errorResponse(404, err.code, err.message);
  }
  if (err instanceof AmbiguousSymbolError) {
    return errorResponse(409, err.code, err.message);
  }
  if (err instanceof AssetRegistryError) {
    return errorResponse(500, err.code, err.message);
  }

  if (err instanceof DexScreenerProviderError) {
    switch (err.code) {
      case "TIMEOUT":
        return errorResponse(504, err.code, err.message);
      case "NETWORK_ERROR":
      case "HTTP_ERROR":
      case "INVALID_JSON":
      case "SCHEMA_VALIDATION_ERROR":
        return errorResponse(502, err.code, err.message);
    }
  }

  if (err instanceof PoolDiscoveryError) {
    return errorResponse(500, err.code, err.message);
  }

  if (err instanceof RobinhoodRpcError) {
    switch (err.code) {
      case "TIMEOUT":
      case "NETWORK_ERROR":
        return errorResponse(504, err.code, err.message);
      case "CONFIG_ERROR":
        return errorResponse(500, err.code, err.message);
      default:
        return errorResponse(502, err.code, err.message);
    }
  }

  if (err instanceof PoolVerificationError) {
    return errorResponse(500, err.code, err.message);
  }
  if (err instanceof QuotePreconditionError) {
    return errorResponse(500, err.code, err.message);
  }

  if (err instanceof ExecutionComparisonError) {
    switch (err.code) {
      case "UNKNOWN_OUTPUT_GROUP":
      case "DEPTH_THRESHOLDS_TOO_LARGE":
        return errorResponse(400, err.code, err.message);
      case "NO_VERIFIED_GROUPS":
        return errorResponse(404, err.code, err.message);
      case "MISSING_TOKEN_DECIMALS":
        return errorResponse(500, err.code, err.message);
      case "VERIFICATION_DEGRADED":
        return errorResponse(503, err.code, err.message);
      case "MATRIX_TOO_LARGE":
        // Unreachable from this route — this endpoint never triggers
        // the matrix's own cap; present only so this switch remains
        // exhaustive over ExecutionComparisonErrorCode.
        return errorResponse(500, err.code, err.message);
    }
  }

  return errorResponse(
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred while computing executable-depth thresholds.",
  );
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await request.text();
  if (text.trim().length === 0) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ symbol: string }> },
) {
  try {
    const { symbol } = await context.params;

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      return errorResponse(400, "INVALID_BODY", "Request body must be valid JSON.");
    }

    const shapeResult = parseDepthThresholdsRequestShape(bodyResult.value);
    if (!shapeResult.ok) {
      return errorResponse(400, shapeResult.error.code, shapeResult.error.message);
    }
    const { tokenOut, hookData } = shapeResult.value;

    // Resolved EXACTLY ONCE for this whole request — groups,
    // default/explicit group selection, and every pool's depth-
    // threshold result all come from this SAME snapshot — never a
    // second, independently (re)acquired one. See
    // `compareAssetExecutionDepthThresholdsFromSnapshot`'s own doc
    // comment (`src/domain/execution-comparison/compareDepthThresholds.ts`)
    // and both sibling routes' own identical comment for the full
    // invariant this preserves.
    const snapshot = await getVerifiedExecutionSnapshot(symbol);
    if (snapshot.asset.tokenDecimals === null) {
      return errorResponse(
        500,
        "MISSING_TOKEN_DECIMALS",
        `Canonical asset "${symbol}" has no known tokenDecimals — cannot scale the depth-threshold ladder.`,
      );
    }

    const result = await compareAssetExecutionDepthThresholdsFromSnapshot(snapshot, {
      symbol,
      tokenOut,
      hookData,
    });

    return NextResponse.json({ data: toAssetExecutableDepthDto(result) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
