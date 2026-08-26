import { zeroAddress, type Address, type Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolIdentityVerification, VerifiedV4PoolKey } from "@/domain/pool-verification";
import { getProtocolDeploymentAddress } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { assembleQuoteAnalytics, type TokenDenomination } from "./analytics";
import { decodeV4QuoteReturn, decodeV4Slot0SqrtPriceX96 } from "./abi/decode";
import { encodeGetSlot0Call, encodeQuoteExactInputSingleV4Call } from "./abi/selectors";
import {
  IdentityNotVerifiedError,
  InvalidAmountInError,
  InvalidTokenInError,
  MissingHookDataError,
  MissingIdentityBlockError,
  MissingVerifiedPoolKeyError,
  PoolIdentityMismatchError,
  UnsupportedIdentityFamilyError,
} from "./errors";
import { callQuoter, classifyRevert, describeError } from "./read";
import type { QuoteEvidence, QuoteStatus, UniswapV4QuoteMetadata, UniswapV4QuoteVerification, UniswapV4QuoteWithAnalytics } from "./types";

/** `V4Quoter.quoteExactInputSingle`'s `exactAmount` is `uint128` — this is that ABI-level bound, exported so callers that need to distinguish "amountIn <= 0" (globally invalid) from "amountIn exceeds V4's own representable range" (a V4-specific constraint another protocol's candidate may not share — see `compare-verified-pools.ts`) can do so without duplicating this literal. */
export const UINT128_MAX = (1n << 128n) - 1n;

export interface QuoteVerifiedUniswapV4ExactInputInput {
  readonly pool: LiquidityPool;
  readonly identity: PoolIdentityVerification;
  readonly tokenIn: Address;
  readonly amountIn: bigint;
  readonly rpc: VerifiedRobinhoodRpcClient;
  /**
   * Explicit `hookData` for a hooked pool. `undefined` means "not
   * provided" — for a hooked pool (`poolKey.hooks !== zeroAddress`)
   * this throws `MissingHookDataError` before any RPC, per the frozen
   * fail-closed hookData rule (see the module doc comment below). An
   * unhooked pool ignores this field entirely and always uses `0x`
   * internally. Pass an explicit `"0x"` to deliberately quote a hooked
   * pool with empty hookData — that is a real, distinguishable choice
   * from not passing this field at all.
   */
  readonly hookData?: Hex;
}

function validateV4AmountIn(amountIn: bigint): void {
  if (amountIn <= 0n) {
    throw new InvalidAmountInError(amountIn);
  }
  if (amountIn > UINT128_MAX) {
    throw new InvalidAmountInError(amountIn);
  }
}

/**
 * Quotes an exact-input, single-hop swap through one already
 * identity-VERIFIED Uniswap V4 pool via the canonical `V4Quoter`
 * (resolved from the shared `pool-verification` deployment registry —
 * `deployments.ts`'s `"quoter"` role). Canonical protocol simulation,
 * not a local estimate: `V4Quoter.quoteExactInputSingle` invokes the
 * REAL `PoolManager` swap path (`beforeSwap`/`afterSwap` hooks, dynamic
 * LP-fee overrides, hook-return deltas all genuinely execute) via
 * `eth_call`, so it is authoritative for this phase in a way a local
 * reimplementation could never be for a hooked pool — see the Phase 6E
 * architecture research for the full analysis.
 *
 * Preconditions are checked in order, each throwing a typed
 * `QuotePreconditionError` *before* any RPC call:
 *  1. `identity.pool` must match `pool` (same chainId/pairAddress).
 *  2. `identity.status` must be `"VERIFIED"`.
 *  3. `identity.family` must be `"UNISWAP_V4"`.
 *  4. `identity.blockNumber` must be non-null (defensive).
 *  5. `identity.poolKey` must be present (defensive — unreachable in
 *     practice given `VERIFIED`/`UNISWAP_V4` always populates it, see
 *     `pool-verification/strategies/uniswap-v4.ts`).
 *  6. `amountIn` must be greater than zero, and must fit in `uint128`
 *     (`V4Quoter`'s `exactAmount` parameter type).
 *  7. `tokenIn` must be one of `poolKey.currency0`/`currency1` —
 *     `zeroForOne` is derived from this, never caller-supplied.
 *  8. **hookData, fail-closed** (frozen rule): if `poolKey.hooks ===
 *     zeroAddress`, `hookData` is internally canonicalized to `0x`
 *     regardless of what (if anything) the caller passed — there is no
 *     hook to consume it. If `poolKey.hooks !== zeroAddress` and the
 *     caller did not explicitly provide `hookData` (i.e. it is
 *     `undefined`), this throws `MissingHookDataError` — empty
 *     `hookData` is NEVER silently assumed safe for a hooked pool (see
 *     the Phase 6E hookData research: a hook's required calling
 *     convention cannot be generically known). If the caller explicitly
 *     provides `hookData` (including a deliberate `"0x"`), the quote
 *     proceeds using exactly that value, and the result explicitly
 *     discloses (`hookDataCallerSupplied: true` plus a
 *     `HOOK_DATA_DISCLOSURE` evidence entry) that this `hookData` was
 *     caller-supplied and NOT independently verified as canonically
 *     correct for this specific hook.
 *
 * After preconditions, exactly one `eth_blockNumber` call pins
 * `quoteBlockNumber`; the single `V4Quoter.quoteExactInputSingle` call
 * is pinned to that block. `eth_blockNumber` is never called again.
 *
 * `QUOTED` requires the quoter call to transport-succeed, its 2-word
 * return to strictly decode, and `amountOut` to be a semantically
 * usable `uint256` (see `read-uniswap-v3-quote.ts`'s `amountOut === 0`
 * reasoning — identical logic applies here). Economic quality never
 * changes this. A quoter revert is classified via `abi/revert.ts`'s
 * explicit allowlist into `UNQUOTABLE` or `INDETERMINATE`.
 *
 * This function does NOT claim `V4Quoter`'s simulated fee behavior
 * equals Phase 6D's stored `lpFee` — the quoter's simulation is
 * authoritative precisely because it re-derives the effective fee
 * itself (via the real `beforeSwap` path) rather than trusting any
 * previously-read value.
 */
