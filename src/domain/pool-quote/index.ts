// Internals (`abi/`, `read.ts`, `analytics.ts`'s RPC-orchestrating
// `assembleQuoteAnalytics`/`readSpotAndDecimals`, and each reader's
// private/module-shared `resolveV3*`/`resolveV4*`/`quoteV3AtBlock`/
// `quoteV4AtBlock`/`readV3SpotSqrtPriceX96`/`readV4SpotSqrtPriceX96`)
// are deliberately NOT exported here — same policy `pool-verification/
// index.ts` and `pool-state/index.ts` use. No "quote at an arbitrary
// block" primitive is exported: the only supported entry points are the
// six functions below, each of which pins its own block internally.
export { quoteVerifiedUniswapV3ExactInput, quoteVerifiedUniswapV3ExactInputWithAnalytics } from "./read-uniswap-v3-quote";
export type { QuoteVerifiedUniswapV3ExactInputInput } from "./read-uniswap-v3-quote";
export { quoteVerifiedUniswapV4ExactInput, quoteVerifiedUniswapV4ExactInputWithAnalytics } from "./read-uniswap-v4-quote";
export type { QuoteVerifiedUniswapV4ExactInputInput } from "./read-uniswap-v4-quote";
export { quoteVerifiedUniswapV3ExactInputDepthCurve } from "./read-uniswap-v3-depth-curve";
export type { QuoteVerifiedUniswapV3ExactInputDepthCurveInput } from "./read-uniswap-v3-depth-curve";
export { quoteVerifiedUniswapV4ExactInputDepthCurve } from "./read-uniswap-v4-depth-curve";
export type { QuoteVerifiedUniswapV4ExactInputDepthCurveInput } from "./read-uniswap-v4-depth-curve";
export { largestQuotedSample, sampledDepthAtBps } from "./depth-math";
export type {
  DepthCurvePointLike,
  QuoteAnalytics,
  QuoteAnalyticsStatus,
  QuoteEvidence,
  QuoteEvidenceKind,
  QuoteEvidenceOutcome,
  QuoteStatus,
  QuoteVerification,
  RationalValue,
  UniswapV3DepthCurve,
  UniswapV3DepthCurvePoint,
  UniswapV3QuoteMetadata,
  UniswapV3QuoteVerification,
  UniswapV3QuoteWithAnalytics,
  UniswapV4DepthCurve,
  UniswapV4DepthCurvePoint,
  UniswapV4QuoteMetadata,
  UniswapV4QuoteVerification,
  UniswapV4QuoteWithAnalytics,
} from "./types";
export {
  EmptyAmountsLadderError,
  IdentityNotVerifiedError,
  InvalidAmountInError,
  InvalidTokenInError,
  MissingHookDataError,
  MissingIdentityBlockError,
  MissingVerifiedPoolKeyError,
  MissingVerifiedV3PoolKeyError,
  PoolIdentityMismatchError,
  QuotePreconditionError,
  UnsupportedIdentityFamilyError,
} from "./errors";
export type { QuotePreconditionErrorCode } from "./errors";
