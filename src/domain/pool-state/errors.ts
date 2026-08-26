/**
 * Typed precondition failures shared by `readVerifiedUniswapV3PoolState`
 * and `readVerifiedUniswapV4PoolState`. Deliberately a separate
 * hierarchy from `pool-verification`'s `PoolVerificationError` (not
 * reused, not extended, not imported) — see the module doc comment on
 * `read-uniswap-v3-state.ts` for why identity verification and state
 * reading are kept as fully independent trust boundaries, down to the
 * type level. Every one of these is thrown *before* any protocol state
 * RPC call is made: a precondition failure is a caller-usage/trust-
 * boundary problem, never a per-pool epistemic outcome, so it is never
 * folded into `PoolStateVerification.status`.
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
      `identity.pool.pairAddress ("${identityPairAddress}") does not match pool.pairAddress ("${poolPairAddress}") — current-state reads require an identity proof produced from the same pool`,
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

/** `identity.family` doesn't match the protocol this specific reader function supports. Each reader (`readVerifiedUniswapV3PoolState`/`readVerifiedUniswapV4PoolState`) is protocol-specific by design — there is no generic multi-protocol dispatcher yet (see `types.ts`'s `PoolStateVerification` doc comment) — so passing a V4 identity to the V3 reader (or vice versa) is a caller-usage error, not a per-pool outcome. */
export class UnsupportedIdentityFamilyError extends PoolStateError {
  readonly code = "UNSUPPORTED_IDENTITY_FAMILY" as const;
  readonly family: string;
  readonly expectedFamily: string;

  constructor(family: string, expectedFamily: string) {
    super(`identity.family is "${family}", not "${expectedFamily}" — this reader only supports ${expectedFamily}`);
    this.name = "UnsupportedIdentityFamilyError";
    this.family = family;
    this.expectedFamily = expectedFamily;
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

/** `identity.pool.pairAddress` doesn't have the identifier shape this reader requires (20-byte address for V3, 32-byte PoolId for V4). Defensive re-check, not a trust assumption on `identity.family`'s implied shape — guarantees the V3 reader can never route a bytes32 PoolId into an address-only RPC field, and the V4 reader can never mistake a 20-byte address for a PoolId. */
export class UnexpectedPoolStateIdentifierShapeError extends PoolStateError {
  readonly code = "UNEXPECTED_IDENTIFIER_SHAPE" as const;
  readonly pairAddress: string;
  readonly expectedShape: string;

  constructor(pairAddress: string, expectedShape: string) {
    super(`pairAddress "${pairAddress}" is not ${expectedShape} — refusing to read pool state against a mismatched identifier shape`);
    this.name = "UnexpectedPoolStateIdentifierShapeError";
    this.pairAddress = pairAddress;
    this.expectedShape = expectedShape;
  }
}
