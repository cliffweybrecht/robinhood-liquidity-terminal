import type { Hex } from "viem";

/**
 * Hand-decodes ABI return words with the same strict-decoding policy
 * `pool-verification/abi/decode.ts` and `pool-state/abi/decode.ts`
 * established: every numeric field is checked against its *exact*
 * Solidity-declared range/shape, never just "fits in a `bigint`."
 * Deliberately duplicated locally rather than imported from either
 * sibling module — same module-independence policy those two modules
 * already established between each other.
 */
const WORD_HEX_LENGTH = 64; // 32 bytes * 2 hex chars per byte
const UINT8_MAX = 0xffn;
const UINT16_MAX = 0xffffn;
const UINT24_MAX = 0xffffffn;
const UINT32_MAX = 0xffffffffn;
const UINT160_MAX = (1n << 160n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const INT24_MIN = -8388608n; // -(2^23)
const INT24_MAX = 8388607n; // 2^23 - 1
const UINT256_SIGN_BIT = 1n << 255n;
const UINT256_MODULUS = 1n << 256n;

function wordToUint(raw: Hex, max: bigint): bigint | null {
  const body = raw.slice(2);
  if (body.length !== WORD_HEX_LENGTH) return null;
  const value = BigInt(`0x${body}`);
  if (value < 0n || value > max) return null;
  return value;
}

/** Decodes a single ABI `uint8` return value (e.g. ERC20 `decimals()`). */
export function decodeUint8Return(raw: Hex): number | null {
  const value = wordToUint(raw, UINT8_MAX);
  return value === null ? null : Number(value);
}

/** Decodes a single ABI `uint16` return value (e.g. `slot0()`'s observation-slot fields). */
export function decodeUint16Return(raw: Hex): number | null {
  const value = wordToUint(raw, UINT16_MAX);
  return value === null ? null : Number(value);
}

export function decodeUint24Return(raw: Hex): number | null {
  const value = wordToUint(raw, UINT24_MAX);
  return value === null ? null : Number(value);
}

/**
 * Decodes a single ABI `int24` value (e.g. `slot0()`/`getSlot0()`'s
 * `tick`). Reads the word as a signed 256-bit two's-complement integer
 * and rejects anything outside the genuine `int24` range — matches
 * `pool-state/abi/decode.ts`'s `decodeInt24Return`, deliberately
 * duplicated here rather than imported (same module-independence policy
 * this file's own doc comment already establishes for every other
 * primitive in it).
 */
export function decodeInt24Return(raw: Hex): number | null {
  const body = raw.slice(2);
  if (body.length !== WORD_HEX_LENGTH) return null;

  const unsigned = BigInt(`0x${body}`);
  const signed = unsigned >= UINT256_SIGN_BIT ? unsigned - UINT256_MODULUS : unsigned;
  if (signed < INT24_MIN || signed > INT24_MAX) return null;
  return Number(signed);
}

/** Decodes a single ABI `bool` value — canonical encoding is exactly `0` or `1` in the full 32-byte word; anything else is a decode failure, never coerced. */
export function decodeBoolReturn(raw: Hex): boolean | null {
  const body = raw.slice(2);
  if (body.length !== WORD_HEX_LENGTH) return null;
  const value = BigInt(`0x${body}`);
  if (value === 0n) return false;
  if (value === 1n) return true;
  return null;
}

export function decodeUint32Return(raw: Hex): number | null {
  const value = wordToUint(raw, UINT32_MAX);
  return value === null ? null : Number(value);
}

/** Kept as a `bigint`, never narrowed to `number`. */
export function decodeUint160Return(raw: Hex): bigint | null {
  return wordToUint(raw, UINT160_MAX);
}

/** Kept as a `bigint`, never narrowed to `number`. */
export function decodeUint256Return(raw: Hex): bigint | null {
  return wordToUint(raw, UINT256_MAX);
}

function word(raw: Hex, index: number): Hex {
  const body = raw.slice(2);
  const start = index * WORD_HEX_LENGTH;
  return `0x${body.slice(start, start + WORD_HEX_LENGTH)}` as Hex;
}

/** `QuoterV2.quoteExactInputSingle`'s full 4-word success return: `(uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)`. */
export interface V3QuoteReturn {
  readonly amountOut: bigint;
  readonly sqrtPriceX96After: bigint;
  readonly initializedTicksCrossed: number;
  readonly gasEstimate: bigint;
}

const V3_QUOTE_WORD_COUNT = 4;
const V3_QUOTE_HEX_LENGTH = 2 + WORD_HEX_LENGTH * V3_QUOTE_WORD_COUNT;

/** Decodes and validates the ENTIRE 4-word `quoteExactInputSingle` (V3) success return — exact length, no truncation, no trailing bytes, every word individually range-checked. */
export function decodeV3QuoteReturn(raw: Hex): V3QuoteReturn | null {
  const body = raw.slice(2);
  if (body.length !== V3_QUOTE_HEX_LENGTH - 2) return null;

  const amountOut = decodeUint256Return(word(raw, 0));
  if (amountOut === null) return null;
  const sqrtPriceX96After = decodeUint160Return(word(raw, 1));
  if (sqrtPriceX96After === null) return null;
  const initializedTicksCrossed = decodeUint32Return(word(raw, 2));
  if (initializedTicksCrossed === null) return null;
  const gasEstimate = decodeUint256Return(word(raw, 3));
  if (gasEstimate === null) return null;

  return { amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate };
}

/** `V4Quoter.quoteExactInputSingle`'s full 2-word success return: `(uint256 amountOut, uint256 gasEstimate)`. */
export interface V4QuoteReturn {
  readonly amountOut: bigint;
  readonly gasEstimate: bigint;
}

const V4_QUOTE_WORD_COUNT = 2;
const V4_QUOTE_HEX_LENGTH = 2 + WORD_HEX_LENGTH * V4_QUOTE_WORD_COUNT;

/** Decodes and validates the ENTIRE 2-word `quoteExactInputSingle` (V4) success return — exact length, no truncation, no trailing bytes. */
export function decodeV4QuoteReturn(raw: Hex): V4QuoteReturn | null {
  const body = raw.slice(2);
  if (body.length !== V4_QUOTE_HEX_LENGTH - 2) return null;

  const amountOut = decodeUint256Return(word(raw, 0));
  if (amountOut === null) return null;
  const gasEstimate = decodeUint256Return(word(raw, 1));
  if (gasEstimate === null) return null;

  return { amountOut, gasEstimate };
}

const V3_SLOT0_WORD_COUNT = 7;
const V3_SLOT0_HEX_LENGTH = 2 + WORD_HEX_LENGTH * V3_SLOT0_WORD_COUNT;

/**
 * Validates the ENTIRE 7-word `slot0()` (Uniswap V3 pool) success return
 * — `(uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16
 * observationCardinality, uint16 observationCardinalityNext, uint8
 * feeProtocol, bool unlocked)` — exact length, no truncation, no
 * trailing bytes, every word individually range-checked, same discipline
 * as `decodeV3QuoteReturn` above. Deliberately returns ONLY
 * `sqrtPriceX96` (Phase 6E.2 needs nothing else from this tuple) — the
 * other 6 words are still fully decoded and validated as part of
 * confirming this is a well-formed 7-word tuple at all, they are simply
 * not surfaced, matching `pool-state/abi/decode.ts`'s
 * `decodeSlot0Return` precedent for the identical shape (duplicated
 * here, not imported, per this file's established module-independence
 * policy).
 */
export function decodeV3Slot0SqrtPriceX96(raw: Hex): bigint | null {
  const body = raw.slice(2);
  if (body.length !== V3_SLOT0_HEX_LENGTH - 2) return null;

  const sqrtPriceX96 = decodeUint160Return(word(raw, 0));
  if (sqrtPriceX96 === null) return null;
  if (decodeInt24Return(word(raw, 1)) === null) return null; // tick
  if (decodeUint16Return(word(raw, 2)) === null) return null; // observationIndex
  if (decodeUint16Return(word(raw, 3)) === null) return null; // observationCardinality
  if (decodeUint16Return(word(raw, 4)) === null) return null; // observationCardinalityNext
  if (decodeUint8Return(word(raw, 5)) === null) return null; // feeProtocol
  if (decodeBoolReturn(word(raw, 6)) === null) return null; // unlocked

  return sqrtPriceX96;
}

const V4_SLOT0_WORD_COUNT = 4;
const V4_SLOT0_HEX_LENGTH = 2 + WORD_HEX_LENGTH * V4_SLOT0_WORD_COUNT;

/**
 * Validates the ENTIRE 4-word `StateView.getSlot0(poolId)` (Uniswap V4)
 * success return — `(uint160 sqrtPriceX96, int24 tick, uint24
 * protocolFee, uint24 lpFee)` — same discipline as
 * `decodeV3Slot0SqrtPriceX96` above, a different (shorter) canonical V4
 * shape, not a V3 tuple with fields removed. Returns ONLY `sqrtPriceX96`,
 * for the same reason.
 */
export function decodeV4Slot0SqrtPriceX96(raw: Hex): bigint | null {
  const body = raw.slice(2);
  if (body.length !== V4_SLOT0_HEX_LENGTH - 2) return null;

  const sqrtPriceX96 = decodeUint160Return(word(raw, 0));
  if (sqrtPriceX96 === null) return null;
  if (decodeInt24Return(word(raw, 1)) === null) return null; // tick
  if (decodeUint24Return(word(raw, 2)) === null) return null; // protocolFee
  if (decodeUint24Return(word(raw, 3)) === null) return null; // lpFee

  return sqrtPriceX96;
}
