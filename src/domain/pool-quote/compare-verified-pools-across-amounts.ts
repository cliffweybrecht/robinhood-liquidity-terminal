import type { Address, Hex } from "viem";
import { getProtocolDeploymentAddress, type VerifiedV4PoolKey } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { createLimiter } from "@/lib/concurrency/limiter";
import { computeExecutionPrice, computePriceImpactBps, computeSpotPrice, readSharedDecimals, type SharedDecimals, type TokenDenomination } from "./analytics";
import { computeRanking, type ComparisonCandidateInput } from "./compare-verified-pools";
import { mapWithBoundedConcurrency } from "./depth-math";
import {
  DuplicateCandidateError,
  EmptyAmountsLadderError,
  EmptyCandidatesError,
  InvalidAmountInError,
  MatrixTooLargeError,
  MismatchedComparisonGroupError,
  MissingHookDataError,
  TooManyAmountsError,
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
  CrossPoolExecutionMatrixResult,
  MatrixCandidateRow,
  MatrixCell,
  QuoteAnalyticsStatus,
  QuoteEvidence,
  QuoteStatus,
  RationalValue,
} from "./types";

/**
 * UI V1.1 — bounded-safety limits on `compareVerifiedPoolsAcrossExactInputs`,
 * enforced as structural preconditions (thrown before any RPC call) —
 * see that function's own doc comment for the full reasoning. Frozen by
 * live RPC capacity research (`CHATGPT_CLAUDE_PROJECT_FILES/UI_V1_1/
 * ui-v1-1-architecture-research.txt`, section 20) — never redeclared as
 * a second, independently-chosen literal anywhere else in this codebase.
 */
export const MAX_MATRIX_AMOUNTS = 10;
/**
 * Bounds `executable.length * amountsIn.length` — i.e. the number of
 * ACTUAL canonical quoter RPC calls this matrix will attempt. NEVER the
 * raw candidate count, NEVER the rendered row count — a
 * `PRECONDITION_FAILED` row (see `classifyMatrixCandidates`) issues zero
 * quoter calls and therefore never counts toward this limit, while
 * always remaining visible in the returned result.
 */
export const MAX_MATRIX_CELLS = 60;
/**
 * Fixed, non-configurable concurrency/spacing for the matrix's own
 * quoter-call fan-out — mirrors `DEPTH_CURVE_CONCURRENCY`'s own
 * precedent (a fixed module constant, never a caller-supplied
 * parameter, matching this codebase's "no unnecessary knobs"
 * convention). `MATRIX_QUOTE_INTERVAL_MS` is the DOMINANT throughput
 * constraint: `createLimiter`'s `intervalMs` enforces a single GLOBAL
 * minimum gap between ANY two consecutive quoter-call starts, regardless
 * of concurrency — concurrency=3 only allows up to 3 already-started
 * calls to remain in flight at once (hiding a slow call's tail), it does
 * NOT let new calls start more often than once every
 * `MATRIX_QUOTE_INTERVAL_MS`. See the frozen implementation plan's
 * correction 1 for the full arithmetic this constant pairing was chosen
 * against.
 */
export const MATRIX_QUOTE_CONCURRENCY = 3;
export const MATRIX_QUOTE_INTERVAL_MS = 100;

export interface CompareVerifiedPoolsAcrossExactInputsInput {
  readonly candidates: readonly ComparisonCandidateInput[];
  readonly tokenIn: Address;
  /**
   * The requested trade-size samples, in caller order. NOT assumed
   * sorted, NOT silently sorted, NOT deduplicated — identical contract
   * to 6F.1's own `amountsIn` (`read-uniswap-v3-depth-curve.ts`). Every
   * entry becomes one column in every row of the returned matrix, at the
   * same index it was requested at.
   */
  readonly amountsIn: readonly bigint[];
  readonly rpc: VerifiedRobinhoodRpcClient;
}

