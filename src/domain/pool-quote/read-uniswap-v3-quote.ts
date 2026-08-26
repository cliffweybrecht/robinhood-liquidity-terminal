import { getAddress, type Address, type Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolIdentityVerification } from "@/domain/pool-verification";
import { getProtocolDeploymentAddress } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { assembleQuoteAnalytics } from "./analytics";
import { decodeV3QuoteReturn, decodeV3Slot0SqrtPriceX96 } from "./abi/decode";
import { encodeQuoteExactInputSingleV3Call, encodeSlot0Call } from "./abi/selectors";
import {
  IdentityNotVerifiedError,
  InvalidAmountInError,
  InvalidTokenInError,
  MissingIdentityBlockError,
  MissingVerifiedV3PoolKeyError,
  PoolIdentityMismatchError,
  UnsupportedIdentityFamilyError,
} from "./errors";
import { callQuoter, classifyRevert, describeError } from "./read";
import type { QuoteEvidence, QuoteStatus, UniswapV3QuoteMetadata, UniswapV3QuoteVerification, UniswapV3QuoteWithAnalytics } from "./types";

export interface QuoteVerifiedUniswapV3ExactInputInput {
  readonly pool: LiquidityPool;
  readonly identity: PoolIdentityVerification;
  readonly tokenIn: Address;
  readonly amountIn: bigint;
  readonly rpc: VerifiedRobinhoodRpcClient;
}