export async function quoteVerifiedUniswapV4ExactInput(input: QuoteVerifiedUniswapV4ExactInputInput): Promise<UniswapV4QuoteVerification> {
  const { pool, identity, tokenIn, amountIn, rpc, hookData: callerHookData } = input;

  const identityResolved = resolveV4Identity({ pool, identity });
  validateV4AmountIn(amountIn);
  const direction = resolveV4TokenDirection(identityResolved.poolKey, tokenIn);
  const hook = resolveV4HookData(identityResolved.poolKey, callerHookData);

  const resolved: V4ResolvedQuoteInputs = {
    identityVerificationBlock: identityResolved.identityVerificationBlock,
    poolKey: identityResolved.poolKey,
    quoterAddress: getProtocolDeploymentAddress(rpc.chainId, "UNISWAP_V4", "quoter"),
    tokenIn: direction.tokenIn,
    tokenOut: direction.tokenOut,
    zeroForOne: direction.zeroForOne,
    hookData: hook.hookData,
  };

  const baseEvidence: QuoteEvidence[] = [];
  if (hook.isHooked) {
    baseEvidence.push({
      kind: "HOOK_DATA_DISCLOSURE",
      outcome: "disclosed",
      source: "poolKey.hooks",
      observed: `hooks=${resolved.poolKey.hooks} hookData=${hook.hookData}`,
      detail:
        "This pool has an active hook. hookData was explicitly supplied by the caller and is used exactly as given — it is NOT independently verified as canonically correct for this specific hook.",
    });
  }

  let quoteBlockNumber: bigint;
  try {
    quoteBlockNumber = await rpc.getBlockNumber();
  } catch (error) {
    return buildResult({
      pool: identity.pool,
      identityVerificationBlock: resolved.identityVerificationBlock,
      quoteBlockNumber: null,
      tokenIn: resolved.tokenIn,
      tokenOut: resolved.tokenOut,
      amountIn,
      hookDataCallerSupplied: hook.hookDataCallerSupplied,
      status: "RPC_ERROR",
      evidence: [
        ...baseEvidence,
        {
          kind: "BLOCK_PIN_FAILURE",
          outcome: "rpc_error",
          source: "eth_blockNumber",
          detail: `Could not pin a block for this quote attempt: ${describeError(error)}`,
        },
      ],
    });
  }

  const attempt = await quoteV4AtBlock(resolved, amountIn, quoteBlockNumber, rpc);

  return buildResult({
    pool: identity.pool,
    identityVerificationBlock: resolved.identityVerificationBlock,
    quoteBlockNumber,
    tokenIn: resolved.tokenIn,
    tokenOut: resolved.tokenOut,
    amountIn,
    hookDataCallerSupplied: hook.hookDataCallerSupplied,
    status: attempt.status,
    evidence: [...baseEvidence, ...attempt.evidence],
    amountOut: attempt.amountOut,
    metadata: attempt.metadata,
  });
}

