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
 *
 * Phase 6F.1 additionally extracts `readSpotAndDecimals` as its own
 * exported function (the same three reads `assembleQuoteAnalytics`
 * already performed, now factored out so a caller — the depth-curve
 * readers — can perform this shared read EXACTLY ONCE per curve and
 * reuse the result across every sampled point, rather than once per
 * point). `assembleQuoteAnalytics`'s own external behavior is
 * UNCHANGED — it now simply calls `readSpotAndDecimals` internally
 * before computing the execution price/impact for its one `amountIn`/
 * `amountOut` pair, verified by the full existing analytics test suite
 * passing unmodified.
 *
 * Post-review revision (still Phase 6F.1): decimals resolution no longer
 * infers "V4 native ETH" from an `Address` value anywhere in this file —
 * see `TokenDenomination`'s doc comment below for why, and for exactly
 * where that trust boundary now lives instead.
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

/**
 * How one side of a quote is denominated, for the purpose of resolving
 * `decimals`. Deliberately a discriminated union, NOT a bare `Address` —
 * this is the entire fix for the trust-boundary issue an earlier revision
 * of this file had: that revision let `readDecimals` itself inspect an
 * `Address` value and independently conclude "this is the zero address,
 * therefore it must be V4 native ETH, therefore 18 decimals, no
 * `eth_call`." That inference lived in GENERIC, protocol-agnostic code
 * with no way to prove the zero address it was looking at actually came
 * from a verified V4 `PoolKey` currency, rather than from anywhere else
 * (in principle, any future caller of this shared module). Its safety
 * depended entirely on every current and future caller happening to
 * maintain that invariant by convention — never structurally enforced.
 *
 * Now: the `"V4_NATIVE_ETH"` variant carries NO `Address` field at all.
 * There is no address value anywhere in this type that could equal, or
 * be mistaken for, the zero address — the ONLY way to obtain a
 * `TokenDenomination` with `kind === "V4_NATIVE_ETH"` is for a caller to
 * construct that exact literal itself. `read-uniswap-v3-quote.ts`/
 * `read-uniswap-v3-depth-curve.ts` NEVER construct it (V3 has no native-
 * currency concept at the pool level — every V3 denomination this module
 * ever receives is `{ kind: "ERC20", address }`). `read-uniswap-v4-
 * quote.ts`/`read-uniswap-v4-depth-curve.ts` construct it via their own
 * `resolveV4Denomination` helper, called ONLY with a value already
 * proven — by that same file's `resolveV4TokenDirection` — to be exactly
 * `identity.poolKey.currency0` or `identity.poolKey.currency1`, the
 * VERIFIED PoolKey Phase 6C.2 independently established on-chain. A
 * caller-supplied, unverified `LiquidityPool`'s `baseToken`/`quoteToken`
 * metadata is never consulted anywhere in that derivation.
 *
 * `readDecimals`/`readSpotAndDecimals`/`assembleQuoteAnalytics` below
 * never perform an address-equality check against the zero address (or
 * against any other "special" value) anywhere in this file — they only
 * ever switch on `denomination.kind`, a value they cannot second-guess
 * or independently re-derive.
 */
export type TokenDenomination = { readonly kind: "ERC20"; readonly address: Address } | { readonly kind: "V4_NATIVE_ETH" };

/** Protocol-defined: the V4 native chain currency is always 18 decimals — a fact about the protocol, not inferred from any address, not read, not assumed for anything else. Reached ONLY via `TokenDenomination`'s `"V4_NATIVE_ETH"` variant. */
const NATIVE_CURRENCY_DECIMALS = 18;

/**
 * Resolves `decimals` for one `TokenDenomination`. For `"ERC20"`, this is
 * always a real on-chain `decimals()` `eth_call` — unconditionally, for
 * every address, no exceptions, no shortcuts. For `"V4_NATIVE_ETH"`, no
 * `eth_call` is made at all (there is no `Address` in this variant to
 * call in the first place) — `NATIVE_CURRENCY_DECIMALS` is returned
 * directly. See `TokenDenomination`'s doc comment for the full trust
 * reasoning.
 */
async function readDecimals(rpc: VerifiedRobinhoodRpcClient, denomination: TokenDenomination, blockNumber: bigint): Promise<SupportingReadOutcome<number>> {
  if (denomination.kind === "V4_NATIVE_ETH") {
    return { outcome: "ok", value: NATIVE_CURRENCY_DECIMALS };
  }
  let raw;
  try {
    raw = await rpc.call({ to: denomination.address, data: encodeDecimalsCall() }, blockNumber);
  } catch (error) {
    return { outcome: "rpc_error", detail: describeError(error) };
  }
  const decimals = decodeUint8Return(raw);
  if (decimals === null) {
    return { outcome: "decode_error", detail: `decimals() return data could not be decoded into a valid uint8 (raw: ${raw}).` };
  }
  return { outcome: "ok", value: decimals };
}

