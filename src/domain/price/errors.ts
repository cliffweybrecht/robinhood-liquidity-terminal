export type PriceComparisonErrorCode =
  | "REFERENCE_PRICE_NOT_FOUND"
  | "INVALID_REFERENCE_QUOTE"
  | "CROSSED_REFERENCE_MARKET";

export abstract class PriceComparisonError extends Error {
  abstract readonly code: PriceComparisonErrorCode;
}

/**
 * Robinhood's price response didn't include a quote for this canonical
 * symbol. Shouldn't happen — the symbol comes from an already-canonical
 * Phase 1 asset — but Robinhood's price registry and asset registry are
 * two independent systems, and this is the explicit, fail-closed
 * handling for them disagreeing rather than silently falling back to a
 * fabricated/zero reference price.
 */
export class RobinhoodReferencePriceNotFoundError extends PriceComparisonError {
  readonly code = "REFERENCE_PRICE_NOT_FOUND" as const;
  readonly symbol: string;

  constructor(symbol: string) {
    super(`No Robinhood reference price found for canonical symbol "${symbol}"`);
    this.name = "RobinhoodReferencePriceNotFoundError";
    this.symbol = symbol;
  }
}

/**
 * Hardening pass (post-Phase-5-review): the raw quote's `bid`/`ask`, or
 * the canonical asset's `currentMultiplier`, failed to parse to a
 * finite, in-domain number — e.g. `Number(quote.bid)` producing `NaN`
 * (a numeric-string schema regression), a negative bid/ask (the schema
 * allows a leading `-`, since it also validates other signed fields;
 * this is where non-negativity is actually enforced), or a
 * non-positive/non-finite multiplier. Thrown instead of silently
 * computing with `NaN`/`Infinity`/a negative price — a fabricated
 * reference price is worse than no reference price.
 */
export class InvalidReferenceQuoteError extends PriceComparisonError {
  readonly code = "INVALID_REFERENCE_QUOTE" as const;
  readonly symbol: string;
  readonly reason: string;

  constructor(symbol: string, reason: string) {
    super(`Invalid Robinhood reference quote for canonical symbol "${symbol}": ${reason}`);
    this.name = "InvalidReferenceQuoteError";
    this.symbol = symbol;
    this.reason = reason;
  }
}

/**
 * Hardening pass: `bid > ask` on the raw Robinhood quote — a crossed
 * market. Whether this represents a genuine (if unusual) trading-halt
 * artifact or a data-quality problem upstream, synthesizing
 * `mid(bid, ask)` from a crossed quote would produce a reference price
 * with no defensible interpretation. Fails closed rather than reporting
 * a midpoint that doesn't mean what "mid of a two-sided quote" normally
 * means.
 */
export class CrossedReferenceMarketError extends PriceComparisonError {
  readonly code = "CROSSED_REFERENCE_MARKET" as const;
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;

  constructor(symbol: string, bid: number, ask: number) {
    super(`Crossed Robinhood reference market for canonical symbol "${symbol}": bid ${bid} > ask ${ask}`);
    this.name = "CrossedReferenceMarketError";
    this.symbol = symbol;
    this.bid = bid;
    this.ask = ask;
  }
}
