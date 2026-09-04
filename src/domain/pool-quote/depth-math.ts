import type { DepthCurvePointLike, UpperRangeClassification } from "./types";

/**
 * Phase 6F.1 — pure derived helpers over an already-computed depth
 * curve's `points` array (no RPC, no I/O), plus the bounded-concurrency
 * primitive the depth-curve readers use to fire N quoter simulations
 * without unbounded parallelism.
 *
 * Deliberately kept OUT of `DepthCurve` itself (not stored fields) —
 * these are views over the authoritative sampled curve, computed
 * on-demand, never persisted as part of the domain result. Keeps the
 * curve result itself free of any assumption about which thresholds a
 * caller cares about, and keeps it unambiguous that these values are
 * derived, not independently measured.
 */

/**
 * The largest sampled `amountIn` among points with `status === "QUOTED"`,
 * or `null` if no point qualifies. Does NOT assume `points` is sorted by
 * `amountIn` — scans and compares every point's `amountIn` by value,
 * since callers are explicitly permitted to supply an unsorted ladder
 * (see `read-uniswap-v3-depth-curve.ts`'s/`read-uniswap-v4-depth-
 * curve.ts`'s ladder-validation doc comments) and this helper must not
 * silently assume otherwise.
 *
 * This means EXACTLY "the largest requested trade size that this
 * specific canonical quoter simulation, at this specific block,
 * actually returned a successful decode for" — nothing more. It is NOT:
 *  - the pool's true capacity,
 *  - the exact maximum executable amount (a larger, untested amount
 *    could succeed or fail — this was never sampled),
 *  - continuous/interpolated depth,
 *  - a guarantee that every amount larger than this would fail (a later
 *    sample could fail for an unrelated reason — e.g. a hook-imposed cap
 *    — while an even-larger untested amount might not; nothing here
 *    proves monotonic failure).
 */
export function largestQuotedSample(points: readonly DepthCurvePointLike[]): bigint | null {
  let largest: bigint | null = null;
  for (const point of points) {
    if (point.status !== "QUOTED") continue;
    if (largest === null || point.amountIn > largest) largest = point.amountIn;
  }
  return largest;
}

/**
 * The largest sampled `amountIn` among points with `status === "QUOTED"`
 * AND `priceImpactBps <= thresholdBps` (exact `RationalValue`
 * comparison via cross-multiplication — no floating point, no division),
 * or `null` if no point qualifies (including when no point has
 * `priceImpactBps` at all, e.g. because the curve's shared spot/decimals
 * read failed).
 *
 * This is **sampled depth, not continuous/exact depth** — the true
 * threshold-crossing `amountIn` could be anywhere between this point and
 * the next larger sampled point (which either wasn't `QUOTED`, exceeded
 * the threshold, or simply wasn't requested). Never interpolated, never
 * estimated between samples. `thresholdBps` may be any integer
 * (positive, negative, or zero); a point exactly at the threshold
 * qualifies (`<=`, not `<`).
 */
export function sampledDepthAtBps(points: readonly DepthCurvePointLike[], thresholdBps: number): bigint | null {
  const threshold = BigInt(thresholdBps);
  let largest: bigint | null = null;
  for (const point of points) {
    if (point.status !== "QUOTED" || point.priceImpactBps === undefined) continue;
    const { numerator, denominator } = point.priceImpactBps;
    // denominator > 0n always (see RationalValue's doc comment), so the
    // inequality direction is preserved by cross-multiplying:
    // numerator/denominator <= threshold  <=>  numerator <= threshold * denominator
    if (numerator > threshold * denominator) continue;
    if (largest === null || point.amountIn > largest) largest = point.amountIn;
  }
  return largest;
}

/**
 * Executable-Depth Thresholds — true iff EVERY `QUOTED` point with
 * `amountIn <= amountIn` (the given value) ALSO has `priceImpactBps <=
 * thresholdBps` (same exact cross-multiplied `bigint` comparison
 * `sampledDepthAtBps` itself uses — no floating point). A non-`QUOTED`
 * point at or below the given value is simply skipped (never counted
 * as a violation) — this function answers "did every point we actually
 * MEASURED at or below this size behave consistently with this
 * threshold," not "were all points below this size measured at all"
 * (that is `classifyUpperRange`'s concern, for points ABOVE the given
 * value, not this function's).
 *
 * `false` means a non-monotonic result was directly observed for this
 * threshold: some smaller tested amount showed WORSE impact than a
 * larger one that itself qualifies. This is never treated as an error
 * or used to reject/alter `sampledDepthAtBps`'s own result — it is a
 * pure disclosure signal a caller may surface as a caution alongside
 * an otherwise-valid `qualifying` claim. See `sampledDepthAtBps`'s own
 * doc comment: the true crossing behavior is never assumed monotonic
 * anywhere in this codebase, for any pool family.
 */