export interface ReadSpotAndDecimalsArgs {
  readonly rpc: VerifiedRobinhoodRpcClient;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** How `tokenIn` is denominated for `decimals` resolution — see `TokenDenomination`'s doc comment. `tokenIn`/`tokenOut` above remain the addresses used for orientation/evidence/result fields; `tokenInDenomination`/`tokenOutDenomination` are consulted ONLY for `decimals`. */
  readonly tokenInDenomination: TokenDenomination;
  readonly tokenOutDenomination: TokenDenomination;
  readonly blockNumber: bigint;
  readonly tokenInIsToken0: boolean;
  /**
   * Performs the protocol-specific pre-trade spot read (V3 `slot0()` on
   * the pool / V4 `StateView.getSlot0(poolId)`) at `blockNumber` and
   * strictly decodes it down to `sqrtPriceX96` only — the caller owns
   * the encode/decode specifics; this function owns everything else
   * (decimals reads, classification).
   */
  readonly readSpotSqrtPriceX96: () => Promise<SupportingReadOutcome<bigint>>;
  /** Human-readable call description for evidence, e.g. `"pool.slot0()"` / `"StateView.getSlot0(poolId)"`. */
  readonly spotEvidenceSource: string;
}

/** The shared, amountIn/amountOut-independent portion of a `QuoteAnalytics` result: pre-trade spot price and both tokens' decimals, at one pinned block. */
export interface SharedSpotAndDecimals {
  readonly status: QuoteAnalyticsStatus;
  /** Present only when `status === "OK"`. */
  readonly tokenInDecimals?: number;
  /** Present only when `status === "OK"`. */
  readonly tokenOutDecimals?: number;
  /** Present only when `status === "OK"`. */
  readonly spotPrice?: RationalValue;
  readonly evidence: readonly QuoteEvidence[];
}

/**
 * Fires the pre-trade spot read and both `decimals()` reads concurrently
 * — all three are independent, side-effect-free reads already pinned to
 * the identical `blockNumber` the caller established — and classifies
 * the combined outcome into `QuoteAnalyticsStatus`. Contains NO
 * `amountIn`/`amountOut`-dependent computation at all, precisely so a
 * caller with N trade sizes at one block (the depth-curve readers) can
 * call this exactly ONCE and reuse the resulting `spotPrice`/decimals
 * for every sampled point via `computeExecutionPrice`/
 * `computePriceImpactBps` directly — never re-reading spot/decimals per
 * point.
 *
 * Decimals resolution is driven entirely by `args.tokenInDenomination`/
 * `tokenOutDenomination` — this function never inspects `tokenIn`/
 * `tokenOut` (the plain addresses) to decide HOW to resolve decimals; it
 * only uses them for evidence/orientation. See `TokenDenomination`'s
 * doc comment.
 */
