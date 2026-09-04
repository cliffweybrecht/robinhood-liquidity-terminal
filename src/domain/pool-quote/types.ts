import type { Address, Hex } from "viem";
import type { ClassifiedPoolIdentity } from "@/domain/protocol";

/**
 * Explicit epistemic states for a single-pool exact-input quote
 * attempt. Deliberately its own status set, not copied from
 * `pool-verification`'s or `pool-state`'s:
 *
 *  - `QUOTED`: the canonical quoter's `eth_call` completed without a
 *    transport failure, the success return decoded strictly, and
 *    `amountOut` is a semantically usable value (see `read-uniswap-v3-
 *    quote.ts`/`read-uniswap-v4-quote.ts` for the exact `amountOut ===
 *    0` reasoning). Economic quality — extreme price movement, a huge
 *    `initializedTicksCrossed`, a terrible effective rate — does NOT
 *    change this status; this phase does not judge quote quality, only
 *    whether the canonical protocol simulation itself succeeded.
 *  - `UNQUOTABLE`: the quoter call reverted with `rpcCode === 3`
 *    (a genuine EVM execution revert, not a JSON-RPC/transport-level
 *    error) AND the revert data strictly matches one of a small,
 *    explicitly hand-verified allowlist of known canonical Uniswap
 *    error signatures (see `abi/revert.ts`). This is a decisive,
 *    positive product answer: "no, this trade cannot execute, for this
 *    specific known protocol reason" — never inferred from an empty or
 *    unrecognized revert.
 *  - `INDETERMINATE`: the quoter call completed (whether via a success
 *    return or a `rpcCode === 3` revert) but either the success return
 *    could not be strictly decoded / failed a semantic check, or the
 *    revert data is empty, malformed, or does not match any allowlisted
 *    known error. This is the fail-closed default for "we don't know
 *    why" — never upgraded to `UNQUOTABLE` by guessing.
 *  - `RPC_ERROR`: a transport/infrastructure failure — `eth_blockNumber`
 *    itself failing, or the quoter `eth_call` failing at the network/
 *    HTTP/JSON-RPC-envelope level (including a JSON-RPC error response
 *    whose code is anything other than `3`, which is not treated as an
 *    execution revert — see `abi/revert.ts`).
 *
 * No `UNSUPPORTED`: every precondition this module cares about (wrong
 * family, non-VERIFIED identity, pool/identity mismatch, invalid
 * amountIn/tokenIn, missing V4 PoolKey, missing hookData for a hooked
 * pool) is checked *before* any RPC call and fails closed via a thrown
 * `QuotePreconditionError` (see `errors.ts`) — there is no calling path
 * that produces an `UNSUPPORTED` result value.
 *
 * No `CONTRADICTED`: this module performs no comparison against another
 * independently trusted claimed value.
 */
export type QuoteStatus = "QUOTED" | "UNQUOTABLE" | "INDETERMINATE" | "RPC_ERROR";

/** Whether one piece of quote evidence reflects a clean success, a transport failure, a decode failure, or a positively-classified protocol-level "cannot execute" outcome. */
export type QuoteEvidenceOutcome = "ok" | "rpc_error" | "decode_error" | "unquotable" | "disclosed";

export type QuoteEvidenceKind =
  | "BLOCK_PIN_FAILURE"
  | "FEE_READ"
  | "QUOTE_CALL"
  | "HOOK_DATA_DISCLOSURE"
  | "DECIMALS_READ"
  | "SPOT_READ";

/** One piece of structured, machine-readable evidence for a single step of a quote attempt. */
export interface QuoteEvidence {
  readonly kind: QuoteEvidenceKind;
  readonly outcome: QuoteEvidenceOutcome;
  /** The call this evidence came from, e.g. `"QuoterV2.quoteExactInputSingle(...)"`. */
  readonly source: string;
  /** What was actually observed, when applicable. Omitted for failures with nothing to observe. */
  readonly observed?: string;
  /** Human-readable explanation — supplements the typed fields above, never replaces them. */
  readonly detail: string;
}

/** Canonical `QuoterV2.quoteExactInputSingle` return metadata, beyond `amountOut`. */
export interface UniswapV3QuoteMetadata {
  readonly sqrtPriceX96After: bigint;
  readonly initializedTicksCrossed: number;
  readonly gasEstimate: bigint;
}

/** Canonical `V4Quoter.quoteExactInputSingle` return metadata, beyond `amountOut`. V4Quoter returns no post-trade price/tick metadata — only `gasEstimate`. */
export interface UniswapV4QuoteMetadata {
  readonly gasEstimate: bigint;
}

/**
 * Shared fields across both protocols' quote-verification results.
 * Exposes two distinct block numbers, never conflated:
 *
 *  - `identityVerificationBlock`: the block Phase 6C's identity proof
 *    was pinned to. May be arbitrarily older than `quoteBlockNumber`.
 *  - `quoteBlockNumber`: the ONE block this quote attempt pinned via a
 *    single `eth_blockNumber` call — every RPC read in this attempt
 *    (including the V3 path's supporting `fee()` read, see
 *    `read-uniswap-v3-quote.ts`) uses exactly this block, never
 *    inherited from identity verification and never re-pinned mid
 *    attempt. `null` only if `eth_blockNumber` itself failed before any
 *    quote read was attempted.
 */
interface QuoteVerificationBase {
  readonly pool: ClassifiedPoolIdentity;
  readonly status: QuoteStatus;
  readonly identityVerificationBlock: bigint;
  readonly quoteBlockNumber: bigint | null;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  /** Present only when `status === "QUOTED"`. */
  readonly amountOut?: bigint;
  readonly evidence: readonly QuoteEvidence[];
}

