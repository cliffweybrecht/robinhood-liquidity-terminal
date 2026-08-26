import type { Address } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import { getProtocolDeploymentAddress, type PoolIdentityVerification } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { computeExecutionPrice, computePriceImpactBps, readSpotAndDecimals, type SharedSpotAndDecimals } from "./analytics";
import { mapWithBoundedConcurrency } from "./depth-math";
import { EmptyAmountsLadderError, InvalidAmountInError } from "./errors";
import { describeError } from "./read";
import {
  quoteV3AtBlock,
  readV3SpotSqrtPriceX96,
  resolveV3Identity,
  resolveV3TokenDirection,
  type V3QuoteAttemptOutcome,
  type V3ResolvedQuoteInputs,
} from "./read-uniswap-v3-quote";
import type { UniswapV3DepthCurve, UniswapV3DepthCurvePoint } from "./types";

/**
 * Bounded concurrency cap for ladder quoter calls — see `depth-math.ts`'s
 * `mapWithBoundedConcurrency` doc comment for why this exists at all: an
 * unbounded `Promise.all` over a caller-controlled `amountsIn.length`
 * would fire an unbounded number of simultaneous `eth_call`s. Fixed and
 * documented rather than caller-configurable, matching this module's
 * established "no unnecessary knobs" convention. The shared spot +
 * decimals read (2-3 calls) is small and fixed-size, so it is fired via
 * plain `Promise.all` as `analytics.ts` already established — only the
 * potentially-large ladder is bounded.
 */
export const DEPTH_CURVE_CONCURRENCY = 5;

export interface QuoteVerifiedUniswapV3ExactInputDepthCurveInput {
  readonly pool: LiquidityPool;
  readonly identity: PoolIdentityVerification;
  readonly tokenIn: Address;
  /**
   * The requested trade-size samples, in caller order. NOT assumed
   * sorted, NOT silently sorted (a caller-supplied ordering is preserved
   * exactly — this curve represents requested samples, not an inferred
   * continuous function), and NOT deduplicated. Every entry becomes
   * exactly one independent point in the returned `points` array, at
   * the same index it was requested at. Duplicate values are
   * deterministically supported (each occurrence gets its own
   * independent, identically-computed point) rather than rejected —
   * there is no correctness reason to reject a repeated size, and
   * rejecting would add complexity for no benefit (e.g. a caller
   * checking result stability, or a mechanically-generated ladder that
   * was not pre-deduplicated).
   */
  readonly amountsIn: readonly bigint[];
  readonly rpc: VerifiedRobinhoodRpcClient;
}

/**
 * Phase 6F.1 — a same-block executable-depth curve for one already
 * identity-VERIFIED Uniswap V3 pool across a caller-supplied ladder of
 * exact-input `amountIn` samples, via the canonical `QuoterV2`.
 *
 * Trust model, matching `quoteVerifiedUniswapV3ExactInput` exactly, just
 * applied once per curve instead of once per call:
 *  - Preconditions 1-5 (pool/identity match, VERIFIED, UNISWAP_V3
 *    family, non-null identity block, `v3PoolKey` present) are resolved
 *    exactly once via `resolveV3Identity` — the SAME shared function the
 *    single-quote path uses, so this can never diverge from it.
 *  - Ladder validation (this phase's own precondition, before any RPC):
 *    `amountsIn` must have at least one entry (`EmptyAmountsLadderError`
 *    otherwise), and every entry must be `> 0n` (`InvalidAmountInError`
 *    on the first offending entry otherwise) — checked BEFORE `tokenIn`
 *    direction resolution and BEFORE any RPC call, mirroring the
 *    single-quote path's own precondition ordering as closely as a
 *    whole-ladder check can.
 *  - `tokenIn` direction (`resolveV3TokenDirection`) — the SAME shared
 *    function, deriving `tokenOut`/`fee` EXCLUSIVELY from the verified
 *    `v3PoolKey`, never from caller-supplied `pool.baseToken`/
 *    `quoteToken` metadata. A spoofed `LiquidityPool` object (genuine
 *    `pairAddress`, altered token fields) cannot redirect this curve's
 *    quotes for the exact same structural reason it cannot redirect a
 *    single quote — see that function's own doc comment.
 *  - Exactly ONE `eth_blockNumber` call pins `blockNumber` for the
 *    ENTIRE curve — never per point, never re-pinned. If this fails,
 *    `blockNumber` is `null`, `spotStatus` is `"RPC_ERROR"`, and `points`
 *    is empty (nothing could be attempted without a pinned block).
 *  - The shared pre-trade spot (`pool.slot0()`) and both `decimals()`
 *    reads are performed EXACTLY ONCE, via `analytics.ts`'s
 *    `readSpotAndDecimals` (the same function
 *    `quoteVerifiedUniswapV3ExactInputWithAnalytics` uses for its own
 *    single point), at the identical pinned `blockNumber`.
 *  - Then exactly N canonical `QuoterV2.quoteExactInputSingle` calls
 *    (one per `amountsIn` entry), all at that SAME `blockNumber`, via
 *    `quoteV3AtBlock` — the exact same per-`amountIn` primitive
 *    `quoteVerifiedUniswapV3ExactInput` uses for its own one call.
 *    Fired with bounded concurrency (`DEPTH_CURVE_CONCURRENCY`), never
 *    unbounded — see `mapWithBoundedConcurrency`. Output order always
 *    matches `amountsIn`'s order, regardless of which call actually
 *    completes first.
 *
 * Total `eth_call` count for a successful attempt: `slot0()` (1) +
 * `decimals()` (2) + `amountsIn.length` quoter calls — no `fee()` read
 * (fee is `identity.v3PoolKey.fee`, exactly as in the single-quote
 * path).
 *
 * Each point is fully independent: one point's `INDETERMINATE`/
 * `UNQUOTABLE`/`RPC_ERROR` never affects any other point, and sampling
 * NEVER stops early — every requested size is always attempted. See
 * `UniswapV3DepthCurvePoint`'s doc comment for exactly what each point
 * means, and `depth-math.ts`'s `largestQuotedSample`/`sampledDepthAtBps`
 * for the honest, sampled-not-continuous derived summaries built on top
 * of this curve.
 *
 * A shared spot/decimals read failure (`spotStatus !== "OK"`) NEVER
 * blanks out a point's own `status`/`amountOut` — those come exclusively
 * from that point's own canonical quoter `eth_call`. It only means
 * `executionPrice`/`priceImpactBps` are unavailable on every point (there
 * is no spot reference to compute them against) — Phase 6E.2's "a valid
 * QUOTED result is never downgraded because analytics failed" principle,
 * applied at curve granularity.
 */