interface ResolvedV3Row {
  readonly kind: "v3";
  readonly input: ComparisonCandidateInput;
  readonly identityVerificationBlock: bigint;
  readonly tokenOut: Address;
  readonly resolvedInputs: V3ResolvedQuoteInputs;
}

interface ResolvedV4Row {
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
  readonly hookData: Hex;
  readonly hookDataCallerSupplied: boolean;
  readonly isHooked: boolean;
}

/** One candidate that resolved to an EXECUTABLE row — see `classifyMatrixCandidates`. */
type ExecutableRow = ResolvedV3Row | ResolvedV4Row;

/** One candidate that is `PRECONDITION_FAILED` for the whole row (today: a hooked V4 pool with no caller-supplied `hookData`) — see `classifyMatrixCandidates`. */
export interface PreconditionFailedRow {
  readonly input: ComparisonCandidateInput;
  readonly family: "UNISWAP_V3" | "UNISWAP_V4";
  readonly identityVerificationBlock: bigint;
  readonly code: "MISSING_HOOK_DATA";
  readonly detail: string;
}

export interface ClassifiedMatrixCandidates {
  readonly executable: readonly ExecutableRow[];
  readonly preconditionFailed: readonly PreconditionFailedRow[];
  /** The one verified `tokenOut` every candidate (executable AND precondition-failed) resolved to — established the same way `compareVerifiedPoolsExactInput`'s own `checkGroup` already does, just hoisted into this pure classification pass. */
  readonly tokenOut: Address;
}

function checkGroup(groupTokenOut: Address | null, candidateTokenOut: Address): Address {
  if (groupTokenOut === null) return candidateTokenOut;
  if (groupTokenOut.toLowerCase() !== candidateTokenOut.toLowerCase()) {
    throw new MismatchedComparisonGroupError(groupTokenOut, candidateTokenOut);
  }
  return groupTokenOut;
}

/**
 * UI V1.1 — PURE (zero RPC calls) classification of a raw candidate list
 * into executable rows vs. row-wide `PRECONDITION_FAILED` rows, plus the
 * one shared verified `tokenOut` every candidate must agree on. This is
 * the SINGLE implementation both `compareVerifiedPoolsAcrossExactInputs`
 * (authoritative — see below) and the `execution-comparison` orchestration
 * layer's own fast-path `MAX_MATRIX_CELLS` pre-check call, specifically
 * so the two layers can never disagree about which candidates are
 * "executable" (see the frozen implementation plan's correction 2 for
 * why a cruder raw-candidate-count fast-path was explicitly rejected).
 *
 * Today, the ONLY structural (whole-row) classification failure is a
 * hooked V4 candidate with no caller-supplied `hookData`
 * (`resolveV4HookData`'s `MissingHookDataError`) — caught here, per
 * candidate, and routed to `preconditionFailed` rather than aborting the
 * whole classification pass. Every OTHER identity/direction/family
 * problem (`PoolIdentityMismatchError`, `IdentityNotVerifiedError`,
 * `UnsupportedComparisonIdentityFamilyError`, `MismatchedComparisonGroupError`,
 * etc.) remains a WHOLE-REQUEST structural precondition, exactly as it
 * already is in `compareVerifiedPoolsExactInput` — those are caller/
 * orchestration-layer bugs, never a per-row market outcome, so they are
 * never downgraded to a `PRECONDITION_FAILED` row here.
 *
 * `chainId` (not the whole `VerifiedRobinhoodRpcClient`) is deliberately
 * the parameter, to make plain at every call site that this function
 * never performs an RPC call — `getProtocolDeploymentAddress` is a pure,
 * in-memory deployment-registry lookup keyed by chain id, not a network
 * call.
 */
