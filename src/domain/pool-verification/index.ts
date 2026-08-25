// Protocol-specific verification internals (`strategies/`, `abi/`,
// `read.ts`) are deliberately NOT exported here. `verifyPoolIdentity` is
// the only supported entry point — there is no concrete downstream
// reason yet for a caller to invoke a single protocol's strategy
// directly, bypassing Phase 6B classification dispatch.
export { verifyPoolIdentity } from "./verify";
export type { VerifyPoolIdentityInput } from "./verify";
export type {
  HistoricalPoolProvenance,
  PoolIdentityVerification,
  PoolVerificationEvidence,
  PoolVerificationEvidenceKind,
  PoolVerificationEvidenceSupport,
  PoolVerificationStatus,
} from "./types";
export {
  MissingDeploymentBlockError,
  PoolClassificationMismatchError,
  PoolVerificationError,
  UnexpectedIdentifierShapeError,
  UnknownProtocolDeploymentError,
} from "./errors";
export type { PoolVerificationErrorCode } from "./errors";
export { getProtocolDeployment, getProtocolDeploymentAddress } from "./deployments";
export type { ProtocolDeployment, ProtocolDeploymentProtocol, ProtocolDeploymentRole } from "./deployments";
