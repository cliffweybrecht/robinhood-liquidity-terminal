export type PoolVerificationErrorCode =
  | "CLASSIFICATION_MISMATCH"
  | "UNEXPECTED_IDENTIFIER_SHAPE"
  | "UNKNOWN_PROTOCOL_DEPLOYMENT";

export abstract class PoolVerificationError extends Error {
  abstract readonly code: PoolVerificationErrorCode;
}

/**
 * The `classification` passed to `verifyPoolIdentity` was not produced
 * from the same `pool` (different `chainId`/`pairAddress`). This should
 * be unreachable given correct caller usage — `verifyPoolIdentity` is
 * documented as taking a pool and *its* Phase 6B classification — but is
 * checked explicitly rather than trusted, since silently verifying
 * evidence against the wrong pool would be exactly the kind of identity
 * mix-up this whole phase exists to prevent.
 */
export class PoolClassificationMismatchError extends PoolVerificationError {
  readonly code = "CLASSIFICATION_MISMATCH" as const;
  readonly poolPairAddress: string;
  readonly classificationPairAddress: string;

  constructor(poolPairAddress: string, classificationPairAddress: string) {
    super(
      `classification.pool.pairAddress ("${classificationPairAddress}") does not match pool.pairAddress ("${poolPairAddress}") — verifyPoolIdentity requires a classification produced from the same pool`,
    );
    this.name = "PoolClassificationMismatchError";
    this.poolPairAddress = poolPairAddress;
    this.classificationPairAddress = classificationPairAddress;
  }
}

/**
 * A `CLASSIFIED` `UNISWAP_V3` classification's pool had a `pairAddress`
 * that isn't a 20-byte address shape. Should be unreachable: Phase 6B's
 * `classifyPoolProtocol` only reaches `CLASSIFIED`/`UNISWAP_V3` when the
 * identifier shape is already confirmed `ADDRESS_20_BYTE` (a mismatch is
 * `CONFLICT`, not `CLASSIFIED`) — but this module re-checks the shape
 * itself before ever calling `getCode`, rather than trusting that
 * invariant, so a 32-byte PoolId can never reach an RPC call meant for a
 * 20-byte address.
 */
export class UnexpectedIdentifierShapeError extends PoolVerificationError {
  readonly code = "UNEXPECTED_IDENTIFIER_SHAPE" as const;
  readonly pairAddress: string;

  constructor(pairAddress: string) {
    super(
      `pairAddress "${pairAddress}" is not a 20-byte address, but classification claimed CLASSIFIED/UNISWAP_V3 — refusing to call getCode/eth_call against a non-address identifier`,
    );
    this.name = "UnexpectedIdentifierShapeError";
    this.pairAddress = pairAddress;
  }
}

/**
 * No deployment is configured in `deployments.ts` for the requested
 * chain/protocol/role. Thrown, not folded into `RPC_ERROR` or
 * `INDETERMINATE` — a missing deployment is a configuration/registry
 * problem, not an epistemic fact about a specific pool's on-chain state,
 * and deliberately fails loudly rather than producing a result that
 * looks like a per-pool verification outcome.
 */
export class UnknownProtocolDeploymentError extends PoolVerificationError {
  readonly code = "UNKNOWN_PROTOCOL_DEPLOYMENT" as const;
  readonly chainId: number;
  readonly protocol: string;
  readonly role: string;

  constructor(chainId: number, protocol: string, role: string) {
    super(`No deployment configured for chainId=${chainId} protocol=${protocol} role=${role}`);
    this.name = "UnknownProtocolDeploymentError";
    this.chainId = chainId;
    this.protocol = protocol;
    this.role = role;
  }
}
