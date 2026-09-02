/**
 * Exact, floating-point-free conversion between a human-typed decimal
 * string (e.g. a trade-size input) and the raw `bigint` base-unit value
 * a token amount actually is on-chain, given that token's own
 * `decimals`. Deliberately its own small module — no existing exact
 * decimal parser exists elsewhere in this codebase (every existing
 * numeric formatter in `src/app/` operates on plain `number`, never
 * bigint) — and this one deliberately does nothing beyond parsing;
 * display/formatting is a separate, symmetric concern
 * (`formatTokenAmount`, same file).
 */

export type ParseTokenAmountResult =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly reason: "EMPTY" | "MALFORMED" | "NOT_POSITIVE" | "EXCESS_PRECISION" };

const DECIMAL_STRING_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a user-typed decimal string (e.g. `"1"`, `"1.5"`, `"0.000001"`)
 * into the exact raw base-unit `bigint` for a token with `decimals`
 * fractional digits — e.g. `parseTokenAmount("1.5", 18)` returns
 * `1500000000000000000n`. Never uses floating-point arithmetic at any
 * step (no `Number(...)`, no `parseFloat`) — every digit is handled as
 * a plain string/bigint operation, so this can never introduce the
 * rounding error a `Number`-based conversion would for a value with
 * many fractional digits.
 *
 * Deliberately REJECTS (never silently truncates/rounds) an input with
 * MORE fractional digits than `decimals` supports — e.g.
 * `parseTokenAmount("1.1234567", 6)` fails with `"EXCESS_PRECISION"`
 * rather than silently dropping the extra digit(s), because silently
 * rounding a user's own typed trade size is exactly the kind of "fake
 * precision" this project's entire execution-truth design forbids.
 *
 * Rejects: empty/whitespace-only input, a negative sign, anything that
 * is not plain ASCII digits with at most one decimal point (no
 * scientific notation, no thousands separators, no leading `+`), and
 * zero (a `0`/`0.0` amount is syntactically valid but semantically
 * useless for an exact-input trade — callers that need `amountIn > 0`
 * enforced get it here, once, rather than re-checking after parsing).
 */
export function parseTokenAmount(raw: string, decimals: number): ParseTokenAmountResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "EMPTY" };
  }

  const match = DECIMAL_STRING_PATTERN.exec(trimmed);
  if (!match) {
    return { ok: false, reason: "MALFORMED" };
  }

  const wholePart = match[1] as string;
  const fractionalPart = match[2] ?? "";

  if (fractionalPart.length > decimals) {
    return { ok: false, reason: "EXCESS_PRECISION" };
  }

  const paddedFractional = fractionalPart.padEnd(decimals, "0");
  const combined = `${wholePart}${paddedFractional}`;
  // Strip any leading zeros before parsing to bigint — BigInt() itself
  // handles a leading-zero decimal digit string fine, but an all-zero
  // string ("0", "00") must still parse to exactly 0n, checked below.
  const value = BigInt(combined);

  if (value <= 0n) {
    return { ok: false, reason: "NOT_POSITIVE" };
  }

  return { ok: true, value };
}

/**
 * The exact inverse of `parseTokenAmount` for DISPLAY — converts a raw
 * base-unit `bigint` into a truncated (never rounded) human decimal
 * string, capped at `maxFractionalDigits` fractional digits (default
 * 6). Truncation, not rounding, is deliberate: a truncated display
 * value can only ever UNDERSTATE the true amount, never overstate it —
 * the conservative direction to err in for a number a user might act
 * on. Returns the FULL-PRECISION string separately (`full`) so a
 * caller can expose it via a `title`/hover attribute without a second
 * conversion.
 */
export interface FormattedTokenAmount {
  readonly display: string;
  readonly full: string;
}

export function formatTokenAmount(raw: bigint, decimals: number, maxFractionalDigits = 6): FormattedTokenAmount {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const remainder = abs % divisor;
  const fractional = remainder.toString().padStart(decimals, "0");

  const fullFractionalTrimmed = fractional.replace(/0+$/, "");
  const full = fullFractionalTrimmed.length > 0 ? `${whole}.${fullFractionalTrimmed}` : `${whole}`;

  const truncatedFractional = fractional.slice(0, Math.min(decimals, maxFractionalDigits)).replace(/0+$/, "");
  const display = truncatedFractional.length > 0 ? `${whole}.${truncatedFractional}` : `${whole}`;

  const sign = negative ? "-" : "";
  return { display: `${sign}${display}`, full: `${sign}${full}` };
}

/**
 * Exact long-division of `remainder / denominator` (`remainder <
 * denominator` assumed) into `digits` fractional decimal digits, as a
 * plain digit string — no floating point at any step.
 */
function longDivisionFractionalDigits(remainder: bigint, denominator: bigint, digits: number): string {
  let r = remainder;
  let out = "";
  for (let i = 0; i < digits; i++) {
    r *= 10n;
    out += (r / denominator).toString();
    r %= denominator;
  }
  return out;
}

/**
 * Formats an exact `RationalValue`-shaped `{ numerator, denominator }`
 * (see `src/domain/pool-quote/types.ts`) for display — used for
 * execution price and price-impact-bps, both of which are exact
 * rationals, never a `bigint`+fixed-decimals token amount (that case is
 * `formatTokenAmount` above). Never converts either bigint to `Number`
 * at any point — the whole part and every fractional digit are produced
 * by exact bigint long division. `denominator` is assumed `> 0n`,
 * matching `RationalValue`'s own documented invariant; a `0n`
 * denominator (which should be structurally unreachable per that
 * invariant) renders as `"—"` rather than throwing/dividing by zero.
 *
 * Unlike `formatTokenAmount`, `full` here is NOT a claim of true exact
 * precision (an arbitrary rational can be a non-terminating decimal,
 * e.g. 1/3) — it is simply a longer (12+ digit) truncation, intended
 * for a hover/title attribute that shows meaningfully more precision
 * than the primary `display` value, not infinite precision.
 *
 * Sign handling: the `-` sign is only prefixed when the value is
 * negative AND the value at the requested display precision is
 * non-zero — a negative value that truncates to exactly `"0"` at
 * `maxFractionalDigits` renders as `"0"`, not the arguably-more
 * -confusing `"-0"` (the `full` string, at higher precision, still
 * shows the true sign whenever the value is genuinely non-zero there).
 */
export function formatRational(numerator: bigint, denominator: bigint, maxFractionalDigits = 6): FormattedTokenAmount {
  if (denominator <= 0n) {
    return { display: "—", full: "—" };
  }

  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const whole = absNumerator / denominator;
  const remainder = absNumerator % denominator;

  const displayFractional = longDivisionFractionalDigits(remainder, denominator, maxFractionalDigits).replace(/0+$/, "");
  const extendedFractional = longDivisionFractionalDigits(remainder, denominator, Math.max(maxFractionalDigits, 12)).replace(/0+$/, "");

  const display = displayFractional ? `${whole}.${displayFractional}` : `${whole}`;
  const full = extendedFractional ? `${whole}.${extendedFractional}` : `${whole}`;

  const displayIsZero = whole === 0n && displayFractional === "";
  const fullIsZero = whole === 0n && extendedFractional === "";

  return {
    display: `${negative && !displayIsZero ? "-" : ""}${display}`,
    full: `${negative && !fullIsZero ? "-" : ""}${full}`,
  };
}
