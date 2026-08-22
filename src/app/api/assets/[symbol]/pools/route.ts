import { NextResponse } from "next/server";
import {
  AmbiguousSymbolError,
  AssetNotFoundError,
  AssetRegistryError,
} from "@/domain/asset";
import { PoolDiscoveryError, getDexScreenerPoolsBySymbol } from "@/domain/pool";
import { DexScreenerProviderError } from "@/providers/dexscreener";

export const dynamic = "force-dynamic";

interface ErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json<ErrorBody>({ error: { code, message } }, { status });
}

/**
 * Maps internal error types to intentional HTTP statuses. Never falls
 * back to returning an empty pool list — a genuine zero-pool result is
 * only ever produced by `getDexScreenerPoolsBySymbol` succeeding with
 * `pools: []`, which is distinct from every branch here.
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
    // DuplicatePoolConflictError and any future PoolDiscoveryError
    // subtype: an internal invariant was violated by upstream data, not
    // attributable to the request itself.
    return errorResponse(500, err.code, err.message);
  }

  return errorResponse(
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred while discovering Dexscreener pools.",
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ symbol: string }> },
) {
  try {
    const { symbol } = await context.params;
    const { asset, pools } = await getDexScreenerPoolsBySymbol(symbol);

    return NextResponse.json({
      data: {
        asset: {
          symbol: asset.symbol,
          name: asset.name,
          contractAddress: asset.contractAddress,
        },
        poolCount: pools.length,
        pools,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
