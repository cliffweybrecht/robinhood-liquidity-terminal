// The mapping table's internals (`isKnownDexId`, `lookupLabelHint`,
// `normalizeDexId`, `normalizeLabel`, `LabelClassificationHint`) are
// deliberately NOT exported here. They're implementation details of how
// `classifyPoolProtocol` interprets evidence, not something any current
// or anticipated caller needs directly — this phase has no route/UI/
// external consumer of them (see README "Phase 6B"). Import them from
// `./mapping` directly, inside this module, if that ever changes.
export type {
  ClassificationStatus,
  ClassifiedPoolIdentity,
  PoolIdentifierShape,
  PoolProtocolClassification,
  ProtocolEvidence,
  ProtocolEvidenceKind,
  ProtocolFamily,
} from "./types";
export { classifyPoolProtocol } from "./classify";
export { InvalidPoolIdentifierShapeError, ProtocolClassificationError } from "./errors";
export type { ProtocolClassificationErrorCode } from "./errors";
