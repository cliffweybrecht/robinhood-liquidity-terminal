import { getAddress } from "viem";
import { getPairIdentifierShape } from "@/domain/pool";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolIdentityVerification } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { encodeFeeCall, encodeLiquidityCall, encodeSlot0Call, encodeTickSpacingCall } from "./abi/selectors";
import {
  IdentityNotVerifiedError,
  MissingIdentityBlockError,
  PoolIdentityMismatchError,
  UnexpectedPoolStateIdentifierShapeError,
  UnsupportedIdentityFamilyError,
} from "./errors";
import { describeError, readFee, readLiquidity, readSlot0, readTickSpacing, type ReadResult } from "./read";
import type { PoolStateEvidence, PoolStateStatus, PoolStateVerification, UniswapV3PoolState } from "./types";

export interface ReadVerifiedUniswapV3PoolStateInput {
  readonly pool: LiquidityPool;
  readonly identity: PoolIdentityVerification;
  readonly rpc: VerifiedRobinhoodRpcClient;
}

function failureEvidence(
  kind: PoolStateEvidence["kind"],
  source: string,
  result: ReadResult<unknown> & { outcome: "rpc_error" | "decode_error" },
): PoolStateEvidence {
  if (result.outcome === "rpc_error") {
    return { kind, outcome: "rpc_error", source, detail: `RPC read failed: ${describeError(result.error)}` };
  }
  return { kind, outcome: "decode_error", source, detail: `Return data could not be decoded into a valid value (raw: ${result.raw}).` };
}

/**
 * Reads, decodes, and validates one Uniswap V3 pool's **current** AMM
 * state at a single freshly-pinned block. This is state reading, not
 * identity verification — see `pool-verification/verify.ts` for that —
 * and the two are deliberately kept as independent trust boundaries:
 * this module never re-derives or re-checks pool *identity* (token
 * pair, canonical asset, factory provenance), it only trusts an
 * already-`VERIFIED` `PoolIdentityVerification` supplied by the caller.
 * Conversely, `pool-verification` has no notion of *current* state —
 * neither module imports the other's read/decode/strategy internals.
 *
 * Preconditions are checked in order, each throwing a typed
 * `PoolStateError` *before* any protocol RPC call — a precondition
 * failure is a caller-usage/trust-boundary problem, never a per-pool
 * epistemic outcome (same policy `pool-verification` uses for its own
 * `PoolClassificationMismatchError`/`UnexpectedIdentifierShapeError`):
 *
 *  1. `identity.pool` must match `pool` (same chainId/pairAddress).
 *  2. `identity.status` must be `"VERIFIED"`.
 *  3. `identity.family` must be `"UNISWAP_V3"` — this module has no V4
 *     (or other) reader; a future generic dispatcher (mirroring
 *     `verifyPoolIdentity`) belongs in a later phase once a V4 state
 *     reader actually exists, not as a speculative branch here.
 *  4. `identity.blockNumber` must be non-null (defensive; unreachable
 *     in practice given `VERIFIED` implies a pinned block).
 *  5. `identity.pool.pairAddress` must be a 20-byte address (defensive
 *     re-check, not a trust assumption on `identity.family`'s implied
 *     shape) — guarantees this module can never pass a bytes32 PoolId
 *     into an address-only RPC field.
 *
 * Once preconditions pass, exactly one NEW block is pinned via
 * `getBlockNumber()` — never `identity.blockNumber`, which may be
 * arbitrarily old — and `slot0()`/`liquidity()`/`fee()`/`tickSpacing()`
 * are all read at that one pinned block. `VERIFIED` requires all four
 * to both transport-succeed and strictly decode; any transport failure
 * yields `RPC_ERROR`, any decode failure (with no transport failure)
 * yields `INDETERMINATE` — see `types.ts` for why there is no
 * `CONTRADICTED`/`UNSUPPORTED` in this module's status model.
 */
