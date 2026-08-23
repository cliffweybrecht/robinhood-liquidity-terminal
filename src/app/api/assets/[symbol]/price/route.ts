import { NextResponse } from "next/server";
import {
  AmbiguousSymbolError,
  AssetNotFoundError,
  AssetRegistryError,
} from "@/domain/asset";
import {
  getAssetPriceComparisonBySymbol,
  PriceComparisonError,
} from "@/domain/price";
import { PoolDiscoveryError } from "@/domain/pool";
import { DexScreenerProviderError } from "@/providers/dexscreener";
import { RobinhoodPriceProviderError } from "@/providers/robinhood-price";

export const dynamic = "force-dynamic";

interface ErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json<ErrorBody>({ error: { code, message } }, { status });
}

/**
 * Same error-mapping approach as the other per-asset routes. A genuine
 * "no usable DEX price" or "no reference price coverage for these
 * pools" result is a normal 200 response with null aggregates, never
 * one of these branches — only actual provider/resolution failures map
 * to non-2xx statuses.
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

  if (err instanceof RobinhoodPriceProviderError) {
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
  if (err instanceof PriceComparisonError) {
    // Robinhood's price registry disagreeing with its own asset
    // registry is an upstream data inconsistency, not a client error.
    return errorResponse(502, err.code, err.message);
  }

  return errorResponse(
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred while building the price comparison.",
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ symbol: string }> },
) {
  try {
    const { symbol } = await context.params;
    const comparison = await getAssetPriceComparisonBySymbol(symbol);

    return NextResponse.json({ data: comparison });
  } catch (err) {
    return toErrorResponse(err);
  }
}
