import { getPairIdentifierShape } from "@/domain/pool";
import type { LiquidityPool } from "@/domain/pool";
import { InvalidPoolIdentifierShapeError } from "./errors";
import { isKnownDexId, lookupLabelHint, normalizeDexId, normalizeLabel } from "./mapping";
import type { PoolIdentifierShape, PoolProtocolClassification, ProtocolEvidence, ProtocolFamily } from "./types";

/**
 * Delegates to `src/domain/pool/address.ts`'s `getPairIdentifierShape` —
 * the single canonical definition of the 20-byte-address-vs-32-byte-PoolId
 * distinction, already relied on by Phase 2 validation. This module does
 * not maintain its own copy of that pattern. `null` (shape unrecognized)
 * should be unreachable in practice, since Phase 2's `normalizePool`
 * already validates `pairAddress` via `isValidPairIdentifier` — the same
 * underlying check — before a `LiquidityPool` can exist; kept as a
 * defensive invariant check rather than a trust assumption.
 */
function detectIdentifierShape(pairAddress: string): PoolIdentifierShape {
  const shape = getPairIdentifierShape(pairAddress);
  if (shape === null) throw new InvalidPoolIdentifierShapeError(pairAddress);
  return shape;
}

/** The identifier shape a given protocol family's confirmed evidence is consistent with. */
function expectedShapeFor(family: ProtocolFamily): PoolIdentifierShape | null {
  switch (family) {
    case "UNISWAP_V4":
      return "ID_32_BYTE";
    case "UNISWAP_V2_LIKE":
    case "UNISWAP_V3":
      return "ADDRESS_20_BYTE";
    default:
      return null;
  }
}

/**
 * Classifies a single Phase 2 `LiquidityPool` into a protocol family
 * using only the pool's own already-validated fields — `dexId`,
 * `labels`, and the shape of `pairAddress`. Pure and network-independent:
 * no RPC calls, no on-chain reads, no mutation of `pool`. Dexscreener's
 * `dexId`/`labels` are treated strictly as discovery metadata, never as
 * proof — see `mapping.ts` for the only place label evidence is
 * interpreted, and the module doc there for what is/isn't backed by
 * actually-observed data.
 *
 * This is classification, NOT on-chain verification: a `CLASSIFIED`
 * result means the available off-chain evidence is unambiguous, not
 * that the pool has been proven on-chain to be what it claims.
 */
