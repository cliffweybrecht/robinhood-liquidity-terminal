import type { ClassifiedPoolIdentity } from "@/domain/protocol";

/**
 * Explicit epistemic states for a current-state read attempt.
 * Deliberately narrower than `pool-verification`'s
 * `PoolVerificationStatus`, not copied from it:
 *
 *  - `VERIFIED`: every required state read was successfully obtained,
 *    strictly decoded, and — for V4 — passed the required semantic
 *    validity check, all at the same pinned `stateBlockNumber`.
 *  - `INDETERMINATE`: every required RPC read completed (no transport
 *    failure) but at least one return payload either could not be
 *    strictly decoded (malformed ABI shape, out-of-range value, bad
 *    padding) or decoded to a structurally valid but semantically
 *    unusable value (V4 only — see `PoolStateEvidenceOutcome`'s
 *    `"semantic_error"` case).
 *  - `RPC_ERROR`: a transport/RPC failure prevented `eth_blockNumber`
 *    or a required `eth_call` from completing at all.
 *
 * No `UNSUPPORTED`: every precondition this module cares about (wrong
 * family, non-VERIFIED identity, pool/identity mismatch, wrong
 * identifier shape) is checked *before* any RPC call and fails closed
 * via a thrown `PoolStateError` (see `errors.ts`) — there is no calling
 * path through `readVerifiedUniswapV3PoolState`/`readVerifiedUniswapV4PoolState`
 * that produces an `UNSUPPORTED` result value, so the status union does
 * not carry one.
 *
 * No `CONTRADICTED`: this module performs no comparison against another
 * independently trusted claimed value — it independently reads and
 * reports *current* state, full stop. A V4 read that observes a
 * structurally valid but semantically impossible/canonically-invalid
 * state — e.g. `sqrtPriceX96 === 0` on a pool identity already proved
 * `VERIFIED`, an `lpFee` exceeding Uniswap V4's own `MAX_LP_FEE`
 * (1,000,000), or a packed `protocolFee` whose zero-for-one or
 * one-for-zero component exceeds `MAX_PROTOCOL_FEE` (1000) — is
 * `INDETERMINATE`, not `CONTRADICTED`: this module is not the layer
 * responsible for declaring which specific upstream trusted proposition
 * was contradicted, only that the observed state cannot be trusted as
 * usable current state. (Phase 6C.1's identity proof separately read
 * `fee()` as part of establishing identity, but `PoolIdentityVerification`
 * only exposes that as a free-form string inside one evidence entry, not
 * a structured field — see the module doc comment on
 * `read-uniswap-v3-state.ts` for why this module deliberately does not
 * parse that string to build a cross-check, and does not widen Phase
 * 6C's public types to enable one.)
 */
export type PoolStateStatus = "VERIFIED" | "INDETERMINATE" | "RPC_ERROR";

/**
 * Whether one state read outcome is a clean success, a transport
 * failure, a decode failure, or — V4 only — a semantic-validity
 * failure. The first three reuse the same vocabulary
 * `pool-verification/read.ts`'s internal `ReadResult` already uses
 * (accurate description of what happened, not a borrowed
 * comparison-oriented vocabulary — `pool-verification`'s
 * `SUPPORTS`/`CONTRADICTS`/`NEUTRAL` would be misleading here: this
 * module never compares anything, so `support` would always be a
 * meaningless constant). `"semantic_error"` is additive: the ABI decode
 * itself succeeded (unlike `"decode_error"`) but the decoded value is
 * not usable as current state by a known, canonical V4 invariant (e.g.
 * an already-initialized pool can never report `sqrtPriceX96 === 0`).
 */
export type PoolStateEvidenceOutcome = "ok" | "rpc_error" | "decode_error" | "semantic_error";