/**
 * Phase 6E.2 — same-block execution analytics for an exact-input quote
 * through one already identity-VERIFIED Uniswap V4 pool. Runs the exact
 * same precondition/hookData/block-pin/quoter-call path as
 * `quoteVerifiedUniswapV4ExactInput` and, ONLY when that result is
 * `QUOTED`, additionally reads the canonical `StateView.getSlot0(poolId)`
 * (pre-trade spot) and `decimals()` for both `tokenIn`/`tokenOut` — all
 * pinned to the EXACT SAME `quoteBlockNumber`. No second
 * `eth_blockNumber` call is ever made. `StateView`'s address is resolved
 * through the same canonical protocol deployment registry already used
 * for the `"quoter"` role.
 *
 * `tokenInIsToken0` is derived from the already-verified typed
 * `poolKey.currency0` (Phase 6C.2), never re-derived from an untrusted
 * source. A non-`QUOTED` result is returned completely unchanged, with
 * no `analytics` field — see the identical reasoning on
 * `quoteVerifiedUniswapV3ExactInputWithAnalytics`.
 */
export async function quoteVerifiedUniswapV4ExactInputWithAnalytics(
  input: QuoteVerifiedUniswapV4ExactInputInput,
): Promise<UniswapV4QuoteWithAnalytics> {
  const result = await quoteVerifiedUniswapV4ExactInput(input);
  if (result.status !== "QUOTED" || result.quoteBlockNumber === null || result.amountOut === undefined) {
    return result;
  }

  const poolKey = input.identity.poolKey;
  if (poolKey === null || poolKey === undefined) {
    // Unreachable in practice — a QUOTED result already required a
    // non-null poolKey (MissingVerifiedPoolKeyError otherwise) — but
    // re-checked defensively rather than trusted, matching this
    // module's established style.
    return result;
  }

  const poolId = result.pool.pairAddress;
  const stateViewAddress = getProtocolDeploymentAddress(input.rpc.chainId, "UNISWAP_V4", "state_view");
  const blockNumber = result.quoteBlockNumber;
  const tokenInIsToken0 = result.tokenIn.toLowerCase() === poolKey.currency0.toLowerCase();

  const analytics = await assembleQuoteAnalytics({
    rpc: input.rpc,
    tokenIn: result.tokenIn,
    tokenOut: result.tokenOut,
    // result.tokenIn/tokenOut are provably poolKey.currency0/currency1
    // (in the order tokenInIsToken0 selects) — resolveV4TokenDirection
    // guarantees this earlier in the pipeline, never caller-supplied
    // pool metadata. See resolveV4Denomination's doc comment.
    tokenInDenomination: resolveV4Denomination(result.tokenIn),
    tokenOutDenomination: resolveV4Denomination(result.tokenOut),
    blockNumber,
    tokenInIsToken0,
    amountIn: result.amountIn,
    amountOut: result.amountOut,
    readSpotSqrtPriceX96: () => readV4SpotSqrtPriceX96(input.rpc, stateViewAddress, poolId, blockNumber),
    spotEvidenceSource: "StateView.getSlot0(poolId)",
  });

  return { ...result, analytics };
}

/**
 * Phase 6F.1 — internal, unexported (from `index.ts`) shared primitives.
 * Extracted so `read-uniswap-v4-depth-curve.ts` can reuse the EXACT same
 * identity preconditions, token-direction derivation, hookData
 * resolution, and single-`amountIn` quoter-call/classify/decode logic as
 * the single-quote functions above, byte-for-byte. Exported from THIS
 * FILE (a normal named export other files in this module may import via
 * a relative path) but never re-exported from `pool-quote/index.ts`.
 */
export interface V4ResolvedIdentity {
  readonly identityVerificationBlock: bigint;
  readonly poolKey: VerifiedV4PoolKey;
}

/** Preconditions 1-5 only — deliberately NOT including `amountIn`/`tokenIn`/`hookData` validation, so this is shared by both a single-`amountIn` caller and an N-`amountIn` ladder caller. */
export function resolveV4Identity(args: { pool: LiquidityPool; identity: PoolIdentityVerification }): V4ResolvedIdentity {
  const { pool, identity } = args;
  if (identity.pool.chainId !== pool.chainId || identity.pool.pairAddress.toLowerCase() !== pool.pairAddress.toLowerCase()) {
    throw new PoolIdentityMismatchError(pool.pairAddress, identity.pool.pairAddress);
  }
  if (identity.status !== "VERIFIED") {
    throw new IdentityNotVerifiedError(identity.status);
  }
  if (identity.family !== "UNISWAP_V4") {
    throw new UnsupportedIdentityFamilyError(identity.family, "UNISWAP_V4");
  }
  if (identity.blockNumber === null) {
    throw new MissingIdentityBlockError();
  }
  const poolKey = identity.poolKey;
  if (poolKey === null || poolKey === undefined) {
    throw new MissingVerifiedPoolKeyError();
  }
  return { identityVerificationBlock: identity.blockNumber, poolKey };
}

