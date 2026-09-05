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
  compareAssetExecutionCrossMarketFromSnapshot,
  ExecutionComparisonError,
  getVerifiedExecutionSnapshot,
  parseCrossMarketRequestShape,
  toAssetCrossMarketExecutionDto,
} from "@/domain/execution-comparison";

export const dynamic = "force-dynamic";

interface ErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json<ErrorBody>({ error: { code, message } }, { status });
}

/**
 * Same per-asset error-mapping convention as `.../execution/compare/`,
 * `.../execution/compare-matrix/`, and `.../execution/depth-thresholds/`
 * routes (all unmodified by this endpoint). `ExecutionComparisonError` is
 * this module's own error hierarchy: `UNKNOWN_OUTPUT_GROUP` is the
 * caller's fault (an explicitly requested group doesn't exist in a
 * HEALTHY snapshot) -> 400; `CROSS_MARKET_DEPTH_TOO_LARGE` is this
 * orchestration layer's own fast-path rejection for an oversized
 * REQUEST-WIDE cross-market request (computed against the EXECUTABLE
 * candidate count summed across every selected group, never a raw
 * count — see `compareCrossMarket.ts`) -> 400, the caller asked for
 * something the server will not attempt, exactly analogous to
 * `UNKNOWN_OUTPUT_GROUP`'s existing 400 mapping; `MISSING_TOKEN_DECIMALS`
 * is an upstream registry gap -> 500; `VERIFICATION_DEGRADED` means
 * verification did not reach a settled outcome for every candidate this
 * attempt (so the true group count/existence is unproven, not a
 * definitive `INSUFFICIENT_MARKETS`/`UNKNOWN_OUTPUT_GROUP` fact) -> 503,
 * a transient condition worth retrying. `NO_VERIFIED_GROUPS`,
 * `MATRIX_TOO_LARGE`, `DEPTH_THRESHOLDS_TOO_LARGE` are UNREACHABLE from
 * this route (this endpoint never throws them) — present only so this
 * switch remains exhaustive over the shared `ExecutionComparisonErrorCode`
 * union every sibling route also switches over.
 * `QuotePreconditionError` (from `@/domain/pool-quote`) reaching this
 * route at all would mean this module's own orchestration constructed
 * an invalid call or its own fast-path pre-check has a bug — an
 * internal invariant violation, never a client input problem -> 500.
 *
 * NOTE: `INSUFFICIENT_MARKETS` and `BLOCK_PIN_FAILURE` are NOT errors —
 * they are `AssetCrossMarketExecution` DOMAIN STATES, returned as a
 * normal `200` response body via `toAssetCrossMarketExecutionDto`, the
 * same way `VerifiedPoolDepthThresholdsResult`'s own
 * `"BLOCK_PIN_FAILURE"` status is a normal 200 response on the existing
 * depth-thresholds route. Neither ever reaches this function.
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
      case "CROSS_MARKET_DEPTH_TOO_LARGE":
        return errorResponse(400, err.code, err.message);
      case "MISSING_TOKEN_DECIMALS":
        return errorResponse(500, err.code, err.message);
      case "VERIFICATION_DEGRADED":
        return errorResponse(503, err.code, err.message);
      case "NO_VERIFIED_GROUPS":
      case "MATRIX_TOO_LARGE":
      case "DEPTH_THRESHOLDS_TOO_LARGE":
        // Unreachable from this route — this endpoint never throws
        // these; present only so this switch remains exhaustive over
        // ExecutionComparisonErrorCode.
        return errorResponse(500, err.code, err.message);
    }
  }

  return errorResponse(
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred while computing cross-market execution synthesis.",
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

    const shapeResult = parseCrossMarketRequestShape(bodyResult.value);
    if (!shapeResult.ok) {
      return errorResponse(400, shapeResult.error.code, shapeResult.error.message);
    }
    const { tokenOuts, hookData } = shapeResult.value;

    // Resolved EXACTLY ONCE for this whole request — group existence
    // checks, insufficient-markets/degraded classification, ladder
    // construction, the request-wide cell-cap preflight, the ONE shared
    // block pin, and every group's own depth-threshold result all come
    // from this SAME snapshot — never a second, independently
    // (re)acquired one. Mirrors every sibling execution route's own
    // identical single-snapshot invariant.
    const snapshot = await getVerifiedExecutionSnapshot(symbol);
    if (snapshot.asset.tokenDecimals === null) {
      return errorResponse(
        500,
        "MISSING_TOKEN_DECIMALS",
        `Canonical asset "${symbol}" has no known tokenDecimals — cannot construct the depth-threshold ladder.`,
      );
    }

    const result = await compareAssetExecutionCrossMarketFromSnapshot(snapshot, {
      symbol,
      tokenOuts,
      hookData,
    });

    return NextResponse.json({ data: toAssetCrossMarketExecutionDto(result) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