/**
 * Quotes an exact-input, single-hop swap through one already
 * identity-VERIFIED Uniswap V3 pool via the canonical `QuoterV2`
 * (resolved from the shared `pool-verification` deployment registry —
 * `deployments.ts`'s `"quoter"` role). This is canonical protocol
 * simulation, not a local estimate — `QuoterV2.quoteExactInputSingle`
 * performs a real `eth_call`-simulated swap against current chain
 * state and reports exactly what the protocol itself computes.
 *
 * Preconditions are checked in order, each throwing a typed
 * `QuotePreconditionError` *before* any RPC call:
 *  1. `identity.pool` must match `pool` (same chainId/pairAddress).
 *  2. `identity.status` must be `"VERIFIED"`.
 *  3. `identity.family` must be `"UNISWAP_V3"`.
 *  4. `identity.blockNumber` must be non-null (defensive; unreachable
 *     in practice given `VERIFIED` implies a pinned block).
 *  5. `identity.v3PoolKey` must be present (defensive — unreachable in
 *     practice given `VERIFIED`/`UNISWAP_V3` always populates it, see
 *     `pool-verification/strategies/uniswap-v3.ts`). This is also the
 *     trust-boundary fix at the heart of this precondition list: `tokenIn`/
 *     `tokenOut`/`fee` are derived EXCLUSIVELY from
 *     `identity.v3PoolKey.token0`/`token1`/`fee` below — the SAME values
 *     Phase 6C.1 already independently read on-chain (`token0()`/
 *     `token1()`/`fee()`) and cryptographically confirmed via the
 *     canonical factory's `getPool(token0, token1, fee)` lookup — NEVER
 *     from the caller-supplied `pool.baseToken`/`pool.quoteToken` fields,
 *     which are only Dexscreener-reported (see `pool/types.ts`) and are
 *     NOT re-verified against `identity` beyond the `pairAddress`/
 *     `chainId` check in precondition 1. A caller could otherwise pair a
 *     genuinely `VERIFIED` identity for one pool with a `LiquidityPool`
 *     object carrying the same `pairAddress` but altered
 *     `baseToken`/`quoteToken` addresses — this precondition, and the
 *     `tokenIn` derivation below, make that structurally impossible: the
 *     quote can only ever be constructed from the independently-verified
 *     token pair, never the caller-supplied one.
 *  6. `amountIn` must be greater than zero.
 *  7. `tokenIn` must be one of `identity.v3PoolKey.token0`/`token1` —
 *     `tokenOut` and `fee` are derived from that same typed, verified
 *     fact, never caller-supplied, and never read from `pool` at all.
 *
 * `fee` is `identity.v3PoolKey.fee` — the SAME `uint24` Phase 6C.1
 * already read and proved immutable (Uniswap V3 pools have no dynamic-fee
 * mechanism; `fee()` is set once in the pool's constructor and can never
 * change). Because this is now a typed, already-proven identity fact,
 * this function performs NO supporting `fee()` read of its own — doing
 * so would only re-read a value that cannot have changed since
 * verification, at the cost of an extra `eth_call` per quote, with zero
 * additional trust gained.
 *
 * After preconditions, exactly one `eth_blockNumber` call pins
 * `quoteBlockNumber`; the single `QuoterV2.quoteExactInputSingle` call
 * is pinned to that block. `eth_blockNumber` is never called a second
 * time.
 *
 * `QUOTED` requires: the quoter call to transport-succeed, the quoter's
 * 4-word return to strictly decode, and (see the module-level
 * `amountOut === 0` reasoning below) `amountOut` to be a semantically
 * usable `uint256`. Economic quality — however extreme the price
 * movement, however many ticks crossed, however bad the effective rate —
 * never changes this: `QUOTED` reflects only whether the canonical
 * protocol simulation itself succeeded, per the frozen architecture. A
 * quoter revert is classified via `abi/revert.ts`'s explicit, hand-
 * verified allowlist into `UNQUOTABLE` (a known canonical failure
 * reason, reachable through this reader's own valid precondition domain)
 * or `INDETERMINATE` (anything else, including a bare/empty revert) —
 * see that module's doc comment. As of this writing the V3 allowlist has
 * zero entries: "AS" (`amountSpecified != 0`) was considered and
 * deliberately excluded because it is provably unreachable through this
 * reader (this function's own `amountIn <= 0` precondition, above,
 * already rejects the only input that could trigger it, before any RPC
 * call) — no other V3 revert reason has yet been positively
 * characterized as both canonical and reachable here. Every V3 revert
 * this reader can currently receive therefore resolves to
 * `INDETERMINATE`, which is the correct, evidence-honest outcome, not a
 * gap to be papered over by allowlisting something unproven.
 *
 * `amountOut === 0`: Uniswap V3 swaps round output DOWN, so an
 * extremely small `amountIn` can legitimately compute to zero output —
 * this is real, protocol-correct behavior, not a decode failure or a
 * sign of malformed data. `amountOut === 0` is therefore treated as a
 * structurally and semantically valid `QUOTED` result (a real, if
 * uninteresting, answer), never downgraded — consistent with the frozen
 * "do not invent economic rejection thresholds" rule.
 *
 * Preconditions + block pin + the single canonical
 * `QuoterV2.quoteExactInputSingle` call — extracted (Phase 6E.2) into a
 * private, unexported core so `quoteVerifiedUniswapV3ExactInputWithAnalytics`
 * can reuse it byte-for-byte rather than duplicating any precondition or
 * revert-classification logic. `quoteVerifiedUniswapV3ExactInput` below
 * is a one-line wrapper around this function. Never exported from
 * `index.ts`.
 */
