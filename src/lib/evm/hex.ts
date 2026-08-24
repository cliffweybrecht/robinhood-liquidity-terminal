import type { Hex } from "viem";

const HEX_BYTES_PATTERN = /^0x([0-9a-fA-F]{2})*$/;
const HEX_QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;
const HEX_32_BYTE_WORD_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Whether `value` is a syntactically valid 0x-prefixed hex *byte
 * string* — an even number of hex characters after `0x`, so it decodes
 * to a whole number of bytes. `"0x"` (zero bytes) is valid and is the
 * correct representation of e.g. "no code at this address," not a
 * malformed or missing value.
 *
 * This is the shape used by EVM bytecode and calldata — NOT the shape
 * used by JSON-RPC numeric quantities (`eth_blockNumber`, `eth_chainId`),
 * which allow an odd number of hex digits and no even-byte-count
 * requirement. See `isHexQuantity` for that distinct shape. The two
 * must never be conflated: a quantity like `"0x123"` (3 hex digits, an
 * odd count) is a perfectly valid chain quantity but is not valid hex
 * *bytes* — bytecode/calldata must always decode to a whole number of
 * bytes.
 */
export function isHexBytes(value: unknown): value is Hex {
  return typeof value === "string" && HEX_BYTES_PATTERN.test(value);
}

/**
 * Whether `value` is a syntactically valid 0x-prefixed JSON-RPC
 * *quantity* — at least one hex digit after `0x`, representing a number
 * rather than a byte string. Unlike `isHexBytes`, an odd digit count is
 * valid here (`"0x0"`, `"0x1237"`) since quantities are not byte-aligned.
 * Used for `eth_chainId`/`eth_blockNumber` results and explicit
 * block-number parameters — never for bytecode or calldata.
 */
export function isHexQuantity(value: unknown): value is Hex {
  return typeof value === "string" && HEX_QUANTITY_PATTERN.test(value);
}

/**
 * Whether `value` is a syntactically valid 0x-prefixed hex string of
 * *exactly* 32 bytes (64 hex characters) — one EVM word. This is
 * stricter than `isHexBytes` (which allows any even byte count):
 * log topics, transaction hashes, and block hashes are always exactly
 * one word, never shorter or longer, and a value of the wrong length
 * is malformed regardless of whether it happens to be valid hex.
 */
export function isHex32ByteWord(value: unknown): value is Hex {
  return typeof value === "string" && HEX_32_BYTE_WORD_PATTERN.test(value);
}

/**
 * Parses an already-validated hex quantity string into a `bigint`,
 * never a floating-point `number` — chain quantities (block numbers,
 * chain IDs) must never lose precision to IEEE-754 rounding.
 *
 * Callers must check `isHexQuantity` first when the input is untrusted;
 * this throws a plain `Error` (not a provider-typed error — provider
 * code wraps this with its own typed error, e.g.
 * `RobinhoodRpcInvalidResultError`) if `value` isn't shaped like a hex
 * quantity, since this function is meant to be called only after that
 * check has already passed.
 */
export function hexQuantityToBigInt(value: string): bigint {
  if (!isHexQuantity(value)) {
    throw new Error(`"${value}" is not a valid hex quantity`);
  }
  return BigInt(value);
}