export async function readSpotAndDecimals(args: ReadSpotAndDecimalsArgs): Promise<SharedSpotAndDecimals> {
  const { rpc, tokenInDenomination, tokenOutDenomination, blockNumber, readSpotSqrtPriceX96, spotEvidenceSource } = args;

  const [spotOutcome, decInOutcome, decOutOutcome] = await Promise.all([
    readSpotSqrtPriceX96(),
    readDecimals(rpc, tokenInDenomination, blockNumber),
    readDecimals(rpc, tokenOutDenomination, blockNumber),
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
          detail:
            tokenInDenomination.kind === "V4_NATIVE_ETH"
              ? "tokenIn is the VERIFIED V4 PoolKey's native-currency denomination — decimals resolved as the protocol-defined constant 18, no eth_call made."
              : "tokenIn ERC20 decimals() decoded to a valid uint8 at the exact pinned quote block.",
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
          detail:
            tokenOutDenomination.kind === "V4_NATIVE_ETH"
              ? "tokenOut is the VERIFIED V4 PoolKey's native-currency denomination — decimals resolved as the protocol-defined constant 18, no eth_call made."
              : "tokenOut ERC20 decimals() decoded to a valid uint8 at the exact pinned quote block.",
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
    return { status, evidence };
  }

  return {
    status: "OK",
    tokenInDecimals: decInOutcome.value,
    tokenOutDecimals: decOutOutcome.value,
    spotPrice: computeSpotPrice(spotOutcome.value, args.tokenInIsToken0, decInOutcome.value, decOutOutcome.value),
    evidence,
  };
}

export interface ReadSharedDecimalsArgs {
  readonly rpc: VerifiedRobinhoodRpcClient;
  readonly tokenInDenomination: TokenDenomination;
  readonly tokenOutDenomination: TokenDenomination;
  readonly blockNumber: bigint;
}

/** The `decimals`-only portion of `SharedSpotAndDecimals` — no spot price, no `tokenInIsToken0`. */
export interface SharedDecimals {
  readonly status: QuoteAnalyticsStatus;
  /** Present only when `status === "OK"`. */
  readonly tokenInDecimals?: number;
  /** Present only when `status === "OK"`. */
  readonly tokenOutDecimals?: number;
  readonly evidence: readonly QuoteEvidence[];
}

/**
 * Phase 6F.2 — resolves ONLY `tokenIn`/`tokenOut` decimals (no spot
 * read), for a caller whose spot price is NOT a single shared value —
 * i.e. a multi-pool cross-pool comparison, where every candidate shares
 * the same verified `tokenIn`/`tokenOut` (so decimals are resolved once,
 * for the whole comparison) but each candidate has its OWN pool-specific
 * spot state (so spot can never be part of this shared read — see
 * `compare-verified-pools.ts`). `readSpotAndDecimals` above remains the
 * right function for every existing single-spot caller (single-quote,
 * depth curve); this is a sibling, not a replacement, sharing the same
 * `readDecimals`/`TokenDenomination` trust-boundary machinery
 * underneath — never a second, independently-reasoned decimals path.
 */
export async function readSharedDecimals(args: ReadSharedDecimalsArgs): Promise<SharedDecimals> {
  const { rpc, tokenInDenomination, tokenOutDenomination, blockNumber } = args;

  const [decInOutcome, decOutOutcome] = await Promise.all([
    readDecimals(rpc, tokenInDenomination, blockNumber),
    readDecimals(rpc, tokenOutDenomination, blockNumber),
  ]);

  const evidence: QuoteEvidence[] = [
    decInOutcome.outcome === "ok"
      ? {
          kind: "DECIMALS_READ",
          outcome: "ok",
          source: "tokenIn.decimals()",
          observed: String(decInOutcome.value),
          detail:
            tokenInDenomination.kind === "V4_NATIVE_ETH"
              ? "tokenIn is the VERIFIED V4 PoolKey's native-currency denomination — decimals resolved as the protocol-defined constant 18, no eth_call made."
              : "tokenIn ERC20 decimals() decoded to a valid uint8 at the exact pinned comparison block.",
        }
      : { kind: "DECIMALS_READ", outcome: decInOutcome.outcome, source: "tokenIn.decimals()", detail: decInOutcome.detail },
    decOutOutcome.outcome === "ok"
      ? {
          kind: "DECIMALS_READ",
          outcome: "ok",
          source: "tokenOut.decimals()",
          observed: String(decOutOutcome.value),
          detail:
            tokenOutDenomination.kind === "V4_NATIVE_ETH"
              ? "tokenOut is the VERIFIED V4 PoolKey's native-currency denomination — decimals resolved as the protocol-defined constant 18, no eth_call made."
              : "tokenOut ERC20 decimals() decoded to a valid uint8 at the exact pinned comparison block.",
        }
      : { kind: "DECIMALS_READ", outcome: decOutOutcome.outcome, source: "tokenOut.decimals()", detail: decOutOutcome.detail },
  ];

  const anyRpcError = decInOutcome.outcome === "rpc_error" || decOutOutcome.outcome === "rpc_error";
  const anyDecodeError = decInOutcome.outcome === "decode_error" || decOutOutcome.outcome === "decode_error";

  let status: QuoteAnalyticsStatus;
  if (anyRpcError) status = "RPC_ERROR";
  else if (anyDecodeError) status = "INDETERMINATE";
  else status = "OK";

  if (status !== "OK" || decInOutcome.outcome !== "ok" || decOutOutcome.outcome !== "ok") {
    return { status, evidence };
  }

  return { status: "OK", tokenInDecimals: decInOutcome.value, tokenOutDecimals: decOutOutcome.value, evidence };
}

export interface AssembleQuoteAnalyticsArgs extends ReadSpotAndDecimalsArgs {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

/**
 * Single-quote convenience wrapper: calls `readSpotAndDecimals` (see
 * above) once, then — only when that shared read succeeds — computes
 * the full price/impact trio for this ONE `amountIn`/`amountOut` pair.
 * External behavior is byte-for-byte unchanged from before Phase 6F.1's
 * refactor (verified by the full existing analytics test suite passing
 * unmodified) — this function itself performs no RPC of its own beyond
 * what `readSpotAndDecimals` already does.
 */
export async function assembleQuoteAnalytics(args: AssembleQuoteAnalyticsArgs): Promise<QuoteAnalytics> {
  const shared = await readSpotAndDecimals(args);

  if (shared.status !== "OK" || shared.spotPrice === undefined || shared.tokenInDecimals === undefined || shared.tokenOutDecimals === undefined) {
    return { status: shared.status, priceUnit: "tokenOut_per_tokenIn", evidence: shared.evidence };
  }

  const executionPrice = computeExecutionPrice(args.amountIn, args.amountOut, shared.tokenInDecimals, shared.tokenOutDecimals);
  const priceImpactBps = computePriceImpactBps(shared.spotPrice, executionPrice);

  return {
    status: "OK",
    tokenInDecimals: shared.tokenInDecimals,
    tokenOutDecimals: shared.tokenOutDecimals,
    spotPrice: shared.spotPrice,
    executionPrice,
    priceImpactBps,
    priceUnit: "tokenOut_per_tokenIn",
    evidence: shared.evidence,
  };
}