/** Precondition 7 alone: `tokenIn` must be one of the verified `PoolKey`'s two currencies; `tokenOut`/`zeroForOne` are derived exclusively from that same typed fact. Pure, no RPC. */
export function resolveV4TokenDirection(poolKey: VerifiedV4PoolKey, tokenIn: Address): { tokenIn: Address; tokenOut: Address; zeroForOne: boolean } {
  const currency0Lower = poolKey.currency0.toLowerCase();
  const currency1Lower = poolKey.currency1.toLowerCase();
  const tokenInLower = tokenIn.toLowerCase();
  if (tokenInLower !== currency0Lower && tokenInLower !== currency1Lower) {
    throw new InvalidTokenInError(tokenIn);
  }
  const zeroForOne = tokenInLower === currency0Lower;
  const tokenOut: Address = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  return { tokenIn, tokenOut, zeroForOne };
}

/**
 * Resolves a `TokenDenomination` (see `analytics.ts`) for one currency
 * of a VERIFIED V4 `PoolKey` — the ONLY place in this entire codebase
 * that is permitted to produce `{ kind: "V4_NATIVE_ETH" }`, and it does
 * so ONLY when `currency` is exactly the V4 native-currency zero-address
 * sentinel. This function must ONLY ever be called with a `currency`
 * value that already came from `poolKey.currency0`/`currency1` — in
 * practice, always the `tokenIn`/`tokenOut` `resolveV4TokenDirection`
 * just returned above, which are themselves provably equal to one of
 * those two verified fields (that function's own `InvalidTokenInError`
 * branch rules out any other value reaching this point). NEVER call this
 * with a caller-supplied, unverified address (e.g. from `pool.baseToken`/
 * `quoteToken`) — doing so would defeat the entire point of this
 * function existing separately from a bare zero-address check inside
 * shared `analytics.ts` code. See `TokenDenomination`'s doc comment in
 * `analytics.ts` for the full trust-boundary reasoning this function is
 * the other half of.
 */
export function resolveV4Denomination(currency: Address): TokenDenomination {
  return currency.toLowerCase() === zeroAddress.toLowerCase() ? { kind: "V4_NATIVE_ETH" } : { kind: "ERC20", address: currency };
}

/** Precondition 8 alone: the hookData fail-closed rule. Pure, no RPC. Shared by the whole depth-curve ladder — one `hookData` value applies to every sampled point (the same pool, the same hook, for the entire curve). */
export function resolveV4HookData(
  poolKey: VerifiedV4PoolKey,
  callerHookData: Hex | undefined,
): { hookData: Hex; hookDataCallerSupplied: boolean; isHooked: boolean } {
  const isHooked = poolKey.hooks.toLowerCase() !== zeroAddress.toLowerCase();
  if (!isHooked) {
    return { hookData: "0x", hookDataCallerSupplied: false, isHooked };
  }
  if (callerHookData === undefined) {
    throw new MissingHookDataError(poolKey.hooks);
  }
  return { hookData: callerHookData, hookDataCallerSupplied: true, isHooked };
}

export interface V4ResolvedQuoteInputs {
  readonly identityVerificationBlock: bigint;
  readonly poolKey: VerifiedV4PoolKey;
  readonly quoterAddress: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly zeroForOne: boolean;
  readonly hookData: Hex;
}

/** The outcome of one canonical `V4Quoter.quoteExactInputSingle` attempt for one `amountIn` at an already-pinned block — deliberately lean, mirroring `V3QuoteAttemptOutcome`. Never includes the `HOOK_DATA_DISCLOSURE` evidence entry — that is curve/attempt-level (one disclosure per attempt, not duplicated per amountIn within a shared-hookData ladder), added by the caller. */
export interface V4QuoteAttemptOutcome {
  readonly status: QuoteStatus;
  readonly amountOut?: bigint;
  readonly metadata?: UniswapV4QuoteMetadata;
  readonly evidence: readonly QuoteEvidence[];
}

/**
 * Performs exactly ONE canonical `V4Quoter.quoteExactInputSingle`
 * `eth_call` for `amountIn` at the ALREADY-PINNED `blockNumber` — never
 * pins its own block, never re-validates preconditions beyond what
 * `resolved` already encodes and the `amountIn` bounds check below
 * (still required per-call since each ladder point has its own
 * `amountIn`).
 */
