import type { Address, Hex } from "viem";
import type { CanonicalAssetSide, PoolIdentifierShape } from "@/domain/pool";

// Re-exported so `src/domain/protocol` consumers don't need to reach
// into `@/domain/pool` themselves for a type this module's own public
// API (`PoolProtocolClassification.identifierShape`) exposes. The
// canonical definition — and the only place the underlying 20-byte
// vs. 32-byte shape check lives — is `src/domain/pool/address.ts`;
// see `classify.ts`, which calls `getPairIdentifierShape` from there
// rather than maintaining its own copy of that logic.
export type { PoolIdentifierShape };

/**
 * Broad protocol family a pool's evidence supports. Deliberately does
 * NOT include a generic "UNISWAP" bucket without a version — evidence
 * that only proves "this is some Uniswap-family dexId" without a
 * version marker stays `UNKNOWN` (see `classify.ts`), because guessing
 * a version from dexId alone would violate the "no fabricated mappings"
 * rule.
 */
export type ProtocolFamily = "UNISWAP_V2_LIKE" | "UNISWAP_V3" | "UNISWAP_V4" | "OTHER_KNOWN" | "UNKNOWN";

/**
 * How settled this classification is.
 *  - CLASSIFIED: explicit, non-contradicted evidence identifies the family/version.
 *  - PROVISIONAL: partial evidence (e.g. a known dexId with no version
 *    marker) narrows things but doesn't establish a specific family/version.
 *  - UNKNOWN: no usable evidence — unrecognized dexId and no matching label.
 *  - CONFLICT: two or more pieces of evidence disagree (e.g. a version
 *    label implies one identifier shape but the actual shape is the
 *    other). Never silently resolved in either direction.
 */
export type ClassificationStatus = "CLASSIFIED" | "PROVISIONAL" | "UNKNOWN" | "CONFLICT";

/**
 * Typed, machine-readable evidence categories. Every classification
 * carries at least one; a human-readable `detail` supplements but never
 * replaces the typed `kind`.
 */
export type ProtocolEvidenceKind =
  | "DEXSCREENER_DEX_ID"
  | "IDENTIFIER_SHAPE_20_BYTE"
  | "IDENTIFIER_SHAPE_32_BYTE"
  | "EXPLICIT_KNOWN_LABEL_MAPPING"
  | "CONTRADICTORY_LABEL_SHAPE"
  | "CONTRADICTORY_LABEL_EVIDENCE"
  | "UNSUPPORTED_LABEL";

export interface ProtocolEvidence {
  readonly kind: ProtocolEvidenceKind;
  /** Human-readable explanation of this specific piece of evidence. */
  readonly detail: string;
}

/**
 * The subset of a Phase 2 `LiquidityPool`'s identity fields carried
 * through unchanged into a classification result — never recomputed,
 * reinterpreted, or used to infer anything beyond what Phase 2 already
 * established.
 */
export interface ClassifiedPoolIdentity {
  readonly chainId: string;
  readonly pairAddress: Hex;
  readonly dexId: string;
  readonly canonicalAssetAddress: Address;
  readonly canonicalAssetSymbol: string;
  readonly canonicalAssetSide: CanonicalAssetSide;
}

/**
 * The output of `classifyPoolProtocol`. Pure discovery-metadata
 * classification — NOT on-chain verification. A `CLASSIFIED` result
 * here means "the available off-chain evidence points unambiguously at
 * this family/version," not "this pool has been proven on-chain to be
 * what it claims."
 */
export interface PoolProtocolClassification {
  readonly pool: ClassifiedPoolIdentity;
  readonly identifierShape: PoolIdentifierShape;
  readonly family: ProtocolFamily;
  /** Specific version/category string (e.g. "v3") when justified by evidence; null otherwise. */
  readonly version: string | null;
  readonly status: ClassificationStatus;
  readonly evidence: readonly ProtocolEvidence[];
}
