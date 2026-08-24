import { describe, expect, it } from "vitest";
import { getPairIdentifierShape } from "@/domain/pool";
import type { LiquidityPool } from "@/domain/pool";
import { classifyPoolProtocol } from "../classify";
import { InvalidPoolIdentifierShapeError } from "../errors";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const CHAIN_ID = "robinhood";
// Real 20-byte/32-byte pairAddress forms taken verbatim from
// src/test/fixtures/dexscreener-nvda-valid.json (the confirmed clean
// V3/V4 cases), not invented shapes.
const ADDRESS_20 = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3";
const ID_32 = "0x401bc4b106c6deac5c66c251743efce2776a7eb0ce49d122d870308a4d209e43";
const ANOTHER_ADDRESS_20 = "0x1234567890123456789012345678901234567890";

function pool(overrides: Partial<LiquidityPool> = {}): LiquidityPool {
  return {
    provider: "dexscreener",
    chainId: CHAIN_ID,
    dexId: "uniswap",
    pairAddress: ADDRESS_20,
    canonicalAssetAddress: NVDA,
    canonicalAssetSymbol: "NVDA",
    canonicalAssetSide: "base",
    baseToken: { address: NVDA, name: "NVIDIA • Robinhood Token", symbol: "NVDA" },
    quoteToken: { address: USDG, name: "Global Dollar", symbol: "USDG" },
    priceUsd: 215.18,
    priceNative: 215.1838,
    liquidityUsd: 2762395.14,
    liquidityBase: 4390.08415,
    liquidityQuote: 1817719,
    volume5m: 13319.76,
    volume1h: 366849.22,
    volume6h: 1210948.77,
    volume24h: 13386716.29,
    buys5m: 26,
    sells5m: 19,
    buys1h: 340,
    sells1h: 353,
    buys6h: 1391,
    sells6h: 1043,
    buys24h: 10166,
    sells24h: 9316,
    priceChange5m: null,
    priceChange1h: -0.3,
    priceChange6h: -0.11,
    priceChange24h: -1.13,
    fdv: 5824092,
    marketCap: 4740142,
    pairCreatedAt: 1784631726000,
    dexScreenerUrl: "https://dexscreener.com/robinhood/0xpair",
    labels: ["v3"],
    ...overrides,
  };
}