export type PoolStateEvidenceKind =
  | "BLOCK_PIN_FAILURE"
  | "SLOT0_READ"
  | "ACTIVE_LIQUIDITY_READ"
  | "FEE_READ"
  | "TICK_SPACING_READ"
  | "SLOT0_V4_READ";

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
 * Current Uniswap V4 AMM state for one pool at `stateBlockNumber`, read
 * through the canonical `StateView` periphery contract.
 *
 * `activeLiquidity` is the pool's active in-range concentrated liquidity
 * at the current tick (the raw `StateView.getLiquidity` return) —
 * explicitly NOT total liquidity, NOT pool TVL, NOT executable trade
 * size, for the same reason `UniswapV3PoolState.activeLiquidity` isn't.
 *
 * `lpFee` is the pool's **current stored LP fee** (`slot0.lpFee`), read
 * fresh every call, never inferred from Phase 6C.2 identity evidence: a
 * V4 pool's identity-time `fee()` value may be the dynamic-fee flag
 * (`0x800000`) rather than a real rate, in which case the stored value
 * is only ever knowable via `StateView.getSlot0`. **This is stored
 * state, not necessarily the fee an individual swap will actually pay**
 * — for a dynamic-fee pool, the pool's `beforeSwap` hook may supply a
 * valid per-swap fee override that differs from this stored value at
 * execution time. Accounting for hook-overridden execution fees is a
 * later, executable-quoting-phase concern, out of scope here.
 *
 * `protocolFee` is the **raw packed `uint24` value** `StateView.getSlot0`
 * returns, not decomposed into a single scalar rate. Per Uniswap V4's
 * own packing, it encodes two independent directional fees: the low 12
 * bits are the zero-for-one protocol fee (`protocolFee & 0xFFF`), the
 * high 12 bits are the one-for-zero protocol fee (`protocolFee >> 12`)
 * — each a value in hundredths of a bip, capped at 1000 (0.1%) by
 * Uniswap V4's own `ProtocolFeeLibrary.MAX_PROTOCOL_FEE`. Decomposing
 * this into named fields is deferred to a later phase that actually
 * needs the two directional values separately; this phase only
 * validates the packed value's structural bounds (see
 * `read-uniswap-v4-state.ts`).
 *
 * No `tickSpacing`, no `hooks`: both are immutable `PoolKey` facts
 * already established during Phase 6C.2 identity verification (visible
 * there only as free-form evidence text, not exposed here) — not
 * current state, and `StateView` itself has no accessor for either.
 */
export interface UniswapV4PoolState {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly activeLiquidity: bigint;
  /** Raw packed uint24: low 12 bits = zero-for-one protocol fee, high 12 bits = one-for-zero protocol fee. See the interface doc comment above. */
  readonly protocolFee: number;
  /** Current stored LP fee (`slot0.lpFee`) — a dynamic-fee pool's hook may override this per swap. See the interface doc comment above. */
  readonly lpFee: number;
}

/**
 * Shared fields across both protocols' state-verification results.
 * Deliberately exposes two distinct block numbers rather than one, and
 * never conflates them:
 *
 *  - `identityVerificationBlock`: the block Phase 6C's identity proof
 *    was pinned to. May be arbitrarily older than `stateBlockNumber` —
 *    identity proof can happen long before a given state read.
 *  - `stateBlockNumber`: the block THIS state snapshot's reads are all
 *    pinned to — a fresh block pinned by this call, never inherited
 *    from identity verification. `null` only if `eth_blockNumber`
 *    itself failed before any state read was attempted.
 */
interface PoolStateVerificationBase {
  readonly pool: ClassifiedPoolIdentity;
  readonly status: PoolStateStatus;
  readonly identityVerificationBlock: bigint;
  readonly stateBlockNumber: bigint | null;
  readonly evidence: readonly PoolStateEvidence[];
}

/** The result of `readVerifiedUniswapV3PoolState` — `state` (when present) is always a `UniswapV3PoolState`, enforced by this being that function's own concrete return type, not a runtime tag check. */
export interface UniswapV3PoolStateVerification extends PoolStateVerificationBase {
  readonly family: "UNISWAP_V3";
  /** Present only when `status === "VERIFIED"`. */
  readonly state?: UniswapV3PoolState;
}

/** The result of `readVerifiedUniswapV4PoolState` — `state` (when present) is always a `UniswapV4PoolState`, enforced by this being that function's own concrete return type, not a runtime tag check. */
export interface UniswapV4PoolStateVerification extends PoolStateVerificationBase {
  readonly family: "UNISWAP_V4";
  /** Present only when `status === "VERIFIED"`. */
  readonly state?: UniswapV4PoolState;
}

/**
 * The union of both protocols' state-verification results. No generic
 * multi-protocol dispatcher exists yet — a caller who already knows
 * which protocol a pool is calls the matching concrete function
 * (`readVerifiedUniswapV3PoolState`/`readVerifiedUniswapV4PoolState`)
 * and gets that function's own narrow return type; this union type is
 * for the rarer case of a caller genuinely handling either result
 * generically (e.g. narrowing on `.family`).
 */
export type PoolStateVerification = UniswapV3PoolStateVerification | UniswapV4PoolStateVerification;
