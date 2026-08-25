import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { PoolProtocolClassification } from "@/domain/protocol";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import type { EthGetLogsFilter, LogEntry, VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { computeV4PoolId, decodeV4InitializeLog, V4_INITIALIZE_TOPIC0 } from "../abi/v4-events";
import { getProtocolDeployment } from "../deployments";
import { verifyPoolIdentity } from "../verify";
import { pool } from "./fixtures";

/**
 * Manual live smoke test for Phase 6C.2. Skipped by default — like every
 * other manual test in this project, normal `npm test` never touches the
 * network. Run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run --reporter=verbose src/domain/pool-verification/__tests__/live-smoke-v4.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set. Deliberately narrow: exercises
 * one specific, already-known-real Uniswap V4 PoolId (supplied out of
 * band, not discovered live) so the expected `Initialize` provenance and
 * `PoolKey` can be asserted exactly, not just "some plausible value" —
 * this is a known-vector regression check against the production
 * verification path, not a market-wide census.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

// Authoritative real Uniswap V4 vector on Robinhood Chain (chainId 4663),
// supplied out of band — NOT derived from this codebase's own fixtures.
const REAL_POOL_ID = "0xb9ce9339dc8022b930545d7f523e3208440db9a6b8f2417af26ef36c4a138b2a" as Hex;
const REAL_CURRENCY0 = "0x52c76A314035cFE9a5235Ae05DB7F56A3AE3C8cc" as Address;
const REAL_CURRENCY1 = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const EXPECTED_INITIALIZE_BLOCK = 45178618n;
const EXPECTED_TRANSACTION_HASH = "0x99f86bd27d2715ced6460611afaa8b01cb59bd52827f2938d2ba26bb8e0d90b1" as Hex;
const EXPECTED_LOG_INDEX = 16;
const EXPECTED_FEE = 800000;
const EXPECTED_TICK_SPACING = 60;
const EXPECTED_HOOKS = "0x0000000000000000000000000000000000000000" as Address;

/** A CLASSIFIED UNISWAP_V4 pool+classification pair for the real PoolId above — hand-built, not run through Phase 6B's classifier, since exercising classification is out of this smoke test's scope (see `classifiedV4Pool` in fixtures.ts for the equivalent deterministic-test pattern). */
function realV4Pool(): { pool: ReturnType<typeof pool>; classification: PoolProtocolClassification } {
  const p = pool({
    dexId: "uniswap-v4",
    pairAddress: REAL_POOL_ID,
    canonicalAssetAddress: REAL_CURRENCY0,
    canonicalAssetSymbol: "UNKNOWN",
    canonicalAssetSide: "base",
    baseToken: { address: REAL_CURRENCY0, name: "Unknown Robinhood Asset", symbol: "UNKNOWN" },
    quoteToken: { address: REAL_CURRENCY1, name: "Global Dollar", symbol: "USDG" },
    labels: ["v4"],
  });
  const classification: PoolProtocolClassification = {
    pool: {
      chainId: p.chainId,
      pairAddress: p.pairAddress,
      dexId: p.dexId,
      canonicalAssetAddress: p.canonicalAssetAddress,
      canonicalAssetSymbol: p.canonicalAssetSymbol,
      canonicalAssetSide: p.canonicalAssetSide,
    },
    identifierShape: "ID_32_BYTE",
    family: "UNISWAP_V4",
    version: "v4",
    status: "CLASSIFIED",
    evidence: [],
  };
  return { pool: p, classification };
}

/** Wraps a real client to record every eth_getLogs call and its raw result, without altering behavior — instrumentation for assertions, not a reimplementation of any verification logic. */
function instrumentGetLogs(rpc: VerifiedRobinhoodRpcClient): {
  rpc: VerifiedRobinhoodRpcClient;
  getLogsCalls: EthGetLogsFilter[];
  getLogsResults: (readonly LogEntry[])[];
} {
  const getLogsCalls: EthGetLogsFilter[] = [];
  const getLogsResults: (readonly LogEntry[])[] = [];
  const wrapped: VerifiedRobinhoodRpcClient = {
    ...rpc,
    getLogs: async (filter) => {
      getLogsCalls.push(filter);
      const logs = await rpc.getLogs(filter);
      getLogsResults.push(logs);
      return logs;
    },
  };
  return { rpc: wrapped, getLogsCalls, getLogsResults };
}

describe.skipIf(!RUN_LIVE)("Phase 6C.2 on-chain V4 pool identity verification (live smoke)", () => {
  it(
    "verifies the known real Uniswap V4 PoolId via the production verification path",
    async () => {
      const baseRpc = await createVerifiedRobinhoodRpcClient();
      const { rpc, getLogsCalls, getLogsResults } = instrumentGetLogs(baseRpc);
      const { pool: p, classification } = realV4Pool();
      const poolManager = getProtocolDeployment(rpc.chainId, "UNISWAP_V4", "pool_manager");

      const result = await verifyPoolIdentity({ pool: p, classification, rpc });

      expect(getLogsCalls).toHaveLength(1);
      const filter = getLogsCalls[0]!;
      const logs = getLogsResults[0]!;
      expect(logs).toHaveLength(1);
      const log = logs[0]!;

      // Reuses the real production decoder purely to recover structured
      // fields for display below — this is the identical function
      // `verifyPoolIdentity` already called internally, not a second
      // independent implementation of decoding.
      const decoded = decodeV4InitializeLog(log, REAL_POOL_ID);
      if (decoded.outcome !== "ok") {
        throw new Error(`expected the real Initialize log to decode cleanly, got outcome="${decoded.outcome}"`);
      }
      const recomputedPoolId = computeV4PoolId(decoded.key);
      const assetMatchEvidence = result.evidence.find((e) => e.kind === "CANONICAL_ASSET_MATCH");

      console.log("\n=== Phase 6C.2 live smoke: known real V4 PoolId ===");
      console.log(`verification attempt block: ${result.blockNumber}`);
      console.log(`discovered PoolId: ${result.pool.pairAddress}`);
      console.log(`canonical PoolManager: ${poolManager.address}`);
      console.log(`search fromBlock: ${filter.fromBlock}`);
      console.log(`search toBlock: ${filter.toBlock}`);
      console.log(`Initialize logs returned: ${logs.length}`);
      console.log(`Initialize event block: ${log.blockNumber}`);
      console.log(`transaction hash: ${log.transactionHash}`);
      console.log(`log index: ${log.logIndex}`);
      console.log(`currency0: ${decoded.key.currency0}`);
      console.log(`currency1: ${decoded.key.currency1}`);
      console.log(`fee: ${decoded.key.fee}`);
      console.log(`tickSpacing: ${decoded.key.tickSpacing}`);
      console.log(`hooks: ${decoded.key.hooks}`);
      console.log(`recomputed PoolId: ${recomputedPoolId}`);
      console.log(`discovered pair: {${p.baseToken.address}, ${p.quoteToken.address}}`);
      console.log(`recovered pair: {${decoded.key.currency0}, ${decoded.key.currency1}}`);
      console.log(`canonical asset: ${p.canonicalAssetAddress}`);
      console.log(`canonical asset match: ${assetMatchEvidence?.support ?? "-"}`);
      console.log(`final verification status: ${result.status}`);
      for (const e of result.evidence) {
        console.log(
          `  [${e.kind}] support=${e.support} observed=${e.observed ?? "-"} expected=${e.expected ?? "-"} :: ${e.detail}`,
        );
      }

      // --- negative-evidence / exact filter-shape validation ---
      expect(filter.address).toBe(poolManager.address);
      expect(filter.topics).toEqual([V4_INITIALIZE_TOPIC0, REAL_POOL_ID]);
      expect(filter.fromBlock).toBe(9070n);
      expect(filter.toBlock).toBe(result.blockNumber);

      // --- known-vector cross-checks against the authoritative supplied values ---
      expect(log.blockNumber).toBe(EXPECTED_INITIALIZE_BLOCK);
      expect(log.transactionHash.toLowerCase()).toBe(EXPECTED_TRANSACTION_HASH.toLowerCase());
      expect(log.logIndex).toBe(EXPECTED_LOG_INDEX);
      expect(decoded.key.currency0.toLowerCase()).toBe(REAL_CURRENCY0.toLowerCase());
      expect(decoded.key.currency1.toLowerCase()).toBe(REAL_CURRENCY1.toLowerCase());
      expect(decoded.key.fee).toBe(EXPECTED_FEE);
      expect(decoded.key.tickSpacing).toBe(EXPECTED_TICK_SPACING);
      expect(decoded.key.hooks.toLowerCase()).toBe(EXPECTED_HOOKS.toLowerCase());
      expect(recomputedPoolId.toLowerCase()).toBe(REAL_POOL_ID.toLowerCase());

      expect(result.status).toBe("VERIFIED");
    },
    30000,
  );

  it(
    "flags a deliberately corrupted discovery identity against the same real on-chain evidence as CONTRADICTED",
    async () => {
      const baseRpc = await createVerifiedRobinhoodRpcClient();
      const { rpc, getLogsCalls } = instrumentGetLogs(baseRpc);
      const { pool: p, classification } = realV4Pool();
      // A real, valid 20-byte address that is not part of this pool — the
      // same "corrupt only the canonical asset" pattern the Phase 6C.1
      // V3 live smoke uses, isolating exactly one check (CANONICAL_ASSET_MATCH)
      // against otherwise-genuine on-chain evidence.
      const corrupted = { ...p, canonicalAssetAddress: "0x0000000000000000000000000000000000dEaD" as Address };

      const result = await verifyPoolIdentity({ pool: corrupted, classification, rpc });

      console.log("\n=== Phase 6C.2 live smoke: deliberately corrupted discovery identity ===");
      console.log(`final verification status: ${result.status}`);
      console.log(
        result.evidence
          .filter((e) => e.kind === "CANONICAL_ASSET_MATCH")
          .map((e) => `  [${e.kind}] support=${e.support} :: ${e.detail}`)
          .join("\n"),
      );

      expect(getLogsCalls).toHaveLength(1);
      expect(result.status).toBe("CONTRADICTED");
      expect(result.evidence.find((e) => e.kind === "CANONICAL_ASSET_MATCH")?.support).toBe("CONTRADICTS");
    },
    30000,
  );
});
