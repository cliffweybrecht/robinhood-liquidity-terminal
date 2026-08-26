import type { Address } from "viem";
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
