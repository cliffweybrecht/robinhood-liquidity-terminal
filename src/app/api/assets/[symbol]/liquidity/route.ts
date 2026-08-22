import { NextResponse } from "next/server";
import {
  AmbiguousSymbolError,
  AssetNotFoundError,
  AssetRegistryError,
} from "@/domain/asset";
import { getAssetLiquidityProfileBySymbol } from "@/domain/liquidity";
import { PoolDiscoveryError } from "@/domain/pool";
import { DexScreenerProviderError } from "@/providers/dexscreener";

export const dynamic = "force-dynamic";

interface ErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json<ErrorBody>({ error: { code, message } }, { status });
}

/**
 * Same error-mapping approach as `/api/assets/[symbol]/pools` — see that
 * route for rationale. A genuine "this asset has no displayed liquidity"
 * result is a normal 200 response with null/empty aggregates, never one
 * of these branches.
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

  return errorResponse(
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred while aggregating the liquidity profile.",
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ symbol: string }> },
) {
  try {
    const { symbol } = await context.params;
    const profile = await getAssetLiquidityProfileBySymbol(symbol);

    return NextResponse.json({ data: profile });
  } catch (err) {
    return toErrorResponse(err);
  }
}
