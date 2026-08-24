import type { ProtocolFamily } from "./types";

/**
 * Centralized, evidence-based dexId/label -> protocol hint mapping.
 * This is the ONLY place classification hints are looked up from
 * strings — `classify.ts` never does its own string matching. Fail
 * closed: any (dexId, label) combination not present here yields no
 * hint, never a guess.
 *
 * Mappings are scoped per-dexId, not by label alone. A version label
 * like "v3" is only known to mean something for the dexIds where that
 * combination has actually been observed — applying it to an unrelated
 * dexId would be exactly the kind of fabricated mapping this phase is
 * required to avoid.
 *
 * Evidence basis (see the Phase 6B review package for full citations):
 *  - `uniswap` + label `v3` on a 20-byte address: confirmed live and in
 *    `src/test/fixtures/dexscreener-nvda-valid.json`.
 *  - `uniswap` + label `v4` on a 32-byte PoolId: confirmed in the same
 *    fixture. README.md separately documents a live pool that carried
 *    label `v4` on an ordinary 20-byte address — that combination is a
 *    genuine, previously observed CONFLICT case, not evidence that
 *    `v4` implies a 32-byte identifier; `classify.ts` handles it as
 *    CONFLICT, never as a silently-accepted V4.
 *  - `uniswap` + label `v2`: at the time this mapping was written, NOT
 *    directly observed in this repository's fixtures or README —
 *    included only as a structural extrapolation of the confirmed
 *    `v3`/`v4` label pattern on the SAME already-observed dexId
 *    (`uniswap`), not a fabricated DEX name. Subsequently confirmed
 *    live by this phase's own census run (e.g. MSFT's `uniswap`
 *    20-byte-address pool, labeled `v2`) — see the Phase 6B review
 *    package for the full live census output.
 *
 * README.md's "DEX composition" section (live NVDA census) also
 * observed 7 other dexIds — `ramses`, `alandale`, `up`, `giga`,
 * `sheriff`, `pancakeswap`, `robinswap` — with NO associated label
 * evidence found anywhere in this repository. They intentionally have
 * no entries here and fall through to UNKNOWN/PROVISIONAL by dexId
 * alone; nothing about their names is used to infer a protocol family.
 */
export interface LabelClassificationHint {
  readonly family: ProtocolFamily;
  readonly version: string;
}

const UNISWAP_LABEL_HINTS: ReadonlyMap<string, LabelClassificationHint> = new Map([
  ["v2", { family: "UNISWAP_V2_LIKE", version: "v2" }],
  ["v3", { family: "UNISWAP_V3", version: "v3" }],
  ["v4", { family: "UNISWAP_V4", version: "v4" }],
]);

/** dexId -> its label hint table. Only dexIds with actually-observed label evidence appear here. */
const DEX_LABEL_HINTS: ReadonlyMap<string, ReadonlyMap<string, LabelClassificationHint>> = new Map([
  ["uniswap", UNISWAP_LABEL_HINTS],
]);

/** Normalizes a dexId for lookup/comparison: trim + lowercase only — no fuzzy matching, no substring rules. */
export function normalizeDexId(value: string): string {
  return value.trim().toLowerCase();
}

/** Normalizes a label for lookup/comparison: trim + lowercase only — no fuzzy matching, no substring rules. */
export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

/** Whether `normalizedDexId` has any explicit label-hint entries in the mapping table. */
export function isKnownDexId(normalizedDexId: string): boolean {
  return DEX_LABEL_HINTS.has(normalizedDexId);
}

/**
 * Looks up the explicit hint for a (dexId, label) pair, both already
 * normalized. Returns `undefined` for any combination not explicitly
 * present — the caller must treat that as "no evidence," never as a
 * default family.
 */
export function lookupLabelHint(
  normalizedDexId: string,
  normalizedLabel: string,
): LabelClassificationHint | undefined {
  return DEX_LABEL_HINTS.get(normalizedDexId)?.get(normalizedLabel);
}