async function runV3QuoteCore(input: QuoteVerifiedUniswapV3ExactInputInput): Promise<UniswapV3QuoteVerification> {
  const { pool, identity, tokenIn, amountIn, rpc } = input;

  if (identity.pool.chainId !== pool.chainId || identity.pool.pairAddress.toLowerCase() !== pool.pairAddress.toLowerCase()) {
    throw new PoolIdentityMismatchError(pool.pairAddress, identity.pool.pairAddress);
  }
  if (identity.status !== "VERIFIED") {
    throw new IdentityNotVerifiedError(identity.status);
  }
  if (identity.family !== "UNISWAP_V3") {
    throw new UnsupportedIdentityFamilyError(identity.family, "UNISWAP_V3");
  }
  if (identity.blockNumber === null) {
    throw new MissingIdentityBlockError();
  }
  const v3PoolKey = identity.v3PoolKey;
  if (v3PoolKey === null || v3PoolKey === undefined) {
    throw new MissingVerifiedV3PoolKeyError();
  }
  if (amountIn <= 0n) {
    throw new InvalidAmountInError(amountIn);
  }

  const token0Lower = v3PoolKey.token0.toLowerCase();
  const token1Lower = v3PoolKey.token1.toLowerCase();
  const tokenInLower = tokenIn.toLowerCase();
  if (tokenInLower !== token0Lower && tokenInLower !== token1Lower) {
    throw new InvalidTokenInError(tokenIn);
  }
  const tokenOut: Address = tokenInLower === token0Lower ? v3PoolKey.token1 : v3PoolKey.token0;
  const fee = v3PoolKey.fee;

  const identityVerificationBlock = identity.blockNumber;
  const quoterAddress = getProtocolDeploymentAddress(rpc.chainId, "UNISWAP_V3", "quoter");

  let quoteBlockNumber: bigint;
  try {
    quoteBlockNumber = await rpc.getBlockNumber();
  } catch (error) {
    return buildResult({
      pool: identity.pool,
      identityVerificationBlock,
      quoteBlockNumber: null,
      tokenIn,
      tokenOut,
      amountIn,
      status: "RPC_ERROR",
      evidence: [
        {
          kind: "BLOCK_PIN_FAILURE",
          outcome: "rpc_error",
          source: "eth_blockNumber",
          detail: `Could not pin a block for this quote attempt: ${describeError(error)}`,
        },
      ],
    });
  }

  const evidence: QuoteEvidence[] = [];

  const quoteData = encodeQuoteExactInputSingleV3Call(tokenIn, tokenOut, amountIn, fee);
  const outcome = await callQuoter(rpc, quoterAddress, quoteData, quoteBlockNumber);

  if (outcome.kind === "rpc_error") {
    evidence.push({
      kind: "QUOTE_CALL",
      outcome: "rpc_error",
      source: "QuoterV2.quoteExactInputSingle(...)",
      detail: `RPC call failed: ${outcome.detail}`,
    });
    return buildResult({
      pool: identity.pool,
      identityVerificationBlock,
      quoteBlockNumber,
      tokenIn,
      tokenOut,
      amountIn,
      status: "RPC_ERROR",
      evidence,
    });
  }

  if (outcome.kind === "revert") {
    const classification = classifyRevert("UNISWAP_V3", outcome.data);
    evidence.push({
      kind: "QUOTE_CALL",
      outcome: classification.outcome === "unquotable" ? "unquotable" : "decode_error",
      source: "QuoterV2.quoteExactInputSingle(...)",
      detail: classification.reason,
    });
    return buildResult({
      pool: identity.pool,
      identityVerificationBlock,
      quoteBlockNumber,
      tokenIn,
      tokenOut,
      amountIn,
      status: classification.outcome === "unquotable" ? "UNQUOTABLE" : "INDETERMINATE",
      evidence,
    });
  }

  const decoded = decodeV3QuoteReturn(outcome.raw);
  if (decoded === null) {
    evidence.push({
      kind: "QUOTE_CALL",
      outcome: "decode_error",
      source: "QuoterV2.quoteExactInputSingle(...)",
      detail: `Return data could not be decoded into a valid 4-word quote tuple (raw: ${outcome.raw}).`,
    });
    return buildResult({
      pool: identity.pool,
      identityVerificationBlock,
      quoteBlockNumber,
      tokenIn,
      tokenOut,
      amountIn,
      status: "INDETERMINATE",
      evidence,
    });
  }

  evidence.push({
    kind: "QUOTE_CALL",
    outcome: "ok",
    source: "QuoterV2.quoteExactInputSingle(...)",
    observed: `amountOut=${decoded.amountOut} sqrtPriceX96After=${decoded.sqrtPriceX96After} initializedTicksCrossed=${decoded.initializedTicksCrossed} gasEstimate=${decoded.gasEstimate}`,
    detail:
      "quoteExactInputSingle() decoded to a fully valid 4-word tuple. Economic quality (price movement, ticks crossed) does not affect this outcome.",
  });

  const metadata: UniswapV3QuoteMetadata = {
    sqrtPriceX96After: decoded.sqrtPriceX96After,
    initializedTicksCrossed: decoded.initializedTicksCrossed,
    gasEstimate: decoded.gasEstimate,
  };

  return buildResult({
    pool: identity.pool,
    identityVerificationBlock,
    quoteBlockNumber,
    tokenIn,
    tokenOut,
    amountIn,
    status: "QUOTED",
    evidence,
    amountOut: decoded.amountOut,
    metadata,
  });
}

