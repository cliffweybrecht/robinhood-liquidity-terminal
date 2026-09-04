import type { Address } from "viem";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { createLimiter } from "@/lib/concurrency/limiter";
import { computeExecutionPrice, computePriceImpactBps, computeSpotPrice, readSharedDecimals, type SharedDecimals, type TokenDenomination } from "./analytics";
import { classifyMatrixCandidates } from "./compare-verified-pools-across-amounts";
import type { ComparisonCandidateInput } from "./compare-verified-pools";
import { classifyUpperRange, mapWithBoundedConcurrency, monotonicityObservedAtOrBelow, sampledDepthAtBps } from "./depth-math";
import { DepthThresholdsTooLargeError, DuplicateCandidateError, EmptyCandidatesError, EmptyAmountsLadderError, EmptyThresholdsError, InvalidAmountInError } from "./errors";
import { describeError } from "./read";
import { DEPTH_CURVE_CONCURRENCY } from "./read-uniswap-v3-depth-curve";
import { quoteV3AtBlock, readV3SpotSqrtPriceX96 } from "./read-uniswap-v3-quote";
import { quoteV4AtBlock, readV4SpotSqrtPriceX96, resolveV4Denomination, UINT128_MAX } from "./read-uniswap-v4-quote";
import type {
  BestVenueAtThreshold,
  DepthThresholdOutcome,
  MatrixCandidateRow,
  MatrixCell,
  QuoteStatus,
  RationalValue,
  VerifiedPoolDepthResult,
  VerifiedPoolDepthThresholdsResult,
} from "./types";

/**
 * Executable-Depth Thresholds — bounded-safety limits on
 * `computeVerifiedPoolDepthThresholds`, enforced as structural
 * preconditions (thrown before any RPC call). Deliberately declared
 * as THIS primitive's own constants, NOT imported from
 * `compare-verified-pools-across-amounts.ts`'s `MAX_MATRIX_CELLS`/
 * `MATRIX_QUOTE_CONCURRENCY`/`MATRIX_QUOTE_INTERVAL_MS` — this
 * primitive and the UI V1.1 matrix primitive are PEER canonical
 * orchestration primitives (see the Executable-Depth Thresholds frozen
 * implementation plan, Revision 2), and must not be structurally
 * coupled to one another merely because they happen to share the same
 * frozen numeric policy (the same 60-cell RPC-capacity ceiling and the
 * same concurrency=3/spacing=100ms dispatch policy the matrix already
 * uses) — mirroring the SAME "separate classes, same reasoning, per
 * primitive" precedent this codebase already established for
 * `TooManyAmountsError`/`MatrixTooLargeError`. The NUMBERS are frozen
 * and intentionally identical to the matrix's own; the BINDING is
 * deliberately independent.
 */
export const MAX_DEPTH_THRESHOLD_CELLS = 60;
export const DEPTH_THRESHOLD_QUOTE_CONCURRENCY = 3;
export const DEPTH_THRESHOLD_QUOTE_INTERVAL_MS = 100;

export interface ComputeVerifiedPoolDepthThresholdsInput {
  readonly candidates: readonly ComparisonCandidateInput[];
  readonly tokenIn: Address;
  /** The fixed 12-value ladder, in RAW base units — this primitive owns no default ladder; the frozen ladder values themselves are a product/orchestration-layer concern (see `compareDepthThresholds.ts`). NOT assumed sorted, NOT silently sorted, NOT deduplicated — identical contract to the matrix's own `amountsIn`. */
  readonly amountsIn: readonly bigint[];
  /** The fixed threshold set, in bps — this primitive owns no default threshold set either; the frozen `[50, 100, 200, 500]` values live at the orchestration layer, exactly mirroring `amountsIn`'s own placement. */
  readonly thresholdsBps: readonly number[];
  readonly rpc: VerifiedRobinhoodRpcClient;
}

type ExecutableRow = ReturnType<typeof classifyMatrixCandidates>["executable"][number];

interface SpotClassification {
  readonly analyticsStatus: SharedDecimals["status"];
  readonly evidence: MatrixCell["evidence"];
  readonly sqrtPriceX96?: bigint;
}

