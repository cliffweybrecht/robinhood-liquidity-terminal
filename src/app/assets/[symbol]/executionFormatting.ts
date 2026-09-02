import { formatRational, formatTokenAmount } from "@/lib/decimal/parseTokenAmount";
import type {
  ExecutionCandidateDto,
  ExecutionComparisonSnapshotDto,
  PreconditionFailureDto,
  RationalDto,
} from "@/domain/execution-comparison";

/**
 * Pure, framework-independent presentation helpers for the Execution
 * Comparison panel — kept out of the client component so the table
 * ordering / status-copy / numeric-formatting rules (all
 * product-critical per the approved architecture) are unit-testable
 * without React/DOM machinery.
 */

const STATUS_COPY: Record<Exclude<ExecutionCandidateDto["status"], "PRECONDITION_FAILED">, string> = {
  QUOTED: "Quoted",
  UNQUOTABLE: "Cannot execute",
  INDETERMINATE: "Could not determine",
  RPC_ERROR: "RPC error",
};

const PRECONDITION_STATUS_COPY: Record<PreconditionFailureDto["code"], string> = {
  MISSING_HOOK_DATA: "Hook parameters unsupported",
  AMOUNT_IN_EXCEEDS_V4_BOUND: "Amount exceeds quote bound",
};

export const PRECONDITION_DETAIL_COPY: Record<PreconditionFailureDto["code"], string> = {
  MISSING_HOOK_DATA: "This pool uses custom hook parameters that this app cannot safely construct yet.",
  AMOUNT_IN_EXCEEDS_V4_BOUND: "This trade size exceeds the amount bound supported by this V4 quote path.",
};

/** Never collapses a specific status into a generic "Error" — every `ComparisonCandidateStatus` has its own exact copy. */
export function statusCopy(candidate: ExecutionCandidateDto): string {
  if (candidate.status === "PRECONDITION_FAILED") {
    return candidate.preconditionFailure ? PRECONDITION_STATUS_COPY[candidate.preconditionFailure.code] : "Unsupported";
  }
  return STATUS_COPY[candidate.status];
}

export interface OrderedCandidates {
  /** QUOTED first, in exact `ranking.rankedQuotedPoolAddresses` server order; then attempted-but-not-quoted (UNQUOTABLE/INDETERMINATE/RPC_ERROR) in original candidate order. Never PRECONDITION_FAILED. */
  readonly attempted: readonly ExecutionCandidateDto[];
  /** PRECONDITION_FAILED candidates only, original order — belongs in a separate disclosure section, never this table. */
  readonly precondition: readonly ExecutionCandidateDto[];
}

/** Orders candidates for the comparison table using ONLY the server's authoritative `ranking` array for QUOTED rows — never re-sorts by a client-parsed `amountOut`. */
export function orderCandidatesForTable(
  candidates: readonly ExecutionCandidateDto[],
  ranking: ExecutionComparisonSnapshotDto["ranking"],
): OrderedCandidates {
  const byAddress = new Map(candidates.map((c) => [c.pairAddress.toLowerCase(), c] as const));
  const quotedInRankOrder = ranking.rankedQuotedPoolAddresses
    .map((addr) => byAddress.get(addr.toLowerCase()))
    .filter((c): c is ExecutionCandidateDto => c !== undefined);
  const quotedAddresses = new Set(quotedInRankOrder.map((c) => c.pairAddress.toLowerCase()));

  const precondition: ExecutionCandidateDto[] = [];
  const attemptedNonQuoted: ExecutionCandidateDto[] = [];
  for (const candidate of candidates) {
    if (quotedAddresses.has(candidate.pairAddress.toLowerCase())) continue;
    if (candidate.status === "PRECONDITION_FAILED") {
      precondition.push(candidate);
    } else {
      attemptedNonQuoted.push(candidate);
    }
  }

  return { attempted: [...quotedInRankOrder, ...attemptedNonQuoted], precondition };
}

/** True for every candidate tied for best — `ranking.bestCandidatePoolAddresses` may legitimately contain more than one address on an exact `amountOut` tie. */
export function isBestCandidate(pairAddress: string, bestCandidatePoolAddresses: readonly string[]): boolean {
  const lower = pairAddress.toLowerCase();
  return bestCandidatePoolAddresses.some((addr) => addr.toLowerCase() === lower);
}

