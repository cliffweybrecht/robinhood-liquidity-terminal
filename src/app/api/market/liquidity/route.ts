import { NextResponse } from "next/server";
import { AssetRegistryError } from "@/domain/asset";
import { getMarketLiquiditySnapshot } from "@/domain/market";
import { RobinhoodProviderError } from "@/providers/robinhood";

export const dynamic = "force-dynamic";

interface ErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json<ErrorBody>({ error: { code, message } }, { status });
}

/**
 * Building a snapshot can only throw here if the Phase 1 canonical
 * registry fetch itself fails — every per-asset Dexscreener/pool
 * failure is already captured in `snapshot.failures`, never thrown.
 */
function toErrorResponse(err: unknown) {
  if (err instanceof RobinhoodProviderError) {
    switch (err.code) {
      case "TIMEOUT":
        return errorResponse(504, err.code, err.message);
      default:
        return errorResponse(502, err.code, err.message);
    }
  }
  if (err instanceof AssetRegistryError) {
    return errorResponse(500, err.code, err.message);
  }
  return errorResponse(
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred while building the market liquidity snapshot.",
  );
}

export async function GET() {
  try {
    const { snapshot, cache } = await getMarketLiquiditySnapshot();
    return NextResponse.json({ data: snapshot, cache });
  } catch (err) {
    return toErrorResponse(err);
  }
}
