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
const UINT24_MAX = 0xffffffn;
const UINT32_MAX = 0xffffffffn;
const UINT160_MAX = (1n << 160n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function wordToUint(raw: Hex, max: bigint): bigint | null {
  const body = raw.slice(2);
  if (body.length !== WORD_HEX_LENGTH) return null;
  const value = BigInt(`0x${body}`);
  if (value < 0n || value > max) return null;
  return value;
}

export function decodeUint24Return(raw: Hex): number | null {
  const value = wordToUint(raw, UINT24_MAX);
  return value === null ? null : Number(value);
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
