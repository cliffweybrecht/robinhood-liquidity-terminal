/**
 * Typed failures specific to this orchestration module — a separate
 * hierarchy from `pool`/`pool-verification`/`pool-quote`'s own error
 * classes, matching this codebase's established module-independence
 * policy (never reused/extended across domain modules).
 */
export type ExecutionComparisonErrorCode =
  | "NO_VERIFIED_GROUPS"
  | "UNKNOWN_OUTPUT_GROUP"
  | "MISSING_TOKEN_DECIMALS"
  | "VERIFICATION_DEGRADED"
  | "MATRIX_TOO_LARGE";

export abstract class ExecutionComparisonError extends Error {
  abstract readonly code: ExecutionComparisonErrorCode;
}

/** The verified snapshot for this symbol has zero candidates in any group — there is nothing to compare, and no default group can be selected. Distinct from "the requested group doesn't exist" (`UnknownOutputGroupError`) — this is "no groups exist at all." */
export class NoVerifiedGroupsError extends ExecutionComparisonError {
  readonly code = "NO_VERIFIED_GROUPS" as const;
  readonly symbol: string;

  constructor(symbol: string) {
    super(`No verified execution candidates were found for "${symbol}" — there is no output group to compare.`);
    this.name = "NoVerifiedGroupsError";
    this.symbol = symbol;
  }
}

/**
 * `VerifiedExecutionSnapshot.verificationHealth === "DEGRADED"` (at
 * least one candidate was still `RPC_ERROR` after exhausting retries)
 * AND zero verified groups could be established on THIS attempt.
 * Deliberately distinct from `NoVerifiedGroupsError`: a `HEALTHY` zero-
 * group snapshot is a settled fact (every candidate reached a final,
 * non-transient outcome — the asset genuinely has no verified execution
 * venue right now); a `DEGRADED` zero-group snapshot means verification
 * itself did not complete — the true group set is INDETERMINATE, not
 * proven empty. Collapsing the two into one "no groups" message would
 * misrepresent a transient, retry-able infrastructure condition as a
 * definitive economic fact. Never thrown when at least one group DID
 * verify, even in an otherwise-degraded build — that case already
 * returns those genuinely-verified groups untouched (graceful degraded
 * operation, see `snapshot.ts`).
 */
export class VerificationDegradedError extends ExecutionComparisonError {
  readonly code = "VERIFICATION_DEGRADED" as const;
  readonly symbol: string;

  constructor(symbol: string) {
    super(
      `Verification for "${symbol}" is currently degraded — at least one candidate could not be verified after retries, so no verified output group could be established on this attempt. This does not mean "${symbol}" has no execution venues; retry shortly.`,
    );
    this.name = "VerificationDegradedError";
    this.symbol = symbol;
  }
}

/** A caller explicitly requested a `tokenOut` that does not match any of this symbol's current authoritative verified groups. Never silently falls back to the default group — an explicit, wrong request is reported as wrong, not quietly redirected. */
export class UnknownOutputGroupError extends ExecutionComparisonError {
  readonly code = "UNKNOWN_OUTPUT_GROUP" as const;
  readonly requestedTokenOut: string;

  constructor(requestedTokenOut: string) {
    super(`"${requestedTokenOut}" is not one of this asset's current authoritative verified output groups.`);
    this.name = "UnknownOutputGroupError";
    this.requestedTokenOut = requestedTokenOut;
  }
}

/** The canonical asset's own `tokenDecimals` (Phase 1) is `null` — the default-amount policy (`1 * 10^tokenDecimals`) and the amount parser both require a real decimals value; there is no safe default to assume instead. */
export class MissingTokenDecimalsError extends ExecutionComparisonError {
  readonly code = "MISSING_TOKEN_DECIMALS" as const;
  readonly symbol: string;

  constructor(symbol: string) {
    super(`Canonical asset "${symbol}" has no known tokenDecimals — cannot determine a default trade amount.`);
    this.name = "MissingTokenDecimalsError";
    this.symbol = symbol;
  }
}

/**
 * UI V1.1 — this orchestration layer's OWN fast-path rejection for an
 * oversized matrix request, thrown in `compareMatrix.ts` immediately
 * after snapshot resolution + candidate classification, BEFORE the
 * pool-quote matrix primitive is even called. Deliberately a SEPARATE
 * class from `@/domain/pool-quote`'s own `MatrixTooLargeError` — same
 * module-independence policy this file's own header comment already
 * establishes (never reused/extended across domain modules) — even
 * though both represent the identical underlying condition
 * (`executableCandidates x amountsIn > MAX_MATRIX_CELLS`, computed via
 * the SAME imported `classifyMatrixCandidates`/`MAX_MATRIX_CELLS`, never
 * a second independently-reasoned formula). This is the class the
 * matrix API route expects and maps to 400; `pool-quote`'s own
 * `MatrixTooLargeError` reaching the route at all would mean THIS
 * layer's own pre-check has a bug (an internal invariant violation,
 * mapped to 500 — mirroring how `QuotePreconditionError` is already
 * handled by the existing single-comparison route for the identical
 * "should never happen" reasoning).
 */
export class MatrixTooLargeError extends ExecutionComparisonError {
  readonly code = "MATRIX_TOO_LARGE" as const;
  readonly executableCandidates: number;
  readonly amounts: number;
  readonly cells: number;
  readonly max: number;

  constructor(executableCandidates: number, amounts: number, max: number) {
    const cells = executableCandidates * amounts;
    super(
      `This matrix would require ${cells} cells (${executableCandidates} executable candidates x ${amounts} amounts), exceeding the maximum of ${max}`,
    );
    this.name = "MatrixTooLargeError";
    this.executableCandidates = executableCandidates;
    this.amounts = amounts;
    this.cells = cells;
    this.max = max;
  }
}