export function classifyMatrixCandidates(candidates: readonly ComparisonCandidateInput[], tokenIn: Address, chainId: number): ClassifiedMatrixCandidates {
  const executable: ExecutableRow[] = [];
  const preconditionFailed: PreconditionFailedRow[] = [];
  let groupTokenOut: Address | null = null;

  for (const candidate of candidates) {
    if (candidate.identity.family === "UNISWAP_V3") {
      const identityResolved = resolveV3Identity({ pool: candidate.pool, identity: candidate.identity });
      const direction = resolveV3TokenDirection(identityResolved.v3PoolKey, tokenIn);
      groupTokenOut = checkGroup(groupTokenOut, direction.tokenOut);
      executable.push({
        kind: "v3",
        input: candidate,
        identityVerificationBlock: identityResolved.identityVerificationBlock,
        tokenOut: direction.tokenOut,
        resolvedInputs: {
          identityVerificationBlock: identityResolved.identityVerificationBlock,
          pairAddress: identityResolved.pairAddress,
          quoterAddress: getProtocolDeploymentAddress(chainId, "UNISWAP_V3", "quoter"),
          tokenIn: direction.tokenIn,
          tokenOut: direction.tokenOut,
          fee: direction.fee,
        },
      });
    } else if (candidate.identity.family === "UNISWAP_V4") {
      const identityResolved = resolveV4Identity({ pool: candidate.pool, identity: candidate.identity });
      const direction = resolveV4TokenDirection(identityResolved.poolKey, tokenIn);
      groupTokenOut = checkGroup(groupTokenOut, direction.tokenOut);

      let hook: { hookData: Hex; hookDataCallerSupplied: boolean; isHooked: boolean };
      try {
        hook = resolveV4HookData(identityResolved.poolKey, candidate.hookData);
      } catch (error) {
        if (error instanceof MissingHookDataError) {
          preconditionFailed.push({
            input: candidate,
            family: "UNISWAP_V4",
            identityVerificationBlock: identityResolved.identityVerificationBlock,
            code: "MISSING_HOOK_DATA",
            detail: error.message,
          });
          continue;
        }
        throw error;
      }

      executable.push({
        kind: "v4",
        input: candidate,
        identityVerificationBlock: identityResolved.identityVerificationBlock,
        poolKey: identityResolved.poolKey,
        poolId: candidate.identity.pool.pairAddress,
        tokenIn: direction.tokenIn,
        tokenOut: direction.tokenOut,
        zeroForOne: direction.zeroForOne,
        quoterAddress: getProtocolDeploymentAddress(chainId, "UNISWAP_V4", "quoter"),
        stateViewAddress: getProtocolDeploymentAddress(chainId, "UNISWAP_V4", "state_view"),
        hookData: hook.hookData,
        hookDataCallerSupplied: hook.hookDataCallerSupplied,
        isHooked: hook.isHooked,
      });
    } else {
      throw new UnsupportedComparisonIdentityFamilyError(candidate.identity.family);
    }
  }

  // Non-null: the loop above ran at least once (candidates.length > 0 is
  // checked by the caller before this function runs) and every branch
  // assigns groupTokenOut, including the preconditionFailed branch
  // (checkGroup runs before the hookData check).
  return { executable, preconditionFailed, tokenOut: groupTokenOut as Address };
}

interface SpotClassification {
  readonly analyticsStatus: QuoteAnalyticsStatus;
  readonly evidence: QuoteEvidence[];
  readonly sqrtPriceX96?: bigint;
}

/**
 * Mirrors `compare-verified-pools.ts`'s own private `classifySpot`
 * exactly (same rpc_error/decode_error/semantically-impossible-zero
 * classification) — re-stated here, not imported, because
 * `compare-verified-pools.ts` is approved for exactly ONE additive
 * change (`computeRanking`'s export) per the frozen implementation
 * plan's own file-scope boundary; this is classification GLUE, not AMM
 * math — the actual math (`computeSpotPrice`/`computeExecutionPrice`/
 * `computePriceImpactBps`) is reused verbatim from `analytics.ts` below,
 * never re-derived.
 */
