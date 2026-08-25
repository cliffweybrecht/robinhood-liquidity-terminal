import { keccak256, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { computeV4PoolId, decodeV4InitializeLog, V4_INITIALIZE_TOPIC0 } from "../abi/v4-events";
import { verifyPoolIdentity } from "../verify";
import {
  addressReturn,
  buildFakeRpc,
  classifiedV4Pool,
  type GetLogsStub,
  intWord,
  OTHER_POOL_ADDRESS,
  uintWord,
  v4InitializeData,
  v4InitializeLog,
  V4_BLOCK_NUMBER,
  V4_CURRENCY0,
  V4_CURRENCY1,
  V4_DEPLOYMENT_BLOCK,
  V4_FEE,
  V4_HISTORICAL_BLOCK_NUMBER,
  V4_HOOKS,
  V4_POOL_ID,
  V4_POOL_MANAGER,
  V4_TICK_SPACING,
  V4_TRANSACTION_HASH,
  WETH,
} from "./fixtures";

describe("Uniswap V4 — PoolId vector", () => {
  it("recomputes the known PoolKey -> PoolId vector, cross-checked via independent raw word concatenation", () => {
    // Deliberately not calling computeV4PoolId to build the "expected"
    // value here — this concatenates the 5 ABI words by hand (valid
    // because every PoolKey field is a static-size ABI type, so
    // abi.encode is exactly this concatenation, with no offset/length
    // prefixes) and only then checks computeV4PoolId reproduces it.
    const words =
      addressReturn(V4_CURRENCY0).slice(2) +
      addressReturn(V4_CURRENCY1).slice(2) +
      uintWord(BigInt(V4_FEE)) +
      intWord(V4_TICK_SPACING) +
      addressReturn(V4_HOOKS).slice(2);
    const independentlyComputed = keccak256(`0x${words}` as Hex);

    expect(independentlyComputed).toBe(V4_POOL_ID);
    expect(
      computeV4PoolId({
        currency0: V4_CURRENCY0,
        currency1: V4_CURRENCY1,
        fee: V4_FEE,
        tickSpacing: V4_TICK_SPACING,
        hooks: V4_HOOKS,
      }),
    ).toBe(independentlyComputed);
  });
});

describe("Uniswap V4 — Initialize log decoder", () => {
  it("decodes a valid, non-removed Initialize log into the exact PoolKey", () => {
    const result = decodeV4InitializeLog(v4InitializeLog(), V4_POOL_ID);

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.key.currency0.toLowerCase()).toBe(V4_CURRENCY0.toLowerCase());
    expect(result.key.currency1.toLowerCase()).toBe(V4_CURRENCY1.toLowerCase());
    expect(result.key.fee).toBe(V4_FEE);
    expect(result.key.tickSpacing).toBe(V4_TICK_SPACING);
    expect(result.key.hooks.toLowerCase()).toBe(V4_HOOKS.toLowerCase());
  });

  it("decodes a negative int24 tickSpacing correctly", () => {
    const log = v4InitializeLog({ data: v4InitializeData({ tickSpacing: -200 }) });

    const result = decodeV4InitializeLog(log, V4_POOL_ID);

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.key.tickSpacing).toBe(-200);
  });

  it("accepts the dynamic-fee flag (0x800000) as a valid fee", () => {
    const log = v4InitializeLog({ data: v4InitializeData({ fee: 0x800000 }) });

    const result = decodeV4InitializeLog(log, V4_POOL_ID);

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.key.fee).toBe(0x800000);
  });

  it("rejects a fee that is neither <= MAX_LP_FEE nor exactly the dynamic-fee flag", () => {
    const log = v4InitializeLog({ data: v4InitializeData({ fee: 0x800001 }) });

    expect(decodeV4InitializeLog(log, V4_POOL_ID).outcome).toBe("malformed");
  });

  it("treats a removed log as removed, distinct from malformed", () => {
    const log = v4InitializeLog({ removed: true });

    expect(decodeV4InitializeLog(log, V4_POOL_ID)).toEqual({ outcome: "removed" });
  });

  describe("malformed topics/data", () => {
    it("rejects a topic count other than 4", () => {
      const log = v4InitializeLog({ topics: [V4_INITIALIZE_TOPIC0, V4_POOL_ID, addressReturn(V4_CURRENCY0)] });
      expect(decodeV4InitializeLog(log, V4_POOL_ID).outcome).toBe("malformed");
    });

    it("rejects a topic0 that does not match the Initialize event signature", () => {
      const wrongTopic0 = `0x${"11".repeat(32)}` as Hex;
      const log = v4InitializeLog({ topics: [wrongTopic0, V4_POOL_ID, addressReturn(V4_CURRENCY0), addressReturn(V4_CURRENCY1)] });
      expect(decodeV4InitializeLog(log, V4_POOL_ID).outcome).toBe("malformed");
    });

    it("rejects a topic1 (id) that does not match the expected PoolId", () => {
      const wrongId = `0x${"22".repeat(32)}` as Hex;
      const log = v4InitializeLog({ topics: [V4_INITIALIZE_TOPIC0, wrongId, addressReturn(V4_CURRENCY0), addressReturn(V4_CURRENCY1)] });
      expect(decodeV4InitializeLog(log, V4_POOL_ID).outcome).toBe("malformed");
    });

    it("rejects a currency topic with non-zero padding (the exact viem decodeAbiParameters leniency this module refuses to inherit)", () => {
      const badlyPaddedCurrency0 = `0x${"11".repeat(12)}${V4_CURRENCY0.slice(2)}` as Hex;
      const log = v4InitializeLog({ topics: [V4_INITIALIZE_TOPIC0, V4_POOL_ID, badlyPaddedCurrency0, addressReturn(V4_CURRENCY1)] });
      expect(decodeV4InitializeLog(log, V4_POOL_ID).outcome).toBe("malformed");
    });

    it("rejects data that is not exactly 5 ABI words", () => {
      const log = v4InitializeLog({ data: "0x1234" as Hex });
      expect(decodeV4InitializeLog(log, V4_POOL_ID).outcome).toBe("malformed");
    });
  });
});

