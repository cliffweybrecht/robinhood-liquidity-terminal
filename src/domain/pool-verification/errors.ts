export type PoolVerificationErrorCode =
  | "CLASSIFICATION_MISMATCH"
  | "UNEXPECTED_IDENTIFIER_SHAPE"
  | "UNKNOWN_PROTOCOL_DEPLOYMENT"
  | "MISSING_DEPLOYMENT_BLOCK";

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
 * A `CLASSIFIED` protocol family reached verification with an identifier
 * shape that is incompatible with that verifier. This is a defensive
 * trust-boundary failure: the verifier refuses to coerce or route the
 * identifier into address-only or PoolId-only RPC operations.
 */
export class UnexpectedIdentifierShapeError extends PoolVerificationError {
  readonly code = "UNEXPECTED_IDENTIFIER_SHAPE" as const;
  readonly pairAddress: string;

  constructor(pairAddress: string) {
    super(
      `pairAddress "${pairAddress}" has an identifier shape incompatible with the classified protocol family — refusing protocol RPC calls`,
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

/**
 * A deployment is configured (see `UnknownProtocolDeploymentError`
 * above for when it isn't) but is missing the `deploymentBlock` a
 * historical-provenance strategy requires — e.g. Uniswap V4 identity
 * verification, which needs a `fromBlock` to search from in order for
 * "zero matching `Initialize` events" to be a complete, decisive search
 * rather than an accidentally-partial one. Same "configuration problem,
 * not a per-pool epistemic fact" reasoning as `UnknownProtocolDeploymentError`:
 * thrown, not folded into a verification result.
 */
export class MissingDeploymentBlockError extends PoolVerificationError {
  readonly code = "MISSING_DEPLOYMENT_BLOCK" as const;
  readonly chainId: number;
  readonly protocol: string;
  readonly role: string;

  constructor(chainId: number, protocol: string, role: string) {
    super(`Deployment for chainId=${chainId} protocol=${protocol} role=${role} has no configured deploymentBlock`);
    this.name = "MissingDeploymentBlockError";
    this.chainId = chainId;
    this.protocol = protocol;
    this.role = role;
  }
}
