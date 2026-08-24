import { isAddress } from "viem";
import type { Hex } from "viem";

// Uniswap v4 pools are identified by a bytes32 PoolId rather than a
// deployed per-pool contract address. See schema.ts / README for the
// evidence that `labels` is not a reliable discriminator for this.
const POOL_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * The shape of a Dexscreener pool/pair identifier: a 20-byte deployed
 * contract address (most DEXes) or a 32-byte Uniswap v4 PoolId.
 */
export type PoolIdentifierShape = "ADDRESS_20_BYTE" | "ID_32_BYTE";

/**
 * The shape of `value` if it is a valid Phase 2 pool/pair identifier,
 * else `null`. This is the single source of truth for identifier-shape
 * detection — both `isValidPairIdentifier` below and Phase 6B's
 * classifier (`src/domain/protocol/classify.ts`) build on this rather
 * than each maintaining their own copy of the 32-byte PoolId pattern.
 */
export function getPairIdentifierShape(value: string): PoolIdentifierShape | null {
  if (isAddress(value)) return "ADDRESS_20_BYTE";
  if (POOL_ID_PATTERN.test(value)) return "ID_32_BYTE";
  return null;
}

/**
 * A Dexscreener pool/pair identifier is valid if it is either a 20-byte
 * deployed contract address (most DEXes) or a 32-byte PoolId (Uniswap
 * v4). Both forms are treated as opaque identifiers here — only the
 * 20-byte form can be EIP-55 checksummed.
 */
export function isValidPairIdentifier(value: string): value is Hex {
  return getPairIdentifierShape(value) !== null;
}
