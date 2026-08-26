import { zeroAddress, type Address, type Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolIdentityVerification } from "@/domain/pool-verification";
import { getProtocolDeploymentAddress } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { decodeV4QuoteReturn } from "./abi/decode";
import { encodeQuoteExactInputSingleV4Call } from "./abi/selectors";
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
import type { QuoteEvidence, QuoteStatus, UniswapV4QuoteMetadata, UniswapV4QuoteVerification } from "./types";

const UINT128_MAX = (1n << 128n) - 1n;

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
  if (amountIn <= 0n) {
    throw new InvalidAmountInError(amountIn);
  }
  if (amountIn > UINT128_MAX) {
    throw new InvalidAmountInError(amountIn);
  }

  const currency0Lower = poolKey.currency0.toLowerCase();
  const currency1Lower = poolKey.currency1.toLowerCase();
  const tokenInLower = tokenIn.toLowerCase();
  if (tokenInLower !== currency0Lower && tokenInLower !== currency1Lower) {
    throw new InvalidTokenInError(tokenIn);
  }
  const zeroForOne = tokenInLower === currency0Lower;
  const tokenOut: Address = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const isHooked = poolKey.hooks.toLowerCase() !== zeroAddress.toLowerCase();
  let hookData: Hex;
  let hookDataCallerSupplied = false;
  if (!isHooked) {
    hookData = "0x";
  } else if (callerHookData === undefined) {
    throw new MissingHookDataError(poolKey.hooks);
  } else {
    hookData = callerHookData;
    hookDataCallerSupplied = true;
  }

  const identityVerificationBlock = identity.blockNumber;
  const quoterAddress = getProtocolDeploymentAddress(rpc.chainId, "UNISWAP_V4", "quoter");

  const evidence: QuoteEvidence[] = [];
  if (isHooked) {
    evidence.push({
      kind: "HOOK_DATA_DISCLOSURE",
      outcome: "disclosed",
      source: "poolKey.hooks",
      observed: `hooks=${poolKey.hooks} hookData=${hookData}`,
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
      identityVerificationBlock,
      quoteBlockNumber: null,
      tokenIn,
      tokenOut,
      amountIn,
      hookDataCallerSupplied,
      status: "RPC_ERROR",
      evidence: [
        ...evidence,
        {
          kind: "BLOCK_PIN_FAILURE",
          outcome: "rpc_error",
          source: "eth_blockNumber",
          detail: `Could not pin a block for this quote attempt: ${describeError(error)}`,
        },
      ],
    });
  }

  const quoteData = encodeQuoteExactInputSingleV4Call(poolKey, zeroForOne, amountIn, hookData);
  const outcome = await callQuoter(rpc, quoterAddress, quoteData, quoteBlockNumber);

  if (outcome.kind === "rpc_error") {
    evidence.push({
      kind: "QUOTE_CALL",
      outcome: "rpc_error",
      source: "V4Quoter.quoteExactInputSingle(...)",
      detail: `RPC call failed: ${outcome.detail}`,
    });
    return buildResult({
      pool: identity.pool,
      identityVerificationBlock,
      quoteBlockNumber,
      tokenIn,
      tokenOut,
      amountIn,
      hookDataCallerSupplied,
      status: "RPC_ERROR",
      evidence,
    });
  }

  if (outcome.kind === "revert") {
    const classification = classifyRevert("UNISWAP_V4", outcome.data);
    evidence.push({
      kind: "QUOTE_CALL",
      outcome: classification.outcome === "unquotable" ? "unquotable" : "decode_error",
      source: "V4Quoter.quoteExactInputSingle(...)",
      detail: classification.reason,
    });
    return buildResult({
      pool: identity.pool,
      identityVerificationBlock,
      quoteBlockNumber,
      tokenIn,
      tokenOut,
      amountIn,
      hookDataCallerSupplied,
      status: classification.outcome === "unquotable" ? "UNQUOTABLE" : "INDETERMINATE",
      evidence,
    });
  }

  const decoded = decodeV4QuoteReturn(outcome.raw);
  if (decoded === null) {
    evidence.push({
      kind: "QUOTE_CALL",
      outcome: "decode_error",
      source: "V4Quoter.quoteExactInputSingle(...)",
      detail: `Return data could not be decoded into a valid 2-word quote tuple (raw: ${outcome.raw}).`,
    });
    return buildResult({
      pool: identity.pool,
      identityVerificationBlock,
      quoteBlockNumber,
      tokenIn,
      tokenOut,
      amountIn,
      hookDataCallerSupplied,
      status: "INDETERMINATE",
      evidence,
    });
  }

  evidence.push({
    kind: "QUOTE_CALL",
    outcome: "ok",
    source: "V4Quoter.quoteExactInputSingle(...)",
    observed: `amountOut=${decoded.amountOut} gasEstimate=${decoded.gasEstimate}`,
    detail: "quoteExactInputSingle() decoded to a fully valid 2-word tuple. Economic quality does not affect this outcome.",
  });

  const metadata: UniswapV4QuoteMetadata = { gasEstimate: decoded.gasEstimate };

  return buildResult({
    pool: identity.pool,
    identityVerificationBlock,
    quoteBlockNumber,
    tokenIn,
    tokenOut,
    amountIn,
    hookDataCallerSupplied,
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