describe("Uniswap V4 verification — VERIFIED path", () => {
  it("verifies a pool whose full historical Initialize provenance is internally consistent", async () => {
    const { pool, classification } = classifiedV4Pool();
    const { rpc, calls } = buildFakeRpc({ getLogs: [v4InitializeLog()] });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.family).toBe("UNISWAP_V4");
    expect(result.evidence.every((e) => e.support !== "CONTRADICTS")).toBe(true);
    expect(result.evidence.map((e) => e.kind)).toEqual([
      "V4_INITIALIZE_EVENT_FOUND",
      "V4_POOL_KEY_RECOVERED",
      "V4_POOL_ID_RECOMPUTED",
      "V4_CURRENCY_PAIR_MATCH",
      "CANONICAL_ASSET_MATCH",
    ]);
    // Uniswap V4 has no per-pool contract — identity is never established via getCode/call.
    expect(calls.getCodeCalls).toHaveLength(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("queries eth_getLogs with the exact canonical PoolManager address, Initialize topic0, PoolId topic1, and full deployment-to-pinned-block range", async () => {
    const { pool, classification } = classifiedV4Pool();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: async () => V4_BLOCK_NUMBER, getLogs: [v4InitializeLog()] });

    await verifyPoolIdentity({ pool, classification, rpc });

    expect(calls.getLogsCalls).toHaveLength(1);
    expect(calls.getLogsCalls[0]).toEqual({
      address: V4_POOL_MANAGER,
      topics: [V4_INITIALIZE_TOPIC0, V4_POOL_ID],
      fromBlock: V4_DEPLOYMENT_BLOCK,
      toBlock: V4_BLOCK_NUMBER,
    });
  });

  it("preserves historical provenance (blockNumber, transactionHash, logIndex) from the Initialize event, distinct from the pinned current blockNumber", async () => {
    const { pool, classification } = classifiedV4Pool();
    const { rpc } = buildFakeRpc({ getBlockNumber: async () => V4_BLOCK_NUMBER, getLogs: [v4InitializeLog()] });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.blockNumber).toBe(V4_BLOCK_NUMBER);
    expect(result.historicalProvenance).toEqual({
      blockNumber: V4_HISTORICAL_BLOCK_NUMBER,
      transactionHash: V4_TRANSACTION_HASH,
      logIndex: 0,
    });
    expect(result.historicalProvenance?.blockNumber).not.toBe(result.blockNumber);
  });
});

