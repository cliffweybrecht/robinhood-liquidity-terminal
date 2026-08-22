import { getAddress, isAddress, type Address } from "viem";

/**
 * Whether `value` is a syntactically valid EVM contract address
 * (0x-prefixed, 40 hex characters). This is a shape check only — it does
 * not confirm the address corresponds to a canonical Robinhood Stock
 * Token; that is what the asset registry lookup is for.
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