export function bestExecutionLabel(bestCandidatePoolAddresses: readonly string[]): string {
  return bestCandidatePoolAddresses.length > 1 ? "Tied best execution" : "Best execution";
}

/** Inserts thousands separators into an integer decimal string — never converts to `Number` (gas estimates are display-only, never ranking-relevant, but this still avoids any float path on principle). */
export function formatGasEstimate(raw: string | undefined): string {
  if (raw === undefined) return "—";
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}`;
}

export function formatAmountOut(raw: string | undefined, tokenOutDecimals: number | undefined): string {
  if (raw === undefined || tokenOutDecimals === undefined) return "—";
  return formatTokenAmount(BigInt(raw), tokenOutDecimals).display;
}

export function formatAmountOutFull(raw: string | undefined, tokenOutDecimals: number | undefined): string | undefined {
  if (raw === undefined || tokenOutDecimals === undefined) return undefined;
  return formatTokenAmount(BigInt(raw), tokenOutDecimals).full;
}

export function formatExecutionPrice(rational: RationalDto | undefined): string {
  if (rational === undefined) return "—";
  return formatRational(BigInt(rational.numerator), BigInt(rational.denominator)).display;
}

export function formatExecutionPriceFull(rational: RationalDto | undefined): string | undefined {
  if (rational === undefined) return undefined;
  return formatRational(BigInt(rational.numerator), BigInt(rational.denominator)).full;
}

/** `priceImpactBps` is exact basis points — dividing by 100 (as an equivalent exact fraction, `denominator * 100n`) converts to a percent for display without ever touching `Number`. Sign is preserved as-is: positive = execution worse than spot, negative = execution better than spot (see `src/domain/pool-quote/analytics.ts`) — never inverted based on buy/sell intuition. */
export function formatImpactPercent(bps: RationalDto | undefined): string {
  if (bps === undefined) return "—";
  const numerator = BigInt(bps.numerator);
  const denominator = BigInt(bps.denominator) * 100n;
  const { display } = formatRational(numerator, denominator, 2);
  if (display === "0" || display === "—") return display;
  return numerator >= 0n ? `+${display}%` : `${display}%`;
}

/** `NATIVE_ETH` -> "ETH"; a real address group prefers its verified symbol, falling back to a shortened address only when no symbol could be derived — never fabricates a symbol. */
export function formatGroupLabel(tokenOut: string, tokenOutSymbol: string | undefined): string {
  if (tokenOut === "NATIVE_ETH") return "ETH";
  if (tokenOutSymbol) return tokenOutSymbol;
  return `${tokenOut.slice(0, 6)}…${tokenOut.slice(-4)}`;
}

/** The amount-input field's label — always the canonical Robinhood Chain asset symbol the page itself was loaded for (e.g. `"NVDA"`), never the raw `tokenIn` contract address `comparison.tokenIn` reports. The address is authoritative for parsing/RPC calls; the symbol is authoritative for what the user reads. */
export function amountInLabel(symbol: string): string {
  return `Amount in (${symbol})`;
}

/**
 * Explains a `sharedAnalyticsStatus !== "OK"` comparison — the ONE
 * shared per-comparison decimals read (`readSharedDecimals`,
 * `src/domain/pool-quote/analytics.ts`) failed or could not be decoded
 * at the pinned block. When this happens, `comparison.tokenOutDecimals`
 * is `undefined` (blanking every row's Amount Out) AND every
 * candidate's `executionPrice`/`priceImpactBps` are also `undefined`
 * (`computeCandidatePricing`, `compare-verified-pools.ts`, requires
 * `sharedDecimals.status === "OK"`) — even though `status`/`gasEstimate`
 * remain valid, since those come from each candidate's own, separate
 * quoter call. Distinct from an ordinary "—" (a value that is simply
 * absent for a structural reason, e.g. a non-QUOTED candidate) — this
 * note exists so the user sees an explicit, honest reason for a
 * transient read gap instead of an unexplained blank table. Returns
 * `undefined` when nothing needs explaining.
 */
export function sharedAnalyticsUnavailableNote(sharedAnalyticsStatus: ExecutionComparisonSnapshotDto["sharedAnalyticsStatus"]): string | undefined {
  if (sharedAnalyticsStatus === "OK") return undefined;
  return "Amount Out, Execution Price, and Impact could not be computed for this comparison — a required on-chain read did not complete or could not be decoded at this block. This does not affect Status or Gas, which come from a separate call. Try Refresh.";
}