export async function quoteVerifiedUniswapV3ExactInputDepthCurve(
  input: QuoteVerifiedUniswapV3ExactInputDepthCurveInput,
): Promise<UniswapV3DepthCurve> {
  const { pool, identity, tokenIn, amountsIn, rpc } = input;

  const identityResolved = resolveV3Identity({ pool, identity });

  if (amountsIn.length === 0) {
    throw new EmptyAmountsLadderError();
  }
  for (const amountIn of amountsIn) {
    if (amountIn <= 0n) {
      throw new InvalidAmountInError(amountIn);
    }
  }

  const direction = resolveV3TokenDirection(identityResolved.v3PoolKey, tokenIn);

  const resolved: V3ResolvedQuoteInputs = {
    identityVerificationBlock: identityResolved.identityVerificationBlock,
    pairAddress: identityResolved.pairAddress,
    quoterAddress: getProtocolDeploymentAddress(rpc.chainId, "UNISWAP_V3", "quoter"),
    tokenIn: direction.tokenIn,
    tokenOut: direction.tokenOut,
    fee: direction.fee,
  };

  let blockNumber: bigint;
  try {
    blockNumber = await rpc.getBlockNumber();
  } catch (error) {
    return {
      pool: identity.pool,
      family: "UNISWAP_V3",
      identityVerificationBlock: resolved.identityVerificationBlock,
      blockNumber: null,
      tokenIn: resolved.tokenIn,
      tokenOut: resolved.tokenOut,
      spotStatus: "RPC_ERROR",
      spotEvidence: [
        {
          kind: "BLOCK_PIN_FAILURE",
          outcome: "rpc_error",
          source: "eth_blockNumber",
          detail: `Could not pin a block for this depth-curve attempt: ${describeError(error)}`,
        },
      ],
      points: [],
    };
  }

  const tokenInIsToken0 = resolved.tokenIn.toLowerCase() < resolved.tokenOut.toLowerCase();
  const shared = await readSpotAndDecimals({
    rpc,
    tokenIn: resolved.tokenIn,
    tokenOut: resolved.tokenOut,
    // V3 never has a native-currency side — always ERC20. See
    // analytics.ts's TokenDenomination doc comment.
    tokenInDenomination: { kind: "ERC20", address: resolved.tokenIn },
    tokenOutDenomination: { kind: "ERC20", address: resolved.tokenOut },
    blockNumber,
    tokenInIsToken0,
    readSpotSqrtPriceX96: () => readV3SpotSqrtPriceX96(rpc, resolved.pairAddress, blockNumber),
    spotEvidenceSource: "pool.slot0()",
  });

  const points = await mapWithBoundedConcurrency(amountsIn, DEPTH_CURVE_CONCURRENCY, async (amountIn) => {
    const attempt = await quoteV3AtBlock(resolved, amountIn, blockNumber, rpc);
    return buildV3DepthCurvePoint(attempt, amountIn, shared);
  });

  return {
    pool: identity.pool,
    family: "UNISWAP_V3",
    identityVerificationBlock: resolved.identityVerificationBlock,
    blockNumber,
    tokenIn: resolved.tokenIn,
    tokenOut: resolved.tokenOut,
    tokenInDecimals: shared.tokenInDecimals,
    tokenOutDecimals: shared.tokenOutDecimals,
    spotPrice: shared.spotPrice,
    spotStatus: shared.status,
    spotEvidence: shared.evidence,
    points,
  };
}

function buildV3DepthCurvePoint(attempt: V3QuoteAttemptOutcome, amountIn: bigint, shared: SharedSpotAndDecimals): UniswapV3DepthCurvePoint {
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
