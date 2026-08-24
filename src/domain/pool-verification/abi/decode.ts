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
 *
 * Every function here returns `null` for anything that doesn't satisfy
 * every check — never throws, never returns a "best guess" value. `raw`
 * must already be validated hex bytes (e.g. via `isHexBytes`) by the
 * caller; this module only concerns itself with ABI-level shape.
 */
const WORD_HEX_LENGTH = 64; // 32 bytes * 2 hex chars per byte
const ADDRESS_PADDING_HEX_LENGTH = 24; // 12 bytes * 2 hex chars per byte
const UINT24_MAX = 0xffffffn; // 2^24 - 1

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