/**
 * Depth-local classification glue — mirrors `compare-verified-pools-
 * across-amounts.ts`'s own private `classifySpot` in OBSERVABLE
 * BEHAVIOR ONLY (same three-branch rpc_error/decode_error/
 * semantically-impossible-zero classification): a THIRD independent
 * restatement of this small, stable classification logic (the first
 * being `compare-verified-pools.ts`'s own private original, the second
 * being the matrix's own restatement of it) — deliberately NOT
 * imported from either existing file, per the Executable-Depth
 * Thresholds frozen implementation plan's explicit instruction to
 * "prefer a small amount of depth-local status/classification glue
 * over coupling two high-level canonical primitives together." This is
 * classification glue, not AMM math — the actual math
 * (`computeSpotPrice`/`computeExecutionPrice`/`computePriceImpactBps`)
 * is reused verbatim from `analytics.ts` below, never re-derived.
 */
function classifySpotForDepth(outcome: Awaited<ReturnType<typeof readV3SpotSqrtPriceX96>>, source: string): SpotClassification {
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
        detail: "Pre-trade spot sqrtPriceX96 decoded and shape-validated at the exact pinned depth-threshold request's block.",
      },
    ],
    sqrtPriceX96: outcome.value,
  };
}

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

/**
 * Depth-local dispatch glue — mirrors the matrix's own private
 * `executeCell` in OBSERVABLE BEHAVIOR ONLY: dispatches one
 * (pool, amountIn) canonical quote at the pinned block, applies the
 * SAME V4 `AMOUNT_IN_EXCEEDS_V4_BOUND` PER-CELL precondition check (a
 * larger sampled size may exceed `V4Quoter`'s `uint128` bound while
 * smaller sizes in the SAME ladder, and every sibling pool, remain
 * fully valid — this is exactly why this check lives here, per cell,
 * never as a whole-ladder/whole-curve abort), and computes
 * `executionPrice`/`priceImpactBps` via the SAME shared math every
 * other quote path uses. Deliberately NOT imported from the matrix's
 * own `executeCell` — an independently-written implementation of the
 * same small dispatch logic, not a shared reference to it (see this
 * file's header comment on `classifySpotForDepth` for the full
 * reasoning, which applies identically here).
 */
