import { isAddress, isHex, type Address, type Hex } from "viem";
import { NATIVE_ETH, type TokenOutIdentifier } from "./types";

/**
 * Validation for the `POST /api/assets/[symbol]/execution/depth-
 * thresholds` request body. Mirrors `request.ts`'s own
 * `parseCompareRequestShape` for the `tokenOut`/`hookData` validation
 * rules exactly (same `NATIVE_ETH` sentinel-or-address check, same
 * lowercased-address-keyed hex-value map validation, same error
 * codes) — with the `amountIn` branch removed entirely. This endpoint
 * accepts NO caller-supplied ladder and NO caller-supplied thresholds:
 * both the 12-point ladder and the four price-impact thresholds are
 * server-authoritative and frozen (see `compareDepthThresholds.ts`'s
 * own `DEPTH_THRESHOLD_LADDER_MULTIPLIERS`/`DEPTH_THRESHOLD_BPS`) — a
 * single, minimal request contract by design, not an oversight.
 *
 * FAIL CLOSED on the two forbidden, authority-bearing fields (adversarial
 * pre-commit pass, Issue 1): if the top-level body contains `amountsIn`
 * OR `thresholds`, the WHOLE request is rejected with 400 — NEVER
 * silently ignored. Silently ignoring either would let a caller believe
 * its override was honored (e.g. `{"thresholds":[1000]}`) while the
 * server actually used the frozen 0.5/1/2/5% set — a misleading success
 * response is a worse failure mode than an explicit rejection. Checked
 * BEFORE `tokenOut`/`hookData` are parsed, so a request combining a
 * forbidden field with an otherwise-valid `tokenOut` is still rejected.
 * This does NOT generalize to "reject all unknown fields" — only these
 * two specific, authority-bearing field names are checked; an unrelated
 * unknown field (typo, future-reserved name, etc.) is still silently
 * ignored, matching every other route's own existing body-shape
 * leniency (see `request.ts`/`requestMatrix.ts`) — there is no existing
 * project convention for generic unknown-field rejection, and inventing
 * one here would be unrelated scope creep.
 *
 * Never rejects an omitted `tokenOut`/`hookData` — both are optional,
 * with server-chosen defaults applied downstream
 * (`resolveSelectedTokenOutForDepthThresholds` in
 * `compareDepthThresholds.ts`). An UNKNOWN-but-well-formed `tokenOut`
 * is intentionally NOT rejected here — that check requires the
 * verified snapshot, and is already enforced downstream by
 * `UnknownOutputGroupError`.
 */

export type DepthThresholdsRequestValidationErrorCode =
  | "INVALID_BODY"
  | "INVALID_TOKEN_OUT"
  | "INVALID_HOOK_DATA"
  | "AMOUNTS_IN_NOT_ALLOWED"
  | "THRESHOLDS_NOT_ALLOWED";

export interface DepthThresholdsRequestValidationError {
  readonly code: DepthThresholdsRequestValidationErrorCode;
  readonly message: string;
}

export interface ParsedDepthThresholdsRequestShape {
  readonly tokenOut?: TokenOutIdentifier;
  readonly hookData?: ReadonlyMap<string, Hex>;
}

export type ParseDepthThresholdsRequestShapeResult =
  | { readonly ok: true; readonly value: ParsedDepthThresholdsRequestShape }
  | { readonly ok: false; readonly error: DepthThresholdsRequestValidationError };

function invalid(code: DepthThresholdsRequestValidationErrorCode, message: string): ParseDepthThresholdsRequestShapeResult {
  return { ok: false, error: { code, message } };
}

export function parseDepthThresholdsRequestShape(body: unknown): ParseDepthThresholdsRequestShapeResult {
  if (body === null || body === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return invalid("INVALID_BODY", "Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;

  if (record.amountsIn !== undefined) {
    return invalid(
      "AMOUNTS_IN_NOT_ALLOWED",
      '"amountsIn" is not accepted by this endpoint — the 12-point ladder is server-authoritative and cannot be overridden by the caller.',
    );
  }
  if (record.thresholds !== undefined) {
    return invalid(
      "THRESHOLDS_NOT_ALLOWED",
      '"thresholds" is not accepted by this endpoint — the 0.5%/1%/2%/5% threshold set is server-authoritative and cannot be overridden by the caller.',
    );
  }

  let tokenOut: TokenOutIdentifier | undefined;
  if (record.tokenOut !== undefined) {
    if (typeof record.tokenOut !== "string") {
      return invalid("INVALID_TOKEN_OUT", '"tokenOut" must be a string.');
    }
    if (record.tokenOut === NATIVE_ETH) {
      tokenOut = NATIVE_ETH;
    } else if (isAddress(record.tokenOut)) {
      tokenOut = record.tokenOut as Address;
    } else {
      return invalid("INVALID_TOKEN_OUT", `"tokenOut" must be "${NATIVE_ETH}" or a valid 0x-prefixed address.`);
    }
  }

  let hookData: Map<string, Hex> | undefined;
  if (record.hookData !== undefined) {
    if (typeof record.hookData !== "object" || record.hookData === null || Array.isArray(record.hookData)) {
      return invalid("INVALID_HOOK_DATA", '"hookData" must be an object mapping a pool address to a 0x hex string.');
    }
    const map = new Map<string, Hex>();
    for (const [poolAddress, value] of Object.entries(record.hookData as Record<string, unknown>)) {
      if (!isAddress(poolAddress)) {
        return invalid("INVALID_HOOK_DATA", `"${poolAddress}" in "hookData" is not a valid pool address.`);
      }
      if (typeof value !== "string" || !isHex(value)) {
        return invalid("INVALID_HOOK_DATA", `"hookData" for "${poolAddress}" must be a 0x-prefixed hex string.`);
      }
      map.set(poolAddress.toLowerCase(), value);
    }
    hookData = map;
  }

  return { ok: true, value: { tokenOut, hookData } };
}