/** The result of `quoteVerifiedUniswapV3ExactInput` — `metadata` (when present) is always `UniswapV3QuoteMetadata`, enforced by this being that function's own concrete return type. */
export interface UniswapV3QuoteVerification extends QuoteVerificationBase {
  readonly family: "UNISWAP_V3";
  /** Present only when `status === "QUOTED"`. */
  readonly metadata?: UniswapV3QuoteMetadata;
}

/** The result of `quoteVerifiedUniswapV4ExactInput` — `metadata` (when present) is always `UniswapV4QuoteMetadata`, enforced by this being that function's own concrete return type. */
export interface UniswapV4QuoteVerification extends QuoteVerificationBase {
  readonly family: "UNISWAP_V4";
  /** Present only when `status === "QUOTED"`. */
  readonly metadata?: UniswapV4QuoteMetadata;
  /** `true` only when the caller explicitly supplied `hookData` for a hooked pool — `false`/absent for an unhooked pool's canonical empty `hookData`. Never claims caller-supplied `hookData` is itself verified — see `HOOK_DATA_DISCLOSURE` evidence. */
  readonly hookDataCallerSupplied?: boolean;
}

/**
 * The union of both protocols' quote-verification results. No generic
 * multi-protocol dispatcher exists — a caller who already knows which
 * protocol a pool is calls the matching concrete function and gets that
 * function's own narrow return type; this union is for the rarer case
 * of a caller genuinely handling either result generically.
 */
export type QuoteVerification = UniswapV3QuoteVerification | UniswapV4QuoteVerification;

/**
 * Phase 6E.2 — an exact machine-readable rational number, `numerator /
 * denominator`. Always the authoritative representation for every price/
 * impact value this module computes: never reduced to lowest terms
 * (computing a `gcd` on every value would add complexity for no
 * behavioral benefit — `bigint` arithmetic never overflows, so an
 * unreduced fraction is exactly as usable as a reduced one for any
 * further exact computation), never converted to a floating-point
 * `number`, and never pre-formatted as a display string — formatting/
 * rounding/truncation policy belongs at a later presentation/API/UI
 * boundary, not in this domain type. `denominator` is always `> 0n`.
 */