export function monotonicityObservedAtOrBelow(points: readonly DepthCurvePointLike[], thresholdBps: number, amountIn: bigint): boolean {
  const threshold = BigInt(thresholdBps);
  for (const point of points) {
    if (point.status !== "QUOTED" || point.priceImpactBps === undefined) continue;
    if (point.amountIn > amountIn) continue;
    const { numerator, denominator } = point.priceImpactBps;
    if (numerator > threshold * denominator) return false;
  }
  return true;
}

/**
 * Executable-Depth Thresholds — the ONE structural classification of
 * what is and is not known about ladder points STRICTLY LARGER than
 * `amountIn` (a qualifying threshold value, typically `sampledDepthAtBps`'s
 * own return value). Exists specifically so a caller/UI can never
 * conflate "the next REQUESTED larger sample" with "the next
 * SUCCESSFULLY MEASURED larger sample" — a point whose impact was
 * genuinely evaluated against the threshold is a stronger, more
 * specific claim than "a larger size was attempted," and a point whose
 * outcome is not actually known must never be silently skipped over
 * when making that claim.
 *
 * A point counts as MEASURED here if and only if BOTH
 * `status === "QUOTED"` AND `priceImpactBps !== undefined`.
 * `status === "QUOTED"` alone is NOT sufficient: a `QUOTED` point whose
 * shared spot/decimals analytics failed still has a valid `amountOut`
 * (see `MatrixCell`'s own doc comment — a successful canonical quote is
 * never downgraded because analytics failed), but that alone does NOT
 * tell us whether ITS impact was above or below any threshold — we
 * simply never computed it. Treating such a point as "measured" would
 * let a `CLEAN_CEILING`/`GAPPED_CEILING`'s `nextMeasuredAmountIn`
 * silently claim a point "exceeded" a threshold that was, in truth,
 * never evaluated at all. Every point that is NOT measured by this
 * definition — `UNQUOTABLE` / `INDETERMINATE` / `RPC_ERROR` /
 * `PRECONDITION_FAILED`, OR `QUOTED` with `priceImpactBps === undefined`
 * — is treated identically: "this specific point's outcome relative to
 * the threshold is not known," which is the only fact this function's
 * callers need to decide what can honestly be claimed about the range
 * above `amountIn`.
 *
 * Does not assume sorted input (scans by value, matching
 * `sampledDepthAtBps`'s own established convention).
 *
 *  - No point has `amountIn` strictly greater than the given value ->
 *    `{kind: "OPEN"}` — nothing larger was even requested; never imply
 *    the pool's true capacity ends at `amountIn`.
 *  - At least one larger point exists and EVERY one of them is
 *    MEASURED -> `{kind: "CLEAN_CEILING", nextMeasuredAmountIn}` — safe
 *    to state "the next tested size exceeded," since nothing in
 *    between was left unevaluated. `nextMeasuredAmountIn` is guaranteed
 *    to have exceeded the threshold this was computed against, by
 *    construction: if it had qualified, `sampledDepthAtBps` would have
 *    returned IT instead of the smaller `amountIn` passed in here (it
 *    always returns the largest qualifying point).
 *  - At least one larger point is NOT measured AND at least one larger
 *    point IS measured -> `{kind: "GAPPED_CEILING", nextMeasuredAmountIn}`
 *    — `nextMeasuredAmountIn` is the smallest MEASURED point among the
 *    larger ones (still guaranteed to have exceeded the threshold, same
 *    reasoning), but at least one intervening point's outcome relative
 *    to the threshold is unknown — never phrase this identically to
 *    `CLEAN_CEILING`.
 *  - At least one larger point exists and NONE of them is measured ->
 *    `{kind: "GAPPED_NO_CEILING"}` — there is no larger measured value
 *    to report at all.
 */
export function classifyUpperRange(points: readonly DepthCurvePointLike[], amountIn: bigint): UpperRangeClassification {
  let anyLarger = false;
  let anyUnmeasuredLarger = false;
  let smallestMeasuredLarger: bigint | null = null;

  for (const point of points) {
    if (point.amountIn <= amountIn) continue;
    anyLarger = true;
    if (point.status !== "QUOTED" || point.priceImpactBps === undefined) {
      anyUnmeasuredLarger = true;
      continue;
    }
    if (smallestMeasuredLarger === null || point.amountIn < smallestMeasuredLarger) {
      smallestMeasuredLarger = point.amountIn;
    }
  }

  if (!anyLarger) return { kind: "OPEN" };
  if (smallestMeasuredLarger === null) return { kind: "GAPPED_NO_CEILING" };
  if (anyUnmeasuredLarger) return { kind: "GAPPED_CEILING", nextMeasuredAmountIn: smallestMeasuredLarger };
  return { kind: "CLEAN_CEILING", nextMeasuredAmountIn: smallestMeasuredLarger };
}

/**
 * Applies `mapper` to every item in `items` with at most `concurrency`
 * in flight at once, and returns results in the SAME order as `items`
 * regardless of which item's `mapper` call actually completes first —
 * `results[i]` is always written from `items[i]`, never reordered by
 * completion time. Bounds worst-case simultaneous `eth_call` load
 * independent of a caller-controlled ladder length, without requiring
 * strictly sequential (slow) execution for the common small-ladder case.
 */
export async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await mapper(item, index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
