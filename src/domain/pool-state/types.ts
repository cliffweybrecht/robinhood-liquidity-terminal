import type { ClassifiedPoolIdentity } from "@/domain/protocol";

/**
 * Explicit epistemic states for a current-state read attempt.
 * Deliberately narrower than `pool-verification`'s
 * `PoolVerificationStatus`, not copied from it:
 *
 *  - `VERIFIED`: every required state read (`slot0`, `liquidity`,
 *    `fee`, `tickSpacing`) was successfully obtained and strictly
 *    decoded at the same pinned `stateBlockNumber`.
 *  - `INDETERMINATE`: every required RPC read completed (no transport
 *    failure) but at least one return payload could not be strictly
 *    decoded (malformed ABI shape, out-of-range value, bad padding).
 *  - `RPC_ERROR`: a transport/RPC failure prevented `eth_blockNumber`
 *    or a required `eth_call` from completing at all.
 *
 * No `UNSUPPORTED`: every precondition this module cares about (wrong
 * family, non-VERIFIED identity, pool/identity mismatch, wrong
 * identifier shape) is checked *before* any RPC call and fails closed
 * via a thrown `PoolStateError` (see `errors.ts`) — there is no calling
 * path through `readVerifiedUniswapV3PoolState` that produces an
 * `UNSUPPORTED` result value, so the status union does not carry one.
 *
 * No `CONTRADICTED`: this module performs no comparison against another
 * claimed value — it independently reads and reports *current* state,
 * full stop. (Phase 6C.1's identity proof separately read `fee()` as
 * part of establishing identity, but `PoolIdentityVerification` only
 * exposes that as a free-form string inside one evidence entry, not a
 * structured field — see the module doc comment on
 * `read-uniswap-v3-state.ts` for why this module deliberately does not
 * parse that string to build a cross-check, and does not widen Phase
 * 6C's public types to enable one.)
 */
export type PoolStateStatus = "VERIFIED" | "INDETERMINATE" | "RPC_ERROR";

/** Whether one state read outcome is a clean success, a transport failure, or a decode failure — the same three-way vocabulary `pool-verification/read.ts`'s internal `ReadResult` already uses, reused here because it's the accurate description of what happened, not a borrowed comparison-oriented vocabulary (`pool-verification`'s `SUPPORTS`/`CONTRADICTS`/`NEUTRAL` would be misleading here: this module never compares anything, so `support` would always be a meaningless constant). */
export type PoolStateEvidenceOutcome = "ok" | "rpc_error" | "decode_error";

export type PoolStateEvidenceKind = "BLOCK_PIN_FAILURE" | "SLOT0_READ" | "ACTIVE_LIQUIDITY_READ" | "FEE_READ" | "TICK_SPACING_READ";

/** One piece of structured, machine-readable evidence for a single required read. */
export interface PoolStateEvidence {
  readonly kind: PoolStateEvidenceKind;
  readonly outcome: PoolStateEvidenceOutcome;
  /** The call this evidence came from, e.g. `"pool.slot0()"`. */
  readonly source: string;
  /** What was actually observed, when the read succeeded. Omitted for failures. */
  readonly observed?: string;
  /** Human-readable explanation — supplements the typed fields above, never replaces them. */
  readonly detail: string;
}

/**
 * Current Uniswap V3 AMM state for one pool at `stateBlockNumber`.
 *
 * `activeLiquidity` is the pool's active in-range concentrated liquidity
 * at the current tick (the raw `liquidity()` return) — explicitly NOT
 * total liquidity, NOT pool TVL, NOT executable trade size. Determining
 * actual executable depth requires walking initialized ticks/the tick
 * bitmap outward from the current tick, which this phase does not do —
 * see the module doc comment on `read-uniswap-v3-state.ts`.
 */
export interface UniswapV3PoolState {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly activeLiquidity: bigint;
  readonly fee: number;
  readonly tickSpacing: number;
}

/**
 * The result of `readVerifiedUniswapV3PoolState`. Deliberately exposes
 * two distinct block numbers rather than one, and never conflates them:
 *
 *  - `identityVerificationBlock`: the block Phase 6C's identity proof
 *    was pinned to. May be arbitrarily older than `stateBlockNumber` —
 *    identity proof can happen long before a given state read.
 *  - `stateBlockNumber`: the block THIS state snapshot's reads
 *    (`slot0`/`liquidity`/`fee`/`tickSpacing`) are all pinned to — a
 *    fresh block pinned by this call, never inherited from identity
 *    verification. `null` only if `eth_blockNumber` itself failed
 *    before any state read was attempted.
 */
export interface PoolStateVerification {
  readonly pool: ClassifiedPoolIdentity;
  readonly family: "UNISWAP_V3";
  readonly status: PoolStateStatus;
  readonly identityVerificationBlock: bigint;
  readonly stateBlockNumber: bigint | null;
  /** Present only when `status === "VERIFIED"`. */
  readonly state?: UniswapV3PoolState;
  readonly evidence: readonly PoolStateEvidence[];
}
