import type { Address, Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import { getProtocolDeploymentAddress, type PoolIdentityVerification } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { computeExecutionPrice, computePriceImpactBps, readSpotAndDecimals, type SharedSpotAndDecimals } from "./analytics";
import { DEPTH_CURVE_CONCURRENCY } from "./read-uniswap-v3-depth-curve";
import { mapWithBoundedConcurrency } from "./depth-math";
import { EmptyAmountsLadderError } from "./errors";
import { describeError } from "./read";
import {
  quoteV4AtBlock,
  readV4SpotSqrtPriceX96,
  resolveV4Denomination,
  resolveV4HookData,
  resolveV4Identity,
  resolveV4TokenDirection,
  validateV4AmountIn,
  type V4QuoteAttemptOutcome,
  type V4ResolvedQuoteInputs,
} from "./read-uniswap-v4-quote";
import type { QuoteEvidence, UniswapV4DepthCurve, UniswapV4DepthCurvePoint } from "./types";

export interface QuoteVerifiedUniswapV4ExactInputDepthCurveInput {
  readonly pool: LiquidityPool;
  readonly identity: PoolIdentityVerification;
  readonly tokenIn: Address;
  /** Same semantics as `QuoteVerifiedUniswapV3ExactInputDepthCurveInput.amountsIn` — caller order preserved, not sorted, not deduplicated. See that type's doc comment. */
  readonly amountsIn: readonly bigint[];
  readonly rpc: VerifiedRobinhoodRpcClient;
  /**
   * Explicit `hookData` for a hooked pool — applies to EVERY point in
   * the curve (one hook, one hookData value, for the whole ladder; a
   * hook cannot receive a different `hookData` per trade size within one
   * curve request). Same fail-closed semantics as
   * `QuoteVerifiedUniswapV4ExactInputInput.hookData`: `undefined` throws
   * `MissingHookDataError` for a hooked pool, before any RPC call. Never
   * silently defaulted.
   */
  readonly hookData?: Hex;
}

/**
 * Phase 6F.1 — a same-block executable-depth curve for one already
 * identity-VERIFIED Uniswap V4 pool across a caller-supplied ladder of
 * exact-input `amountIn` samples, via the canonical `V4Quoter`. Mirrors
 * `quoteVerifiedUniswapV3ExactInputDepthCurve`'s architecture exactly —
 * see that function's doc comment for the full shared-primitive/trust-
 * model explanation — with two V4-specific additions:
 *
 * **hookData** is resolved exactly ONCE for the whole curve
 * (`resolveV4HookData`, the SAME shared function the single-quote path
 * uses) and applied to every point's `V4Quoter` call — never per point.
 * If the pool is hooked and the caller did not supply `hookData`, this
 * throws `MissingHookDataError` before any RPC, exactly as the single-
 * quote path does. When hooked and explicit `hookData` IS supplied, a
 * single `HOOK_DATA_DISCLOSURE` evidence entry is added to `spotEvidence`
 * (curve-level, not per-point — the same value applies to every point)
 * stating it is caller-supplied and not independently verified.
 *
 * **Native ETH**: `analytics.ts`'s shared `readSpotAndDecimals` (via its
 * internal `readDecimals`) resolves decimals as the protocol-defined
 * constant `18` — with NO `eth_call` at all — whenever `tokenIn`/
 * `tokenOut` is exactly the V4 native-currency zero-address sentinel.
 * This exception cannot be triggered by spoofed `LiquidityPool`
 * metadata: by the time `tokenIn`/`tokenOut` reach `readSpotAndDecimals`
 * here, they are already `resolved.tokenIn`/`tokenOut` — values derived
 * EXCLUSIVELY from the verified `poolKey.currency0`/`currency1` via
 * `resolveV4TokenDirection` above, never from caller-supplied pool
 * metadata. See `analytics.ts`'s `readDecimals` doc comment for the full
 * reasoning.
 *
 * Total `eth_call` count for a successful attempt against two ordinary
 * ERC20 currencies: `StateView.getSlot0` (1) + `decimals()` (2) +
 * `amountsIn.length` quoter calls. Against a pool with a native-ETH
 * side: `StateView.getSlot0` (1) + `decimals()` (1, for the non-native
 * side only) + `amountsIn.length` quoter calls — one fewer `eth_call`
 * than the ERC20/ERC20 case, never more.
 */
export async function quoteVerifiedUniswapV4ExactInputDepthCurve(
  input: QuoteVerifiedUniswapV4ExactInputDepthCurveInput,
): Promise<UniswapV4DepthCurve> {
  const { pool, identity, tokenIn, amountsIn, rpc, hookData: callerHookData } = input;

  const identityResolved = resolveV4Identity({ pool, identity });

  if (amountsIn.length === 0) {
    throw new EmptyAmountsLadderError();
  }
  for (const amountIn of amountsIn) {
    validateV4AmountIn(amountIn);
  }

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

  const hookEvidence: QuoteEvidence[] = hook.isHooked
    ? [
        {
          kind: "HOOK_DATA_DISCLOSURE",
          outcome: "disclosed",
          source: "poolKey.hooks",
          observed: `hooks=${resolved.poolKey.hooks} hookData=${hook.hookData}`,
          detail:
            "This pool has an active hook. hookData was explicitly supplied by the caller and applies to EVERY point in this curve — it is NOT independently verified as canonically correct for this specific hook.",
        },
      ]
    : [];

  let blockNumber: bigint;
  try {
    blockNumber = await rpc.getBlockNumber();
  } catch (error) {
    return {
      pool: identity.pool,
      family: "UNISWAP_V4",
      identityVerificationBlock: resolved.identityVerificationBlock,
      blockNumber: null,
      tokenIn: resolved.tokenIn,
      tokenOut: resolved.tokenOut,
      spotStatus: "RPC_ERROR",
      spotEvidence: [
        ...hookEvidence,
        {
          kind: "BLOCK_PIN_FAILURE",
          outcome: "rpc_error",
          source: "eth_blockNumber",
          detail: `Could not pin a block for this depth-curve attempt: ${describeError(error)}`,
        },
      ],
      points: [],
      hookDataCallerSupplied: hook.hookDataCallerSupplied || undefined,
    };
  }

  const poolId = identity.pool.pairAddress;
  const stateViewAddress = getProtocolDeploymentAddress(rpc.chainId, "UNISWAP_V4", "state_view");
  const tokenInIsToken0 = resolved.tokenIn.toLowerCase() === resolved.poolKey.currency0.toLowerCase();

  const shared = await readSpotAndDecimals({
    rpc,
    tokenIn: resolved.tokenIn,
    tokenOut: resolved.tokenOut,
    // resolved.tokenIn/tokenOut are provably poolKey.currency0/currency1
    // (resolveV4TokenDirection guarantees this) — never caller-supplied
    // pool metadata. See resolveV4Denomination's doc comment.
    tokenInDenomination: resolveV4Denomination(resolved.tokenIn),
    tokenOutDenomination: resolveV4Denomination(resolved.tokenOut),
    blockNumber,
    tokenInIsToken0,
    readSpotSqrtPriceX96: () => readV4SpotSqrtPriceX96(rpc, stateViewAddress, poolId, blockNumber),
    spotEvidenceSource: "StateView.getSlot0(poolId)",
  });

  const points = await mapWithBoundedConcurrency(amountsIn, DEPTH_CURVE_CONCURRENCY, async (amountIn) => {
    const attempt = await quoteV4AtBlock(resolved, amountIn, blockNumber, rpc);
    return buildV4DepthCurvePoint(attempt, amountIn, shared);
  });

  return {
    pool: identity.pool,
    family: "UNISWAP_V4",
    identityVerificationBlock: resolved.identityVerificationBlock,
    blockNumber,
    tokenIn: resolved.tokenIn,
    tokenOut: resolved.tokenOut,
    tokenInDecimals: shared.tokenInDecimals,
    tokenOutDecimals: shared.tokenOutDecimals,
    spotPrice: shared.spotPrice,
    spotStatus: shared.status,
    spotEvidence: [...hookEvidence, ...shared.evidence],
    points,
    hookDataCallerSupplied: hook.hookDataCallerSupplied || undefined,
  };
}

function buildV4DepthCurvePoint(attempt: V4QuoteAttemptOutcome, amountIn: bigint, shared: SharedSpotAndDecimals): UniswapV4DepthCurvePoint {
  if (
    attempt.status !== "QUOTED" ||
    attempt.amountOut === undefined ||
    shared.status !== "OK" ||
    shared.spotPrice === undefined ||
    shared.tokenInDecimals === undefined ||
    shared.tokenOutDecimals === undefined
  ) {
    return { amountIn, status: attempt.status, amountOut: attempt.amountOut, metadata: attempt.metadata, evidence: attempt.evidence };
  }
  const executionPrice = computeExecutionPrice(amountIn, attempt.amountOut, shared.tokenInDecimals, shared.tokenOutDecimals);
  const priceImpactBps = computePriceImpactBps(shared.spotPrice, executionPrice);
  return {
    amountIn,
    status: "QUOTED",
    amountOut: attempt.amountOut,
    metadata: attempt.metadata,
    executionPrice,
    priceImpactBps,
    evidence: attempt.evidence,
  };
}
