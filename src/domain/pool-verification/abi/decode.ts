import { getAddress, isAddress, type Address, type Hex } from "viem";

/**
 * Hand-decodes single-value ABI return words rather than using viem's
 * `decodeFunctionResult` for this half of the round trip. Every call
 * this module makes returns exactly one static-size value (an `address`
 * or a `uint24`, both ABI-encoded as one 32-byte word) — simple enough
 * that a direct, auditable decode is clearer than routing through a
 * generic ABI decoder, and importantly lets this module enforce checks
 * viem's decoder does not perform by default:
 *
 *  - For `address` returns: viem's decoder takes the low 20 bytes of
 *    the word and does not verify the high 12 bytes are zero padding.
 *    A well-formed `address` return always has that padding; anything
 *    else indicates a malformed or unexpected response, and this module
 *    treats that as a decode failure rather than silently accepting
 *    whatever the low 20 bytes happen to be.
 *  - For `uint24` returns: ABI encoding always pads integers to a full
 *    32-byte word regardless of the Solidity type's declared width — the
 *    width is a compile-time fact about the *source* contract, not
 *    something the ABI encoding itself enforces. A value larger than
 *    `2^24 - 1` in that word is impossible for a real `uint24` and is
 *    treated as a decode failure, not silently accepted as a `bigint`.
 *  - For `int24` returns: a signed Solidity integer smaller than 256
 *    bits is ABI-encoded via full sign extension across the whole
 *    32-byte word (every upper bit repeats the value's sign bit). This
 *    module verifies that by reading the word as a signed 256-bit
 *    two's-complement integer and rejecting anything outside the
 *    genuine `int24` range (`-2^23` .. `2^23 - 1`) — a word that isn't a
 *    faithfully sign-extended `int24` decodes to a value outside that
 *    range and is treated as a decode failure. (viem's own
 *    `decodeAbiParameters` decodes `int24` sign-extension correctly, but
 *    this module hand-rolls it anyway for the same reason as `address`
 *    above: untrusted wire data gets this module's own strict checks,
 *    not a generic decoder's leniency, by policy.)
 *
 * Every function here returns `null` for anything that doesn't satisfy
 * every check — never throws, never returns a "best guess" value. `raw`
 * must already be validated hex bytes (e.g. via `isHexBytes`) by the
 * caller; this module only concerns itself with ABI-level shape.
 */
const WORD_HEX_LENGTH = 64; // 32 bytes * 2 hex chars per byte
const ADDRESS_PADDING_HEX_LENGTH = 24; // 12 bytes * 2 hex chars per byte
const UINT24_MAX = 0xffffffn; // 2^24 - 1
const INT24_MIN = -8388608n; // -(2^23)
const INT24_MAX = 8388607n; // 2^23 - 1
const UINT256_SIGN_BIT = 1n << 255n;
const UINT256_MODULUS = 1n << 256n;

/** Decodes a single ABI `address` return value (e.g. `token0()`, `factory()`, `getPool(...)`). */
export function decodeAddressReturn(raw: Hex): Address | null {
  const body = raw.slice(2);
  if (body.length !== WORD_HEX_LENGTH) return null;

  const padding = body.slice(0, ADDRESS_PADDING_HEX_LENGTH);
  if (!/^0+$/.test(padding)) return null;

  const addressHex = `0x${body.slice(ADDRESS_PADDING_HEX_LENGTH)}`;
  if (!isAddress(addressHex)) return null;
  return getAddress(addressHex);
}

/** Decodes a single ABI `uint24` return value (e.g. `fee()`). */
export function decodeUint24Return(raw: Hex): number | null {
  const body = raw.slice(2);
  if (body.length !== WORD_HEX_LENGTH) return null;

  const value = BigInt(`0x${body}`);
  if (value < 0n || value > UINT24_MAX) return null;
  return Number(value);
}

/** Decodes a single ABI `int24` value (e.g. Uniswap V4's `Initialize.tickSpacing`). */
export function decodeInt24Return(raw: Hex): number | null {
  const body = raw.slice(2);
  if (body.length !== WORD_HEX_LENGTH) return null;

  const unsigned = BigInt(`0x${body}`);
  const signed = unsigned >= UINT256_SIGN_BIT ? unsigned - UINT256_MODULUS : unsigned;
  if (signed < INT24_MIN || signed > INT24_MAX) return null;
  return Number(signed);
}