export async function readVerifiedUniswapV3PoolState(input: ReadVerifiedUniswapV3PoolStateInput): Promise<PoolStateVerification> {
  const { pool, identity, rpc } = input;

  if (identity.pool.chainId !== pool.chainId || identity.pool.pairAddress.toLowerCase() !== pool.pairAddress.toLowerCase()) {
    throw new PoolIdentityMismatchError(pool.pairAddress, identity.pool.pairAddress);
  }
  if (identity.status !== "VERIFIED") {
    throw new IdentityNotVerifiedError(identity.status);
  }
  if (identity.family !== "UNISWAP_V3") {
    throw new UnsupportedIdentityFamilyError(identity.family);
  }
  if (identity.blockNumber === null) {
    throw new MissingIdentityBlockError();
  }
  if (getPairIdentifierShape(identity.pool.pairAddress) !== "ADDRESS_20_BYTE") {
    throw new UnexpectedPoolStateIdentifierShapeError(identity.pool.pairAddress);
  }

  const pairAddress = getAddress(identity.pool.pairAddress);
  const identityVerificationBlock = identity.blockNumber;

  let stateBlockNumber: bigint;
  try {
    stateBlockNumber = await rpc.getBlockNumber();
  } catch (error) {
    return {
      pool: identity.pool,
      family: "UNISWAP_V3",
      status: "RPC_ERROR",
      identityVerificationBlock,
      stateBlockNumber: null,
      evidence: [
        {
          kind: "BLOCK_PIN_FAILURE",
          outcome: "rpc_error",
          source: "eth_blockNumber",
          detail: `Could not pin a block for this state read: ${describeError(error)}`,
        },
      ],
    };
  }

  const [slot0Result, liquidityResult, feeResult, tickSpacingResult] = await Promise.all([
    readSlot0(rpc, pairAddress, encodeSlot0Call(), stateBlockNumber),
    readLiquidity(rpc, pairAddress, encodeLiquidityCall(), stateBlockNumber),
    readFee(rpc, pairAddress, encodeFeeCall(), stateBlockNumber),
    readTickSpacing(rpc, pairAddress, encodeTickSpacingCall(), stateBlockNumber),
  ]);

  const evidence: PoolStateEvidence[] = [];
  let hadRpcError = false;
  let hadDecodeError = false;

  if (slot0Result.outcome === "ok") {
    evidence.push({
      kind: "SLOT0_READ",
      outcome: "ok",
      source: "pool.slot0()",
      observed: `sqrtPriceX96=${slot0Result.value.sqrtPriceX96} tick=${slot0Result.value.tick}`,
      detail: "slot0() decoded to a fully valid 7-word tuple.",
    });
  } else {
    evidence.push(failureEvidence("SLOT0_READ", "pool.slot0()", slot0Result));
    hadRpcError ||= slot0Result.outcome === "rpc_error";
    hadDecodeError ||= slot0Result.outcome === "decode_error";
  }

  if (liquidityResult.outcome === "ok") {
    evidence.push({
      kind: "ACTIVE_LIQUIDITY_READ",
      outcome: "ok",
      source: "pool.liquidity()",
      observed: String(liquidityResult.value),
      detail: "liquidity() decoded to a valid uint128 — the pool's active in-range concentrated liquidity, not total/executable liquidity.",
    });
  } else {
    evidence.push(failureEvidence("ACTIVE_LIQUIDITY_READ", "pool.liquidity()", liquidityResult));
    hadRpcError ||= liquidityResult.outcome === "rpc_error";
    hadDecodeError ||= liquidityResult.outcome === "decode_error";
  }

  if (feeResult.outcome === "ok") {
    evidence.push({
      kind: "FEE_READ",
      outcome: "ok",
      source: "pool.fee()",
      observed: String(feeResult.value),
      detail: "fee() decoded to a valid uint24.",
    });
  } else {
    evidence.push(failureEvidence("FEE_READ", "pool.fee()", feeResult));
    hadRpcError ||= feeResult.outcome === "rpc_error";
    hadDecodeError ||= feeResult.outcome === "decode_error";
  }

  if (tickSpacingResult.outcome === "ok") {
    evidence.push({
      kind: "TICK_SPACING_READ",
      outcome: "ok",
      source: "pool.tickSpacing()",
      observed: String(tickSpacingResult.value),
      detail: "tickSpacing() decoded to a valid int24.",
    });
  } else {
    evidence.push(failureEvidence("TICK_SPACING_READ", "pool.tickSpacing()", tickSpacingResult));
    hadRpcError ||= tickSpacingResult.outcome === "rpc_error";
    hadDecodeError ||= tickSpacingResult.outcome === "decode_error";
  }

  const status: PoolStateStatus = hadRpcError ? "RPC_ERROR" : hadDecodeError ? "INDETERMINATE" : "VERIFIED";

  const state: UniswapV3PoolState | undefined =
    slot0Result.outcome === "ok" && liquidityResult.outcome === "ok" && feeResult.outcome === "ok" && tickSpacingResult.outcome === "ok"
      ? {
          sqrtPriceX96: slot0Result.value.sqrtPriceX96,
          tick: slot0Result.value.tick,
          activeLiquidity: liquidityResult.value,
          fee: feeResult.value,
          tickSpacing: tickSpacingResult.value,
        }
      : undefined;

  return {
    pool: identity.pool,
    family: "UNISWAP_V3",
    status,
    identityVerificationBlock,
    stateBlockNumber,
    state,
    evidence,
  };
}
