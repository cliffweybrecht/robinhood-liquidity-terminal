import { getAddress, type Address } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolIdentityVerification } from "@/domain/pool-verification";
import { getProtocolDeploymentAddress } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { decodeUint24Return, decodeV3QuoteReturn } from "./abi/decode";
import { encodeFeeCall, encodeQuoteExactInputSingleV3Call } from "./abi/selectors";
import {
  IdentityNotVerifiedError,
  InvalidAmountInError,
  InvalidTokenInError,
  MissingIdentityBlockError,
  PoolIdentityMismatchError,
  UnsupportedIdentityFamilyError,
} from "./errors";
import { callQuoter, classifyRevert, describeError } from "./read";
import type { QuoteEvidence, QuoteStatus, UniswapV3QuoteMetadata, UniswapV3QuoteVerification } from "./types";

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
 *  5. `amountIn` must be greater than zero.
 *  6. `tokenIn` must be one of the verified pool's two tokens — `tokenOut`
 *     is derived from this, never caller-supplied, and neither is `fee`
 *     or the quoter contract address.
 *
 * `fee` is not caller-suppliable and is not available as a typed field
 * anywhere in this codebase's existing identity result — Phase 6C.1's
 * identity proof only exposes it as free-form evidence text (the same
 * situation `VerifiedV4PoolKey` fixed for V4's PoolKey — see
 * `pool-verification/types.ts`). Rather than parse that evidence string,
 * or accept a caller-supplied fee (explicitly forbidden — fee must come
 * from trustworthy verified/canonical data, never an arbitrary input),
 * this function reads `pool.fee()` itself as one additional supporting
 * call, pinned to the *exact same* `quoteBlockNumber` as the quote call
 * — never a separately-pinned, potentially-drifted block. This is not a
 * Phase 6D `pool-state` read (no external `UniswapV3PoolState` object is
 * accepted or required as input, and this module does not import
 * `pool-state` at all) — it is a minimal, quote-module-owned read of
 * exactly the one fact the canonical quoter's ABI requires that isn't
 * otherwise available as trustworthy typed data.
 *
 * After preconditions, exactly one `eth_blockNumber` call pins
 * `quoteBlockNumber`; the supporting `fee()` read and the single
 * `QuoterV2.quoteExactInputSingle` call are both pinned to that same
 * block. `eth_blockNumber` is never called a second time.
 *
 * `QUOTED` requires: the `fee()` read and the quoter call to both
 * transport-succeed, the quoter's 4-word return to strictly decode, and
 * (see the module-level `amountOut === 0` reasoning below) `amountOut`
 * to be a semantically usable `uint256`. Economic quality — however
 * extreme the price movement, however many ticks crossed, however bad
 * the effective rate — never changes this: `QUOTED` reflects only
 * whether the canonical protocol simulation itself succeeded, per the
 * frozen architecture. A quoter revert is classified via
 * `abi/revert.ts`'s explicit, hand-verified allowlist into `UNQUOTABLE`
 * (a known canonical failure reason, reachable through this reader's own
 * valid precondition domain) or `INDETERMINATE` (anything else, including
 * a bare/empty revert) — see that module's doc comment. As of this
 * writing the V3 allowlist has zero entries: "AS" (`amountSpecified != 0`)
 * was considered and deliberately excluded because it is provably
 * unreachable through this reader (this function's own `amountIn <= 0`
 * precondition, above, already rejects the only input that could trigger
 * it, before any RPC call) — no other V3 revert reason has yet been
 * positively characterized as both canonical and reachable here. Every
 * V3 revert this reader can currently receive therefore resolves to
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
 */
export async function quoteVerifiedUniswapV3ExactInput(input: QuoteVerifiedUniswapV3ExactInputInput): Promise<UniswapV3QuoteVerification> {
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
  if (amountIn <= 0n) {
    throw new InvalidAmountInError(amountIn);
  }

  const baseAddress = pool.baseToken.address.toLowerCase();
  const quoteAddress = pool.quoteToken.address.toLowerCase();
  const tokenInLower = tokenIn.toLowerCase();
  if (tokenInLower !== baseAddress && tokenInLower !== quoteAddress) {
    throw new InvalidTokenInError(tokenIn);
  }
  const tokenOut: Address = tokenInLower === baseAddress ? pool.quoteToken.address : pool.baseToken.address;

  const identityVerificationBlock = identity.blockNumber;
  const pairAddress = getAddress(identity.pool.pairAddress);
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

  let fee: number;
  {
    const raw = await rpc.call({ to: pairAddress, data: encodeFeeCall() }, quoteBlockNumber).then(
      (value) => ({ outcome: "ok" as const, value }),
      (error: unknown) => ({ outcome: "rpc_error" as const, error }),
    );
    if (raw.outcome === "rpc_error") {
      evidence.push({
        kind: "FEE_READ",
        outcome: "rpc_error",
        source: "pool.fee()",
        detail: `RPC read failed: ${describeError(raw.error)}`,
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
    const decoded = decodeUint24Return(raw.value);
    if (decoded === null) {
      evidence.push({
        kind: "FEE_READ",
        outcome: "decode_error",
        source: "pool.fee()",
        detail: `Return data could not be decoded into a valid uint24 (raw: ${raw.value}).`,
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
    fee = decoded;
    evidence.push({
      kind: "FEE_READ",
      outcome: "ok",
      source: "pool.fee()",
      observed: String(fee),
      detail: "fee() decoded to a valid uint24 — used as a required QuoterV2 input, never caller-supplied.",
    });
  }

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