export function classifyPoolProtocol(pool: LiquidityPool): PoolProtocolClassification {
  const identifierShape = detectIdentifierShape(pool.pairAddress);
  const normalizedDexId = normalizeDexId(pool.dexId);

  const evidence: ProtocolEvidence[] = [
    {
      kind: identifierShape === "ADDRESS_20_BYTE" ? "IDENTIFIER_SHAPE_20_BYTE" : "IDENTIFIER_SHAPE_32_BYTE",
      detail: `pairAddress "${pool.pairAddress}" is a ${identifierShape === "ADDRESS_20_BYTE" ? "20-byte address" : "32-byte identifier"}`,
    },
    {
      kind: "DEXSCREENER_DEX_ID",
      detail: `dexId reported as "${pool.dexId}"`,
    },
  ];

  // Empty/whitespace-only labels carry no information. Phase 2's schema
  // (`labels: z.array(z.string()).nullish()`) permits them — unlike
  // `dexId`, which has `.min(1)` — but an empty string is the absence of
  // evidence, not evidence of something unrecognized. They are excluded
  // entirely from matching/unsupported-label evidence so they can never
  // downgrade an otherwise-CLASSIFIED result: only a real, meaningful
  // label can trigger the mixed-evidence PROVISIONAL rule below.
  const meaningfulLabels = pool.labels
    .map((rawLabel) => ({ rawLabel, normalizedLabel: normalizeLabel(rawLabel) }))
    .filter((entry) => entry.normalizedLabel.length > 0);

  const matches = meaningfulLabels
    .map((entry) => ({ rawLabel: entry.rawLabel, hint: lookupLabelHint(normalizedDexId, entry.normalizedLabel) }))
    .filter((entry): entry is { rawLabel: string; hint: NonNullable<(typeof entry)["hint"]> } =>
      Boolean(entry.hint),
    );

  const unmatchedLabels = meaningfulLabels
    .filter((entry) => !matches.some((m) => m.rawLabel === entry.rawLabel))
    .map((entry) => entry.rawLabel);

  if (unmatchedLabels.length > 0) {
    evidence.push({
      kind: "UNSUPPORTED_LABEL",
      detail: `label(s) [${unmatchedLabels.join(", ")}] have no explicit mapping for dexId "${pool.dexId}"`,
    });
  }

  if (matches.length === 0) {
    return {
      pool: identity(pool),
      identifierShape,
      family: "UNKNOWN",
      version: null,
      status: isKnownDexId(normalizedDexId) ? "PROVISIONAL" : "UNKNOWN",
      evidence,
    };
  }

  const uniqueHints = dedupeHints(matches.map((m) => m.hint));

  for (const match of matches) {
    evidence.push({
      kind: "EXPLICIT_KNOWN_LABEL_MAPPING",
      detail: `label "${match.rawLabel}" maps to ${match.hint.family} (${match.hint.version}) for dexId "${pool.dexId}"`,
    });
  }

  if (uniqueHints.length > 1) {
    evidence.push({
      kind: "CONTRADICTORY_LABEL_EVIDENCE",
      detail: `labels disagree on protocol family/version: ${uniqueHints.map((h) => `${h.family}(${h.version})`).join(" vs ")}`,
    });
    return {
      pool: identity(pool),
      identifierShape,
      family: "UNKNOWN",
      version: null,
      status: "CONFLICT",
      evidence,
    };
  }

  const hint = uniqueHints[0];
  if (!hint) {
    throw new Error("unreachable: uniqueHints must contain exactly one hint here");
  }
  const expectedShape = expectedShapeFor(hint.family);
  if (expectedShape !== null && expectedShape !== identifierShape) {
    evidence.push({
      kind: "CONTRADICTORY_LABEL_SHAPE",
      detail: `label evidence implies ${hint.family} (expects ${expectedShape}) but pairAddress is ${identifierShape}`,
    });
    return {
      pool: identity(pool),
      identifierShape,
      family: "UNKNOWN",
      version: null,
      status: "CONFLICT",
      evidence,
    };
  }

  if (unmatchedLabels.length > 0) {
    // A recognized, internally-consistent label hint exists, but at
    // least one other meaningful label on the same pool is not
    // understood. CLASSIFIED requires ALL meaningful labels on the pool
    // to be understood and internally consistent — mixed known/unknown
    // evidence is downgraded to PROVISIONAL rather than presented as a
    // confident classification. The candidate family/version is
    // deliberately not surfaced even provisionally (both stay
    // null/UNKNOWN), matching CONFLICT's own convention, for maximum
    // trust clarity: a caller reading only `family`/`version` never sees
    // a value that later evidence partially undermines.
    return {
      pool: identity(pool),
      identifierShape,
      family: "UNKNOWN",
      version: null,
      status: "PROVISIONAL",
      evidence,
    };
  }

  return {
    pool: identity(pool),
    identifierShape,
    family: hint.family,
    version: hint.version,
    status: "CLASSIFIED",
    evidence,
  };
}

function dedupeHints<T extends { family: ProtocolFamily; version: string }>(hints: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const hint of hints) {
    seen.set(`${hint.family}:${hint.version}`, hint);
  }
  return [...seen.values()];
}

function identity(pool: LiquidityPool): PoolProtocolClassification["pool"] {
  return {
    chainId: pool.chainId,
    pairAddress: pool.pairAddress,
    dexId: pool.dexId,
    canonicalAssetAddress: pool.canonicalAssetAddress,
    canonicalAssetSymbol: pool.canonicalAssetSymbol,
    canonicalAssetSide: pool.canonicalAssetSide,
  };
}
