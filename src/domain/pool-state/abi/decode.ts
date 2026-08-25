import type { Hex } from "viem";

/**
 * Hand-decodes ABI return words with the same strict-decoding policy
 * `pool-verification/abi/decode.ts` established: every numeric/boolean
 * field is checked against its *exact* Solidity-declared range/shape,
 * not just "fits in a `bigint`" — a well-formed response from a real
 * `uint16`/`uint8`/`bool`-returning function always satisfies these
 * checks, and anything else is treated as a decode failure rather than
 * silently accepted.
 *
 * This module intentionally does NOT import `pool-verification`'s
 * decoders, even though `int24`/`uint24` decoding is identical logic —
 * `pool-verification/abi/` is deliberately not exported from that
 * module's `index.ts` ("internals... not exported"), and reaching past
 * that boundary with a deep relative import would couple two modules
 * this phase's architecture requires to stay independent (see
 * `../read-uniswap-v3-state.ts`'s module doc comment). The ~10 lines of
 * duplicated int24/uint24 logic is the accepted cost of that boundary.
 */
const WORD_HEX_LENGTH = 64; // 32 bytes * 2 hex chars per byte
const UINT8_MAX = 0xffn;
const UINT16_MAX = 0xffffn;
const UINT24_MAX = 0xffffffn;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n;
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

export function decodeUint8Return(raw: Hex): number | null {
  const value = wordToUint(raw, UINT8_MAX);
  return value === null ? null : Number(value);
}

export function decodeUint16Return(raw: Hex): number | null {
  const value = wordToUint(raw, UINT16_MAX);
  return value === null ? null : Number(value);
}

/** Decodes a single ABI `uint24` return value (e.g. `fee()`). */
export function decodeUint24Return(raw: Hex): number | null {
  const value = wordToUint(raw, UINT24_MAX);
  return value === null ? null : Number(value);
}

/** Decodes a single ABI `uint128` return value (e.g. `liquidity()`) — kept as a `bigint`, never narrowed to `number`. */
export function decodeUint128Return(raw: Hex): bigint | null {
  return wordToUint(raw, UINT128_MAX);
}

/** Decodes a single ABI `uint160` return value (e.g. `slot0().sqrtPriceX96`) — kept as a `bigint`, never narrowed to `number`. */
export function decodeUint160Return(raw: Hex): bigint | null {
  return wordToUint(raw, UINT160_MAX);
}

/**
 * Decodes a single ABI `int24` value (e.g. `slot0().tick`,
 * `tickSpacing()`). Reads the word as a signed 256-bit two's-complement
 * integer and rejects anything outside the genuine `int24` range — a
 * word that isn't a faithfully sign-extended `int24` decodes to a value
 * outside that range and is treated as a decode failure.
 */
export function decodeInt24Return(raw: Hex): number | null {
  const body = raw.slice(2);
  if (body.length !== WORD_HEX_LENGTH) return null;

  const unsigned = BigInt(`0x${body}`);
  const signed = unsigned >= UINT256_SIGN_BIT ? unsigned - UINT256_MODULUS : unsigned;
  if (signed < INT24_MIN || signed > INT24_MAX) return null;
  return Number(signed);
}

/** Decodes a single ABI `bool` value. Canonical encoding is exactly `0` or `1` in the full 32-byte word — any other value (including a dirty non-zero word other than 1) is a decode failure, never coerced to a truthy/falsy guess. */
export function decodeBoolReturn(raw: Hex): boolean | null {
  const body = raw.slice(2);
  if (body.length !== WORD_HEX_LENGTH) return null;
  const value = BigInt(`0x${body}`);
  if (value === 0n) return false;
  if (value === 1n) return true;
  return null;
}

/** The full `slot0()` return tuple, structurally validated word-by-word. */
export interface Slot0Tuple {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly observationIndex: number;
  readonly observationCardinality: number;
  readonly observationCardinalityNext: number;
  readonly feeProtocol: number;
  readonly unlocked: boolean;
}

const SLOT0_WORD_COUNT = 7;
const SLOT0_HEX_LENGTH = 2 + WORD_HEX_LENGTH * SLOT0_WORD_COUNT;

function slot0Word(raw: Hex, index: number): Hex {
  const body = raw.slice(2);
  const start = index * WORD_HEX_LENGTH;
  return `0x${body.slice(start, start + WORD_HEX_LENGTH)}` as Hex;
}

/**
 * Decodes and validates the *entire* `slot0()` return tuple — all 7
 * ABI words, not just the `sqrtPriceX96`/`tick` fields this phase's
 * domain result exposes. A malformed trailing word (e.g. a corrupted
 * `feeProtocol`/`unlocked` encoding) is still a decode failure even
 * though those specific fields are never surfaced downstream: accepting
 * a response with any invalid word would mean trusting a response this
 * module cannot actually prove is well-formed ABI output at all.
 */
export function decodeSlot0Return(raw: Hex): Slot0Tuple | null {
  const body = raw.slice(2);
  if (body.length !== SLOT0_HEX_LENGTH - 2) return null;

  const sqrtPriceX96 = decodeUint160Return(slot0Word(raw, 0));
  if (sqrtPriceX96 === null) return null;
  const tick = decodeInt24Return(slot0Word(raw, 1));
  if (tick === null) return null;
  const observationIndex = decodeUint16Return(slot0Word(raw, 2));
  if (observationIndex === null) return null;
  const observationCardinality = decodeUint16Return(slot0Word(raw, 3));
  if (observationCardinality === null) return null;
  const observationCardinalityNext = decodeUint16Return(slot0Word(raw, 4));
  if (observationCardinalityNext === null) return null;
  const feeProtocol = decodeUint8Return(slot0Word(raw, 5));
  if (feeProtocol === null) return null;
  const unlocked = decodeBoolReturn(slot0Word(raw, 6));
  if (unlocked === null) return null;

  return { sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, feeProtocol, unlocked };
}