/** See the module doc comment above `runV3QuoteCore` — this is an unchanged, behavior-preserving wrapper around it. */
export async function quoteVerifiedUniswapV3ExactInput(input: QuoteVerifiedUniswapV3ExactInputInput): Promise<UniswapV3QuoteVerification> {
  return runV3QuoteCore(input);
}

/**
 * Phase 6E.2 — same-block execution analytics for an exact-input quote
 * through one already identity-VERIFIED Uniswap V3 pool. Runs the exact
 * same `runV3QuoteCore` as `quoteVerifiedUniswapV3ExactInput` (identical
 * preconditions, identical single `eth_blockNumber` pin, identical
 * `fee()`/`QuoterV2` calls) and, ONLY when that core result is `QUOTED`,
 * additionally reads `pool.slot0()` (pre-trade spot) and `decimals()`
 * for both `tokenIn`/`tokenOut` — all three pinned to the EXACT SAME
 * `quoteBlockNumber` the core already established, via the already-
 * returned result's own fields (`result.tokenIn`/`tokenOut`/`amountIn`/
 * `amountOut`/`quoteBlockNumber`/`pool.pairAddress`). No second
 * `eth_blockNumber` call is ever made — see `assembleQuoteAnalytics` in
 * `./analytics.ts` for the shared math/orchestration.
 *
 * A non-`QUOTED` core result (including `RPC_ERROR`/`UNQUOTABLE`/
 * `INDETERMINATE`) is returned completely unchanged, with no `analytics`
 * field at all — there is no execution price to pair a spot reference
 * with, and a valid `QUOTED` result is never downgraded because
 * analytics could not be computed (the reverse also holds: analytics
 * never rescues/upgrades a non-`QUOTED` result).
 */
export async function quoteVerifiedUniswapV3ExactInputWithAnalytics(
  input: QuoteVerifiedUniswapV3ExactInputInput,
): Promise<UniswapV3QuoteWithAnalytics> {
  const result = await runV3QuoteCore(input);
  if (result.status !== "QUOTED" || result.quoteBlockNumber === null || result.amountOut === undefined) {
    return result;
  }

  const pairAddress = getAddress(result.pool.pairAddress);
  const blockNumber = result.quoteBlockNumber;

  const analytics = await assembleQuoteAnalytics({
    rpc: input.rpc,
    tokenIn: result.tokenIn,
    tokenOut: result.tokenOut,
    blockNumber,
    tokenInIsToken0: result.tokenIn.toLowerCase() < result.tokenOut.toLowerCase(),
    amountIn: result.amountIn,
    amountOut: result.amountOut,
    readSpotSqrtPriceX96: () => readV3SpotSqrtPriceX96(input.rpc, pairAddress, blockNumber),
    spotEvidenceSource: "pool.slot0()",
  });

  return { ...result, analytics };
}

async function readV3SpotSqrtPriceX96(
  rpc: VerifiedRobinhoodRpcClient,
  pairAddress: Address,
  blockNumber: bigint,
): Promise<{ readonly outcome: "ok"; readonly value: bigint } | { readonly outcome: "rpc_error"; readonly detail: string } | { readonly outcome: "decode_error"; readonly detail: string }> {
  let raw: Hex;
  try {
    raw = await rpc.call({ to: pairAddress, data: encodeSlot0Call() }, blockNumber);
  } catch (error) {
    return { outcome: "rpc_error", detail: describeError(error) };
  }
  const sqrtPriceX96 = decodeV3Slot0SqrtPriceX96(raw);
  if (sqrtPriceX96 === null) {
    return { outcome: "decode_error", detail: `slot0() return data could not be decoded into a valid 7-word tuple (raw: ${raw}).` };
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
  status: QuoteStatus;
  evidence: readonly QuoteEvidence[];
  amountOut?: bigint;
  metadata?: UniswapV3QuoteMetadata;
}): UniswapV3QuoteVerification {
  return {
    pool: args.pool,
    family: "UNISWAP_V3",
    status: args.status,
    identityVerificationBlock: args.identityVerificationBlock,
    quoteBlockNumber: args.quoteBlockNumber,
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    amountIn: args.amountIn,
    amountOut: args.amountOut,
    metadata: args.metadata,
    evidence: args.evidence,
  };
}