export async function quoteV4AtBlock(
  resolved: V4ResolvedQuoteInputs,
  amountIn: bigint,
  blockNumber: bigint,
  rpc: VerifiedRobinhoodRpcClient,
): Promise<V4QuoteAttemptOutcome> {
  const quoteData = encodeQuoteExactInputSingleV4Call(resolved.poolKey, resolved.zeroForOne, amountIn, resolved.hookData);
  const outcome = await callQuoter(rpc, resolved.quoterAddress, quoteData, blockNumber);

  if (outcome.kind === "rpc_error") {
    return {
      status: "RPC_ERROR",
      evidence: [{ kind: "QUOTE_CALL", outcome: "rpc_error", source: "V4Quoter.quoteExactInputSingle(...)", detail: `RPC call failed: ${outcome.detail}` }],
    };
  }

  if (outcome.kind === "revert") {
    const classification = classifyRevert("UNISWAP_V4", outcome.data);
    return {
      status: classification.outcome === "unquotable" ? "UNQUOTABLE" : "INDETERMINATE",
      evidence: [
        {
          kind: "QUOTE_CALL",
          outcome: classification.outcome === "unquotable" ? "unquotable" : "decode_error",
          source: "V4Quoter.quoteExactInputSingle(...)",
          detail: classification.reason,
        },
      ],
    };
  }

  const decoded = decodeV4QuoteReturn(outcome.raw);
  if (decoded === null) {
    return {
      status: "INDETERMINATE",
      evidence: [
        {
          kind: "QUOTE_CALL",
          outcome: "decode_error",
          source: "V4Quoter.quoteExactInputSingle(...)",
          detail: `Return data could not be decoded into a valid 2-word quote tuple (raw: ${outcome.raw}).`,
        },
      ],
    };
  }

  return {
    status: "QUOTED",
    amountOut: decoded.amountOut,
    metadata: { gasEstimate: decoded.gasEstimate },
    evidence: [
      {
        kind: "QUOTE_CALL",
        outcome: "ok",
        source: "V4Quoter.quoteExactInputSingle(...)",
        observed: `amountOut=${decoded.amountOut} gasEstimate=${decoded.gasEstimate}`,
        detail: "quoteExactInputSingle() decoded to a fully valid 2-word tuple. Economic quality does not affect this outcome.",
      },
    ],
  };
}

/** Exported for `read-uniswap-v4-depth-curve.ts` to reuse — the same `StateView.getSlot0` spot read `quoteVerifiedUniswapV4ExactInputWithAnalytics` already performs. Also exported: the per-call `amountIn` bounds validation, reused identically by the depth-curve's ladder validation. */
export { validateV4AmountIn };

export async function readV4SpotSqrtPriceX96(
  rpc: VerifiedRobinhoodRpcClient,
  stateViewAddress: Address,
  poolId: Hex,
  blockNumber: bigint,
): Promise<{ readonly outcome: "ok"; readonly value: bigint } | { readonly outcome: "rpc_error"; readonly detail: string } | { readonly outcome: "decode_error"; readonly detail: string }> {
  let raw: Hex;
  try {
    raw = await rpc.call({ to: stateViewAddress, data: encodeGetSlot0Call(poolId) }, blockNumber);
  } catch (error) {
    return { outcome: "rpc_error", detail: describeError(error) };
  }
  const sqrtPriceX96 = decodeV4Slot0SqrtPriceX96(raw);
  if (sqrtPriceX96 === null) {
    return { outcome: "decode_error", detail: `StateView.getSlot0(poolId) return data could not be decoded into a valid 4-word tuple (raw: ${raw}).` };
  }
  return { outcome: "ok", value: sqrtPriceX96 };
}

function buildResult(args: {
  pool: PoolIdentityVerification["pool"];
  identityVerificationBlock: bigint;
  quoteBlockNumber: bigint | null;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  hookDataCallerSupplied: boolean;
  status: QuoteStatus;
  evidence: readonly QuoteEvidence[];
  amountOut?: bigint;
  metadata?: UniswapV4QuoteMetadata;
}): UniswapV4QuoteVerification {
  return {
    pool: args.pool,
    family: "UNISWAP_V4",
    status: args.status,
    identityVerificationBlock: args.identityVerificationBlock,
    quoteBlockNumber: args.quoteBlockNumber,
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    amountIn: args.amountIn,
    amountOut: args.amountOut,
    metadata: args.metadata,
    hookDataCallerSupplied: args.hookDataCallerSupplied || undefined,
    evidence: args.evidence,
  };
}
