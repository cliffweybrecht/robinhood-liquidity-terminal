import { isAddress, isHex, type Address, type Hex } from "viem";
import { NATIVE_ETH, type TokenOutIdentifier } from "./types";

/**
 * Validation for the `POST /api/assets/[symbol]/execution/cross-market`
 * request body. Mirrors `requestDepthThresholds.ts`'s own discipline
 * (server-authoritative ladder/thresholds, no caller override of
 * either) plus this endpoint's own two additional, cross-market-
 * specific concerns:
 *
 *  - `tokenOuts` (plural, an array) replaces the single-group
 *    `tokenOut` every sibling request module accepts. Omitted means
 *    "select every eligible group" (resolved downstream, against the
 *    live snapshot, by `resolveSelectedGroupsForCrossMarket` in
 *    `compareCrossMarket.ts`). An explicit array is validated HERE at
 *    two independent levels:
 *     1. per-entry FORMAT (`INVALID_TOKEN_OUTS`) — not an array, a
 *        non-string entry, or a string that is neither `NATIVE_ETH` nor
 *        a valid 0x-prefixed address.
 *     2. SELECTION shape (`INVALID_MARKET_SELECTION`) — fewer than 2
 *        entries, or a case-insensitive duplicate (including two
 *        `NATIVE_ETH` entries) — both making this "technically an
 *        array of valid tokenOut identifiers" but not a valid
 *        cross-market SELECTION. Never silently deduplicated or
 *        truncated — an invalid selection is rejected, not repaired.
 *  - No caller-supplied `amounts`/`ladder`/`thresholds`/`blockNumber`/
 *    `cellCap`/`concurrency`/normalization input of ANY kind — this
 *    endpoint's only optional fields are `tokenOuts` and `hookData`.
 *    Unlike `requestDepthThresholds.ts`, this module does NOT
 *    explicitly fail-closed on stray authority-bearing field names
 *    (`amountsIn`/`thresholds`/etc.) — those fields simply don't exist
 *    in `ParsedCrossMarketRequestShape`, so supplying them has no
 *    effect either way; this endpoint has no server-authoritative
 *    override surface for a caller to mistakenly believe was honored.
 *
 * `hookData` validation is IDENTICAL, restated (not imported) from
 * `request.ts`/`requestMatrix.ts`/`requestDepthThresholds.ts`'s own
 * copies — same established "restate small, stable shape-validation
 * glue rather than couple sibling request modules together" precedent
 * those three files already establish relative to one another.
 */

export type CrossMarketRequestValidationErrorCode = "INVALID_BODY" | "INVALID_TOKEN_OUTS" | "INVALID_MARKET_SELECTION" | "INVALID_HOOK_DATA";

export interface CrossMarketRequestValidationError {
  readonly code: CrossMarketRequestValidationErrorCode;
  readonly message: string;
}

export interface ParsedCrossMarketRequestShape {
  readonly tokenOuts?: readonly TokenOutIdentifier[];
  readonly hookData?: ReadonlyMap<string, Hex>;
}

export type ParseCrossMarketRequestShapeResult =
  | { readonly ok: true; readonly value: ParsedCrossMarketRequestShape }
  | { readonly ok: false; readonly error: CrossMarketRequestValidationError };

function invalid(code: CrossMarketRequestValidationErrorCode, message: string): ParseCrossMarketRequestShapeResult {
  return { ok: false, error: { code, message } };
}

/** Case-insensitive dedupe key — an address lowercased, or the `NATIVE_ETH` sentinel verbatim (it has no casing). Restated, not imported from `snapshot.ts`'s own private `tokenOutSortKey`, which exists for a different purpose (deterministic group ordering) in a different module. */
function tokenOutDedupeKey(tokenOut: TokenOutIdentifier): string {
  return tokenOut === NATIVE_ETH ? NATIVE_ETH : tokenOut.toLowerCase();
}

export function parseCrossMarketRequestShape(body: unknown): ParseCrossMarketRequestShapeResult {
  if (body === null || body === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return invalid("INVALID_BODY", "Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;

  let tokenOuts: TokenOutIdentifier[] | undefined;
  if (record.tokenOuts !== undefined) {
    if (!Array.isArray(record.tokenOuts)) {
      return invalid("INVALID_TOKEN_OUTS", '"tokenOuts" must be an array of addresses or "NATIVE_ETH".');
    }

    const parsed: TokenOutIdentifier[] = [];
    for (const entry of record.tokenOuts) {
      if (typeof entry !== "string") {
        return invalid("INVALID_TOKEN_OUTS", '"tokenOuts" entries must be strings.');
      }
      if (entry === NATIVE_ETH) {
        parsed.push(NATIVE_ETH);
      } else if (isAddress(entry)) {
        parsed.push(entry as Address);
      } else {
        return invalid("INVALID_TOKEN_OUTS", `"${entry}" in "tokenOuts" must be "${NATIVE_ETH}" or a valid 0x-prefixed address.`);
      }
    }

    if (parsed.length < 2) {
      return invalid(
        "INVALID_MARKET_SELECTION",
        '"tokenOuts" must contain at least 2 entries when explicitly supplied — omit the field entirely to select every eligible output group.',
      );
    }

    const seen = new Set<string>();
    for (const tokenOut of parsed) {
      const key = tokenOutDedupeKey(tokenOut);
      if (seen.has(key)) {
        return invalid("INVALID_MARKET_SELECTION", `"tokenOuts" contains a duplicate entry ("${tokenOut}") — each requested output group must be distinct.`);
      }
      seen.add(key);
    }

    tokenOuts = parsed;
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

  return { ok: true, value: { tokenOuts, hookData } };
}
