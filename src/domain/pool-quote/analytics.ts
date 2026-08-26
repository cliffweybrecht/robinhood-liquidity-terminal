import type { Address } from "viem";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { decodeUint8Return } from "./abi/decode";
import { encodeDecimalsCall } from "./abi/selectors";
import { describeError } from "./read";
import type { QuoteAnalytics, QuoteAnalyticsStatus, QuoteEvidence, RationalValue } from "./types";

/**
 * Phase 6E.2 — pure price/impact math (no RPC, no I/O) plus the shared
 * RPC orchestration that assembles a `QuoteAnalytics` result from three
 * same-block reads: the protocol-specific pre-trade spot read (V3
 * `slot0()` / V4 `StateView.getSlot0(poolId)` — supplied by the caller
 * as `readSpotSqrtPriceX96`, so this file stays protocol-agnostic) and
 * `decimals()` for both `tokenIn`/`tokenOut`. Shared between
 * `read-uniswap-v3-quote.ts` and `read-uniswap-v4-quote.ts` so the
 * math/assembly logic is written exactly once — only the protocol-
 * specific spot-state call differs between them.
 */

const Q192 = 1n << 192n;

/**
 * Same-block pre-trade spot price, `tokenOut` per `tokenIn`, as an exact
 * rational. `sqrtPriceX96` represents `sqrt(token1/token0) * 2^96` by
 * Uniswap convention (token0/token1 ordered by address, independent of
 * trade direction) — `tokenInIsToken0` selects which side of that ratio
 * corresponds to the actual requested trade direction; the decimal
 * normalization (`10^(decimalsIn - decimalsOut)`) has the identical
 * closed form regardless of which branch was taken (verified
 * algebraically and against live data during Phase 6E.2 architecture
 * research). The exponent's sign — never `tokenInIsToken0` — decides
 * whether the scaling factor multiplies the numerator or the
 * denominator, avoiding any negative `bigint` exponent.
 */
export function computeSpotPrice(sqrtPriceX96: bigint, tokenInIsToken0: boolean, decimalsIn: number, decimalsOut: number): RationalValue {
  const rawNumerator = tokenInIsToken0 ? sqrtPriceX96 * sqrtPriceX96 : Q192;
  const rawDenominator = tokenInIsToken0 ? Q192 : sqrtPriceX96 * sqrtPriceX96;
  const exponent = decimalsIn - decimalsOut;
  return exponent >= 0
    ? { numerator: rawNumerator * 10n ** BigInt(exponent), denominator: rawDenominator }
    : { numerator: rawNumerator, denominator: rawDenominator * 10n ** BigInt(-exponent) };
}

/** Normalized execution price, `tokenOut` per `tokenIn`, as an exact rational. No direction branching needed — `amountIn`/`amountOut` are already the correct trade-direction values by construction. */
export function computeExecutionPrice(amountIn: bigint, amountOut: bigint, decimalsIn: number, decimalsOut: number): RationalValue {
  return { numerator: amountOut * 10n ** BigInt(decimalsIn), denominator: amountIn * 10n ** BigInt(decimalsOut) };
}

/**
 * Signed execution impact vs pre-trade pool spot, in bps, as an exact
 * rational: `(spotPrice - executionPrice) / spotPrice * 10000`. Positive
 * = execution worse than spot. Negative = execution better than spot —
 * never clamped (see `QuoteAnalytics`'s doc comment in `./types.ts`).
 * `executionPrice.denominator` and `spotPrice.numerator` are always
 * strictly positive by construction (see callers), so the returned
 * `denominator` is always `> 0n`.
 */
export function computePriceImpactBps(spotPrice: RationalValue, executionPrice: RationalValue): RationalValue {
  const numerator = (spotPrice.numerator * executionPrice.denominator - executionPrice.numerator * spotPrice.denominator) * 10000n;
  const denominator = executionPrice.denominator * spotPrice.numerator;
  return { numerator, denominator };
}

type SupportingReadOutcome<T> =
  | { readonly outcome: "ok"; readonly value: T }
  | { readonly outcome: "rpc_error"; readonly detail: string }
  | { readonly outcome: "decode_error"; readonly detail: string };

async function readDecimals(rpc: VerifiedRobinhoodRpcClient, token: Address, blockNumber: bigint): Promise<SupportingReadOutcome<number>> {
  let raw;
  try {
    raw = await rpc.call({ to: token, data: encodeDecimalsCall() }, blockNumber);
  } catch (error) {
    return { outcome: "rpc_error", detail: describeError(error) };
  }
  const decimals = decodeUint8Return(raw);
  if (decimals === null) {
    return { outcome: "decode_error", detail: `decimals() return data could not be decoded into a valid uint8 (raw: ${raw}).` };
  }
  return { outcome: "ok", value: decimals };
}

