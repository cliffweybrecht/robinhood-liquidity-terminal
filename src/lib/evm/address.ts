import { getAddress, isAddress, type Address } from "viem";

/**
 * Whether `value` is a syntactically valid, correctly-checksummed EVM
 * address (0x-prefixed, 40 hex characters). This is a shape/checksum
 * check only — it says nothing about what the address *is* (canonical
 * asset, pool, arbitrary wallet, etc.); that's the caller's concern.
 */
export function isValidEvmAddress(value: string): value is Address {
  return isAddress(value);
}

/**
 * Normalizes an address to its EIP-55 checksummed form for canonical
 * storage and display. Throws if `value` is not a valid address shape —
 * callers must check `isValidEvmAddress` first when the input is
 * untrusted.
 */
export function toChecksummedAddress(value: string): Address {
  return getAddress(value);
}
