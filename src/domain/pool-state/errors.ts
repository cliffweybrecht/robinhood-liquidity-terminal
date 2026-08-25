/**
 * Typed precondition failures for `readVerifiedUniswapV3PoolState`.
 * Deliberately a separate hierarchy from `pool-verification`'s
 * `PoolVerificationError` (not reused, not extended, not imported) — see
 * the module doc comment on `read-uniswap-v3-state.ts` for why identity
 * verification and state reading are kept as fully independent trust
 * boundaries, down to the type level. Every one of these is thrown
 * *before* any protocol state RPC call is made: a precondition failure
 * is a caller-usage/trust-boundary problem, never a per-pool epistemic
 * outcome, so it is never folded into `PoolStateVerification.status`.
 */
export type PoolStateErrorCode =
  | "POOL_IDENTITY_MISMATCH"
  | "IDENTITY_NOT_VERIFIED"
  | "UNSUPPORTED_IDENTITY_FAMILY"
  | "MISSING_IDENTITY_BLOCK"
  | "UNEXPECTED_IDENTIFIER_SHAPE";

export abstract class PoolStateError extends Error {
  abstract readonly code: PoolStateErrorCode;
}

/**
 * `identity.pool` does not match the supplied `pool` (different
 * `chainId`/`pairAddress`). Mirrors `pool-verification`'s
 * `PoolClassificationMismatchError` — a caller could otherwise pass a
 * genuinely `VERIFIED` identity proof for one pool alongside a
 * different pool's data, and this module would silently read the wrong
 * contract's state under the wrong pool's label.
 */
export class PoolIdentityMismatchError extends PoolStateError {
  readonly code = "POOL_IDENTITY_MISMATCH" as const;
  readonly poolPairAddress: string;
  readonly identityPairAddress: string;

  constructor(poolPairAddress: string, identityPairAddress: string) {
    super(
      `identity.pool.pairAddress ("${identityPairAddress}") does not match pool.pairAddress ("${poolPairAddress}") — readVerifiedUniswapV3PoolState requires an identity proof produced from the same pool`,
    );
    this.name = "PoolIdentityMismatchError";
    this.poolPairAddress = poolPairAddress;
    this.identityPairAddress = identityPairAddress;
  }
}

/** `identity.status !== "VERIFIED"`. Current state may only be read for a pool whose identity has already been proven, never a merely-attempted one. */
export class IdentityNotVerifiedError extends PoolStateError {
  readonly code = "IDENTITY_NOT_VERIFIED" as const;
  readonly status: string;

  constructor(status: string) {
    super(`identity.status is "${status}", not "VERIFIED" — current pool state can only be read for an already-VERIFIED identity`);
    this.name = "IdentityNotVerifiedError";
    this.status = status;
  }
}

/** `identity.family !== "UNISWAP_V3"`. This module has no V4 (or other) state reader — see the module doc comment for why that's a deliberate scope boundary, not a missing dispatch branch. */
export class UnsupportedIdentityFamilyError extends PoolStateError {
  readonly code = "UNSUPPORTED_IDENTITY_FAMILY" as const;
  readonly family: string;

  constructor(family: string) {
    super(`identity.family is "${family}" — readVerifiedUniswapV3PoolState only supports UNISWAP_V3`);
    this.name = "UnsupportedIdentityFamilyError";
    this.family = family;
  }
}

/** `identity.blockNumber === null` on a `VERIFIED` identity. Should be unreachable (`VERIFIED` implies a block was pinned during identity verification) but re-checked explicitly rather than trusted — the same defensive-invariant policy `pool-verification` already established. */
export class MissingIdentityBlockError extends PoolStateError {
  readonly code = "MISSING_IDENTITY_BLOCK" as const;

  constructor() {
    super("identity.blockNumber is null on a VERIFIED identity — refusing to proceed without confirmed identity provenance");
    this.name = "MissingIdentityBlockError";
  }
}

/** `identity.pool.pairAddress` is not a 20-byte address. Defensive re-check, not a trust assumption — guarantees this module can never route a bytes32 PoolId into an address-only RPC field. */
export class UnexpectedPoolStateIdentifierShapeError extends PoolStateError {
  readonly code = "UNEXPECTED_IDENTIFIER_SHAPE" as const;
  readonly pairAddress: string;

  constructor(pairAddress: string) {
    super(`pairAddress "${pairAddress}" is not a 20-byte address — refusing to read Uniswap V3 pool state against a non-address identifier`);
    this.name = "UnexpectedPoolStateIdentifierShapeError";
    this.pairAddress = pairAddress;
  }
}
