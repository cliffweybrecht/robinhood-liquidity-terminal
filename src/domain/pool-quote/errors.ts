/**
 * Typed precondition failures for `quoteVerifiedUniswapV3ExactInput` and
 * `quoteVerifiedUniswapV4ExactInput`. A separate hierarchy from
 * `pool-verification`'s `PoolVerificationError` and `pool-state`'s
 * `PoolStateError` (not reused, not extended, not imported) — same
 * module-independence policy those two modules already established
 * between each other. Every one of these is thrown *before* any RPC
 * call is made: a precondition failure is a caller-usage/trust-boundary
 * problem, never a per-quote epistemic outcome, so it is never folded
 * into `QuoteVerification.status`.
 */
export type QuotePreconditionErrorCode =
  | "POOL_IDENTITY_MISMATCH"
  | "IDENTITY_NOT_VERIFIED"
  | "UNSUPPORTED_IDENTITY_FAMILY"
  | "MISSING_IDENTITY_BLOCK"
  | "INVALID_AMOUNT_IN"
  | "INVALID_TOKEN_IN"
  | "MISSING_VERIFIED_POOL_KEY"
  | "MISSING_VERIFIED_V3_POOL_KEY"
  | "MISSING_HOOK_DATA";

export abstract class QuotePreconditionError extends Error {
  abstract readonly code: QuotePreconditionErrorCode;
}

/** `identity.pool` does not match the supplied `pool` (different `chainId`/`pairAddress`). Mirrors `pool-state`'s `PoolIdentityMismatchError` — a caller could otherwise pass a genuinely `VERIFIED` identity proof for one pool alongside a different pool's data. */
export class PoolIdentityMismatchError extends QuotePreconditionError {
  readonly code = "POOL_IDENTITY_MISMATCH" as const;
  readonly poolPairAddress: string;
  readonly identityPairAddress: string;

  constructor(poolPairAddress: string, identityPairAddress: string) {
    super(
      `identity.pool.pairAddress ("${identityPairAddress}") does not match pool.pairAddress ("${poolPairAddress}") — quoting requires an identity proof produced from the same pool`,
    );
    this.name = "PoolIdentityMismatchError";
    this.poolPairAddress = poolPairAddress;
    this.identityPairAddress = identityPairAddress;
  }
}

/** `identity.status !== "VERIFIED"`. A quote may only be attempted for a pool whose identity has already been proven. */
export class IdentityNotVerifiedError extends QuotePreconditionError {
  readonly code = "IDENTITY_NOT_VERIFIED" as const;
  readonly status: string;

  constructor(status: string) {
    super(`identity.status is "${status}", not "VERIFIED" — a quote can only be attempted for an already-VERIFIED identity`);
    this.name = "IdentityNotVerifiedError";
    this.status = status;
  }
}

/** `identity.family` doesn't match the protocol this specific quote function supports. Each function (`quoteVerifiedUniswapV3ExactInput`/`quoteVerifiedUniswapV4ExactInput`) is protocol-specific by design — no generic dispatcher exists. */
export class UnsupportedIdentityFamilyError extends QuotePreconditionError {
  readonly code = "UNSUPPORTED_IDENTITY_FAMILY" as const;
  readonly family: string;
  readonly expectedFamily: string;

  constructor(family: string, expectedFamily: string) {
    super(`identity.family is "${family}", not "${expectedFamily}" — this quote function only supports ${expectedFamily}`);
    this.name = "UnsupportedIdentityFamilyError";
    this.family = family;
    this.expectedFamily = expectedFamily;
  }
}

/** `identity.blockNumber === null` on a `VERIFIED` identity. Should be unreachable but re-checked explicitly rather than trusted, matching the defensive-invariant policy `pool-verification`/`pool-state` already established. */
export class MissingIdentityBlockError extends QuotePreconditionError {
  readonly code = "MISSING_IDENTITY_BLOCK" as const;

  constructor() {
    super("identity.blockNumber is null on a VERIFIED identity — refusing to proceed without confirmed identity provenance");
    this.name = "MissingIdentityBlockError";
  }
}

