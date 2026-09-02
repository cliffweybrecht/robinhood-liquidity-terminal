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
  ExecutionComparisonError,
  compareAssetExecutionFromSnapshot,
  getVerifiedExecutionSnapshot,
  parseCompareRequestShape,
  resolveAmountIn,
  toAssetExecutionComparisonDto,
} from "@/domain/execution-comparison";

export const dynamic = "force-dynamic";

interface ErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json<ErrorBody>({ error: { code, message } }, { status });
}

/**
 * Same per-asset error-mapping convention as `pools/route.ts` and
 * `price/route.ts`. `ExecutionComparisonError` is this module's own
 * error hierarchy: `UNKNOWN_OUTPUT_GROUP` is the caller's fault (a
 * syntactically valid but non-existent `tokenOut`) -> 400;
 * `NO_VERIFIED_GROUPS` means there is nothing to compare for this
 * symbol right now -> 404 (a legitimate "nothing found" outcome, not a
 * client mistake); `MISSING_TOKEN_DECIMALS` is an upstream registry
 * data-completeness gap, not attributable to the request -> 500.
 * `VERIFICATION_DEGRADED` means verification did not reach a settled
 * outcome for every candidate this attempt (zero groups is NOT proven,
 * only unresolved) -> 503, matching this project's existing convention
 * for a transient upstream condition worth retrying, never 404 (which
 * would misreport an indeterminate state as a definitive one).
 * `QuotePreconditionError`/`PoolVerificationError` reaching this route
 * at all would mean this module's own orchestration constructed an
 * invalid call (wrong classification, wrong candidate shape) — an
 * internal invariant violation, never a client input problem -> 500.
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
        return errorResponse(400, err.code, err.message);
      case "NO_VERIFIED_GROUPS":
        return errorResponse(404, err.code, err.message);
      case "MISSING_TOKEN_DECIMALS":
        return errorResponse(500, err.code, err.message);
      case "VERIFICATION_DEGRADED":
        return errorResponse(503, err.code, err.message);
    }
  }

  return errorResponse(
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred while building the execution comparison.",
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

    const shapeResult = parseCompareRequestShape(bodyResult.value);
    if (!shapeResult.ok) {
      return errorResponse(400, shapeResult.error.code, shapeResult.error.message);
    }
    const { tokenOut, amountInRaw, hookData } = shapeResult.value;

    // Resolved EXACTLY ONCE for this whole request. Groups, default/
    // explicit group selection, tokenIn decimals (for exact amountIn
    // parsing below), and comparison candidates all come from this SAME
    // snapshot — never a second, independently (re)acquired one. This
    // matters specifically under `verificationHealth === "DEGRADED"`:
    // the snapshot cache evicts a degraded entry the instant it's
    // returned (see `snapshot.ts`), so a second `getVerifiedExecution
    // Snapshot` call later in this same request could rebuild and
    // observe a MATERIALLY DIFFERENT candidate/group set than the one
    // used here — e.g. reporting valid `tokenDecimals` from one snapshot
    // while the comparison below silently operates against a different,
    // freshly-rebuilt one. See `compareAssetExecutionFromSnapshot`'s own
    // doc comment (`src/domain/execution-comparison/compare.ts`) for the
    // full invariant this preserves.
    const snapshot = await getVerifiedExecutionSnapshot(symbol);
    if (snapshot.asset.tokenDecimals === null) {
      return errorResponse(
        500,
        "MISSING_TOKEN_DECIMALS",
        `Canonical asset "${symbol}" has no known tokenDecimals — cannot validate a trade amount.`,
      );
    }

    const amountInResult = resolveAmountIn(amountInRaw, snapshot.asset.tokenDecimals);
    if (!amountInResult.ok) {
      return errorResponse(400, amountInResult.error.code, amountInResult.error.message);
    }

    const result = await compareAssetExecutionFromSnapshot(snapshot, {
      symbol,
      tokenOut,
      amountIn: amountInResult.value,
      hookData,
    });

    return NextResponse.json({ data: toAssetExecutionComparisonDto(result) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
