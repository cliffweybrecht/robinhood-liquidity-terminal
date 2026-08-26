import type { Address, Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import { getProtocolDeploymentAddress, type PoolIdentityVerification, type VerifiedV4PoolKey } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { computeExecutionPrice, computePriceImpactBps, computeSpotPrice, readSharedDecimals, type SharedDecimals, type TokenDenomination } from "./analytics";
import { mapWithBoundedConcurrency } from "./depth-math";
import {
  DuplicateCandidateError,
  EmptyCandidatesError,
  InvalidAmountInError,
  MismatchedComparisonGroupError,
  MissingHookDataError,
  UnsupportedComparisonIdentityFamilyError,
} from "./errors";
import { describeError } from "./read";
import { DEPTH_CURVE_CONCURRENCY } from "./read-uniswap-v3-depth-curve";
import { quoteV3AtBlock, readV3SpotSqrtPriceX96, resolveV3Identity, resolveV3TokenDirection, type V3ResolvedQuoteInputs } from "./read-uniswap-v3-quote";
import {
  quoteV4AtBlock,
  readV4SpotSqrtPriceX96,
  resolveV4Denomination,
  resolveV4HookData,
  resolveV4Identity,
  resolveV4TokenDirection,
  UINT128_MAX,
  type V4ResolvedQuoteInputs,
} from "./read-uniswap-v4-quote";
import type {
  ComparisonCandidate,
  CrossPoolComparisonResult,
  QuoteAnalyticsStatus,
  QuoteEvidence,
  QuoteStatus,
  RationalValue,
  UniswapV3ComparisonCandidate,
  UniswapV4ComparisonCandidate,
} from "./types";

/** One candidate handed to `compareVerifiedPoolsExactInput`. */
export interface ComparisonCandidateInput {
  readonly pool: LiquidityPool;
  readonly identity: PoolIdentityVerification;
  /**
   * V4 only — ignored for a V3 candidate (V3 has no hook concept).
   * Explicit `hookData` for THIS candidate specifically, never shared
   * across candidates — see the module doc comment's "hookData is
   * per-candidate" section. A hooked V4 candidate with `hookData`
   * left `undefined` does not abort the whole comparison; it becomes
   * that ONE candidate's own `PRECONDITION_FAILED` result (see
   * `ComparisonCandidateStatus`'s doc comment in `types.ts`).
   */
  readonly hookData?: Hex;
}

export interface CompareVerifiedPoolsExactInputInput {
  readonly candidates: readonly ComparisonCandidateInput[];
  readonly tokenIn: Address;
  readonly amountIn: bigint;
  readonly rpc: VerifiedRobinhoodRpcClient;
}

/**
 * Phase 6F.2 — same-block execution comparison across N already
 * identity-VERIFIED Uniswap V3/V4 pools, all sharing the exact same
 * verified `tokenIn`/`tokenOut` pair, for ONE exact `amountIn`.
 *
 * This is the first genuine multi-protocol dispatcher in `pool-quote` —
 * earlier phases deliberately avoided a generic V3/V4 dispatcher because
 * there was no concrete use case requiring one; a cross-pool comparison
 * INHERENTLY needs to rank V3 and V4 candidates against each other in
 * one list, so the justification now exists. This function does NOT
 * reimplement any V3/V4 quote logic — it dispatches, per candidate, to
 * the EXACT SAME internal primitives the single-quote and depth-curve
 * readers already use and already have their own dedicated test
 * coverage (`resolveV3Identity`/`resolveV3TokenDirection`/
 * `quoteV3AtBlock`/`readV3SpotSqrtPriceX96` for V3;
 * `resolveV4Identity`/`resolveV4TokenDirection`/`resolveV4HookData`/
 * `resolveV4Denomination`/`quoteV4AtBlock`/`readV4SpotSqrtPriceX96` for
 * V4).
 *
 * Trust model:
 *  - Every candidate's execution identity (`tokenIn`/`tokenOut`/`fee`
 *    for V3, `tokenIn`/`tokenOut`/`zeroForOne`/`poolKey` for V4) is
 *    derived EXCLUSIVELY from that candidate's own VERIFIED typed
 *    identity facts (`identity.v3PoolKey`/`identity.poolKey`) — never
 *    from the caller-supplied `LiquidityPool`'s `baseToken`/`quoteToken`
 *    metadata, exactly as every existing quote reader already
 *    guarantees.
 *  - Grouping/comparability is STRUCTURALLY VALIDATED, not assumed:
 *    every candidate must resolve (via its own verified identity) to
 *    the exact same `tokenOut` address the first candidate resolved to
 *    — a mismatch throws `MismatchedComparisonGroupError` before any
 *    RPC call. This function does not itself discover/group pools (see
 *    module-level "out of scope" note below) — it only refuses to
 *    proceed with an internally-inconsistent candidate list.
 *  - Native-ETH denomination (V4 only) is resolved via the SAME
 *    `resolveV4Denomination` function every other V4 reader uses,
 *    called ONLY with a `tokenIn`/`tokenOut` value already proven (by
 *    that same V4 candidate's own `resolveV4TokenDirection` call) to
 *    equal a verified `PoolKey.currency0`/`currency1` — never inferred
 *    merely from seeing the zero address. If the comparison group
 *    contains zero V4 candidates (V3-only), both denominations are
 *    unconditionally `{ kind: "ERC20", ... }` — V3 structurally cannot
 *    produce a native denomination. See `analytics.ts`'s
 *    `TokenDenomination` doc comment for the full trust-boundary
 *    reasoning this preserves unchanged.
 *
 * Precondition order (every one of these throws BEFORE any RPC call —
 * zero `eth_blockNumber` calls, zero `eth_call`s):
 *  1. `candidates.length === 0` -> `EmptyCandidatesError`.
 *  2. Any two candidates share the same `(chainId, pairAddress)`
 *     (case-insensitive) -> `DuplicateCandidateError`. Checked before
 *     any identity resolution — a purely mechanical scan over the raw
 *     input, no RPC, no resolved facts needed.
 *  3. `amountIn <= 0n` -> `InvalidAmountInError`. This is the ONLY
 *     amountIn check performed globally — `amountIn`'s positivity is a
 *     fact about the REQUEST, independent of which protocols happen to
 *     be present among the candidates.
 *  4. For each candidate, in array order: family dispatch
 *     (`UNISWAP_V3` -> `resolveV3Identity`+`resolveV3TokenDirection`,
 *     `UNISWAP_V4` -> `resolveV4Identity`+`resolveV4TokenDirection`,
 *     anything else -> `UnsupportedComparisonIdentityFamilyError`) — the
 *     first candidate that fails ANY of its own IDENTITY preconditions
 *     (pool/identity mismatch, not VERIFIED, missing typed key, invalid
 *     `tokenIn` for that candidate's own verified pair) throws that SAME
 *     typed error the single-quote readers already throw for the
 *     identical condition. Every candidate's resolved `tokenOut` is
 *     compared against the first candidate's — a mismatch throws
 *     `MismatchedComparisonGroupError` immediately. Deliberately NOT
 *     checked here: V4's `uint128` `exactAmount` bound (see below) — a
 *     candidate whose IDENTITY is perfectly valid never fails structural
 *     validation merely because ITS protocol cannot represent an
 *     otherwise-positive shared `amountIn` that a V3 sibling could.
 *
 * Deliberately NOT preconditions (candidate-level instead, never abort
 * the whole request — checked per-candidate, AFTER the block is pinned,
 * each becoming that ONE candidate's own `PRECONDITION_FAILED` result;
 * see `ComparisonCandidateStatus`'s doc comment in `types.ts` for why
 * these are never folded into `INDETERMINATE`):
 *  - a hooked V4 candidate with missing `hookData`
 *    (`resolveV4HookData`'s `MissingHookDataError`) — see section 6 of
 *    this phase's architecture review for why a single global
 *    `hookData` value must never be used across candidates (empirically
 *    demonstrated live: a naive shared `hookData` left 12 of 15 real V4
 *    candidates `INDETERMINATE` in that research).
 *  - a V4 candidate whose shared `amountIn` exceeds
 *    `UINT128_MAX` (V4Quoter's `exactAmount` is `uint128`; `amountIn`
 *    itself was already proven `> 0` by the GLOBAL check above, so this
 *    is purely an upper-bound concern, and purely a V4-specific one — a
 *    V3 sibling has no such bound and is never affected). Checked first
 *    in `executeV4Candidate`, before hookData resolution: an
 *    unrepresentable amount makes hookData moot for that candidate
 *    either way. Reuses the SAME `UINT128_MAX` constant
 *    `validateV4AmountIn` itself is built on (exported from
 *    `read-uniswap-v4-quote.ts` for exactly this reuse) — never a
 *    second, independently-declared copy of the literal. The existing
 *    single-quote (`quoteVerifiedUniswapV4ExactInput`) and depth-curve
 *    (`quoteVerifiedUniswapV4ExactInputDepthCurve`) readers are
 *    UNCHANGED: both still call `validateV4AmountIn` and still THROW
 *    `InvalidAmountInError` for an out-of-range amount, because their
 *    entire request targets exactly one V4 pool — there is no sibling
 *    to isolate the failure from. This distinction — global request
 *    validity vs. one candidate's protocol-specific inability to
 *    represent an otherwise-valid shared amount — is the entire reason
 *    this function does not simply call `validateV4AmountIn` during
 *    structural validation the way it might naively seem to.
 *
 * After preconditions: exactly ONE `eth_blockNumber` call pins
 * `blockNumber` for the ENTIRE comparison. If it fails, this returns
 * `{ status: "BLOCK_PIN_FAILURE", ... }` — no candidate is ever
 * attempted. Otherwise, the comparison's ONE shared decimals read
 * (`analytics.ts`'s `readSharedDecimals`) fires, followed by every
 * EXECUTABLE candidate's own spot read + quote call, fired concurrently
 * per candidate (`Promise.all` of the two) and bounded across
 * candidates by `mapWithBoundedConcurrency`/`DEPTH_CURVE_CONCURRENCY` —
 * the SAME bounded-concurrency primitive and constant the depth-curve
 * readers already use, deliberately not a second, independently-tuned
 * cap. Candidate output order always matches `candidates`' input order,
 * regardless of completion order; `ranking` (see `types.ts`) is a
 * SEPARATE, derived ordering, never a reordering of `candidates` itself.
 *
 * Total `eth_call` count for E EXECUTABLE candidates (i.e. excluding any
 * `PRECONDITION_FAILED` candidate, which performs zero calls): `2 * E +
 * 2` when both `tokenIn`/`tokenOut` are ERC20 (one shared `decimals()`
 * per side + one spot read + one quote call per executable candidate);
 * `2 * E + 1` when one side is the V4 native-ETH denomination (one fewer
 * shared `decimals()` call).
 *
 * Explicitly out of scope for this function (see this phase's
 * architecture review, sections 6/30): it does not discover pools, does
 * not call Dexscreener, does not classify protocols, does not verify
 * identities, does not group candidates by asset, does not normalize
 * USD, does not route, does not accept a ladder of amounts (one exact
 * `amountIn` only — a caller wanting multiple sizes calls this multiple
 * times, each independently pinning its own one shared block).
 */
export async function compareVerifiedPoolsExactInput(input: CompareVerifiedPoolsExactInputInput): Promise<CrossPoolComparisonResult> {
  const { candidates, tokenIn, amountIn, rpc } = input;

  if (candidates.length === 0) {
    throw new EmptyCandidatesError();
  }

  const seenPoolKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.pool.chainId}:${candidate.pool.pairAddress.toLowerCase()}`;
    if (seenPoolKeys.has(key)) {
      throw new DuplicateCandidateError(candidate.pool.chainId, candidate.pool.pairAddress);
    }
    seenPoolKeys.add(key);
  }

  if (amountIn <= 0n) {
    throw new InvalidAmountInError(amountIn);
  }

  const resolved: ResolvedCandidate[] = [];
  let groupTokenOut: Address | null = null;

  for (const candidate of candidates) {
    if (candidate.identity.family === "UNISWAP_V3") {
      const identityResolved = resolveV3Identity({ pool: candidate.pool, identity: candidate.identity });
      const direction = resolveV3TokenDirection(identityResolved.v3PoolKey, tokenIn);
      groupTokenOut = checkGroup(groupTokenOut, direction.tokenOut);
      resolved.push({
        kind: "v3",
        input: candidate,
        identityVerificationBlock: identityResolved.identityVerificationBlock,
        resolvedInputs: {
          identityVerificationBlock: identityResolved.identityVerificationBlock,
          pairAddress: identityResolved.pairAddress,
          quoterAddress: getProtocolDeploymentAddress(rpc.chainId, "UNISWAP_V3", "quoter"),
          tokenIn: direction.tokenIn,
          tokenOut: direction.tokenOut,
          fee: direction.fee,
        },
      });
    } else if (candidate.identity.family === "UNISWAP_V4") {
      const identityResolved = resolveV4Identity({ pool: candidate.pool, identity: candidate.identity });
      const direction = resolveV4TokenDirection(identityResolved.poolKey, tokenIn);
      groupTokenOut = checkGroup(groupTokenOut, direction.tokenOut);
      resolved.push({
        kind: "v4",
        input: candidate,
        identityVerificationBlock: identityResolved.identityVerificationBlock,
        poolKey: identityResolved.poolKey,
        poolId: candidate.identity.pool.pairAddress,
        tokenIn: direction.tokenIn,
        tokenOut: direction.tokenOut,
        zeroForOne: direction.zeroForOne,
        quoterAddress: getProtocolDeploymentAddress(rpc.chainId, "UNISWAP_V4", "quoter"),
        stateViewAddress: getProtocolDeploymentAddress(rpc.chainId, "UNISWAP_V4", "state_view"),
      });
    } else {
      throw new UnsupportedComparisonIdentityFamilyError(candidate.identity.family);
    }
  }

  // Non-null: the loop above ran at least once (candidates.length > 0
  // was already checked) and every branch assigns `groupTokenOut`.
  const tokenOut = groupTokenOut as Address;
  const tokenInIsToken0 = tokenIn.toLowerCase() < tokenOut.toLowerCase();

  let blockNumber: bigint;
  try {
    blockNumber = await rpc.getBlockNumber();
  } catch (error) {
    return {
      status: "BLOCK_PIN_FAILURE",
      tokenIn,
      tokenOut,
      amountIn,
      evidence: [
        {
          kind: "BLOCK_PIN_FAILURE",
          outcome: "rpc_error",
          source: "eth_blockNumber",
          detail: `Could not pin a block for this comparison: ${describeError(error)}`,
        },
      ],
    };
  }

  // Native-ETH denomination is derived ONLY via `resolveV4Denomination`,
  // called ONLY with a value already proven (by that V4 candidate's own
  // `resolveV4TokenDirection` above) to equal a verified PoolKey
  // currency — never inferred merely from inspecting `tokenIn`/
  // `tokenOut` here. If the group has no V4 candidate at all, both
  // denominations are unconditionally ERC20 — V3 cannot be native.
  const firstV4 = resolved.find((r): r is ResolvedV4Candidate => r.kind === "v4");
  const tokenInDenomination: TokenDenomination = firstV4 ? resolveV4Denomination(firstV4.tokenIn) : { kind: "ERC20", address: tokenIn };
  const tokenOutDenomination: TokenDenomination = firstV4 ? resolveV4Denomination(firstV4.tokenOut) : { kind: "ERC20", address: tokenOut };

  const sharedDecimals = await readSharedDecimals({ rpc, tokenInDenomination, tokenOutDenomination, blockNumber });

  const candidateResults = await mapWithBoundedConcurrency(resolved, DEPTH_CURVE_CONCURRENCY, async (rc) =>
    rc.kind === "v3"
      ? executeV3Candidate(rc, amountIn, blockNumber, tokenInIsToken0, sharedDecimals, rpc)
      : executeV4Candidate(rc, amountIn, blockNumber, tokenInIsToken0, sharedDecimals, rpc),
  );

  return {
    status: "OK",
    blockNumber,
    tokenIn,
    tokenOut,
    amountIn,
    tokenInDecimals: sharedDecimals.tokenInDecimals,
    tokenOutDecimals: sharedDecimals.tokenOutDecimals,
    sharedAnalyticsStatus: sharedDecimals.status,
    sharedEvidence: sharedDecimals.evidence,
    candidates: candidateResults,
    ranking: computeRanking(candidateResults),
  };
}

function checkGroup(groupTokenOut: Address | null, candidateTokenOut: Address): Address {
  if (groupTokenOut === null) return candidateTokenOut;
  if (groupTokenOut.toLowerCase() !== candidateTokenOut.toLowerCase()) {
    throw new MismatchedComparisonGroupError(groupTokenOut, candidateTokenOut);
  }
  return groupTokenOut;
}

interface ResolvedV3Candidate {
  readonly kind: "v3";
  readonly input: ComparisonCandidateInput;
  readonly identityVerificationBlock: bigint;
  readonly resolvedInputs: V3ResolvedQuoteInputs;
}

interface ResolvedV4Candidate {
  readonly kind: "v4";
  readonly input: ComparisonCandidateInput;
  readonly identityVerificationBlock: bigint;
  readonly poolKey: VerifiedV4PoolKey;
  readonly poolId: Hex;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly zeroForOne: boolean;
  readonly quoterAddress: Address;
  readonly stateViewAddress: Address;
}

type ResolvedCandidate = ResolvedV3Candidate | ResolvedV4Candidate;

interface SpotClassification {
  readonly analyticsStatus: QuoteAnalyticsStatus;
  readonly evidence: QuoteEvidence[];
  readonly sqrtPriceX96?: bigint;
}

/** Classifies one candidate's OWN same-block spot read outcome — never shared across candidates, mirroring (at candidate granularity) the same rpc_error/decode_error/semantically-impossible-zero classification `analytics.ts`'s `readSpotAndDecimals` already applies at curve granularity. */
function classifySpot(
  outcome: Awaited<ReturnType<typeof readV3SpotSqrtPriceX96>>,
  source: string,
): SpotClassification {
  if (outcome.outcome === "rpc_error") {
    return { analyticsStatus: "RPC_ERROR", evidence: [{ kind: "SPOT_READ", outcome: "rpc_error", source, detail: outcome.detail }] };
  }
  if (outcome.outcome === "decode_error") {
    return { analyticsStatus: "INDETERMINATE", evidence: [{ kind: "SPOT_READ", outcome: "decode_error", source, detail: outcome.detail }] };
  }
  if (outcome.value === 0n) {
    return {
      analyticsStatus: "INDETERMINATE",
      evidence: [
        {
          kind: "SPOT_READ",
          outcome: "decode_error",
          source,
          detail:
            "sqrtPriceX96 decoded to exactly zero on an already-VERIFIED pool identity — semantically impossible for an initialized pool; analytics fails closed.",
        },
      ],
    };
  }
  return {
    analyticsStatus: "OK",
    evidence: [
      {
        kind: "SPOT_READ",
        outcome: "ok",
        source,
        observed: `sqrtPriceX96=${outcome.value}`,
        detail: "Pre-trade spot sqrtPriceX96 decoded and shape-validated at the exact pinned comparison block.",
      },
    ],
    sqrtPriceX96: outcome.value,
  };
}

function computeCandidatePricing(
  status: QuoteStatus,
  amountOut: bigint | undefined,
  spot: SpotClassification,
  sharedDecimals: SharedDecimals,
  amountIn: bigint,
  tokenInIsToken0: boolean,
): { executionPrice?: RationalValue; priceImpactBps?: RationalValue } {
  if (
    status !== "QUOTED" ||
    amountOut === undefined ||
    spot.analyticsStatus !== "OK" ||
    spot.sqrtPriceX96 === undefined ||
    sharedDecimals.status !== "OK" ||
    sharedDecimals.tokenInDecimals === undefined ||
    sharedDecimals.tokenOutDecimals === undefined
  ) {
    return {};
  }
  const spotPrice = computeSpotPrice(spot.sqrtPriceX96, tokenInIsToken0, sharedDecimals.tokenInDecimals, sharedDecimals.tokenOutDecimals);
  const executionPrice = computeExecutionPrice(amountIn, amountOut, sharedDecimals.tokenInDecimals, sharedDecimals.tokenOutDecimals);
  const priceImpactBps = computePriceImpactBps(spotPrice, executionPrice);
  return { executionPrice, priceImpactBps };
}

async function executeV3Candidate(
  rc: ResolvedV3Candidate,
  amountIn: bigint,
  blockNumber: bigint,
  tokenInIsToken0: boolean,
  sharedDecimals: SharedDecimals,
  rpc: VerifiedRobinhoodRpcClient,
): Promise<UniswapV3ComparisonCandidate> {
  const [spotOutcome, attempt] = await Promise.all([
    readV3SpotSqrtPriceX96(rpc, rc.resolvedInputs.pairAddress, blockNumber),
    quoteV3AtBlock(rc.resolvedInputs, amountIn, blockNumber, rpc),
  ]);
  const spot = classifySpot(spotOutcome, "pool.slot0()");
  const pricing = computeCandidatePricing(attempt.status, attempt.amountOut, spot, sharedDecimals, amountIn, tokenInIsToken0);
  return {
    pool: rc.input.identity.pool,
    family: "UNISWAP_V3",
    identityVerificationBlock: rc.identityVerificationBlock,
    status: attempt.status,
    amountOut: attempt.amountOut,
    metadata: attempt.metadata,
    analyticsStatus: spot.analyticsStatus,
    executionPrice: pricing.executionPrice,
    priceImpactBps: pricing.priceImpactBps,
    evidence: [...attempt.evidence, ...spot.evidence],
  };
}

async function executeV4Candidate(
  rc: ResolvedV4Candidate,
  amountIn: bigint,
  blockNumber: bigint,
  tokenInIsToken0: boolean,
  sharedDecimals: SharedDecimals,
  rpc: VerifiedRobinhoodRpcClient,
): Promise<UniswapV4ComparisonCandidate> {
  // amountIn > 0n is already guaranteed by the whole-request global check
  // in compareVerifiedPoolsExactInput — this is purely V4's own upper
  // bound (`exactAmount` is `uint128`), checked here rather than during
  // structural validation so that a V3 sibling — which has no such bound
  // — is never affected by a V4 candidate that cannot represent this
  // otherwise-valid shared amount. See the module doc comment.
  if (amountIn > UINT128_MAX) {
    return {
      pool: rc.input.identity.pool,
      family: "UNISWAP_V4",
      identityVerificationBlock: rc.identityVerificationBlock,
      status: "PRECONDITION_FAILED",
      analyticsStatus: "INDETERMINATE",
      evidence: [],
      preconditionFailure: {
        code: "AMOUNT_IN_EXCEEDS_V4_BOUND",
        detail: `amountIn (${amountIn}) exceeds V4Quoter's exactAmount uint128 bound (max ${UINT128_MAX}) — this candidate cannot be quoted at this amount, though sibling candidates on other protocols may still be valid.`,
      },
    };
  }

  let hook: { hookData: Hex; hookDataCallerSupplied: boolean; isHooked: boolean };
  try {
    hook = resolveV4HookData(rc.poolKey, rc.input.hookData);
  } catch (error) {
    if (error instanceof MissingHookDataError) {
      return {
        pool: rc.input.identity.pool,
        family: "UNISWAP_V4",
        identityVerificationBlock: rc.identityVerificationBlock,
        status: "PRECONDITION_FAILED",
        analyticsStatus: "INDETERMINATE",
        evidence: [],
        preconditionFailure: { code: "MISSING_HOOK_DATA", detail: error.message },
      };
    }
    throw error;
  }

  const resolvedInputs: V4ResolvedQuoteInputs = {
    identityVerificationBlock: rc.identityVerificationBlock,
    poolKey: rc.poolKey,
    quoterAddress: rc.quoterAddress,
    tokenIn: rc.tokenIn,
    tokenOut: rc.tokenOut,
    zeroForOne: rc.zeroForOne,
    hookData: hook.hookData,
  };

  const [spotOutcome, attempt] = await Promise.all([
    readV4SpotSqrtPriceX96(rpc, rc.stateViewAddress, rc.poolId, blockNumber),
    quoteV4AtBlock(resolvedInputs, amountIn, blockNumber, rpc),
  ]);
  const spot = classifySpot(spotOutcome, "StateView.getSlot0(poolId)");
  const pricing = computeCandidatePricing(attempt.status, attempt.amountOut, spot, sharedDecimals, amountIn, tokenInIsToken0);

  const hookEvidence: QuoteEvidence[] = hook.isHooked
    ? [
        {
          kind: "HOOK_DATA_DISCLOSURE",
          outcome: "disclosed",
          source: "poolKey.hooks",
          observed: `hooks=${rc.poolKey.hooks} hookData=${hook.hookData}`,
          detail:
            "This pool has an active hook. hookData was explicitly supplied by the caller for THIS candidate — it is NOT independently verified as canonically correct for this specific hook, and is never reused for any other candidate.",
        },
      ]
    : [];

  return {
    pool: rc.input.identity.pool,
    family: "UNISWAP_V4",
    identityVerificationBlock: rc.identityVerificationBlock,
    status: attempt.status,
    amountOut: attempt.amountOut,
    metadata: attempt.metadata,
    analyticsStatus: spot.analyticsStatus,
    executionPrice: pricing.executionPrice,
    priceImpactBps: pricing.priceImpactBps,
    evidence: [...attempt.evidence, ...spot.evidence, ...hookEvidence],
    hookDataCallerSupplied: hook.isHooked ? hook.hookDataCallerSupplied || undefined : undefined,
  };
}

function computeRanking(candidates: readonly ComparisonCandidate[]): { rankedQuotedPoolAddresses: readonly Hex[]; bestCandidatePoolAddresses: readonly Hex[] } {
  const quoted = candidates.filter(
    (c): c is ComparisonCandidate & { readonly status: "QUOTED"; readonly amountOut: bigint } => c.status === "QUOTED" && c.amountOut !== undefined,
  );

  const sorted = [...quoted].sort((a, b) => {
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
    // Deterministic PRESENTATION ordering only for an exact amountOut
    // tie — ascending pairAddress. This carries NO economic meaning;
    // see `bestCandidatePoolAddresses` for the truthful tie
    // representation.
    return a.pool.pairAddress.toLowerCase() < b.pool.pairAddress.toLowerCase() ? -1 : 1;
  });

  const rankedQuotedPoolAddresses = sorted.map((c) => c.pool.pairAddress);
  const topAmountOut = sorted[0]?.amountOut;
  const bestCandidatePoolAddresses = topAmountOut === undefined ? [] : sorted.filter((c) => c.amountOut === topAmountOut).map((c) => c.pool.pairAddress);

  return { rankedQuotedPoolAddresses, bestCandidatePoolAddresses };
}
