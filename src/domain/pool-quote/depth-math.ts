import type { DepthCurvePointLike } from "./types";

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
