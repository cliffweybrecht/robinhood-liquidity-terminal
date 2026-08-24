export type ProtocolClassificationErrorCode = "INVALID_POOL_IDENTIFIER_SHAPE";

export abstract class ProtocolClassificationError extends Error {
  abstract readonly code: ProtocolClassificationErrorCode;
}

/**
 * `pairAddress` matched neither a 20-byte address nor a 32-byte PoolId
 * shape. This should be unreachable in practice — Phase 2's
 * `normalizePool` (`src/domain/pool/normalize.ts`) already validates
 * `pairAddress` via `isValidPairIdentifier` before a `LiquidityPool` can
 * exist — but the classifier re-checks the shape itself rather than
 * trusting the caller, and fails closed with a typed error instead of
 * guessing a shape if that invariant is ever violated (e.g. a
 * hand-constructed test fixture).
 */
export class InvalidPoolIdentifierShapeError extends ProtocolClassificationError {
  readonly code = "INVALID_POOL_IDENTIFIER_SHAPE" as const;
  readonly pairAddress: string;

  constructor(pairAddress: string) {
    super(
      `pairAddress "${pairAddress}" is neither a 20-byte address nor a 32-byte PoolId — this violates the precondition that classifyPoolProtocol only accepts already-validated Phase 2 LiquidityPool records`,
    );
    this.name = "InvalidPoolIdentifierShapeError";
    this.pairAddress = pairAddress;
  }
}
