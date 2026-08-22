export type PoolDiscoveryErrorCode = "DUPLICATE_POOL_CONFLICT";

export abstract class PoolDiscoveryError extends Error {
  abstract readonly code: PoolDiscoveryErrorCode;
}

/**
 * Integrity conflict: Dexscreener returned two or more records for the
 * same pool (same `chainId` + `pairAddress`) that disagree on at least
 * one normalized field. Materially identical duplicates are silently
 * deduplicated (see `src/domain/pool/normalize.ts`); this is reserved
 * for the case where they don't agree — we refuse to silently pick one.
 */
export class DuplicatePoolConflictError extends PoolDiscoveryError {
  readonly code = "DUPLICATE_POOL_CONFLICT" as const;
  readonly chainId: string;
  readonly pairAddress: string;

  constructor(chainId: string, pairAddress: string) {
    super(
      `Integrity conflict: Dexscreener returned multiple records for pool ${chainId}/${pairAddress} that disagree on one or more fields`,
    );
    this.name = "DuplicatePoolConflictError";
    this.chainId = chainId;
    this.pairAddress = pairAddress;
  }
}