function classifySpot(outcome: Awaited<ReturnType<typeof readV3SpotSqrtPriceX96>>, source: string): SpotClassification {
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
        detail: "Pre-trade spot sqrtPriceX96 decoded and shape-validated at the exact pinned matrix block.",
      },
    ],
    sqrtPriceX96: outcome.value,
  };
}

/**
 * Mirrors `compare-verified-pools.ts`'s own private `computeCandidatePricing`
 * exactly — see `classifySpot`'s own doc comment for why this is
 * re-stated rather than imported. RELEASE-CRITICAL invariant, unchanged
 * from the existing single-size comparison: a valid `QUOTED` cell's
 * `amountOut` is NEVER blanked by a spot or shared-decimals analytics
 * failure — only `executionPrice`/`priceImpactBps` become unavailable.
 */
function computeCellPricing(
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

async function executeCell(
  row: ExecutableRow,
  amountIn: bigint,
  blockNumber: bigint,
  tokenInIsToken0: boolean,
  sharedDecimals: SharedDecimals,
  spot: SpotClassification,
  rpc: VerifiedRobinhoodRpcClient,
): Promise<MatrixCell> {
  // Per-CELL (not per-row) V4 precondition — mirrors executeV4Candidate's
  // own identical check in compare-verified-pools.ts. A larger sampled
  // size may exceed V4Quoter's uint128 bound while smaller sizes in the
  // SAME row remain fully valid — this is exactly why this check lives
  // here, per cell, rather than in classifyMatrixCandidates (per row).
  if (row.kind === "v4" && amountIn > UINT128_MAX) {
    return {
      amountIn,
      status: "PRECONDITION_FAILED",
      analyticsStatus: "INDETERMINATE",
      evidence: [],
      preconditionFailure: {
        code: "AMOUNT_IN_EXCEEDS_V4_BOUND",
        detail: `amountIn (${amountIn}) exceeds V4Quoter's exactAmount uint128 bound (max ${UINT128_MAX}) — this cell cannot be quoted at this amount, though smaller sizes in the same row, and sibling candidates, may still be valid.`,
      },
    };
  }

  const attempt =
    row.kind === "v3"
      ? await quoteV3AtBlock(row.resolvedInputs, amountIn, blockNumber, rpc)
      : await quoteV4AtBlock(
          {
            identityVerificationBlock: row.identityVerificationBlock,
            poolKey: row.poolKey,
            quoterAddress: row.quoterAddress,
            tokenIn: row.tokenIn,
            tokenOut: row.tokenOut,
            zeroForOne: row.zeroForOne,
            hookData: row.hookData,
          } satisfies V4ResolvedQuoteInputs,
          amountIn,
          blockNumber,
          rpc,
        );

  // RELEASE-CRITICAL: attempt.status/attempt.amountOut are NEVER altered
  // because of spot/decimals analytics outcome — only executionPrice/
  // priceImpactBps depend on that (see computeCellPricing above). A
  // successful canonical quote remains QUOTED and rankable regardless.
  const pricing = computeCellPricing(attempt.status, attempt.amountOut, spot, sharedDecimals, amountIn, tokenInIsToken0);

  return {
    amountIn,
    status: attempt.status,
    amountOut: attempt.amountOut,
    analyticsStatus: spot.analyticsStatus,
    executionPrice: pricing.executionPrice,
    priceImpactBps: pricing.priceImpactBps,
    gasEstimate: attempt.metadata?.gasEstimate,
    evidence: [...attempt.evidence, ...spot.evidence],
  };
}

/**
 * UI V1.1 — Phase 6F.3-equivalent: a same-block execution MATRIX across
 * N already identity-VERIFIED Uniswap V3/V4 pools (all sharing the exact
 * same verified `tokenIn`/`tokenOut` pair) x M caller-supplied exact
 * `amountIn` sizes. This is the canonical peer primitive to
 * `compareVerifiedPoolsExactInput` (6F.2, one size) and
 * `quoteVerifiedUniswapV3/V4ExactInputDepthCurve` (6F.1, one pool) —
 * built DIRECTLY on the same shared lower-level primitives all three
 * already use, never a wrapper around either higher-level entry point
 * (see the frozen architecture research's own Finding 1: composing on
 * top of 6F.1 would import ITS whole-row/whole-curve abort semantics for
 * missing hookData / oversized V4 amounts, which is coarser than the
 * per-cell isolation this matrix requires; composing on top of 6F.2 by
 * calling it once per size cannot guarantee one shared block across the
 * whole matrix, since it pins its own block internally on every call).
 *
 * Orchestration, in order:
 *  1. Structural preconditions (before any RPC call): empty candidates,
 *     duplicate candidates, empty ladder, non-positive amount, ladder
 *     too long (`MAX_MATRIX_AMOUNTS`) — reusing the SAME typed errors
 *     `compareVerifiedPoolsExactInput`/6F.1 already throw for the
 *     identical conditions.
 *  2. `classifyMatrixCandidates` (pure, zero RPC) partitions candidates
 *     into `executable` rows and row-wide `PRECONDITION_FAILED` rows,
 *     and establishes the one shared verified `tokenOut` — a mismatch
 *     throws `MismatchedComparisonGroupError` here, exactly as 6F.2
 *     already does, before any RPC call.
 *  3. `executable.length * amountsIn.length > MAX_MATRIX_CELLS` throws
 *     `MatrixTooLargeError` — computed against the EXECUTABLE count
 *     only, never the raw candidate count (a `PRECONDITION_FAILED` row
 *     issues zero quoter calls and must never be double-penalized by
 *     also counting against this safety limit).
 *  4. Exactly ONE `eth_blockNumber` call pins `blockNumber` for the
 *     ENTIRE matrix — every spot read, the one shared decimals read, and
 *     every quoter call in this SAME matrix build use this identical
 *     value. Failure -> `{status: "BLOCK_PIN_FAILURE", ...}`, no
 *     candidate/size ever attempted.
 *  5. Exactly ONE shared decimals read (`readSharedDecimals`).
 *  6. Exactly ONE spot read PER EXECUTABLE ROW (never per cell — spot
 *     price does not depend on `amountIn`), fired via
 *     `mapWithBoundedConcurrency`/`DEPTH_CURVE_CONCURRENCY`, the SAME
 *     bounded-concurrency primitive/constant every other pool-quote
 *     reader already uses for this exact kind of small, one-time,
 *     per-candidate fan-out. `PRECONDITION_FAILED` rows never reach this
 *     step.
 *  7. The `executable.length x amountsIn.length` cell list is flattened
 *     and dispatched through ONE `createLimiter({concurrency:
 *     MATRIX_QUOTE_CONCURRENCY, intervalMs: MATRIX_QUOTE_INTERVAL_MS})`
 *     instance, constructed fresh for THIS call (never a cross-request
 *     singleton) — see `MATRIX_QUOTE_CONCURRENCY`'s own doc comment for
 *     exactly what `intervalMs` does and does not do. Every quoter call
 *     (`quoteV3AtBlock`/`quoteV4AtBlock`, reused verbatim) is scheduled
 *     through this SAME limiter — never a bare `Promise.all`, never
 *     `mapWithBoundedConcurrency` for this specific phase (that
 *     primitive has no interval-spacing knob).
 *  8. Per-size ranking: the now-exported `computeRanking`
 *     (`compare-verified-pools.ts`) applied ONCE PER `amountsIn[j]`
 *     COLUMN, over that column's own cells — reused verbatim, never
 *     re-implemented.
 *  9. The final result includes EVERY row — executable AND
 *     precondition-failed — in original candidate order; a
 *     precondition-failed row's `cells` array still has one entry per
 *     requested `amountsIn[j]` (column alignment), each cell
 *     `PRECONDITION_FAILED`/`MISSING_HOOK_DATA`, zero quoter calls
 *     issued.
 *
 * Never caches any quote result across calls — every call performs its
 * own fresh block pin, shared decimals read, spot reads, and quoter
 * calls, unconditionally, exactly matching `compareVerifiedPoolsExactInput`'s
 * own existing no-caching guarantee.
 */
export async function compareVerifiedPoolsAcrossExactInputs(input: CompareVerifiedPoolsAcrossExactInputsInput): Promise<CrossPoolExecutionMatrixResult> {
  const { candidates, tokenIn, amountsIn, rpc } = input;

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

  if (amountsIn.length === 0) {
    throw new EmptyAmountsLadderError();
  }
  for (const amountIn of amountsIn) {
    if (amountIn <= 0n) {
      throw new InvalidAmountInError(amountIn);
    }
  }
  if (amountsIn.length > MAX_MATRIX_AMOUNTS) {
    throw new TooManyAmountsError(amountsIn.length, MAX_MATRIX_AMOUNTS);
  }

  const { executable, preconditionFailed, tokenOut } = classifyMatrixCandidates(candidates, tokenIn, rpc.chainId);

  if (executable.length * amountsIn.length > MAX_MATRIX_CELLS) {
    throw new MatrixTooLargeError(executable.length, amountsIn.length, MAX_MATRIX_CELLS);
  }

  const tokenInIsToken0 = tokenIn.toLowerCase() < tokenOut.toLowerCase();

  let blockNumber: bigint;
  try {
    blockNumber = await rpc.getBlockNumber();
  } catch (error) {
    return {
      status: "BLOCK_PIN_FAILURE",
      tokenIn,
      tokenOut,
      amountsIn,
      evidence: [
        {
          kind: "BLOCK_PIN_FAILURE",
          outcome: "rpc_error",
          source: "eth_blockNumber",
          detail: `Could not pin a block for this matrix: ${describeError(error)}`,
        },
      ],
    };
  }

  const firstV4 = executable.find((r): r is ResolvedV4Row => r.kind === "v4");
  const tokenInDenomination: TokenDenomination = firstV4 ? resolveV4Denomination(firstV4.tokenIn) : { kind: "ERC20", address: tokenIn };
  const tokenOutDenomination: TokenDenomination = firstV4 ? resolveV4Denomination(firstV4.tokenOut) : { kind: "ERC20", address: tokenOut };

  const [sharedDecimals, spotByRow] = await Promise.all([
    readSharedDecimals({ rpc, tokenInDenomination, tokenOutDenomination, blockNumber }),
    mapWithBoundedConcurrency(executable, DEPTH_CURVE_CONCURRENCY, async (row) => {
      const outcome =
        row.kind === "v3"
          ? await readV3SpotSqrtPriceX96(rpc, row.resolvedInputs.pairAddress, blockNumber)
          : await readV4SpotSqrtPriceX96(rpc, row.stateViewAddress, row.poolId, blockNumber);
      return classifySpot(outcome, row.kind === "v3" ? "pool.slot0()" : "StateView.getSlot0(poolId)");
    }),
  ]);

  const limiter = createLimiter({ concurrency: MATRIX_QUOTE_CONCURRENCY, intervalMs: MATRIX_QUOTE_INTERVAL_MS });

  // rowCells[rowIndex][amountIndex] — filled via the limiter-scheduled
  // fan-out below, then assembled into MatrixCandidateRow order.
  const rowCells: MatrixCell[][] = executable.map(() => new Array(amountsIn.length));
  const cellTasks: Array<Promise<void>> = [];
  for (let rowIndex = 0; rowIndex < executable.length; rowIndex++) {
    const row = executable[rowIndex]!;
    const spot = spotByRow[rowIndex]!;
    for (let amountIndex = 0; amountIndex < amountsIn.length; amountIndex++) {
      const amountIn = amountsIn[amountIndex]!;
      cellTasks.push(
        limiter.schedule(() => executeCell(row, amountIn, blockNumber, tokenInIsToken0, sharedDecimals, spot, rpc)).then((cell) => {
          rowCells[rowIndex]![amountIndex] = cell;
        }),
      );
    }
  }
  await Promise.all(cellTasks);

  const executableRows: MatrixCandidateRow[] = executable.map((row, rowIndex) => ({
    pool: row.input.identity.pool,
    family: row.kind === "v3" ? "UNISWAP_V3" : "UNISWAP_V4",
    identityVerificationBlock: row.identityVerificationBlock,
    hookDataCallerSupplied: row.kind === "v4" && row.isHooked ? row.hookDataCallerSupplied || undefined : undefined,
    cells: rowCells[rowIndex]!,
  }));

  const preconditionFailedRows: MatrixCandidateRow[] = preconditionFailed.map((row) => ({
    pool: row.input.identity.pool,
    family: row.family,
    identityVerificationBlock: row.identityVerificationBlock,
    cells: amountsIn.map((amountIn) => ({
      amountIn,
      status: "PRECONDITION_FAILED" as const,
      analyticsStatus: "INDETERMINATE" as const,
      evidence: [],
      preconditionFailure: { code: row.code, detail: row.detail },
    })),
  }));

  // Preserve original candidate input order across BOTH executable and
  // precondition-failed rows — never grouped/reordered by outcome.
  const rowsByInput = new Map<ComparisonCandidateInput, MatrixCandidateRow>();
  executable.forEach((row, i) => rowsByInput.set(row.input, executableRows[i]!));
  preconditionFailed.forEach((row, i) => rowsByInput.set(row.input, preconditionFailedRows[i]!));
  const rows = candidates.map((c) => rowsByInput.get(c)!);

  const rankingsByAmount = amountsIn.map((amountIn, amountIndex) => {
    // Reconstruct ONE column's worth of ComparisonCandidate-shaped
    // values, purely so the EXISTING computeRanking algorithm (reused
    // verbatim, never re-derived) can rank this column exactly as it
    // already ranks a single-size comparison — this is a type-shape
    // adapter only, not a second ranking implementation.
    const columnCandidates: ComparisonCandidate[] = executable.map((row, rowIndex) => {
      const cell = rowCells[rowIndex]![amountIndex]!;
      const base = {
        pool: row.input.identity.pool,
        identityVerificationBlock: row.identityVerificationBlock,
        status: cell.status,
        amountOut: cell.amountOut,
        analyticsStatus: cell.analyticsStatus,
        executionPrice: cell.executionPrice,
        priceImpactBps: cell.priceImpactBps,
        evidence: cell.evidence,
        preconditionFailure: cell.preconditionFailure,
      };
      return row.kind === "v3"
        ? { ...base, family: "UNISWAP_V3" as const }
        : { ...base, family: "UNISWAP_V4" as const, hookDataCallerSupplied: row.isHooked ? row.hookDataCallerSupplied || undefined : undefined };
    });
    const ranking = computeRanking(columnCandidates);
    return { amountIn, rankedQuotedPoolAddresses: ranking.rankedQuotedPoolAddresses, bestCandidatePoolAddresses: ranking.bestCandidatePoolAddresses };
  });

  return {
    status: "OK",
    blockNumber,
    tokenIn,
    tokenOut,
    amountsIn,
    tokenInDecimals: sharedDecimals.tokenInDecimals,
    tokenOutDecimals: sharedDecimals.tokenOutDecimals,
    sharedAnalyticsStatus: sharedDecimals.status,
    sharedEvidence: sharedDecimals.evidence,
    rows,
    rankingsByAmount,
  };
}
