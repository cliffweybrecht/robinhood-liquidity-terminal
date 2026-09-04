// Internals (`abi/`, `read.ts`, `analytics.ts`'s RPC-orchestrating
// `assembleQuoteAnalytics`/`readSpotAndDecimals`, and each reader's
// private/module-shared `resolveV3*`/`resolveV4*`/`quoteV3AtBlock`/
// `quoteV4AtBlock`/`readV3SpotSqrtPriceX96`/`readV4SpotSqrtPriceX96`)
// are deliberately NOT exported here — same policy `pool-verification/
// index.ts` and `pool-state/index.ts` use. No "quote at an arbitrary
// block" primitive is exported: the only supported entry points are the
// eight functions below, each of which pins its own block internally.
export { quoteVerifiedUniswapV3ExactInput, quoteVerifiedUniswapV3ExactInputWithAnalytics } from "./read-uniswap-v3-quote";
export type { QuoteVerifiedUniswapV3ExactInputInput } from "./read-uniswap-v3-quote";
export { quoteVerifiedUniswapV4ExactInput, quoteVerifiedUniswapV4ExactInputWithAnalytics } from "./read-uniswap-v4-quote";
export type { QuoteVerifiedUniswapV4ExactInputInput } from "./read-uniswap-v4-quote";
export { quoteVerifiedUniswapV3ExactInputDepthCurve } from "./read-uniswap-v3-depth-curve";
export type { QuoteVerifiedUniswapV3ExactInputDepthCurveInput } from "./read-uniswap-v3-depth-curve";
export { quoteVerifiedUniswapV4ExactInputDepthCurve } from "./read-uniswap-v4-depth-curve";
export type { QuoteVerifiedUniswapV4ExactInputDepthCurveInput } from "./read-uniswap-v4-depth-curve";
export { compareVerifiedPoolsExactInput, computeRanking } from "./compare-verified-pools";
export type { ComparisonCandidateInput, CompareVerifiedPoolsExactInputInput } from "./compare-verified-pools";
export {
  classifyMatrixCandidates,
  compareVerifiedPoolsAcrossExactInputs,
  MATRIX_QUOTE_CONCURRENCY,
  MATRIX_QUOTE_INTERVAL_MS,
  MAX_MATRIX_AMOUNTS,
  MAX_MATRIX_CELLS,
} from "./compare-verified-pools-across-amounts";
export type {
  ClassifiedMatrixCandidates,
  CompareVerifiedPoolsAcrossExactInputsInput,
  PreconditionFailedRow,
} from "./compare-verified-pools-across-amounts";
export { classifyUpperRange, largestQuotedSample, monotonicityObservedAtOrBelow, sampledDepthAtBps } from "./depth-math";
export {
  computeVerifiedPoolDepthThresholds,
  DEPTH_THRESHOLD_QUOTE_CONCURRENCY,
  DEPTH_THRESHOLD_QUOTE_INTERVAL_MS,
  MAX_DEPTH_THRESHOLD_CELLS,
} from "./compute-verified-pool-depth-thresholds";
export type { ComputeVerifiedPoolDepthThresholdsInput } from "./compute-verified-pool-depth-thresholds";
export type {
  ComparisonCandidate,
  ComparisonCandidateStatus,
  ComparisonPreconditionFailure,
  ComparisonPreconditionFailureCode,
  CrossPoolComparisonBlockPinFailure,
  CrossPoolComparisonResult,
  CrossPoolComparisonSnapshot,
  CrossPoolExecutionMatrixBlockPinFailure,
  CrossPoolExecutionMatrixResult,
  CrossPoolExecutionMatrixSnapshot,
  DepthCurvePointLike,
  DepthThresholdOutcome,
  MatrixCandidateRow,
  MatrixCell,
  MatrixRanking,
  QuoteAnalytics,
  QuoteAnalyticsStatus,
  QuoteEvidence,
  QuoteEvidenceKind,
  QuoteEvidenceOutcome,
  QuoteStatus,
  QuoteVerification,
  RationalValue,
  UniswapV3ComparisonCandidate,
  UniswapV3DepthCurve,
  UniswapV3DepthCurvePoint,
  UniswapV3QuoteMetadata,
  UniswapV3QuoteVerification,
  UniswapV3QuoteWithAnalytics,
  UniswapV4ComparisonCandidate,
  UniswapV4DepthCurve,
  UniswapV4DepthCurvePoint,
  UniswapV4QuoteMetadata,
  UniswapV4QuoteVerification,
  UniswapV4QuoteWithAnalytics,
  UpperRangeClassification,
  BestVenueAtThreshold,
  VerifiedPoolDepthResult,
  VerifiedPoolDepthThresholdsBlockPinFailure,
  VerifiedPoolDepthThresholdsResult,
  VerifiedPoolDepthThresholdsSnapshot,
} from "./types";
export {
  DepthThresholdsTooLargeError,
  DuplicateCandidateError,
  EmptyAmountsLadderError,
  EmptyCandidatesError,
  EmptyThresholdsError,
  IdentityNotVerifiedError,
  InvalidAmountInError,
  InvalidTokenInError,
  MatrixTooLargeError,
  MismatchedComparisonGroupError,
  MissingHookDataError,
  MissingIdentityBlockError,
  MissingVerifiedPoolKeyError,
  MissingVerifiedV3PoolKeyError,
  PoolIdentityMismatchError,
  QuotePreconditionError,
  TooManyAmountsError,
  UnsupportedComparisonIdentityFamilyError,
  UnsupportedIdentityFamilyError,
} from "./errors";
export type { QuotePreconditionErrorCode } from "./errors";
