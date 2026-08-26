import { getPairIdentifierShape } from "@/domain/pool";
import type { LiquidityPool } from "@/domain/pool";
import { getProtocolDeploymentAddress } from "@/domain/pool-verification";
import type { PoolIdentityVerification } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import type { Slot0V4Tuple } from "./abi/decode";
import { encodeGetLiquidityCall, encodeGetSlot0Call } from "./abi/selectors";
import {
  IdentityNotVerifiedError,
  MissingIdentityBlockError,
  PoolIdentityMismatchError,
  UnexpectedPoolStateIdentifierShapeError,
  UnsupportedIdentityFamilyError,
} from "./errors";
import { describeError, readLiquidity, readSlot0V4, type ReadResult } from "./read";
import type { PoolStateEvidence, PoolStateStatus, UniswapV4PoolState, UniswapV4PoolStateVerification } from "./types";

export interface ReadVerifiedUniswapV4PoolStateInput {
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
 * Reads, decodes, and validates one Uniswap V4 pool's **current** AMM
 * state at a single freshly-pinned block, through the canonical
 * `StateView` periphery contract (resolved from the shared
 * `pool-verification` deployment registry — see `deployments.ts`'s
 * `"state_view"` role). This is state reading, not identity
 * verification — see `pool-verification/verify.ts` for that — and the
 * two are deliberately kept as independent trust boundaries, the same
 * policy `read-uniswap-v3-state.ts` documents: this module never
 * re-derives or re-checks pool *identity* (currency pair, canonical
 * asset, `Initialize` provenance), it only trusts an already-`VERIFIED`
 * `PoolIdentityVerification` supplied by the caller.
 *
 * V4 pools have no per-pool contract (Uniswap V4 is a singleton
 * `PoolManager` design) — state is read through `StateView`, a
 * PoolManager-bound lens contract, keyed by `PoolId` (bytes32), never
 * an address. `StateView`'s own `poolManager()` immutable binding to
 * the canonical Robinhood Chain PoolManager was verified once, off-chain,
 * at deployment-registry configuration time (see `deployments.ts`'s
 * `state_view` entry provenance) — re-verifying that binding on every
 * state read would be redundant, since it is constructor-set and can
 * never change.
 *
 * Preconditions are checked in order, each throwing a typed
 * `PoolStateError` *before* any protocol RPC call — identical shape to
 * `readVerifiedUniswapV3PoolState`'s five checks, with `"ID_32_BYTE"` in
 * place of `"ADDRESS_20_BYTE"`:
 *
 *  1. `identity.pool` must match `pool` (same chainId/pairAddress).
 *  2. `identity.status` must be `"VERIFIED"`.
 *  3. `identity.family` must be `"UNISWAP_V4"` — this module has no V3
 *     (or other) reader; see `read-uniswap-v3-state.ts` for that.
 *  4. `identity.blockNumber` must be non-null (defensive; unreachable
 *     in practice given `VERIFIED` implies a pinned block).
 *  5. `identity.pool.pairAddress` must be a 32-byte PoolId (defensive
 *     re-check) — guarantees this module never passes a `PoolId` into
 *     an address-only RPC field; it is only ever ABI-encoded as
 *     `getSlot0`/`getLiquidity` call *data*, never a `to`.
 *
 * Once preconditions pass, exactly one NEW block is pinned via
 * `getBlockNumber()` — never `identity.blockNumber` — and
 * `getSlot0(poolId)`/`getLiquidity(poolId)` are both read at that one
 * pinned block, concurrently, regardless of whether one fails (same
 * "no artificial short-circuiting for independent reads" policy V3
 * uses). `VERIFIED` requires both to transport-succeed, strictly
 * decode, AND (for `getSlot0`) pass three semantic invariant checks —
 * see `slot0SemanticIssue` below:
 *
 *  1. `sqrtPriceX96 !== 0`. An already-identity-VERIFIED pool has a
 *     proven real `Initialize` event and can never have a zero starting
 *     price.
 *  2. `lpFee <= 1_000_000` (Uniswap V4's own `LPFeeLibrary.MAX_LP_FEE`).
 *     `lpFee` is the pool's *current stored* LP fee — **not** a
 *     guarantee of what an individual swap will actually pay: a
 *     dynamic-fee pool's `beforeSwap` hook may supply a valid per-swap
 *     fee override that differs from this stored value at execution
 *     time. Accounting for hook-overridden execution fees is an
 *     executable-quoting-phase concern, out of scope here — this check
 *     only validates that the *stored* value itself is a canonically
 *     possible one.
 *  3. `protocolFee`'s two packed 12-bit directional components (low
 *     bits = zero-for-one, high bits = one-for-zero — see
 *     `UniswapV4PoolState`'s doc comment) must each be
 *     `<= 1000` (Uniswap V4's own `ProtocolFeeLibrary.MAX_PROTOCOL_FEE`).
 *
 * `StateView.getSlot0`/`getLiquidity` never revert for a nonexistent
 * PoolId (they read raw packed storage), so these semantic checks are
 * the only available signal that something is wrong despite a
 * structurally clean ABI decode. Any failure resolves to `INDETERMINATE`,
 * not `CONTRADICTED`: this module does not declare *which* upstream
 * trusted proposition was contradicted, only that the observed state
 * cannot be trusted as usable current state — see `types.ts` for the
 * full status model and why `CONTRADICTED` does not exist here.
 */
const MAX_LP_FEE = 1_000_000; // LPFeeLibrary.MAX_LP_FEE
const MAX_PROTOCOL_FEE_COMPONENT = 1000; // ProtocolFeeLibrary.MAX_PROTOCOL_FEE
const PROTOCOL_FEE_COMPONENT_MASK = 0xfff;
const PROTOCOL_FEE_COMPONENT_SHIFT = 12;

/**
 * Checks the three canonical V4 semantic invariants a structurally
 * decoded `getSlot0` tuple must satisfy to be trusted as usable current
 * state. Returns a human-readable description of the first violation
 * found, or `null` if all three hold.
 */
function slot0SemanticIssue(value: Slot0V4Tuple): string | null {
  if (value.sqrtPriceX96 === 0n) {
    return "sqrtPriceX96 is zero — an already-identity-VERIFIED pool can never report a zero price";
  }
  if (value.lpFee > MAX_LP_FEE) {
    return `lpFee (${value.lpFee}) exceeds Uniswap V4's MAX_LP_FEE (${MAX_LP_FEE}) — not a canonically valid stored LP fee`;
  }
  const zeroForOneFee = value.protocolFee & PROTOCOL_FEE_COMPONENT_MASK;
  const oneForZeroFee = value.protocolFee >> PROTOCOL_FEE_COMPONENT_SHIFT;
  if (zeroForOneFee > MAX_PROTOCOL_FEE_COMPONENT) {
    return `protocolFee's zero-for-one component (${zeroForOneFee}, packed in protocolFee=${value.protocolFee}) exceeds Uniswap V4's MAX_PROTOCOL_FEE (${MAX_PROTOCOL_FEE_COMPONENT})`;
  }
  if (oneForZeroFee > MAX_PROTOCOL_FEE_COMPONENT) {
    return `protocolFee's one-for-zero component (${oneForZeroFee}, packed in protocolFee=${value.protocolFee}) exceeds Uniswap V4's MAX_PROTOCOL_FEE (${MAX_PROTOCOL_FEE_COMPONENT})`;
  }
  return null;
}
export async function readVerifiedUniswapV4PoolState(input: ReadVerifiedUniswapV4PoolStateInput): Promise<UniswapV4PoolStateVerification> {
  const { pool, identity, rpc } = input;

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
  if (getPairIdentifierShape(identity.pool.pairAddress) !== "ID_32_BYTE") {
    throw new UnexpectedPoolStateIdentifierShapeError(identity.pool.pairAddress, "a 32-byte PoolId");
  }

  const poolId = identity.pool.pairAddress;
  const identityVerificationBlock = identity.blockNumber;
  const stateViewAddress = getProtocolDeploymentAddress(rpc.chainId, "UNISWAP_V4", "state_view");

  let stateBlockNumber: bigint;
  try {
    stateBlockNumber = await rpc.getBlockNumber();
  } catch (error) {
    return {
      pool: identity.pool,
      family: "UNISWAP_V4",
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

  const [slot0Result, liquidityResult] = await Promise.all([
    readSlot0V4(rpc, stateViewAddress, encodeGetSlot0Call(poolId), stateBlockNumber),
    readLiquidity(rpc, stateViewAddress, encodeGetLiquidityCall(poolId), stateBlockNumber),
  ]);

  const evidence: PoolStateEvidence[] = [];
  let hadRpcError = false;
  let hadIndeterminate = false;
  let slot0: Slot0V4Tuple | undefined;

  if (slot0Result.outcome === "ok") {
    const value = slot0Result.value;
    const semanticIssue = slot0SemanticIssue(value);
    if (semanticIssue !== null) {
      hadIndeterminate = true;
      evidence.push({
        kind: "SLOT0_V4_READ",
        outcome: "semantic_error",
        source: "StateView.getSlot0(poolId)",
        observed: `sqrtPriceX96=${value.sqrtPriceX96} tick=${value.tick} protocolFee=${value.protocolFee} lpFee=${value.lpFee}`,
        detail: `getSlot0() decoded to a structurally valid tuple, but ${semanticIssue}. This observed state cannot be trusted as usable current state.`,
      });
    } else {
      slot0 = value;
      evidence.push({
        kind: "SLOT0_V4_READ",
        outcome: "ok",
        source: "StateView.getSlot0(poolId)",
        observed: `sqrtPriceX96=${value.sqrtPriceX96} tick=${value.tick} protocolFee=${value.protocolFee} lpFee=${value.lpFee}`,
        detail: "getSlot0() decoded to a fully valid 4-word tuple with a nonzero price and canonically valid fee bounds.",
      });
    }
  } else {
    evidence.push(failureEvidence("SLOT0_V4_READ", "StateView.getSlot0(poolId)", slot0Result));
    hadRpcError ||= slot0Result.outcome === "rpc_error";
    hadIndeterminate ||= slot0Result.outcome === "decode_error";
  }

  if (liquidityResult.outcome === "ok") {
    evidence.push({
      kind: "ACTIVE_LIQUIDITY_READ",
      outcome: "ok",
      source: "StateView.getLiquidity(poolId)",
      observed: String(liquidityResult.value),
      detail: "getLiquidity() decoded to a valid uint128 — the pool's active in-range concentrated liquidity, not total/executable liquidity.",
    });
  } else {
    evidence.push(failureEvidence("ACTIVE_LIQUIDITY_READ", "StateView.getLiquidity(poolId)", liquidityResult));
    hadRpcError ||= liquidityResult.outcome === "rpc_error";
    hadIndeterminate ||= liquidityResult.outcome === "decode_error";
  }

  const status: PoolStateStatus = hadRpcError ? "RPC_ERROR" : hadIndeterminate ? "INDETERMINATE" : "VERIFIED";

  const state: UniswapV4PoolState | undefined =
    slot0 !== undefined && liquidityResult.outcome === "ok"
      ? {
          sqrtPriceX96: slot0.sqrtPriceX96,
          tick: slot0.tick,
          activeLiquidity: liquidityResult.value,
          protocolFee: slot0.protocolFee,
          lpFee: slot0.lpFee,
        }
      : undefined;

  return {
    pool: identity.pool,
    family: "UNISWAP_V4",
    status,
    identityVerificationBlock,
    stateBlockNumber,
    state,
    evidence,
  };
}
