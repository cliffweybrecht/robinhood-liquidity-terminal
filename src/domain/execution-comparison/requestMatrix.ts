import { isAddress, isHex, type Address, type Hex } from "viem";
import { MAX_MATRIX_AMOUNTS } from "@/domain/pool-quote";
import { parseTokenAmount } from "@/lib/decimal/parseTokenAmount";
import { NATIVE_ETH, type TokenOutIdentifier } from "./types";

/**
 * Validation for the `POST /api/assets/[symbol]/execution/compare-matrix`
 * request body. Mirrors `request.ts`'s own two-pass split exactly
 * (shape validation first, decimals-dependent numeric validation
 * second, once `tokenDecimals` is known) — the ONLY differences from
 * the single-comparison contract are `amountsIn` (an array, not one
 * string) and its two new, ladder-specific rejections:
 *
 *  - a PRESENT but EMPTY `amountsIn` array is REJECTED (fail-closed),
 *    never treated as "use the default ladder" — mirrors
 *    `resolveAmountIn`'s own existing "EMPTY" rejection for a present-
 *    but-empty single `amountIn` string. Only a field that is entirely
 *    ABSENT from the request body resolves to the default ladder
 *    (`compareMatrix.ts`'s own `DEFAULT_MATRIX_LADDER_MULTIPLIERS`).
 *  - `amountsIn.length > MAX_MATRIX_AMOUNTS` is REJECTED here, at the
 *    cheap shape-validation layer, before any snapshot/RPC work —
 *    reusing the SAME `MAX_MATRIX_AMOUNTS` constant the pool-quote
 *    matrix primitive itself also authoritatively enforces (imported,
 *    never redeclared as a second literal).
 */

export type CompareMatrixRequestValidationErrorCode =
  | "INVALID_BODY"
  | "INVALID_TOKEN_OUT"
  | "INVALID_AMOUNTS_IN"
  | "EMPTY_AMOUNTS_IN"
  | "TOO_MANY_AMOUNTS_IN"
  | "INVALID_HOOK_DATA";

export interface CompareMatrixRequestValidationError {
  readonly code: CompareMatrixRequestValidationErrorCode;
  readonly message: string;
}

export interface ParsedCompareMatrixRequestShape {
  readonly tokenOut?: TokenOutIdentifier;
  readonly amountsInRaw?: readonly string[];
  readonly hookData?: ReadonlyMap<string, Hex>;
}

export type ParseCompareMatrixRequestShapeResult =
  | { readonly ok: true; readonly value: ParsedCompareMatrixRequestShape }
  | { readonly ok: false; readonly error: CompareMatrixRequestValidationError };

function invalid(code: CompareMatrixRequestValidationErrorCode, message: string): ParseCompareMatrixRequestShapeResult {
  return { ok: false, error: { code, message } };
}

export function parseCompareMatrixRequestShape(body: unknown): ParseCompareMatrixRequestShapeResult {
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

  let amountsInRaw: readonly string[] | undefined;
  if (record.amountsIn !== undefined) {
    if (!Array.isArray(record.amountsIn)) {
      return invalid("INVALID_AMOUNTS_IN", '"amountsIn" must be an array of decimal strings.');
    }
    if (record.amountsIn.length === 0) {
      return invalid("EMPTY_AMOUNTS_IN", '"amountsIn" must not be an empty array — omit the field entirely to use the default ladder.');
    }
    if (record.amountsIn.length > MAX_MATRIX_AMOUNTS) {
      return invalid("TOO_MANY_AMOUNTS_IN", `"amountsIn" has ${record.amountsIn.length} entries, exceeding the maximum of ${MAX_MATRIX_AMOUNTS}.`);
    }
    for (const entry of record.amountsIn) {
      if (typeof entry !== "string") {
        return invalid("INVALID_AMOUNTS_IN", '"amountsIn" entries must be decimal strings.');
      }
    }
    amountsInRaw = record.amountsIn as string[];
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

  return { ok: true, value: { tokenOut, amountsInRaw, hookData } };
}

const AMOUNTS_IN_REASON_MESSAGES: Record<Exclude<ReturnType<typeof parseTokenAmount>, { ok: true }>["reason"], string> = {
  EMPTY: '"amountsIn" entries must not be empty.',
  MALFORMED: '"amountsIn" entries must be plain positive decimal numbers (no scientific notation, thousands separators, or sign).',
  NOT_POSITIVE: '"amountsIn" entries must be greater than zero.',
  EXCESS_PRECISION: '"amountsIn" has an entry with more fractional digits than this token supports.',
};

export type ResolveAmountsInResult =
  | { readonly ok: true; readonly value: readonly bigint[] | undefined }
  | { readonly ok: false; readonly error: CompareMatrixRequestValidationError };

/**
 * `amountsInRaw === undefined` -> `{ ok: true, value: undefined }` (the
 * caller applies the default ladder). Otherwise parses EVERY entry via
 * the existing, exact `parseTokenAmount` (reused, never reimplemented),
 * failing closed on the FIRST malformed entry — mirrors both
 * `resolveAmountIn`'s own single-value contract and 6F.1's own "first
 * offending entry" ladder-validation precedent (`read-uniswap-v3-depth-
 * curve.ts`).
 */
export function resolveAmountsIn(amountsInRaw: readonly string[] | undefined, tokenDecimals: number): ResolveAmountsInResult {
  if (amountsInRaw === undefined) {
    return { ok: true, value: undefined };
  }
  const parsed: bigint[] = [];
  for (const raw of amountsInRaw) {
    const result = parseTokenAmount(raw, tokenDecimals);
    if (!result.ok) {
      return { ok: false, error: { code: "INVALID_AMOUNTS_IN", message: AMOUNTS_IN_REASON_MESSAGES[result.reason] } };
    }
    parsed.push(result.value);
  }
  return { ok: true, value: parsed };
}