describe("classifyPoolProtocol", () => {
  // 1. canonical Uniswap V2 classification
  it("classifies a 20-byte uniswap pool labeled v2 as UNISWAP_V2_LIKE", () => {
    const result = classifyPoolProtocol(pool({ labels: ["v2"] }));
    expect(result.status).toBe("CLASSIFIED");
    expect(result.family).toBe("UNISWAP_V2_LIKE");
    expect(result.version).toBe("v2");
    expect(result.identifierShape).toBe("ADDRESS_20_BYTE");
  });

  // 2. canonical Uniswap V3 classification
  it("classifies a 20-byte uniswap pool labeled v3 as UNISWAP_V3 (real fixture case)", () => {
    const result = classifyPoolProtocol(pool({ pairAddress: ADDRESS_20, labels: ["v3"] }));
    expect(result.status).toBe("CLASSIFIED");
    expect(result.family).toBe("UNISWAP_V3");
    expect(result.version).toBe("v3");
    expect(result.identifierShape).toBe("ADDRESS_20_BYTE");
  });

  // 3. canonical Uniswap V4 classification
  it("classifies a 32-byte uniswap pool labeled v4 as UNISWAP_V4 (real fixture case)", () => {
    const result = classifyPoolProtocol(
      pool({ pairAddress: ID_32, labels: ["v4"], quoteToken: { address: WETH, name: "WETH", symbol: "WETH" } }),
    );
    expect(result.status).toBe("CLASSIFIED");
    expect(result.family).toBe("UNISWAP_V4");
    expect(result.version).toBe("v4");
    expect(result.identifierShape).toBe("ID_32_BYTE");
  });

  // 4. generic unversioned uniswap label remains provisional/unknown
  it("leaves a 20-byte uniswap pool with no version label as PROVISIONAL/UNKNOWN", () => {
    const result = classifyPoolProtocol(pool({ labels: [] }));
    expect(result.status).toBe("PROVISIONAL");
    expect(result.family).toBe("UNKNOWN");
    expect(result.version).toBeNull();
  });

  // 5. unknown dexId remains unknown
  it("leaves an unrecognized dexId (no label evidence anywhere) as UNKNOWN/UNKNOWN", () => {
    // "ramses" is one of the 8 live-observed dexIds (README "DEX composition")
    // with no confirmed label evidence in this repository.
    const result = classifyPoolProtocol(pool({ dexId: "ramses", labels: [] }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.family).toBe("UNKNOWN");
    expect(result.version).toBeNull();
  });

  // 6. 32-byte ID + V3 label => conflict
  it("flags a 32-byte identifier with a v3 label as CONFLICT, not V3 or V4", () => {
    const result = classifyPoolProtocol(pool({ pairAddress: ID_32, labels: ["v3"] }));
    expect(result.status).toBe("CONFLICT");
    expect(result.family).toBe("UNKNOWN");
    expect(result.version).toBeNull();
    expect(result.evidence.some((e) => e.kind === "CONTRADICTORY_LABEL_SHAPE")).toBe(true);
    expect(result.evidence.some((e) => e.kind === "EXPLICIT_KNOWN_LABEL_MAPPING")).toBe(true);
  });

  // 7. 20-byte address + V4 label => conflict (the documented real-world case)
  it("flags a 20-byte address with a v4 label as CONFLICT, not silently V4", () => {
    const result = classifyPoolProtocol(pool({ pairAddress: ADDRESS_20, labels: ["v4"] }));
    expect(result.status).toBe("CONFLICT");
    expect(result.family).toBe("UNKNOWN");
    expect(result.evidence.some((e) => e.kind === "CONTRADICTORY_LABEL_SHAPE")).toBe(true);
  });

  // 8. case normalization
  it("normalizes uppercase labels and dexId before matching", () => {
    const result = classifyPoolProtocol(pool({ dexId: "UniSwap", labels: ["V3"] }));
    expect(result.status).toBe("CLASSIFIED");
    expect(result.family).toBe("UNISWAP_V3");
  });

  // 9. whitespace normalization
  it("normalizes surrounding whitespace in labels and dexId before matching", () => {
    const result = classifyPoolProtocol(pool({ dexId: "  uniswap  ", labels: [" v3 "] }));
    expect(result.status).toBe("CLASSIFIED");
    expect(result.family).toBe("UNISWAP_V3");
  });

  // 10. supported normalization variant (case-insensitive dexId), distinct from a version/punctuation variant
  it("matches dexId case-insensitively even though live data is consistently lowercase", () => {
    const result = classifyPoolProtocol(pool({ dexId: "Uniswap", labels: ["v2"] }));
    expect(result.status).toBe("CLASSIFIED");
    expect(result.family).toBe("UNISWAP_V2_LIKE");
  });

  // 11. unsupported near-match label does not accidentally classify
  it("does not fuzzy-match a near-miss label like 'v3.0' or 'v3-turbo'", () => {
    const result = classifyPoolProtocol(pool({ labels: ["v3.0"] }));
    expect(result.status).toBe("PROVISIONAL");
    expect(result.family).toBe("UNKNOWN");
    expect(result.evidence.some((e) => e.kind === "UNSUPPORTED_LABEL")).toBe(true);

    const result2 = classifyPoolProtocol(pool({ labels: ["v3-turbo"] }));
    expect(result2.status).toBe("PROVISIONAL");
    expect(result2.family).toBe("UNKNOWN");
  });

  // 12. evidence/provenance is populated
  it("always populates typed evidence, never leaves it empty", () => {
    const classified = classifyPoolProtocol(pool({ labels: ["v3"] }));
    expect(classified.evidence.length).toBeGreaterThan(0);
    expect(classified.evidence.every((e) => typeof e.kind === "string" && e.detail.length > 0)).toBe(true);

    const unknown = classifyPoolProtocol(pool({ dexId: "robinswap", labels: [] }));
    expect(unknown.evidence.length).toBeGreaterThan(0);
  });

  // 13. classifier is deterministic
  it("returns an identical result for identical input across repeated calls", () => {
    const input = pool({ labels: ["v3"] });
    const first = classifyPoolProtocol(input);
    const second = classifyPoolProtocol(input);
    expect(second).toEqual(first);
  });

  // 14. input object is not mutated
  it("does not mutate the input pool", () => {
    const input = pool({ labels: ["v3"] });
    const snapshot = JSON.parse(JSON.stringify(input));
    classifyPoolProtocol(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  // 15. existing Phase 2 validated pool identity is preserved exactly
  it("preserves the Phase 2 pool identity fields exactly, unmodified", () => {
    const input = pool({
      chainId: CHAIN_ID,
      dexId: "uniswap",
      pairAddress: ADDRESS_20,
      canonicalAssetAddress: NVDA,
      canonicalAssetSymbol: "NVDA",
      canonicalAssetSide: "quote",
      labels: ["v3"],
    });
    const result = classifyPoolProtocol(input);
    expect(result.pool).toEqual({
      chainId: CHAIN_ID,
      dexId: "uniswap",
      pairAddress: ADDRESS_20,
      canonicalAssetAddress: NVDA,
      canonicalAssetSymbol: "NVDA",
      canonicalAssetSide: "quote",
    });
  });

  // 16. multiple pools classify independently
  it("classifies multiple distinct pools independently with no shared state", () => {
    const v3Pool = pool({ pairAddress: ADDRESS_20, labels: ["v3"] });
    const v4Pool = pool({ pairAddress: ID_32, labels: ["v4"] });
    const unknownPool = pool({ dexId: "giga", labels: [] });

    const [v3Result, v4Result, unknownResult] = [v3Pool, v4Pool, unknownPool].map(classifyPoolProtocol);

    expect(v3Result?.family).toBe("UNISWAP_V3");
    expect(v4Result?.family).toBe("UNISWAP_V4");
    expect(unknownResult?.family).toBe("UNKNOWN");
    expect(unknownResult?.status).toBe("UNKNOWN");
  });

  // 17. no network call is required
  it("never touches the network — classification is fully synchronous local computation", () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("classifyPoolProtocol must never call fetch");
    }) as typeof fetch;
    try {
      const result = classifyPoolProtocol(pool({ labels: ["v3"] }));
      expect(result.family).toBe("UNISWAP_V3");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Adversarial extras beyond the required 17.

  it("treats an empty dexId defensively as UNKNOWN rather than throwing (Phase 2 schema already forbids this, but the classifier does not trust that blindly)", () => {
    const result = classifyPoolProtocol(pool({ dexId: "", labels: [] }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.family).toBe("UNKNOWN");
  });

  it("treats a whitespace-only dexId as UNKNOWN after normalization", () => {
    const result = classifyPoolProtocol(pool({ dexId: "   ", labels: [] }));
    expect(result.status).toBe("UNKNOWN");
  });

  it("flags disagreeing labels on the same pool as CONFLICT via CONTRADICTORY_LABEL_EVIDENCE", () => {
    const result = classifyPoolProtocol(pool({ pairAddress: ADDRESS_20, labels: ["v3", "v4"] }));
    expect(result.status).toBe("CONFLICT");
    expect(result.family).toBe("UNKNOWN");
    expect(result.evidence.some((e) => e.kind === "CONTRADICTORY_LABEL_EVIDENCE")).toBe(true);
  });

  it("tolerates duplicate identical labels without double-counting into a conflict", () => {
    const result = classifyPoolProtocol(pool({ pairAddress: ADDRESS_20, labels: ["v3", "v3"] }));
    expect(result.status).toBe("CLASSIFIED");
    expect(result.family).toBe("UNISWAP_V3");
  });

  it("throws InvalidPoolIdentifierShapeError for a pairAddress matching neither shape (defensive invariant, unreachable via real Phase 2 output)", () => {
    expect(() => classifyPoolProtocol(pool({ pairAddress: "0xnotarealaddress" as LiquidityPool["pairAddress"] }))).toThrow(
      InvalidPoolIdentifierShapeError,
    );
  });

  it("does not classify a completely unrelated dexId's v3-shaped label as Uniswap V3", () => {
    // No evidence has ever been observed tying any non-"uniswap" dexId to a
    // "v3" label in this repository's fixtures or README — the mapping
    // table is scoped per-dexId specifically to prevent this.
    const result = classifyPoolProtocol(pool({ dexId: "pancakeswap", pairAddress: ADDRESS_20, labels: ["v3"] }));
    expect(result.family).not.toBe("UNISWAP_V3");
    expect(result.status).not.toBe("CLASSIFIED");
  });

  it("classifies two pools with different canonical asset sides independently", () => {
    const basePool = pool({ canonicalAssetSide: "base", pairAddress: ADDRESS_20, labels: ["v2"] });
    const quotePool = pool({
      canonicalAssetSide: "quote",
      pairAddress: ANOTHER_ADDRESS_20,
      labels: ["v3"],
      dexId: "uniswap",
    });
    const baseResult = classifyPoolProtocol(basePool);
    const quoteResult = classifyPoolProtocol(quotePool);
    expect(baseResult.family).toBe("UNISWAP_V2_LIKE");
    expect(quoteResult.family).toBe("UNISWAP_V3");
    expect(baseResult.pool.canonicalAssetSide).toBe("base");
    expect(quoteResult.pool.canonicalAssetSide).toBe("quote");
  });
});

describe("classifyPoolProtocol — mixed matched/unsupported label semantics (hardening pass)", () => {
  // 1/2. ["v3", "xyz"] does NOT return CLASSIFIED, and retains both
  // mapped-label and unsupported-label provenance.
  it("downgrades to PROVISIONAL/UNKNOWN when a matched label is mixed with an unsupported one", () => {
    const result = classifyPoolProtocol(pool({ pairAddress: ADDRESS_20, labels: ["v3", "xyz"] }));
    expect(result.status).toBe("PROVISIONAL");
    expect(result.family).toBe("UNKNOWN");
    expect(result.version).toBeNull();
    expect(result.evidence.some((e) => e.kind === "EXPLICIT_KNOWN_LABEL_MAPPING")).toBe(true);
    expect(result.evidence.some((e) => e.kind === "UNSUPPORTED_LABEL")).toBe(true);
  });

  // 3. ["v3"] remains CLASSIFIED.
  it("keeps a single matched label CLASSIFIED", () => {
    const result = classifyPoolProtocol(pool({ pairAddress: ADDRESS_20, labels: ["v3"] }));
    expect(result.status).toBe("CLASSIFIED");
    expect(result.family).toBe("UNISWAP_V3");
  });

  // 4. ["v3", "v3"] remains CLASSIFIED (duplicate matched labels are not "mixed").
  it("keeps duplicate identical matched labels CLASSIFIED", () => {
    const result = classifyPoolProtocol(pool({ pairAddress: ADDRESS_20, labels: ["v3", "v3"] }));
    expect(result.status).toBe("CLASSIFIED");
    expect(result.family).toBe("UNISWAP_V3");
  });

  // 5. ["v3", "v4"] remains CONFLICT (label-vs-label disagreement takes
  // priority over the mixed-evidence PROVISIONAL rule — both labels here
  // are "matched", so this never reaches the mixed-evidence check at all).
  it("keeps disagreeing matched labels CONFLICT, not PROVISIONAL", () => {
    const result = classifyPoolProtocol(pool({ pairAddress: ADDRESS_20, labels: ["v3", "v4"] }));
    expect(result.status).toBe("CONFLICT");
    expect(result.family).toBe("UNKNOWN");
  });

  // 6. Unsupported-only label under a known dexId remains PROVISIONAL/UNKNOWN.
  it("leaves an unsupported-only label under a known dexId as PROVISIONAL/UNKNOWN", () => {
    const result = classifyPoolProtocol(pool({ dexId: "uniswap", labels: ["xyz"] }));
    expect(result.status).toBe("PROVISIONAL");
    expect(result.family).toBe("UNKNOWN");
  });

  // 7. Unsupported label under an unknown dexId remains UNKNOWN (not PROVISIONAL —
  // isKnownDexId is false, so there is no "recognized DEX" to be provisional about).
  it("leaves an unsupported label under an unrecognized dexId as UNKNOWN, not PROVISIONAL", () => {
    const result = classifyPoolProtocol(pool({ dexId: "pancakeswap", pairAddress: ADDRESS_20, labels: ["xyz"] }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.family).toBe("UNKNOWN");
  });

  // 8. Empty/whitespace-only labels are deliberately treated as "no label,"
  // never as unsupported metadata that could downgrade a classification.
  describe("empty/whitespace-only labels are meaningless, never downgrading", () => {
    it("still classifies when an empty-string label is mixed with a real one", () => {
      const result = classifyPoolProtocol(pool({ pairAddress: ADDRESS_20, labels: ["v3", ""] }));
      expect(result.status).toBe("CLASSIFIED");
      expect(result.family).toBe("UNISWAP_V3");
      expect(result.evidence.some((e) => e.kind === "UNSUPPORTED_LABEL")).toBe(false);
    });

    it("still classifies when a whitespace-only label is mixed with a real one", () => {
      const result = classifyPoolProtocol(pool({ pairAddress: ADDRESS_20, labels: ["v3", "   "] }));
      expect(result.status).toBe("CLASSIFIED");
      expect(result.family).toBe("UNISWAP_V3");
    });

    it("treats a pool with only empty/whitespace labels the same as a pool with no labels at all", () => {
      const emptyLabels = classifyPoolProtocol(pool({ labels: [] }));
      const onlyBlankLabels = classifyPoolProtocol(pool({ labels: ["", "   "] }));
      expect(onlyBlankLabels.status).toBe(emptyLabels.status);
      expect(onlyBlankLabels.family).toBe(emptyLabels.family);
      expect(onlyBlankLabels.evidence.some((e) => e.kind === "UNSUPPORTED_LABEL")).toBe(false);
    });
  });

  // 9. Phase 6B uses the canonical Phase 2 pool identifier utility rather
  // than a duplicate PoolId regex — checked by cross-referencing the
  // classifier's own `identifierShape` output against
  // `@/domain/pool`'s `getPairIdentifierShape` directly.
  it("derives identifierShape from the same canonical utility Phase 2 uses", () => {
    const addressPool = pool({ pairAddress: ADDRESS_20, labels: ["v3"] });
    const idPool = pool({ pairAddress: ID_32, labels: ["v4"] });
    expect(classifyPoolProtocol(addressPool).identifierShape).toBe(getPairIdentifierShape(ADDRESS_20));
    expect(classifyPoolProtocol(idPool).identifierShape).toBe(getPairIdentifierShape(ID_32));
  });
});
