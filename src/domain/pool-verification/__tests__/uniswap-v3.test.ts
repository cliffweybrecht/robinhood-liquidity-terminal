import { describe, expect, it } from "vitest";
import { verifyPoolIdentity } from "../verify";
import {
  addressReturn,
  buildFakeRpc,
  CANONICAL_FACTORY,
  classifiedPool,
  FEE_TIER,
  NVDA,
  OTHER_POOL_ADDRESS,
  uint24Return,
  USDG,
  WETH,
} from "./fixtures";

describe("Uniswap V3 verification — VERIFIED path", () => {
  it("verifies a pool whose full on-chain proof is internally consistent", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc, calls } = buildFakeRpc();

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.family).toBe("UNISWAP_V3");
    expect(result.classificationStatus).toBe("CLASSIFIED");
    // every evidence entry is either SUPPORTS or NEUTRAL — nothing contradicts
    expect(result.evidence.every((e) => e.support !== "CONTRADICTS")).toBe(true);
    expect(result.evidence.map((e) => e.kind)).toEqual([
      "CONTRACT_CODE_PRESENT",
      "TOKEN0_READ",
      "TOKEN1_READ",
      "TOKEN_PAIR_MATCH",
      "CANONICAL_ASSET_MATCH",
      "FACTORY_READ",
      "FEE_READ",
      "FACTORY_POOL_LOOKUP",
    ]);
    // the getPool lookup was called against the canonical factory with the decoded token0/token1/fee
    const lookupCall = calls.callCalls.find((c) => c.to.toLowerCase() === CANONICAL_FACTORY.toLowerCase());
    expect(lookupCall).toBeDefined();
  });

  it("exposes v3PoolKey (token0/token1/fee) exactly matching the values already proven via the canonical factory lookup — never re-derived, never re-read", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc();

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.v3PoolKey).toEqual({ token0: NVDA, token1: USDG, fee: FEE_TIER });
    // Exactly the same values the FACTORY_POOL_LOOKUP evidence's canonical proof used as input.
    const feeEvidence = result.evidence.find((e) => e.kind === "FEE_READ");
    expect(feeEvidence?.observed).toBe(String(FEE_TIER));
  });

  it("matches the pair regardless of on-chain token0/token1 orientation vs discovered base/quote orientation", async () => {
    // discovered baseToken=NVDA, quoteToken=USDG; on-chain token0=USDG, token1=NVDA (swapped)
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ token0: addressReturn(USDG), token1: addressReturn(NVDA) });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("VERIFIED");
  });
});

describe("Uniswap V3 verification — CONTRADICTED", () => {
  it("contradicts on a token0 mismatch (token0 is neither discovered token)", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ token0: addressReturn(WETH) });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    expect(result.evidence.find((e) => e.kind === "TOKEN_PAIR_MATCH")?.support).toBe("CONTRADICTS");
    // A CONTRADICTED identity's token0/token1/fee are NOT exposed as "the verified facts for this pool".
    expect(result.v3PoolKey).toBeNull();
  });

  it("contradicts on a token1/pair mismatch", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ token1: addressReturn(WETH) });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    expect(result.evidence.find((e) => e.kind === "TOKEN_PAIR_MATCH")?.support).toBe("CONTRADICTS");
    expect(result.v3PoolKey).toBeNull();
  });

  it("contradicts when the canonical asset address is absent from the on-chain pair", async () => {
    // on-chain pair is {WETH, USDG} — a real pair, but doesn't include canonicalAssetAddress (NVDA)
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ token0: addressReturn(WETH) });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    // both TOKEN_PAIR_MATCH and CANONICAL_ASSET_MATCH contradict here since the whole pair is wrong;
    // assert the canonical-asset-specific evidence is itself present and contradicting.
    expect(result.evidence.find((e) => e.kind === "CANONICAL_ASSET_MATCH")?.support).toBe("CONTRADICTS");
  });

  it("contradicts on a factory mismatch", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ factory: addressReturn(WETH) });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    const factoryEvidence = result.evidence.find((e) => e.kind === "FACTORY_READ");
    expect(factoryEvidence?.support).toBe("CONTRADICTS");
    expect(factoryEvidence?.observed).toBe(WETH);
    expect(factoryEvidence?.expected).toBe(CANONICAL_FACTORY);
  });

  it("contradicts when the canonical factory's getPool returns the zero address", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ getPool: addressReturn("0x0000000000000000000000000000000000000000") });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    const lookupEvidence = result.evidence.find((e) => e.kind === "FACTORY_POOL_LOOKUP");
    expect(lookupEvidence?.support).toBe("CONTRADICTS");
    expect(lookupEvidence?.detail).toMatch(/no pool exists/i);
  });

  it("contradicts when the canonical factory's getPool returns a different pool address", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ getPool: addressReturn(OTHER_POOL_ADDRESS) });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    const lookupEvidence = result.evidence.find((e) => e.kind === "FACTORY_POOL_LOOKUP");
    expect(lookupEvidence?.support).toBe("CONTRADICTS");
    expect(lookupEvidence?.observed).toBe(OTHER_POOL_ADDRESS);
  });
});