async function quoteLadderCellForDepth(
  row: ExecutableRow,
  amountIn: bigint,
  blockNumber: bigint,
  tokenInIsToken0: boolean,
  sharedDecimals: SharedDecimals,
  spot: SpotClassification,
  rpc: VerifiedRobinhoodRpcClient,
): Promise<MatrixCell> {
  if (row.kind === "v4" && amountIn > UINT128_MAX) {
    return {
      amountIn,
      status: "PRECONDITION_FAILED",
      analyticsStatus: "INDETERMINATE",
      evidence: [],
      preconditionFailure: {
        code: "AMOUNT_IN_EXCEEDS_V4_BOUND",
        detail: `amountIn (${amountIn}) exceeds V4Quoter's exactAmount uint128 bound (max ${UINT128_MAX}) — this sample cannot be quoted at this amount, though smaller samples in the same ladder, and sibling pools, may still be valid.`,
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
          },
          amountIn,
          blockNumber,
          rpc,
        );

  // RELEASE-CRITICAL: attempt.status/attempt.amountOut are NEVER
  // altered because of spot/decimals analytics outcome — only
  // executionPrice/priceImpactBps depend on that. A successful
  // canonical quote remains QUOTED regardless.
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
 * Pure, zero-RPC per-(pool,threshold) derivation — see
 * `DepthThresholdOutcome`'s own doc comment (`types.ts`) for the full
 * state-machine reasoning. Checked in order: ladder-level
 * (`NO_QUOTED_SAMPLES` — no point even reached `QUOTED`),
 * pool-level (`ANALYTICS_UNAVAILABLE` — at least one point IS `QUOTED`,
 * but NONE has a defined `priceImpactBps`), then per-threshold
 * (`EXCEEDED_AT_SMALLEST_SAMPLE` / `WITHIN_THRESHOLD`).
 *
 * Deliberately does NOT take the request's shared `sharedAnalyticsStatus`
 * as a parameter and branch on it directly — `priceImpactBps` can be
 * undefined on every cell for TWO independent reasons: the request-wide
 * shared decimals read failed, OR this SPECIFIC pool's own spot read
 * failed (a per-pool fact the shared decimals status says nothing
 * about) — `computeCellPricing` already correctly requires BOTH to
 * succeed before setting `priceImpactBps` on any cell, so checking
 * "does any QUOTED cell have a defined `priceImpactBps`" directly is
 * the single, fully general signal that subsumes both failure modes
 * uniformly, without this function needing to know which one occurred.
 */
function deriveThresholdOutcome(cells: readonly MatrixCell[], thresholdBps: number): DepthThresholdOutcome {
  const anyQuoted = cells.some((c) => c.status === "QUOTED");
  if (!anyQuoted) {
    return { kind: "NO_QUOTED_SAMPLES" };
  }

  let smallestMeasured: bigint | null = null;
  for (const cell of cells) {
    if (cell.status !== "QUOTED" || cell.priceImpactBps === undefined) continue;
    if (smallestMeasured === null || cell.amountIn < smallestMeasured) smallestMeasured = cell.amountIn;
  }
  if (smallestMeasured === null) {
    return { kind: "ANALYTICS_UNAVAILABLE" };
  }

  const qualifying = sampledDepthAtBps(cells, thresholdBps);
  if (qualifying === null) {
    return { kind: "EXCEEDED_AT_SMALLEST_SAMPLE", smallestMeasuredAmountIn: smallestMeasured };
  }

  return {
    kind: "WITHIN_THRESHOLD",
    qualifyingAmountIn: qualifying,
    monotonicityObserved: monotonicityObservedAtOrBelow(cells, thresholdBps, qualifying),
    upperRange: classifyUpperRange(cells, qualifying),
  };
}

/**
 * Executable-Depth Thresholds — a same-block, per-pool sampled
 * execution-depth primitive across N already identity-VERIFIED
 * Uniswap V3/V4 pools (all sharing the exact same verified
 * `tokenIn`/`tokenOut` pair) x a caller-supplied fixed ladder of
 * exact `amountIn` samples, evaluated against a caller-supplied set of
 * price-impact thresholds. The canonical PEER primitive to
 * `compareVerifiedPoolsExactInput` (6F.2, one size) and
 * `compareVerifiedPoolsAcrossExactInputs` (UI V1.1, cross-pool x
 * cross-size matrix) — built DIRECTLY on the same shared lower-level
 * primitives all three already use, never a wrapper around any
 * higher-level entry point (see this file's header on
 * `classifySpotForDepth`/`quoteLadderCellForDepth` for why composing
 * on top of 6F.1's top-level depth-curve readers was rejected: their
 * current V4 ladder-wide `uint128` validation aborts the WHOLE curve
 * for one oversized point, coarser than the per-cell isolation this
 * primitive requires — and why composing on top of the matrix's own
 * `executeCell`/`classifySpot` was rejected: this primitive and the
 * matrix must remain structurally independent PEER primitives, never
 * coupled to one another's internals).
 *
 * Orchestration, in order:
 *  1. Structural preconditions (before any RPC call), mirroring the
 *     matrix's own identical checks: empty `candidates`
 *     (`EmptyCandidatesError`), a duplicate pool in `candidates`
 *     (`DuplicateCandidateError`), empty `amountsIn`
 *     (`EmptyAmountsLadderError`), a non-positive `amountIn`
 *     (`InvalidAmountInError`), empty `thresholdsBps`
 *     (`EmptyThresholdsError`).
 *  2. `classifyMatrixCandidates` (pure, zero RPC) partitions candidates
 *     into `executable` rows and row-wide `PRECONDITION_FAILED` rows,
 *     and establishes the one shared verified `tokenOut` — reused
 *     VERBATIM from the matrix's own file (see this module's own doc
 *     comment on why this ONE reuse is justified and non-coupling).
 *  3. `executable.length * amountsIn.length > MAX_DEPTH_THRESHOLD_CELLS`
 *     throws `DepthThresholdsTooLargeError` here, computed against the
 *     EXECUTABLE count only, never the raw candidate count.
 *  4. Exactly ONE `eth_blockNumber` call pins `blockNumber` for the
 *     ENTIRE request — every spot read, the one shared decimals read,
 *     and every quoter call in this SAME request use this identical
 *     value. Failure -> `{status: "BLOCK_PIN_FAILURE", ...}`.
 *  5. Exactly ONE shared decimals read (`readSharedDecimals`).
 *  6. Exactly ONE spot read PER EXECUTABLE POOL (never per sample),
 *     fired via `mapWithBoundedConcurrency`/`DEPTH_CURVE_CONCURRENCY`
 *     — the SAME bounded-concurrency primitive/constant the matrix
 *     already uses for this exact kind of small, one-time, per-pool
 *     fan-out (a genuinely shared, protocol-generic constant from a
 *     THIRD, neutral file — not matrix-internal).
 *  7. The `executable.length x amountsIn.length` cell list is flattened
 *     and dispatched through ONE `createLimiter({concurrency:
 *     DEPTH_THRESHOLD_QUOTE_CONCURRENCY, intervalMs:
 *     DEPTH_THRESHOLD_QUOTE_INTERVAL_MS})` instance (this primitive's
 *     OWN constants — never the matrix's), every cell via the depth-
 *     local `quoteLadderCellForDepth`.
 *  8. Per-pool, per-threshold derivation (`deriveThresholdOutcome`,
 *     pure, zero RPC) — the state machine in `DepthThresholdOutcome`'s
 *     own doc comment.
 *  9. Best-venue roll-up (pure, zero RPC): per threshold, the maximum
 *     `qualifyingAmountIn` among `WITHIN_THRESHOLD` pools, exact bigint
 *     comparison, every tie preserved.
 * 10. The final result includes EVERY row — executable and
 *     precondition-failed — in original candidate order; a
 *     precondition-failed row's `outcomesByThreshold` is empty.
 *
 * Never caches any quote result across calls — every call performs its
 * own fresh block pin, shared decimals read, spot reads, and quoter
 * calls, unconditionally, exactly matching this module's other entry
 * points' own existing no-caching guarantee.
 */
export async function computeVerifiedPoolDepthThresholds(input: ComputeVerifiedPoolDepthThresholdsInput): Promise<VerifiedPoolDepthThresholdsResult> {
  const { candidates, tokenIn, amountsIn, thresholdsBps, rpc } = input;

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
  if (thresholdsBps.length === 0) {
    throw new EmptyThresholdsError();
  }

  const { executable, preconditionFailed, tokenOut } = classifyMatrixCandidates(candidates, tokenIn, rpc.chainId);

  if (executable.length * amountsIn.length > MAX_DEPTH_THRESHOLD_CELLS) {
    throw new DepthThresholdsTooLargeError(executable.length, amountsIn.length, MAX_DEPTH_THRESHOLD_CELLS);
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
      evidence: [
        {
          kind: "BLOCK_PIN_FAILURE",
          outcome: "rpc_error",
          source: "eth_blockNumber",
          detail: `Could not pin a block for this depth-threshold request: ${describeError(error)}`,
        },
      ],
    };
  }

  const firstV4 = executable.find((r): r is Extract<ExecutableRow, { kind: "v4" }> => r.kind === "v4");
  const tokenInDenomination: TokenDenomination = firstV4 ? resolveV4Denomination(firstV4.tokenIn) : { kind: "ERC20", address: tokenIn };
  const tokenOutDenomination: TokenDenomination = firstV4 ? resolveV4Denomination(firstV4.tokenOut) : { kind: "ERC20", address: tokenOut };

  const [sharedDecimals, spotByRow] = await Promise.all([
    readSharedDecimals({ rpc, tokenInDenomination, tokenOutDenomination, blockNumber }),
    mapWithBoundedConcurrency(executable, DEPTH_CURVE_CONCURRENCY, async (row) => {
      const outcome =
        row.kind === "v3"
          ? await readV3SpotSqrtPriceX96(rpc, row.resolvedInputs.pairAddress, blockNumber)
          : await readV4SpotSqrtPriceX96(rpc, row.stateViewAddress, row.poolId, blockNumber);
      return classifySpotForDepth(outcome, row.kind === "v3" ? "pool.slot0()" : "StateView.getSlot0(poolId)");
    }),
  ]);

  const limiter = createLimiter({ concurrency: DEPTH_THRESHOLD_QUOTE_CONCURRENCY, intervalMs: DEPTH_THRESHOLD_QUOTE_INTERVAL_MS });

  const rowCells: MatrixCell[][] = executable.map(() => new Array(amountsIn.length));
  const cellTasks: Array<Promise<void>> = [];
  for (let rowIndex = 0; rowIndex < executable.length; rowIndex++) {
    const row = executable[rowIndex]!;
    const spot = spotByRow[rowIndex]!;
    for (let amountIndex = 0; amountIndex < amountsIn.length; amountIndex++) {
      const amountIn = amountsIn[amountIndex]!;
      cellTasks.push(
        limiter.schedule(() => quoteLadderCellForDepth(row, amountIn, blockNumber, tokenInIsToken0, sharedDecimals, spot, rpc)).then((cell) => {
          rowCells[rowIndex]![amountIndex] = cell;
        }),
      );
    }
  }
  await Promise.all(cellTasks);

  const executableResults: VerifiedPoolDepthResult[] = executable.map((row, rowIndex) => {
    const cells = rowCells[rowIndex]!;
    const matrixRow: MatrixCandidateRow = {
      pool: row.input.identity.pool,
      family: row.kind === "v3" ? "UNISWAP_V3" : "UNISWAP_V4",
      identityVerificationBlock: row.identityVerificationBlock,
      hookDataCallerSupplied: row.kind === "v4" && row.isHooked ? row.hookDataCallerSupplied || undefined : undefined,
      cells,
    };
    return {
      row: matrixRow,
      outcomesByThreshold: thresholdsBps.map((thresholdBps) => ({
        thresholdBps,
        outcome: deriveThresholdOutcome(cells, thresholdBps),
      })),
    };
  });

  const preconditionFailedResults: VerifiedPoolDepthResult[] = preconditionFailed.map((row) => ({
    row: {
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
    },
    outcomesByThreshold: [],
  }));

  // Preserve original candidate input order across BOTH executable and
  // precondition-failed results — never grouped/reordered by outcome.
  const resultsByInput = new Map<ComparisonCandidateInput, VerifiedPoolDepthResult>();
  executable.forEach((row, i) => resultsByInput.set(row.input, executableResults[i]!));
  preconditionFailed.forEach((row, i) => resultsByInput.set(row.input, preconditionFailedResults[i]!));
  const pools = candidates.map((c) => resultsByInput.get(c)!);

  const bestVenueByThreshold: BestVenueAtThreshold[] = thresholdsBps.map((thresholdBps) => {
    let max: bigint | null = null;
    for (const result of executableResults) {
      const outcome = result.outcomesByThreshold.find((o) => o.thresholdBps === thresholdBps)?.outcome;
      if (outcome?.kind !== "WITHIN_THRESHOLD") continue;
      if (max === null || outcome.qualifyingAmountIn > max) max = outcome.qualifyingAmountIn;
    }
    const poolAddresses =
      max === null
        ? []
        : executableResults
            .filter((result) => {
              const outcome = result.outcomesByThreshold.find((o) => o.thresholdBps === thresholdBps)?.outcome;
              return outcome?.kind === "WITHIN_THRESHOLD" && outcome.qualifyingAmountIn === max;
            })
            .map((result) => result.row.pool.pairAddress);
    return { thresholdBps, poolAddresses };
  });

  return {
    status: "OK",
    blockNumber,
    tokenIn,
    tokenOut,
    ladderAmountsIn: amountsIn,
    thresholdsBps,
    tokenInDecimals: sharedDecimals.tokenInDecimals,
    tokenOutDecimals: sharedDecimals.tokenOutDecimals,
    sharedAnalyticsStatus: sharedDecimals.status,
    sharedEvidence: sharedDecimals.evidence,
    pools,
    bestVenueByThreshold,
  };
}

// Exported for tests only — see the adversarial-pre-commit-pass test
// "quoted-but-impact-unavailable is treated as a threshold gap, never
// as a confirmed 'exceeded' ceiling" in this file's own test suite.
// This exact per-cell divergence (one ladder point QUOTED with
// priceImpactBps undefined while SIBLING points in the SAME row have a
// defined priceImpactBps) is NOT reachable through the full RPC-mocked
// end-to-end harness as this primitive is currently architected — spot
// classification is per-POOL (one spot read shared across a pool's
// entire 12-point ladder) and shared-decimals classification is per-
// REQUEST, so within one pool's own ladder, priceImpactBps
// availability is genuinely all-or-nothing today. `deriveThresholdOutcome`
// itself makes no such assumption (nor does `classifyUpperRange`, the
// pure helper it calls) — testing it directly, with a hand-constructed
// `MatrixCell[]` fixture, against the REAL production function (not a
// reimplementation) is the correct, honest way to exercise this
// defensive case.
export { deriveThresholdOutcome as deriveThresholdOutcomeForTesting };