export interface RationalValue {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * Independent from `QuoteStatus` — analytics can fail while the
 * underlying canonical quote remains fully valid and `QUOTED`. Reuses
 * `QuoteStatus`'s existing failure vocabulary rather than inventing new
 * words for the same underlying failure categories:
 *  - `OK`: both `decimals()` reads and the pre-trade spot read all
 *    transport-succeeded, strictly decoded, and (for the spot read)
 *    `sqrtPriceX96 !== 0`.
 *  - `INDETERMINATE`: every required read completed at the transport
 *    level, but at least one return could not be strictly decoded, or
 *    the spot read decoded to a structurally valid but semantically
 *    impossible `sqrtPriceX96 === 0` on an already-VERIFIED pool.
 *  - `RPC_ERROR`: a transport/infrastructure failure prevented at least
 *    one of the required analytics reads from completing at all.
 * Deliberately no `UNQUOTABLE` analog — there is no protocol-level
 * revert-classification concept for a `decimals()`/spot-state read.
 */
export type QuoteAnalyticsStatus = "OK" | "INDETERMINATE" | "RPC_ERROR";

/**
 * Same-block execution analytics for an exact-input quote that already
 * reached `QUOTED` — never computed/exposed for any other base quote
 * status (see `UniswapV3QuoteWithAnalytics`/`UniswapV4QuoteWithAnalytics`).
 * Every price value is oriented `tokenOut per tokenIn` (`priceUnit`,
 * always present, always this one fixed value — no ambiguous scalar is
 * ever returned without it).
 *
 * `priceImpactBps` is signed: positive means execution was worse than
 * the same-block pre-trade spot price, negative means better, zero means
 * equal. Never clamped — a genuinely negative (favorable) result is
 * returned as computed, since nothing about this codebase's V4 hook
 * architecture guarantees execution can never beat pre-trade spot for an
 * arbitrary hook.
 *
 * For a V4 hooked pool, `priceImpactBps` reflects "execution impact vs
 * pre-trade pool spot" — the canonical `V4Quoter` simulation's
 * `amountOut` already includes whatever the real hook actually did
 * (dynamic fee override, custom swap behavior, hook-returned deltas), in
 * addition to ordinary LP fee/protocol fee/AMM curve movement. This
 * value is NEVER "pure AMM slippage," "isolated price slippage," or
 * "isolated fee impact" — it is the honest end-to-end comparison between
 * what this specific verified pool's canonical quoter actually returned
 * and what its own state showed immediately before, at the same block.
 */
export interface QuoteAnalytics {
  readonly status: QuoteAnalyticsStatus;
  /** Present only when `status === "OK"`. */
  readonly tokenInDecimals?: number;
  /** Present only when `status === "OK"`. */
  readonly tokenOutDecimals?: number;
  /** Present only when `status === "OK"`. Same-block pre-trade pool spot price, `tokenOut` per `tokenIn`. */
  readonly spotPrice?: RationalValue;
  /** Present only when `status === "OK"`. Normalized execution price, `tokenOut` per `tokenIn`. */
  readonly executionPrice?: RationalValue;
  /** Present only when `status === "OK"`. Signed; see interface doc comment above. */
  readonly priceImpactBps?: RationalValue;
  readonly priceUnit: "tokenOut_per_tokenIn";
  readonly evidence: readonly QuoteEvidence[];
}

/** The result of `quoteVerifiedUniswapV3ExactInputWithAnalytics` — `analytics` is present only when `status === "QUOTED"`. */
export interface UniswapV3QuoteWithAnalytics extends UniswapV3QuoteVerification {
  readonly analytics?: QuoteAnalytics;
}

/** The result of `quoteVerifiedUniswapV4ExactInputWithAnalytics` — `analytics` is present only when `status === "QUOTED"`. */
export interface UniswapV4QuoteWithAnalytics extends UniswapV4QuoteVerification {
  readonly analytics?: QuoteAnalytics;
}

/**
 * Phase 6F.1 — one sampled point of a same-block executable-depth curve.
 * Deliberately independent of every sibling point: one point's
 * `status`/`amountOut`/failure has no bearing on any other point's own
 * result (see `quoteVerifiedUniswapV3ExactInputDepthCurve`'s doc comment
 * for why). `executionPrice`/`priceImpactBps` are computed from the
 * curve's ONE shared `spotPrice` (see `DepthCurve`'s doc comment) — never
 * from a per-point spot read — and are present only when BOTH this point
 * is `QUOTED` AND the shared spot/decimals read succeeded; a shared-read
 * failure never blanks out this point's own `amountOut`.
 */
interface DepthCurvePointBase {
  readonly amountIn: bigint;
  readonly status: QuoteStatus;
  /** Present only when `status === "QUOTED"`. */
  readonly amountOut?: bigint;
  /** Present only when `status === "QUOTED"` AND the curve's shared spot/decimals read succeeded. */
  readonly executionPrice?: RationalValue;
  /** Present only when `status === "QUOTED"` AND the curve's shared spot/decimals read succeeded. Signed — see `QuoteAnalytics.priceImpactBps`'s doc comment; identical semantics apply per point. */
  readonly priceImpactBps?: RationalValue;
  readonly evidence: readonly QuoteEvidence[];
}

/** One sampled point of a V3 depth curve. `metadata` (when present) is always `UniswapV3QuoteMetadata`. */
export interface UniswapV3DepthCurvePoint extends DepthCurvePointBase {
  /** Present only when `status === "QUOTED"`. */
  readonly metadata?: UniswapV3QuoteMetadata;
}

/** One sampled point of a V4 depth curve. `metadata` (when present) is always `UniswapV4QuoteMetadata`. */
export interface UniswapV4DepthCurvePoint extends DepthCurvePointBase {
  /** Present only when `status === "QUOTED"`. */
  readonly metadata?: UniswapV4QuoteMetadata;
}

/**
 * Minimal structural shape both `UniswapV3DepthCurvePoint` and
 * `UniswapV4DepthCurvePoint` already satisfy — lets the pure
 * threshold-derivation helpers (`largestQuotedSample`/
 * `sampledDepthAtBps`/`monotonicityObservedAtOrBelow`/
 * `classifyUpperRange`, see `depth-math.ts`) accept either protocol's
 * point array without a generic dispatcher or duplicated per-protocol
 * helper functions.
 *
 * `status` is `ComparisonCandidateStatus` (not the narrower
 * `QuoteStatus`) specifically so a `MatrixCell` — which can be
 * `"PRECONDITION_FAILED"` (e.g. a V4 exact-input amount exceeding
 * `UINT128_MAX` at one ladder point) — also structurally satisfies
 * this shape; every one of the four `depth-math.ts` helpers above
 * already treats any non-`"QUOTED"` status identically (skipped, never
 * distinguished), so this widening is purely additive and changes no
 * existing behavior for `UniswapV3DepthCurvePoint`/
 * `UniswapV4DepthCurvePoint` values, which never produce
 * `"PRECONDITION_FAILED"` in the first place.
 *
 * Compatibility audit performed for the Executable-Depth Thresholds
 * adversarial pre-commit pass (Issue 2), re-verified against source
 * directly rather than trusting the test suite alone:
 *  1. Pre-existing production consumers: `largestQuotedSample` and
 *     `sampledDepthAtBps` (both unmodified — this change touches only
 *     the shared PARAMETER TYPE they and the two newer helpers accept,
 *     never their implementations).
 *  2. Pre-existing tests/fixtures depending on the narrower contract:
 *     NONE. `read-uniswap-v3-depth-curve.test.ts`/`read-uniswap-v4-
 *     depth-curve.test.ts` DO call `largestQuotedSample`/
 *     `sampledDepthAtBps` directly against real `curve.points`
 *     (`UniswapV3DepthCurvePoint[]`/`UniswapV4DepthCurvePoint[]`,
 *     `status: QuoteStatus`) — since `QuoteStatus` is a proper subset
 *     of `ComparisonCandidateStatus`, every such value remains
 *     trivially assignable to the widened shape; these tests continue
 *     to pass unmodified.
 *  3. Does this change the semantic CONTRACT of existing 6F.1 helpers?
 *     NO. `UniswapV3DepthCurvePoint`/`UniswapV4DepthCurvePoint`
 *     themselves (via `DepthCurvePointBase`) still declare
 *     `status: QuoteStatus` — narrower, unchanged, untouched by this
 *     edit. Only the STANDALONE structural-acceptance type used as a
 *     parameter contract was widened; no 6F.1 reader's own return type
 *     changed shape at all.
 *  4/5/6. Is the widening required, and is there a smaller alternative?
 *     YES it is required, and NO smaller alternative was found:
 *     `sampledDepthAtBps` is reused VERBATIM (never duplicated, per
 *     this project's own "do not duplicate threshold math" discipline)
 *     by the NEW Executable-Depth primitive against `MatrixCell[]`
 *     values — so `sampledDepthAtBps` itself, not merely the two newer
 *     helpers, must accept the wider status. A parallel, narrower
 *     structural type would force either (a) duplicating
 *     `sampledDepthAtBps`/`largestQuotedSample` for the wider shape —
 *     rejected, directly duplicates threshold math — or (b) a generic
 *     type parameter threaded through four function signatures for a
 *     benefit that is purely cosmetic, since `QuoteStatus`'s clean
 *     subset relationship to `ComparisonCandidateStatus` already makes
 *     the simple widening fully backward compatible. This type's own
 *     ORIGINAL purpose (stated above: let unrelated point shapes share
 *     one derivation-function contract without a dispatcher or
 *     duplicated helpers) already anticipated exactly this kind of
 *     extension — `MatrixCell` is simply a third point-like shape
 *     joining the two `UniswapV3/V4DepthCurvePoint` types this
 *     interface already existed to unify. Kept, not reverted.
 */
export interface DepthCurvePointLike {
  readonly amountIn: bigint;
  readonly status: ComparisonCandidateStatus;
  readonly priceImpactBps?: RationalValue;
}

/**
 * Phase 6F.1 — a same-block executable-depth curve for ONE already
 * identity-VERIFIED pool across a caller-supplied ladder of exact-input
 * `amountIn` samples. Represents ONE chain state: `blockNumber` is
 * pinned via exactly one `eth_blockNumber` call, and every quoter
 * simulation AND the shared spot/decimals read all use that identical
 * block — never a per-point block, never independently pinned.
 *
 * `spotStatus`/`spotPrice`/`tokenInDecimals`/`tokenOutDecimals` reflect
 * the curve's ONE shared spot+decimals read (`analytics.ts`'s
 * `readSpotAndDecimals`, called exactly once) — completely independent
 * of any individual point's own `status`. A shared-read failure
 * (`spotStatus !== "OK"`) means `executionPrice`/`priceImpactBps` are
 * unavailable on every point, but does NOT invalidate any point's own
 * `status`/`amountOut` — those come exclusively from that point's own
 * canonical quoter `eth_call`, which is a completely separate concern
 * from whether the shared analytics context happened to succeed. This
 * is Phase 6E.2's "a valid QUOTED result is never downgraded because
 * analytics failed" principle, applied at curve granularity.
 *
 * `blockNumber === null` only if the single shared `eth_blockNumber`
 * call itself failed — in that case `points` is empty (nothing could be
 * attempted without a pinned block) and `spotStatus` is `"RPC_ERROR"`.
 */
interface DepthCurveBase {
  readonly pool: ClassifiedPoolIdentity;
  readonly identityVerificationBlock: bigint;
  readonly blockNumber: bigint | null;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** Present only when `spotStatus === "OK"`. */
  readonly tokenInDecimals?: number;
  /** Present only when `spotStatus === "OK"`. */
  readonly tokenOutDecimals?: number;
  /** Present only when `spotStatus === "OK"`. Same-block pre-trade pool spot price, `tokenOut` per `tokenIn`. */
  readonly spotPrice?: RationalValue;
  readonly spotStatus: QuoteAnalyticsStatus;
  /** Evidence for the shared, once-per-curve concerns: block pinning and/or the shared spot+decimals read. Never per-point evidence — see each point's own `evidence` for that. */
  readonly spotEvidence: readonly QuoteEvidence[];
}

/** The result of `quoteVerifiedUniswapV3ExactInputDepthCurve`. */
export interface UniswapV3DepthCurve extends DepthCurveBase {
  readonly family: "UNISWAP_V3";
  readonly points: readonly UniswapV3DepthCurvePoint[];
}

/** The result of `quoteVerifiedUniswapV4ExactInputDepthCurve`. */
export interface UniswapV4DepthCurve extends DepthCurveBase {
  readonly family: "UNISWAP_V4";
  readonly points: readonly UniswapV4DepthCurvePoint[];
  /** `true` only when the caller explicitly supplied `hookData` for a hooked pool — applies to every point in the curve (one hook, one hookData value, for the whole ladder). Never claims caller-supplied `hookData` is itself verified — see the `HOOK_DATA_DISCLOSURE` entry in `spotEvidence` (a curve-level, once-per-curve disclosure, not per-point, since the same `hookData` value is used for every sampled point). */
  readonly hookDataCallerSupplied?: boolean;
}

/**
 * Phase 6F.2 — a single candidate's status within one same-block
 * cross-pool comparison. A strict superset of `QuoteStatus`: every
 * existing quote outcome (`QUOTED`/`UNQUOTABLE`/`INDETERMINATE`/
 * `RPC_ERROR`) means exactly what it already means in the single-quote/
 * depth-curve readers — this adds exactly ONE new, comparison-specific
 * outcome:
 *
 *  - `PRECONDITION_FAILED`: a well-understood, per-candidate structural
 *    precondition could not be satisfied for THIS candidate specifically
 *    — currently either a hooked V4 candidate with no caller-supplied
 *    `hookData`, or a V4 candidate whose shared `amountIn` exceeds the
 *    protocol's own `uint128` representable range (see
 *    `ComparisonPreconditionFailure`) — so NO canonical quoter
 *    simulation and NO spot read were ever attempted for this candidate.
 *    This is deliberately NOT folded into `INDETERMINATE`:
 *    `INDETERMINATE` means "a read/call was attempted and its outcome
 *    could not be classified"; `PRECONDITION_FAILED` means "no attempt
 *    was made at all, for a precisely known reason" — collapsing the two
 *    would hide a real, actionable, typed reason behind a vaguer status.
 *    Deliberately NOT added to `QuoteStatus` itself — every existing
 *    single-quote/depth-curve consumer of `QuoteStatus` continues to see
 *    exactly the four values it always has; this is additive, scoped
 *    only to the comparison result shape.
 *
 *    Both reasons share the same underlying principle: a fact that is
 *    GLOBALLY invalid for the whole comparison (`amountIn <= 0`, an
 *    unVERIFIED identity, a mismatched comparable group, ...) aborts the
 *    whole request before any RPC call, via a thrown
 *    `QuotePreconditionError`; a fact that is valid for the comparison
 *    as a whole but that ONE candidate's specific protocol cannot
 *    represent (a hook needing undisclosed `hookData`; an `amountIn`
 *    that is positive and perfectly valid for a V3 sibling but exceeds
 *    V4's own `uint128` `exactAmount` bound) becomes that candidate's
 *    own `PRECONDITION_FAILED` result instead — never the other's
 *    siblings' problem.
 */
export type ComparisonCandidateStatus = QuoteStatus | "PRECONDITION_FAILED";

export type ComparisonPreconditionFailureCode = "MISSING_HOOK_DATA" | "AMOUNT_IN_EXCEEDS_V4_BOUND";

/** Present on a candidate only when `status === "PRECONDITION_FAILED"`. `code` is machine-readable; `detail` explains precisely why — for `"MISSING_HOOK_DATA"`, the underlying `MissingHookDataError`'s own message; for `"AMOUNT_IN_EXCEEDS_V4_BOUND"`, a message stating the comparison's shared `amountIn` and V4's `uint128` bound — never a generic re-wording. */
export interface ComparisonPreconditionFailure {
  readonly code: ComparisonPreconditionFailureCode;
  readonly detail: string;
}

/**
 * One candidate's result within a `CrossPoolComparisonSnapshot`.
 * Deliberately independent of every sibling candidate — one candidate's
 * `status`/failure has no bearing on any other candidate's own result,
 * exactly matching `DepthCurvePoint`'s point-independence principle,
 * now applied at pool granularity instead of amountIn granularity.
 *
 * `analyticsStatus` reflects ONLY this candidate's OWN same-block spot
 * read (`V3 slot0()` / `V4 StateView.getSlot0`) — never the comparison's
 * shared decimals resolution (see `CrossPoolComparisonSnapshot.
 * sharedAnalyticsStatus` for that, a completely separate, comparison-
 * level concern). For a `PRECONDITION_FAILED` candidate, no spot read
 * was ever attempted; `analyticsStatus` is `"INDETERMINATE"` in that
 * case too — reusing `INDETERMINATE`'s existing "could not be
 * established" meaning (the PRECISE reason is not "could not be
 * established" but "never attempted," which is exactly what
 * `preconditionFailure` exists to state unambiguously — `analyticsStatus`
 * alone was never meant to be the complete explanation for any status).
 *
 * `executionPrice`/`priceImpactBps` are present ONLY when ALL of: this
 * candidate's `status === "QUOTED"`, this candidate's own
 * `analyticsStatus === "OK"`, AND the comparison's shared
 * `sharedAnalyticsStatus === "OK"` — three independent same-block reads
 * (this candidate's quote, this candidate's spot, the shared decimals)
 * must all have succeeded. A failure in any ONE of those three never
 * blanks out `amountOut` itself, which remains ranking truth regardless
 * (see `CrossPoolComparisonSnapshot.ranking`'s doc comment).
 */
interface ComparisonCandidateBase {
  readonly pool: ClassifiedPoolIdentity;
  readonly identityVerificationBlock: bigint;
  readonly status: ComparisonCandidateStatus;
  /** Present only when `status === "QUOTED"`. */
  readonly amountOut?: bigint;
  readonly analyticsStatus: QuoteAnalyticsStatus;
  /** Present only when `status === "QUOTED"` AND `analyticsStatus === "OK"` AND the comparison's shared decimals resolution succeeded. */
  readonly executionPrice?: RationalValue;
  /** Present only under the same three conditions as `executionPrice`. Signed — see `QuoteAnalytics.priceImpactBps`'s doc comment; identical semantics apply per candidate, against THAT candidate's own same-block pre-trade spot. */
  readonly priceImpactBps?: RationalValue;
  /** This candidate's own quote-call and spot-read evidence. Empty for a `PRECONDITION_FAILED` candidate — see `preconditionFailure` for that case's explanation instead. */
  readonly evidence: readonly QuoteEvidence[];
  /** Present only when `status === "PRECONDITION_FAILED"`. */
  readonly preconditionFailure?: ComparisonPreconditionFailure;
}

/** One V3 candidate's comparison result. `metadata` (when present) is always `UniswapV3QuoteMetadata`. */
export interface UniswapV3ComparisonCandidate extends ComparisonCandidateBase {
  readonly family: "UNISWAP_V3";
  /** Present only when `status === "QUOTED"`. */
  readonly metadata?: UniswapV3QuoteMetadata;
}

/** One V4 candidate's comparison result. `metadata` (when present) is always `UniswapV4QuoteMetadata`. */
export interface UniswapV4ComparisonCandidate extends ComparisonCandidateBase {
  readonly family: "UNISWAP_V4";
  /** Present only when `status === "QUOTED"`. */
  readonly metadata?: UniswapV4QuoteMetadata;
  /** `true` only when the caller explicitly supplied `hookData` for THIS hooked candidate. Never claims caller-supplied `hookData` is itself verified — see the `HOOK_DATA_DISCLOSURE` entry in this candidate's own `evidence`. Absent for an unhooked candidate and for a `PRECONDITION_FAILED` candidate. */
  readonly hookDataCallerSupplied?: boolean;
}

/** The union of both protocols' comparison candidate results — a genuine multi-protocol dispatcher's result type, since one comparison may truthfully contain both V3 and V4 candidates (see `compare-verified-pools.ts`'s doc comment for why a generic dispatcher is justified here, unlike the single-quote/depth-curve readers). */
export type ComparisonCandidate = UniswapV3ComparisonCandidate | UniswapV4ComparisonCandidate;

/**
 * Phase 6F.2 — the outcome of `compareVerifiedPoolsExactInput` when the
 * comparison's ONE shared `eth_blockNumber` call itself failed. No
 * candidate was ever attempted — no spot read, no quote call, no shared
 * decimals read — since none of those can be meaningfully pinned without
 * a block. Deliberately a DISTINCT shape from a candidate-level
 * `RPC_ERROR` (which means "this ONE candidate's own read failed, its
 * siblings are unaffected") — a block-pin failure is comparison-wide by
 * construction, and conflating the two would misrepresent a total
 * request failure as if only one candidate were affected.
 */
export interface CrossPoolComparisonBlockPinFailure {
  readonly status: "BLOCK_PIN_FAILURE";
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly evidence: readonly QuoteEvidence[];
}

/**
 * Phase 6F.2 — a same-block cross-pool execution comparison for N
 * already identity-VERIFIED pools, all sharing the exact same verified
 * `tokenIn`/`tokenOut` pair, for ONE exact `amountIn`. Represents ONE
 * chain state: `blockNumber` is pinned via exactly one `eth_blockNumber`
 * call, and every candidate's spot read + quote call, plus the shared
 * decimals read, all use that identical block.
 *
 * `sharedAnalyticsStatus`/`tokenInDecimals`/`tokenOutDecimals` reflect
 * the comparison's ONE shared decimals read (`analytics.ts`'s
 * `readSharedDecimals`, called exactly once for the whole comparison) —
 * completely independent of any individual candidate's own `status`/
 * `analyticsStatus`. Deliberately NOT named `spotStatus` (unlike
 * `DepthCurveBase`) — spot is pool-specific here, never shared; see each
 * candidate's own `analyticsStatus` for that. A shared-decimals failure
 * never blanks out any candidate's own `status`/`amountOut` — every
 * `QUOTED` candidate remains fully rankable by `amountOut` regardless
 * (see `ranking` below).
 */
export interface CrossPoolComparisonSnapshot {
  readonly status: "OK";
  readonly blockNumber: bigint;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  /** Present only when `sharedAnalyticsStatus === "OK"`. */
  readonly tokenInDecimals?: number;
  /** Present only when `sharedAnalyticsStatus === "OK"`. */
  readonly tokenOutDecimals?: number;
  readonly sharedAnalyticsStatus: QuoteAnalyticsStatus;
  /** Evidence for the ONE shared, once-per-comparison decimals read only. Never per-candidate evidence — see each candidate's own `evidence`/`preconditionFailure` for that. */
  readonly sharedEvidence: readonly QuoteEvidence[];
  /** In caller-supplied candidate order — never reordered by status, completion time, or rank. See `ranking` for the derived rank order. */
  readonly candidates: readonly ComparisonCandidate[];
  /**
   * Ranking truth: descending `amountOut`, compared as exact `bigint`,
   * among `status === "QUOTED"` candidates ONLY — `UNQUOTABLE`/
   * `INDETERMINATE`/`RPC_ERROR`/`PRECONDITION_FAILED` candidates are
   * never included, never treated as `amountOut === 0`, and never
   * assumed to rank "worst." Ranking is amountOut-based rather than
   * `priceImpactBps`-based deliberately: because every candidate shares
   * the exact same `tokenIn`/`tokenOut`/`amountIn`/decimals, ranking by
   * `amountOut` and ranking by execution price are mathematically the
   * same total order, and `amountOut` remains available even when a
   * candidate's own analytics (spot) or the shared decimals read failed
   * — analytics must never become load-bearing for ranking.
   */
  readonly ranking: {
    /**
     * `status === "QUOTED"` candidates only, in descending `amountOut`
     * order. When two or more candidates share the exact same
     * `amountOut` (a genuine tie), their RELATIVE order here is a
     * deterministic presentation tie-break (ascending `pool.pairAddress`)
     * — NOT an economic preference; see `bestCandidatePoolAddresses` for
     * the truthful representation of which candidates are actually tied
     * for best.
     */
    readonly rankedQuotedPoolAddresses: readonly Hex[];
    /**
     * The pool address(es) with the single largest `amountOut` among
     * `status === "QUOTED"` candidates. Length 0 means no candidate was
     * `QUOTED` at all. Length 1 means a unique best candidate. Length
     * greater than 1 means a genuine, exact `amountOut` tie — reported
     * truthfully, never arbitrarily resolved to a single "winner." No
     * economic meaning is ever assigned to address ordering within this
     * array.
     */
    readonly bestCandidatePoolAddresses: readonly Hex[];
  };
}

/** Either a full comparison snapshot, or the comparison-wide block-pin failure representation — see `CrossPoolComparisonBlockPinFailure`'s doc comment for why the two are deliberately distinct shapes rather than one shape with more optional fields. */
export type CrossPoolComparisonResult = CrossPoolComparisonSnapshot | CrossPoolComparisonBlockPinFailure;

/**
 * UI V1.1 — one (candidate, sampled trade size) result within a
 * `CrossPoolExecutionMatrixSnapshot`. A deliberate fusion of
 * `ComparisonCandidateBase`'s per-outcome vocabulary (status/
 * analyticsStatus/executionPrice/priceImpactBps/evidence/
 * preconditionFailure — reused verbatim, never redefined) and
 * `DepthCurvePointBase`'s per-amount field (`amountIn`) — reusing BOTH
 * existing status/failure vocabularies rather than inventing new ones.
 * Independent of every sibling cell — one cell's status has no bearing
 * on any other cell in the same row or the same column.
 */
export interface MatrixCell {
  readonly amountIn: bigint;
  readonly status: ComparisonCandidateStatus;
  /** Present only when `status === "QUOTED"`. */
  readonly amountOut?: bigint;
  readonly analyticsStatus: QuoteAnalyticsStatus;
  /** Present only when `status === "QUOTED"` AND this cell's own spot read succeeded AND the matrix's shared decimals resolution succeeded. */
  readonly executionPrice?: RationalValue;
  /** Present only under the same conditions as `executionPrice`. */
  readonly priceImpactBps?: RationalValue;
  /** Present only when `status === "QUOTED"`. Sourced from the SAME canonical quoter call's own return metadata (`UniswapV3/V4QuoteMetadata.gasEstimate`) — never a separate `eth_estimateGas` call. V3's extra `sqrtPriceX96After`/`initializedTicksCrossed` fields are intentionally not surfaced per cell, matching this project's existing DTO-boundary precedent (`dto.ts`'s `toCandidateDto`) of reducing quote metadata to `gasEstimate` only. */
  readonly gasEstimate?: bigint;
  readonly evidence: readonly QuoteEvidence[];
  /** Present only when `status === "PRECONDITION_FAILED"`. */
  readonly preconditionFailure?: ComparisonPreconditionFailure;
}

/**
 * UI V1.1 — one candidate's full row across every sampled trade size.
 * Row-level fields (pool identity, family, hookData disclosure) live
 * ONCE here, exactly matching `ComparisonCandidate`'s own existing
 * "shared candidate facts live once, per-amount facts live in the
 * per-amount result" placement. `cells.length === ` the matrix's own
 * `amountsIn.length` for EVERY row, including a `PRECONDITION_FAILED`
 * row (hookData is row-level, not per-size — a missing-hookData row's
 * cells all carry the identical precondition, one per requested amount,
 * for column alignment).
 */
export interface MatrixCandidateRow {
  readonly pool: ClassifiedPoolIdentity;
  readonly family: "UNISWAP_V3" | "UNISWAP_V4";
  readonly identityVerificationBlock: bigint;
  /** `true` only when the caller explicitly supplied `hookData` for THIS hooked row. Absent for an unhooked row and for a row that is `PRECONDITION_FAILED` for missing hookData (there is nothing to disclose — none was supplied). */
  readonly hookDataCallerSupplied?: boolean;
  readonly cells: readonly MatrixCell[];
}

/**
 * UI V1.1 — the authoritative ranking for ONE sampled trade size,
 * reusing `compareVerifiedPoolsExactInput`'s own `computeRanking`
 * algorithm verbatim (see `compare-verified-pools.ts`), applied
 * independently per amount. Never mixed across amounts, never mixed
 * across `tokenOut` groups.
 */
export interface MatrixRanking {
  readonly amountIn: bigint;
  readonly rankedQuotedPoolAddresses: readonly Hex[];
  readonly bestCandidatePoolAddresses: readonly Hex[];
}

/**
 * UI V1.1 — the comparison-wide block-pin failure representation for a
 * matrix request. Structurally identical in spirit to
 * `CrossPoolComparisonBlockPinFailure`, extended with `amountsIn`
 * (plural) since a matrix always represents a whole ladder, even when
 * the block itself could not be pinned.
 */
export interface CrossPoolExecutionMatrixBlockPinFailure {
  readonly status: "BLOCK_PIN_FAILURE";
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountsIn: readonly bigint[];
  readonly evidence: readonly QuoteEvidence[];
}

/**
 * UI V1.1 — a same-block cross-pool x cross-size execution matrix:
 * `rows.length` candidates (executable AND precondition-failed, in
 * caller candidate order) x `amountsIn.length` sampled sizes (in caller
 * order), ALL sharing the exact same pinned `blockNumber` and the exact
 * same ONE shared decimals read — represents ONE chain state, exactly
 * as `CrossPoolComparisonSnapshot` already does for the single-size
 * case, extended by one dimension.
 *
 * `tokenInDecimals`/`tokenOutDecimals`/`sharedAnalyticsStatus`/
 * `sharedEvidence` reflect the matrix's ONE shared decimals read,
 * completely independent of any individual cell's own `analyticsStatus`
 * — identical semantics to `CrossPoolComparisonSnapshot`'s own fields of
 * the same name, now shared across the WHOLE matrix instead of one
 * comparison.
 *
 * `rankingsByAmount` has exactly one entry per `amountsIn[j]`, computed
 * independently per size over that size's own `QUOTED` cells only — see
 * `MatrixRanking`'s own doc comment. Never interpolated between sizes;
 * never a synthesized crossover amount anywhere in this type.
 */
export interface CrossPoolExecutionMatrixSnapshot {
  readonly status: "OK";
  readonly blockNumber: bigint;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountsIn: readonly bigint[];
  /** Present only when `sharedAnalyticsStatus === "OK"`. */
  readonly tokenInDecimals?: number;
  /** Present only when `sharedAnalyticsStatus === "OK"`. */
  readonly tokenOutDecimals?: number;
  readonly sharedAnalyticsStatus: QuoteAnalyticsStatus;
  readonly sharedEvidence: readonly QuoteEvidence[];
  readonly rows: readonly MatrixCandidateRow[];
  readonly rankingsByAmount: readonly MatrixRanking[];
}

/** Either a full execution matrix, or the matrix-wide block-pin failure representation. */
export type CrossPoolExecutionMatrixResult = CrossPoolExecutionMatrixSnapshot | CrossPoolExecutionMatrixBlockPinFailure;

/**
 * Executable-Depth Thresholds — the ONE structural classification of
 * what is and is not known about ladder points STRICTLY LARGER than a
 * given qualifying threshold value. See `depth-math.ts`'s
 * `classifyUpperRange` (the sole function that produces this type) for
 * the full reasoning behind each variant — this type exists
 * specifically so a caller/UI can never conflate "the next REQUESTED
 * larger sample" with "the next SUCCESSFULLY MEASURED larger sample."
 */
export type UpperRangeClassification =
  | { readonly kind: "OPEN" }
  | { readonly kind: "CLEAN_CEILING"; readonly nextMeasuredAmountIn: bigint }
  | { readonly kind: "GAPPED_CEILING"; readonly nextMeasuredAmountIn: bigint }
  | { readonly kind: "GAPPED_NO_CEILING" };

/**
 * Executable-Depth Thresholds — one (pool, threshold) result. Computed
 * ONLY for an executable pool (a `PRECONDITION_FAILED` row, see
 * `VerifiedPoolDepthResult`, never reaches this — its precondition is a
 * WHOLE-ROW fact, not a per-threshold one, so it has zero outcomes).
 *
 *  - `NO_QUOTED_SAMPLES`: every point in this pool's ladder is
 *    non-`QUOTED` — nothing at all could be established. A ladder-level
 *    fact, true identically for every threshold.
 *  - `ANALYTICS_UNAVAILABLE`: the request's ONE shared spot/decimals
 *    read failed (no `QUOTED` point anywhere in this request has a
 *    defined `priceImpactBps`) — a REQUEST-level fact, true identically
 *    for every pool and every threshold in this same request. A point's
 *    own `amountOut`/`status` is never altered by this — only the
 *    derived impact comparison is unavailable.
 *  - `EXCEEDED_AT_SMALLEST_SAMPLE`: at least one point was genuinely
 *    measured (has a defined `priceImpactBps`), but none satisfies this
 *    threshold. `smallestMeasuredAmountIn` is the smallest `amountIn`
 *    among points with a defined `priceImpactBps` — NOT necessarily the
 *    ladder's literal smallest requested entry, if that specific point
 *    itself failed to quote or its analytics were unavailable; this is
 *    the smallest amount we actually have measured evidence about.
 *  - `WITHIN_THRESHOLD`: `qualifyingAmountIn` is `sampledDepthAtBps`'s
 *    own return value for this threshold — "at least this much was
 *    tested and observed to qualify," never a stronger claim.
 *    `monotonicityObserved` (`monotonicityObservedAtOrBelow`) and
 *    `upperRange` (`classifyUpperRange`) are two independent,
 *    non-overlapping disclosures: the former concerns points AT OR
 *    BELOW `qualifyingAmountIn`, the latter concerns points STRICTLY
 *    ABOVE it. Neither implies anything about the other.
 */
export type DepthThresholdOutcome =
  | {
      readonly kind: "WITHIN_THRESHOLD";
      readonly qualifyingAmountIn: bigint;
      readonly monotonicityObserved: boolean;
      readonly upperRange: UpperRangeClassification;
    }
  | { readonly kind: "EXCEEDED_AT_SMALLEST_SAMPLE"; readonly smallestMeasuredAmountIn: bigint }
  | { readonly kind: "ANALYTICS_UNAVAILABLE" }
  | { readonly kind: "NO_QUOTED_SAMPLES" };

/**
 * Executable-Depth Thresholds — one executable pool's complete result:
 * its full 12-point ladder (`row.cells`, reusing `MatrixCandidateRow`
 * verbatim — the identical "one pool across every sampled size" shape
 * the matrix already uses) plus one `DepthThresholdOutcome` per
 * requested threshold, in threshold order. A `PRECONDITION_FAILED` row
 * (hooked V4, missing hookData — case G) still has a full `row.cells`
 * array (every cell `PRECONDITION_FAILED`, mirroring the matrix's own
 * precondition-failed-row shape exactly) but an EMPTY
 * `outcomesByThreshold` — a row-wide precondition is a WHOLE-ROW fact,
 * never expressed as four repeated per-threshold outcomes.
 */
export interface VerifiedPoolDepthResult {
  readonly row: MatrixCandidateRow;
  readonly outcomesByThreshold: readonly { readonly thresholdBps: number; readonly outcome: DepthThresholdOutcome }[];
}

/**
 * Executable-Depth Thresholds — the best sampled venue(s) at ONE
 * threshold: every executable pool whose `qualifyingAmountIn` at this
 * threshold equals the maximum observed across all executable pools in
 * this request, compared by exact `bigint` equality. `poolAddresses`
 * is empty when zero pools qualify at this threshold (an honest "no
 * tested venue qualifies" result, never omitted). Ties are ALWAYS
 * preserved — no gas, displayed liquidity, TVL, protocol preference, or
 * address ordering is ever used to break a tie; a deterministic address
 * order may be applied only for PRESENTATION after every tied address
 * has already been included.
 */
export interface BestVenueAtThreshold {
  readonly thresholdBps: number;
  readonly poolAddresses: readonly Hex[];
}

/** Executable-Depth Thresholds — the request-wide block-pin failure representation. Structurally identical in spirit to `CrossPoolExecutionMatrixBlockPinFailure`, with no `amountsIn`/`thresholdsBps` echoed back (nothing was attempted at all). */
export interface VerifiedPoolDepthThresholdsBlockPinFailure {
  readonly status: "BLOCK_PIN_FAILURE";
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly evidence: readonly QuoteEvidence[];
}

/**
 * Executable-Depth Thresholds — a same-block, per-pool sampled
 * execution-depth result across every executable pool in one verified
 * `tokenOut` group, evaluated against a caller-supplied set of
 * thresholds. Represents ONE chain state: `blockNumber` is pinned via
 * exactly one `eth_blockNumber` call, and every spot read, the one
 * shared decimals read, and every quoter call across every pool and
 * every ladder point all use that identical block.
 *
 * `tokenInDecimals`/`tokenOutDecimals`/`sharedAnalyticsStatus` reflect
 * the request's ONE shared decimals read, independent of any
 * individual pool's own per-threshold outcomes — identical semantics
 * to `CrossPoolExecutionMatrixSnapshot`'s own fields of the same name.
 */
export interface VerifiedPoolDepthThresholdsSnapshot {
  readonly status: "OK";
  readonly blockNumber: bigint;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly ladderAmountsIn: readonly bigint[];
  readonly thresholdsBps: readonly number[];
  /** Present only when `sharedAnalyticsStatus === "OK"`. */
  readonly tokenInDecimals?: number;
  /** Present only when `sharedAnalyticsStatus === "OK"`. */
  readonly tokenOutDecimals?: number;
  readonly sharedAnalyticsStatus: QuoteAnalyticsStatus;
  readonly sharedEvidence: readonly QuoteEvidence[];
  readonly pools: readonly VerifiedPoolDepthResult[];
  readonly bestVenueByThreshold: readonly BestVenueAtThreshold[];
}

/** Either a full depth-thresholds result, or the request-wide block-pin failure representation. */
export type VerifiedPoolDepthThresholdsResult = VerifiedPoolDepthThresholdsSnapshot | VerifiedPoolDepthThresholdsBlockPinFailure;