describe("Uniswap V3 verification — read failures (RPC_ERROR)", () => {
  it("returns RPC_ERROR when token0() fails", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ token0: { error: new Error("timeout") } });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("RPC_ERROR");
    expect(result.evidence.find((e) => e.kind === "TOKEN0_READ")?.detail).toMatch(/RPC read failed/);
    expect(result.v3PoolKey).toBeNull();
  });

  it("returns RPC_ERROR when token1() fails", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ token1: { error: new Error("timeout") } });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("RPC_ERROR");
  });

  it("returns RPC_ERROR when factory() fails", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ factory: { error: new Error("timeout") } });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("RPC_ERROR");
  });

  it("returns RPC_ERROR when fee() fails", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ fee: { error: new Error("timeout") } });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("RPC_ERROR");
  });

  it("returns RPC_ERROR when the factory getPool lookup fails", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ getPool: { error: new Error("timeout") } });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("RPC_ERROR");
  });

  it("prioritizes CONTRADICTED over RPC_ERROR when both occur in the same attempt", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ token0: addressReturn(WETH), fee: { error: new Error("timeout") } });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("CONTRADICTED");
  });
});

describe("Uniswap V3 verification — decode/structural failures (INDETERMINATE)", () => {
  it("treats a malformed token0 address return as INDETERMINATE, not a contradiction", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ token0: "0xdeadbeef" });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("INDETERMINATE");
    const token0Evidence = result.evidence.find((e) => e.kind === "TOKEN0_READ");
    expect(token0Evidence?.support).toBe("NEUTRAL");
    expect(result.v3PoolKey).toBeNull();
  });

  it("treats a malformed factory address return (non-zero padding) as INDETERMINATE", async () => {
    const { pool, classification } = classifiedPool();
    // 32-byte word with a non-zero byte in the padding region — a well-formed
    // address return never has anything there.
    const malformed = `0x${"11".repeat(12)}${CANONICAL_FACTORY.slice(2).toLowerCase()}`;
    const { rpc } = buildFakeRpc({ factory: malformed as `0x${string}` });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("INDETERMINATE");
  });

  it("treats a malformed fee return (value exceeding uint24 max) as INDETERMINATE", async () => {
    const { pool, classification } = classifiedPool();
    const tooLarge = `0x${(0x1000000n).toString(16).padStart(64, "0")}`; // 2^24, one more than uint24 max
    const { rpc } = buildFakeRpc({ fee: tooLarge as `0x${string}` });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("INDETERMINATE");
  });

  it("treats an empty return where a value was expected as INDETERMINATE, not a contradiction", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ token1: "0x" });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "TOKEN1_READ")?.support).toBe("NEUTRAL");
  });

  it("prioritizes CONTRADICTED over INDETERMINATE when both occur in the same attempt", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc } = buildFakeRpc({ token0: addressReturn(WETH), fee: "0xdeadbeef" });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("CONTRADICTED");
  });

  it("does not attempt the factory getPool lookup when a prerequisite (fee) failed to decode", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc, calls } = buildFakeRpc({ fee: "0xdeadbeef" });
    const result = await verifyPoolIdentity({ pool, classification, rpc });
    expect(result.status).toBe("INDETERMINATE");
    const lookupEvidence = result.evidence.find((e) => e.kind === "FACTORY_POOL_LOOKUP");
    expect(lookupEvidence?.support).toBe("NEUTRAL");
    expect(lookupEvidence?.detail).toMatch(/not attempted/i);
    expect(calls.callCalls.some((c) => c.to.toLowerCase() === CANONICAL_FACTORY.toLowerCase())).toBe(false);
  });
});

describe("Uniswap V3 verification — evidence determinism", () => {
  it("produces evidence in a fixed, deterministic order across repeated runs", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc: rpc1 } = buildFakeRpc();
    const { rpc: rpc2 } = buildFakeRpc();

    const result1 = await verifyPoolIdentity({ pool, classification, rpc: rpc1 });
    const result2 = await verifyPoolIdentity({ pool, classification, rpc: rpc2 });

    expect(result1.evidence.map((e) => e.kind)).toEqual(result2.evidence.map((e) => e.kind));
  });

  it("records the decoded fee tier and passes that exact value as the getPool call's fee argument", async () => {
    const { pool, classification } = classifiedPool();
    const { rpc, calls } = buildFakeRpc({ fee: uint24Return(500) });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.evidence.find((e) => e.kind === "FEE_READ")?.observed).toBe("500");
    const lookupCall = calls.callCalls.find((c) => c.to.toLowerCase() === CANONICAL_FACTORY.toLowerCase());
    // fee=500 ABI-encodes as ...01f4 in the final calldata word
    expect(lookupCall?.data.toLowerCase().endsWith("1f4")).toBe(true);
  });
});
