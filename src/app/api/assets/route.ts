import { NextResponse } from "next/server";
import {
  AssetRegistryError,
  DuplicateContractAddressError,
  getRobinhoodAssets,
  InvalidContractAddressError,
  NoChainDeploymentError,
  ROBINHOOD_CHAIN_ID,
} from "@/domain/asset";
import { RobinhoodProviderError } from "@/providers/robinhood";

export const dynamic = "force-dynamic";

interface ErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json<ErrorBody>({ error: { code, message } }, { status });
}

/**
 * Maps internal error types to intentional HTTP statuses. Never falls
 * back to returning an empty asset list — every failure mode is
 * surfaced as a distinct error response.
 */
function toErrorResponse(err: unknown) {
  if (err instanceof RobinhoodProviderError) {
    switch (err.code) {
      case "TIMEOUT":
        return errorResponse(504, err.code, err.message);
      case "NETWORK_ERROR":
      case "HTTP_ERROR":
      case "INVALID_JSON":
      case "SCHEMA_VALIDATION_ERROR":
        // The upstream Robinhood API is unreachable or returned something
        // we don't trust — that's a bad-gateway condition from this
        // service's perspective, not a client error.
        return errorResponse(502, err.code, err.message);
    }
  }

  if (err instanceof NoChainDeploymentError || err instanceof InvalidContractAddressError) {
    return errorResponse(502, err.code, err.message);
  }

  if (err instanceof DuplicateContractAddressError) {
    // Not attributable to a single bad request — an internal invariant
    // (canonical address uniqueness) was violated by upstream data.
    return errorResponse(500, err.code, err.message);
  }

  if (err instanceof AssetRegistryError) {
    return errorResponse(500, err.code, err.message);
  }

  return errorResponse(
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred while loading the Robinhood asset registry.",
  );
}

export async function GET() {
  try {
    const registry = await getRobinhoodAssets();
    return NextResponse.json({
      data: {
        chainId: ROBINHOOD_CHAIN_ID,
        assetCount: registry.assets.length,
        assets: registry.assets,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