describe("Uniswap V4 verification — CONTRADICTED", () => {
  it("resolves CONTRADICTED when zero matching Initialize events exist across the complete canonical range", async () => {
    const { pool, classification } = classifiedV4Pool();
    const { rpc } = buildFakeRpc({ getLogs: [] });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.kind).toBe("V4_INITIALIZE_EVENT_FOUND");
    expect(result.evidence[0]?.support).toBe("CONTRADICTS");
    expect(result.historicalProvenance).toBeNull();
  });

  it("resolves CONTRADICTED when the recomputed PoolId does not match the discovered PoolId", async () => {
    const { pool, classification } = classifiedV4Pool();
    // Self-consistent topics (matches the getLogs filter and the decoder's
    // topic1 check) but data for a different fee than V4_POOL_ID was
    // derived from — decodes cleanly, but recomputes to a different PoolId.
    const mismatchedLog = v4InitializeLog({ data: v4InitializeData({ fee: 500 }) });
    const { rpc } = buildFakeRpc({ getLogs: [mismatchedLog] });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    const idEvidence = result.evidence.find((e) => e.kind === "V4_POOL_ID_RECOMPUTED");
    expect(idEvidence?.support).toBe("CONTRADICTS");
    // Provenance is still preserved even though the event contradicts —
    // it's real evidence about what WAS found, useful for the record.
    expect(result.historicalProvenance).not.toBeNull();
  });

  it("resolves CONTRADICTED when the decoded currency pair does not match the discovered pool's tokens", async () => {
    const { pool, classification } = classifiedV4Pool({
      baseToken: { address: WETH, name: "Wrapped Ether", symbol: "WETH" },
      quoteToken: { address: OTHER_POOL_ADDRESS, name: "Other", symbol: "OTH" },
      canonicalAssetAddress: WETH,
    });
    const { rpc } = buildFakeRpc({ getLogs: [v4InitializeLog()] });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    const pairEvidence = result.evidence.find((e) => e.kind === "V4_CURRENCY_PAIR_MATCH");
    expect(pairEvidence?.support).toBe("CONTRADICTS");
  });

  it("resolves CONTRADICTED when the canonical asset is absent from the decoded currency pair (pair itself still matches)", async () => {
    const { pool, classification } = classifiedV4Pool({ canonicalAssetAddress: WETH });
    const { rpc } = buildFakeRpc({ getLogs: [v4InitializeLog()] });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("CONTRADICTED");
    expect(result.evidence.find((e) => e.kind === "V4_CURRENCY_PAIR_MATCH")?.support).toBe("SUPPORTS");
    expect(result.evidence.find((e) => e.kind === "CANONICAL_ASSET_MATCH")?.support).toBe("CONTRADICTS");
  });
});

describe("Uniswap V4 verification — INDETERMINATE", () => {
  it("resolves INDETERMINATE when more than one matching Initialize event is returned (protocol-impossible; refuses to pick one)", async () => {
    const { pool, classification } = classifiedV4Pool();
    const { rpc } = buildFakeRpc({ getLogs: [v4InitializeLog(), v4InitializeLog({ logIndex: 1 })] });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.kind).toBe("V4_INITIALIZE_EVENT_AMBIGUOUS");
    expect(result.historicalProvenance).toBeNull();
  });

  it("resolves INDETERMINATE when the single matching log is removed", async () => {
    const { pool, classification } = classifiedV4Pool();
    const { rpc } = buildFakeRpc({ getLogs: [v4InitializeLog({ removed: true })] });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence[0]?.kind).toBe("V4_POOL_KEY_RECOVERED");
    expect(result.historicalProvenance).toBeNull();
  });

  it("resolves INDETERMINATE when the single matching log has malformed data", async () => {
    const { pool, classification } = classifiedV4Pool();
    const { rpc } = buildFakeRpc({ getLogs: [v4InitializeLog({ data: "0xdead" as Hex })] });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence[0]?.kind).toBe("V4_POOL_KEY_RECOVERED");
    expect(result.historicalProvenance).toBeNull();
  });
});

describe("Uniswap V4 verification — RPC_ERROR", () => {
  it("resolves RPC_ERROR when eth_getLogs itself fails", async () => {
    const { pool, classification } = classifiedV4Pool();
    const { rpc } = buildFakeRpc({ getLogs: { error: new Error("transport down") } });

    const result = await verifyPoolIdentity({ pool, classification, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.blockNumber).not.toBeNull();
    expect(result.historicalProvenance).toBeNull();
  });
});

describe("Uniswap V4 verification — never touches eth_getCode/eth_call", () => {
  it("never calls eth_getCode or eth_call for any V4 outcome", async () => {
    const { pool, classification } = classifiedV4Pool();
    const scenarios: GetLogsStub[] = [
      [v4InitializeLog()],
      [],
      [v4InitializeLog(), v4InitializeLog({ logIndex: 1 })],
      { error: new Error("boom") },
    ];

    for (const getLogs of scenarios) {
      const { rpc, calls } = buildFakeRpc({ getLogs });
      await verifyPoolIdentity({ pool, classification, rpc });
      expect(calls.getCodeCalls).toHaveLength(0);
      expect(calls.callCalls).toHaveLength(0);
    }
  });
});
