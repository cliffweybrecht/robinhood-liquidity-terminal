import { describe, expect, it } from "vitest";
import { verifyPoolIdentity } from "../verify";
import { PoolClassificationMismatchError, UnexpectedIdentifierShapeError } from "../errors";
import { buildFakeRpc, classifiedPool, DEFAULT_CODE, POOL_ADDRESS } from "./fixtures";

const ID_32 = "0x401bc4b106c6deac5c66c251743efce2776a7eb0ce49d122d870308a4d209e43";

describe("verifyPoolIdentity — dispatch", () => {
  it.each([
    ["PROVISIONAL classification status", { status: "PROVISIONAL" as const }],
    ["UNKNOWN classification status", { status: "UNKNOWN" as const }],
    ["CONFLICT classification status", { status: "CONFLICT" as const }],
    ["OTHER_KNOWN family", { family: "OTHER_KNOWN" as const }],
    ["UNISWAP_V2_LIKE family", { family: "UNISWAP_V2_LIKE" as const }],
    ["UNISWAP_V4 family", { family: "UNISWAP_V4" as const }],
    ["UNKNOWN family", { family: "UNKNOWN" as const }],
  ])("resolves UNSUPPORTED with zero RPC calls for %s", async (_label, override) => {
    const { pool, classification } = classifiedPool({}, override);
    const { rpc, calls } = buildFakeRpc();

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("UNSUPPORTED");
    expect(result.blockNumber).toBeNull();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.kind).toBe("CLASSIFICATION_UNSUPPORTED");
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.getCodeCalls).toHaveLength(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("preserves family/classificationStatus/pool identity on an UNSUPPORTED result", async () => {
    const { pool, classification } = classifiedPool({}, { family: "UNISWAP_V4", status: "CLASSIFIED" });
    const { rpc } = buildFakeRpc();

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.family).toBe("UNISWAP_V4");
    expect(result.classificationStatus).toBe("CLASSIFIED");
    expect(result.pool).toEqual({
      chainId: pool.chainId,
      pairAddress: pool.pairAddress,
      dexId: pool.dexId,
      canonicalAssetAddress: pool.canonicalAssetAddress,
      canonicalAssetSymbol: pool.canonicalAssetSymbol,
      canonicalAssetSide: pool.canonicalAssetSide,
    });
  });

  it("attempts verification for CLASSIFIED UNISWAP_V3 (reaches the RPC layer)", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc, calls } = buildFakeRpc();

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(calls.getBlockNumberCalls).toBe(1);
    expect(calls.getCodeCalls.length).toBeGreaterThan(0);
  });
});

describe("verifyPoolIdentity — classification/pool consistency", () => {
  it("throws PoolClassificationMismatchError when classification.pool doesn't match pool", async () => {
    const { pool, classification } = classifiedPool();
    const mismatched = {
      ...classification,
      pool: { ...classification.pool, pairAddress: "0x1234567890123456789012345678901234567890" as typeof classification.pool.pairAddress },
    };
    const { rpc } = buildFakeRpc();

    await expect(verifyPoolIdentity({ pool, classification: mismatched, rpc })).rejects.toThrow(
      PoolClassificationMismatchError,
    );
  });

  it("throws UnexpectedIdentifierShapeError for a CLASSIFIED UNISWAP_V3 pool with a 32-byte pairAddress, and never sends it to getCode (defensive, unreachable via the real classifier)", async () => {
    const { pool, classification } = classifiedPool({ pairAddress: ID_32 as typeof POOL_ADDRESS });
    const { rpc, calls } = buildFakeRpc();

    await expect(verifyPoolIdentity({ pool, classification, rpc })).rejects.toThrow(UnexpectedIdentifierShapeError);
    expect(calls.getCodeCalls).toHaveLength(0);
    expect(calls.callCalls).toHaveLength(0);
    expect(calls.getBlockNumberCalls).toBe(0);
  });
});

describe("verifyPoolIdentity — block consistency", () => {
  it("calls getBlockNumber exactly once and pins every subsequent getCode/call to that exact block", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: async () => 999888n });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(result.blockNumber).toBe(999888n);
    expect(calls.getCodeCalls.length).toBeGreaterThan(0);
    for (const c of calls.getCodeCalls) expect(c.blockTag).toBe(999888n);
    expect(calls.callCalls.length).toBeGreaterThan(0);
    for (const c of calls.callCalls) expect(c.blockTag).toBe(999888n);
  });

  it("returns RPC_ERROR with a null blockNumber when getBlockNumber itself fails", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: { error: new Error("boom") } });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.blockNumber).toBeNull();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.kind).toBe("BLOCK_PIN_FAILURE");
    expect(calls.getCodeCalls).toHaveLength(0);
    expect(calls.callCalls).toHaveLength(0);
  });
});

describe("verifyPoolIdentity — generic 20-byte contract-code evidence", () => {
  it("returns CONTRADICTED with CONTRACT_CODE_ABSENT for empty code", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc, calls } = buildFakeRpc({ code: "0x" });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    expect(result.evidence).toEqual([
      expect.objectContaining({ kind: "CONTRACT_CODE_ABSENT", support: "CONTRADICTS" }),
    ]);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("returns INDETERMINATE when getCode returns a value that is not valid hex bytes at all (defensive — the real client never does this)", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc, calls } = buildFakeRpc({ code: "not-hex-at-all" as typeof DEFAULT_CODE });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.kind).toBe("CONTRACT_CODE_PRESENT");
    expect(result.evidence[0]?.support).toBe("NEUTRAL");
    expect(calls.callCalls).toHaveLength(0);
  });

  it("returns RPC_ERROR when getCode itself fails", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc, calls } = buildFakeRpc({ code: { error: new Error("transport down") } });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.blockNumber).not.toBeNull();
    expect(calls.callCalls).toHaveLength(0);
  });

  it("proceeds to V3-specific reads with supporting (non-decisive) evidence for non-empty code", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ code: DEFAULT_CODE });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    const codeEvidence = result.evidence.find((e) => e.kind === "CONTRACT_CODE_PRESENT");
    expect(codeEvidence?.support).toBe("SUPPORTS");
    expect(result.status).toBe("VERIFIED");
  });

  it("never sends a 32-byte identifier to getCode (checked at the RPC boundary in practice; here confirmed only 20-byte addresses reach getCode)", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc, calls } = buildFakeRpc();

    await verifyPoolIdentity({ pool, classification, rpc });

    for (const c of calls.getCodeCalls) {
      expect(c.address.replace(/^0x/, "")).toHaveLength(40);
    }
  });
});