export interface AssembleQuoteAnalyticsArgs {
  readonly rpc: VerifiedRobinhoodRpcClient;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly blockNumber: bigint;
  readonly tokenInIsToken0: boolean;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /**
   * Performs the protocol-specific pre-trade spot read (V3 `slot0()` on
   * the pool / V4 `StateView.getSlot0(poolId)`) at `blockNumber` and
   * strictly decodes it down to `sqrtPriceX96` only — the caller owns
   * the encode/decode specifics; this function owns everything else
   * (decimals reads, classification, math).
   */
  readonly readSpotSqrtPriceX96: () => Promise<SupportingReadOutcome<bigint>>;
  /** Human-readable call description for evidence, e.g. `"pool.slot0()"` / `"StateView.getSlot0(poolId)"`. */
  readonly spotEvidenceSource: string;
}

/**
 * Fires the pre-trade spot read and both `decimals()` reads concurrently
 * — all three are independent, side-effect-free reads already pinned to
 * the identical `blockNumber` the caller established (see
 * `read-uniswap-v3-quote.ts`/`read-uniswap-v4-quote.ts`'s analytics
 * wrappers), so there is no ordering requirement between them and no
 * benefit to staging them sequentially. Classifies the combined outcome
 * into `QuoteAnalyticsStatus` and, only when every read is clean and
 * `sqrtPriceX96 !== 0`, computes the full price/impact trio.
 */
export async function assembleQuoteAnalytics(args: AssembleQuoteAnalyticsArgs): Promise<QuoteAnalytics> {
  const { rpc, tokenIn, tokenOut, blockNumber, tokenInIsToken0, amountIn, amountOut, readSpotSqrtPriceX96, spotEvidenceSource } = args;

  const [spotOutcome, decInOutcome, decOutOutcome] = await Promise.all([
    readSpotSqrtPriceX96(),
    readDecimals(rpc, tokenIn, blockNumber),
    readDecimals(rpc, tokenOut, blockNumber),
  ]);

  const evidence: QuoteEvidence[] = [];

  evidence.push(
    spotOutcome.outcome === "ok"
      ? {
          kind: "SPOT_READ",
          outcome: "ok",
          source: spotEvidenceSource,
          observed: `sqrtPriceX96=${spotOutcome.value}`,
          detail: "Pre-trade spot sqrtPriceX96 decoded and shape-validated at the exact pinned quote block.",
        }
      : { kind: "SPOT_READ", outcome: spotOutcome.outcome, source: spotEvidenceSource, detail: spotOutcome.detail },
  );

  let sqrtPriceZero = false;
  if (spotOutcome.outcome === "ok" && spotOutcome.value === 0n) {
    sqrtPriceZero = true;
    evidence.push({
      kind: "SPOT_READ",
      outcome: "decode_error",
      source: spotEvidenceSource,
      detail:
        "sqrtPriceX96 decoded to exactly zero on an already-VERIFIED pool identity — semantically impossible for an initialized pool; analytics fails closed.",
    });
  }

  evidence.push(
    decInOutcome.outcome === "ok"
      ? {
          kind: "DECIMALS_READ",
          outcome: "ok",
          source: "tokenIn.decimals()",
          observed: String(decInOutcome.value),
          detail: "tokenIn ERC20 decimals() decoded to a valid uint8 at the exact pinned quote block.",
        }
      : { kind: "DECIMALS_READ", outcome: decInOutcome.outcome, source: "tokenIn.decimals()", detail: decInOutcome.detail },
  );

  evidence.push(
    decOutOutcome.outcome === "ok"
      ? {
          kind: "DECIMALS_READ",
          outcome: "ok",
          source: "tokenOut.decimals()",
          observed: String(decOutOutcome.value),
          detail: "tokenOut ERC20 decimals() decoded to a valid uint8 at the exact pinned quote block.",
        }
      : { kind: "DECIMALS_READ", outcome: decOutOutcome.outcome, source: "tokenOut.decimals()", detail: decOutOutcome.detail },
  );

  const anyRpcError = spotOutcome.outcome === "rpc_error" || decInOutcome.outcome === "rpc_error" || decOutOutcome.outcome === "rpc_error";
  const anyDecodeError = spotOutcome.outcome === "decode_error" || decInOutcome.outcome === "decode_error" || decOutOutcome.outcome === "decode_error";

  let status: QuoteAnalyticsStatus;
  if (anyRpcError) status = "RPC_ERROR";
  else if (anyDecodeError || sqrtPriceZero) status = "INDETERMINATE";
  else status = "OK";

  if (status !== "OK" || spotOutcome.outcome !== "ok" || decInOutcome.outcome !== "ok" || decOutOutcome.outcome !== "ok") {
    return { status, priceUnit: "tokenOut_per_tokenIn", evidence };
  }

  const tokenInDecimals = decInOutcome.value;
  const tokenOutDecimals = decOutOutcome.value;
  const spotPrice = computeSpotPrice(spotOutcome.value, tokenInIsToken0, tokenInDecimals, tokenOutDecimals);
  const executionPrice = computeExecutionPrice(amountIn, amountOut, tokenInDecimals, tokenOutDecimals);
  const priceImpactBps = computePriceImpactBps(spotPrice, executionPrice);

  return {
    status: "OK",
    tokenInDecimals,
    tokenOutDecimals,
    spotPrice,
    executionPrice,
    priceImpactBps,
    priceUnit: "tokenOut_per_tokenIn",
    evidence,
  };
}
