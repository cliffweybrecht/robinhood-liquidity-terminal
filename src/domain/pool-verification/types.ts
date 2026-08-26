import type { Address, Hex } from "viem";
import type { ClassificationStatus, ClassifiedPoolIdentity, ProtocolFamily } from "@/domain/protocol";

/**
 * Explicit epistemic states for on-chain pool identity verification.
 * Deliberately no generic `FAILED` status, no confidence score, no
 * partial-VERIFIED state, no heuristic upgrade path — every result is
 * exactly one of these five, chosen because it is the most precise true
 * statement about what the evidence establishes:
 *
 *  - `VERIFIED`: every required protocol-specific identity check
 *    succeeded and none contradicted the discovered pool identity.
 *  - `CONTRADICTED`: at least one piece of valid on-chain evidence
 *    conflicts with the discovered/classified pool identity. Takes
 *    priority over every other status — a proven contradiction is never
 *    downgraded to `RPC_ERROR` or `INDETERMINATE` just because some
 *    other read also failed.
 *  - `UNSUPPORTED`: this module deliberately has no verifier for the
 *    pool's classification (wrong family, or `classification.status`
 *    isn't `CLASSIFIED`). No RPC call is made to reach this status — see
 *    `verify.ts`.
 *  - `INDETERMINATE`: RPC reads succeeded (no transport failure) but the
 *    returned data could not be decoded into a usable value (malformed/
 *    impossible ABI return), so the required check it belonged to could
 *    not be completed either way.
 *  - `RPC_ERROR`: a transport/RPC failure (network, timeout, JSON-RPC
 *    error response, etc. — see `src/providers/robinhood-rpc/errors.ts`)
 *    prevented a required read from completing at all.
 */
export type PoolVerificationStatus = "VERIFIED" | "CONTRADICTED" | "UNSUPPORTED" | "INDETERMINATE" | "RPC_ERROR";

/**
 * Whether one piece of evidence supports, contradicts, or is neutral
 * toward the claimed pool identity. `NEUTRAL` covers both "this is a
 * true fact but doesn't by itself prove or disprove anything" (e.g. a
 * successfully-decoded `fee()` value) and "this check could not be
 * completed" (an RPC or decode failure, or a check deliberately skipped
 * because its prerequisites didn't succeed) — the `detail` field always
 * explains which.
 */
export type PoolVerificationEvidenceSupport = "SUPPORTS" | "CONTRADICTS" | "NEUTRAL";

/**
 * Typed, machine-readable evidence categories. Every non-`UNSUPPORTED`
 * verification attempt that reaches a strategy carries one entry per
 * read/comparison performed, in a fixed, deterministic order — never an
 * opaque prose-only explanation.
 */
export type PoolVerificationEvidenceKind =
  | "CONTRACT_CODE_PRESENT"
  | "CONTRACT_CODE_ABSENT"
  | "TOKEN0_READ"
  | "TOKEN1_READ"
  | "FACTORY_READ"
  | "FEE_READ"
  | "FACTORY_POOL_LOOKUP"
  | "CANONICAL_ASSET_MATCH"
  | "TOKEN_PAIR_MATCH"
  | "CLASSIFICATION_UNSUPPORTED"
  | "BLOCK_PIN_FAILURE"
  | "V4_INITIALIZE_EVENT_FOUND"
  | "V4_INITIALIZE_EVENT_AMBIGUOUS"
  | "V4_POOL_KEY_RECOVERED"
  | "V4_POOL_ID_RECOMPUTED"
  | "V4_CURRENCY_PAIR_MATCH";

/**
 * One piece of structured, machine-readable evidence. `observed`/
 * `expected` are free-form strings (already-formatted addresses/numbers,
 * not raw hex) rather than `unknown` — this module never needs a caller
 * to re-parse them, only to display them; the typed `kind`/`support`
 * fields are what any programmatic consumer should branch on.
 */
export interface PoolVerificationEvidence {
  readonly kind: PoolVerificationEvidenceKind;
  readonly support: PoolVerificationEvidenceSupport;
  /** Where this evidence came from — a call signature or comparison description, e.g. `"pool.token0()"` or `"eth_getCode(0x...)"`. */
  readonly source: string;
  /** What was actually observed, when a read succeeded. Omitted for failures/skips. */
  readonly observed?: string;
  /** What was expected, when this evidence is a comparison against a known value. Omitted when not applicable. */
  readonly expected?: string;
  /** Human-readable explanation — supplements the typed fields above, never replaces them. */
  readonly detail: string;
}

/**
 * The result of `verifyPoolIdentity`. `blockNumber` is `null` only when
 * no chain read was ever attempted or completed: an `UNSUPPORTED` result
 * (decided purely from the classification, zero RPC calls — see
 * `verify.ts`), or an `RPC_ERROR` result where the failure was in
 * `eth_blockNumber` itself, before any block was ever pinned. Whenever a
 * block number *was* obtained, it is preserved here even if a later read
 * in the same verification attempt failed — this is "the block every
 * read in this attempt was pinned to," not "the block verification
 * concluded successfully at."
 */
export interface HistoricalPoolProvenance {
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

/**
 * The immutable Uniswap V4 `PoolKey` fields already proven during
 * identity verification (`strategies/uniswap-v4.ts`): recovered from
 * the pool's historical `Initialize` event, and cryptographically
 * confirmed (`keccak256(abi.encode(PoolKey))`) to reproduce the exact
 * discovered `PoolId`. Exposed here as the SAME values already computed
 * during verification — never re-derived, never re-read — so a later
 * consumer (e.g. Phase 6E's V4 quote path) has trustworthy typed access
 * to `currency0`/`currency1`/`fee`/`tickSpacing`/`hooks` without parsing
 * the free-form `V4_POOL_KEY_RECOVERED` evidence string. Present only
 * when `status === "VERIFIED"` and `family === "UNISWAP_V4"` — `null`/
 * absent otherwise, including for a V4 result that reached `CONTRADICTED`
 * (a contradicted identity's PoolKey is not "the verified PoolKey for
 * this pool").
 */
export interface VerifiedV4PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

export interface PoolIdentityVerification {
  readonly pool: ClassifiedPoolIdentity;
  readonly family: ProtocolFamily;
  readonly classificationStatus: ClassificationStatus;
  readonly status: PoolVerificationStatus;
  readonly blockNumber: bigint | null;
  readonly historicalProvenance?: HistoricalPoolProvenance | null;
  /** Present only for a `VERIFIED` `UNISWAP_V4` result — see `VerifiedV4PoolKey`'s doc comment. */
  readonly poolKey?: VerifiedV4PoolKey | null;
  readonly evidence: readonly PoolVerificationEvidence[];
}
