import { isAddress, isHex, type Address, type Hex } from "viem";
import { parseTokenAmount } from "@/lib/decimal/parseTokenAmount";
import { NATIVE_ETH, type TokenOutIdentifier } from "./types";

/**
 * Validation for the `POST /api/assets/[symbol]/execution/compare`
 * request body. Deliberately split into two passes:
 *
 *  1. `parseCompareRequestShape` — pure, synchronous, needs no asset
 *     lookup: validates JSON shape, `tokenOut`'s address/`NATIVE_ETH`
 *     form, and `hookData`'s address-keyed hex-value shape. Leaves
 *     `amountIn` as a raw string — its numeric validity depends on the
 *     canonical asset's OWN `tokenDecimals`, which isn't known yet at
 *     this point.
 *  2. `resolveAmountIn` — called by the route AFTER the asset/snapshot
 *     is resolved, using the real `tokenDecimals` via the existing
 *     exact `parseTokenAmount` parser (never re-implemented here).
 *
 * Never rejects an omitted `tokenOut`/`amountIn`/`hookData` — the
 * request contract treats all three as optional, with server-chosen
 * defaults applied downstream (`resolveSelectedTokenOut`/
 * `defaultAmountIn` in `compare.ts`). An UNKNOWN-but-well-formed
 * `tokenOut` (a syntactically valid address that just isn't one of
 * this asset's current authoritative verified groups) is intentionally
 * NOT rejected here — that check requires the verified snapshot, and is
 * already enforced by `resolveSelectedTokenOut` throwing
 * `UnknownOutputGroupError`.
 */

export type CompareRequestValidationErrorCode =
  | "INVALID_BODY"
  | "INVALID_TOKEN_OUT"
  | "INVALID_AMOUNT_IN"
  | "INVALID_HOOK_DATA";

export interface CompareRequestValidationError {
  readonly code: CompareRequestValidationErrorCode;
  readonly message: string;
}

export interface ParsedCompareRequestShape {
  readonly tokenOut?: TokenOutIdentifier;
  readonly amountInRaw?: string;
  readonly hookData?: ReadonlyMap<string, Hex>;
}

export type ParseCompareRequestShapeResult =
  | { readonly ok: true; readonly value: ParsedCompareRequestShape }
  | { readonly ok: false; readonly error: CompareRequestValidationError };

function invalid(code: CompareRequestValidationErrorCode, message: string): ParseCompareRequestShapeResult {
  return { ok: false, error: { code, message } };
}

export function parseCompareRequestShape(body: unknown): ParseCompareRequestShapeResult {
  if (body === null || body === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return invalid("INVALID_BODY", "Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;

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

  let amountInRaw: string | undefined;
  if (record.amountIn !== undefined) {
    if (typeof record.amountIn !== "string") {
      return invalid("INVALID_AMOUNT_IN", '"amountIn" must be a decimal string.');
    }
    amountInRaw = record.amountIn;
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

  return { ok: true, value: { tokenOut, amountInRaw, hookData } };
}

const AMOUNT_IN_REASON_MESSAGES: Record<Exclude<ReturnType<typeof parseTokenAmount>, { ok: true }>["reason"], string> = {
  EMPTY: '"amountIn" must not be empty.',
  MALFORMED: '"amountIn" must be a plain positive decimal number (no scientific notation, thousands separators, or sign).',
  NOT_POSITIVE: '"amountIn" must be greater than zero.',
  EXCESS_PRECISION: '"amountIn" has more fractional digits than this token supports.',
};

export type ResolveAmountInResult =
  | { readonly ok: true; readonly value: bigint | undefined }
  | { readonly ok: false; readonly error: CompareRequestValidationError };

/** `amountInRaw === undefined` -> `{ ok: true, value: undefined }` (the caller applies the server default). Otherwise parses exactly via `parseTokenAmount`, never truncating/rounding. */
export function resolveAmountIn(amountInRaw: string | undefined, tokenDecimals: number): ResolveAmountInResult {
  if (amountInRaw === undefined) {
    return { ok: true, value: undefined };
  }
  const result = parseTokenAmount(amountInRaw, tokenDecimals);
  if (!result.ok) {
    return { ok: false, error: { code: "INVALID_AMOUNT_IN", message: AMOUNT_IN_REASON_MESSAGES[result.reason] } };
  }
  return { ok: true, value: result.value };
}
