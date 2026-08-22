import { isAddress } from "viem";
import type { Hex } from "viem";

// Uniswap v4 pools are identified by a bytes32 PoolId rather than a
// deployed per-pool contract address. See schema.ts / README for the
// evidence that `labels` is not a reliable discriminator for this.
const POOL_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * A Dexscreener pool/pair identifier is valid if it is either a 20-byte
 * deployed contract address (most DEXes) or a 32-byte PoolId (Uniswap
 * v4). Both forms are treated as opaque identifiers here — only the
 * 20-byte form can be EIP-55 checksummed.
 */
export function isValidPairIdentifier(value: string): value is Hex {
  return isAddress(value) || POOL_ID_PATTERN.test(value);
}