/** `amountIn <= 0`. Uniswap's own quoters reject a zero swap amount at the protocol level too (V3: `UniswapV3Pool.swap`'s `require(amountSpecified != 0, 'AS')`; V4: the allowlisted `SwapAmountCannotBeZero()`) — rejecting this before any RPC call avoids spending a round trip on an input that can never legitimately quote. This precondition is also what makes V3's "AS" revert reason provably unreachable through this reader specifically, so it is deliberately NOT on `abi/revert.ts`'s V3 allowlist — see that file's doc comment. */
export class InvalidAmountInError extends QuotePreconditionError {
  readonly code = "INVALID_AMOUNT_IN" as const;
  readonly amountIn: string;

  constructor(amountIn: bigint) {
    super(`amountIn (${amountIn}) must be greater than zero`);
    this.name = "InvalidAmountInError";
    this.amountIn = amountIn.toString();
  }
}

/** `tokenIn` is not one of the verified pool's two currencies/tokens. A quote's direction must be derived only from trustworthy verified/canonical data — never an arbitrary caller-supplied address. */
export class InvalidTokenInError extends QuotePreconditionError {
  readonly code = "INVALID_TOKEN_IN" as const;
  readonly tokenIn: string;

  constructor(tokenIn: string) {
    super(`tokenIn ("${tokenIn}") is not one of this verified pool's two tokens/currencies`);
    this.name = "InvalidTokenInError";
    this.tokenIn = tokenIn;
  }
}

/** V4 only: `identity.poolKey` is missing on a `VERIFIED`/`UNISWAP_V4` identity. Should be unreachable — `strategies/uniswap-v4.ts` always populates `poolKey` for a genuinely `VERIFIED` V4 result — but re-checked explicitly rather than trusted. */
export class MissingVerifiedPoolKeyError extends QuotePreconditionError {
  readonly code = "MISSING_VERIFIED_POOL_KEY" as const;

  constructor() {
    super("identity.poolKey is missing on a VERIFIED UNISWAP_V4 identity — refusing to construct a quote without a trustworthy typed PoolKey");
    this.name = "MissingVerifiedPoolKeyError";
  }
}

/**
 * V3 only: `identity.v3PoolKey` is missing on a `VERIFIED`/`UNISWAP_V3`
 * identity. Should be unreachable — `strategies/uniswap-v3.ts` always
 * populates `v3PoolKey` for a genuinely `VERIFIED` V3 result — but
 * re-checked explicitly rather than trusted, same defensive pattern as
 * `MissingVerifiedPoolKeyError` above. Critically, this is also the
 * fail-closed backstop that makes it impossible to construct a quote
 * from a caller-supplied `LiquidityPool`'s (unverified, provider-
 * reported) `baseToken`/`quoteToken` fields instead of the independently
 * on-chain-proven `token0`/`token1`/`fee` — a `VERIFIED` identity without
 * this typed fact can never reach the quoter call.
 */
export class MissingVerifiedV3PoolKeyError extends QuotePreconditionError {
  readonly code = "MISSING_VERIFIED_V3_POOL_KEY" as const;

  constructor() {
    super(
      "identity.v3PoolKey is missing on a VERIFIED UNISWAP_V3 identity — refusing to construct a quote without the independently on-chain-verified token0/token1/fee",
    );
    this.name = "MissingVerifiedV3PoolKeyError";
  }
}

/** V4 only: the verified `PoolKey.hooks` is not the zero address, and the caller did not explicitly supply `hookData`. Frozen rule: never silently assume empty `hookData` for a hooked pool — see `abi/revert.ts`/`read-uniswap-v4-quote.ts`'s module doc comments. */
export class MissingHookDataError extends QuotePreconditionError {
  readonly code = "MISSING_HOOK_DATA" as const;
  readonly hooks: string;

  constructor(hooks: string) {
    super(
      `poolKey.hooks ("${hooks}") is not the zero address — this pool has an active hook, and hookData must be explicitly supplied by the caller (including an explicit "0x" if that is genuinely intended); it is never silently defaulted for a hooked pool`,
    );
    this.name = "MissingHookDataError";
    this.hooks = hooks;
  }
}
