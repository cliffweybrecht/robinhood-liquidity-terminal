import { describe, expect, it } from "vitest";
import { getDexScreenerPoolsBySymbol } from "@/domain/pool";
import { classifyPoolProtocol } from "@/domain/protocol";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { verifyPoolIdentity } from "../verify";

/**
 * Manual live smoke test for Phase 6C.1. Skipped by default — like
 * every other manual test in this project, normal `npm test` never
 * touches the network. Run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run --reporter=verbose src/domain/pool-verification/__tests__/live-smoke.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set (same as Phase 6A's live smoke
 * test). Deliberately narrow: verifies exactly one real, currently
 * CLASSIFIED-UNISWAP_V3 pool discovered for NVDA, plus one deliberately
 * contradictory variant of that same pool. This is NOT a market-wide
 * verification census — see README "Out of scope" for why that's
 * explicitly deferred.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

describe.skipIf(!RUN_LIVE)("Phase 6C.1 on-chain pool identity verification (live smoke)", () => {
  it(
    "verifies a real, currently-discovered CLASSIFIED UNISWAP_V3 pool's on-chain identity",
    async () => {
      const rpc = await createVerifiedRobinhoodRpcClient();
      const { pools } = await getDexScreenerPoolsBySymbol("NVDA");

      const v3Pool = pools
        .map((pool) => ({ pool, classification: classifyPoolProtocol(pool) }))
        .find(({ classification }) => classification.status === "CLASSIFIED" && classification.family === "UNISWAP_V3");

      if (!v3Pool) {
        throw new Error(
          "No CLASSIFIED UNISWAP_V3 pool found among NVDA's currently discovered pools — live pool population may have changed; this smoke test needs at least one to exercise the V3 strategy.",
        );
      }

      const result = await verifyPoolIdentity({ pool: v3Pool.pool, classification: v3Pool.classification, rpc });

      console.log("\n=== Phase 6C.1 live smoke: valid pool ===");
      console.log(`pinned block: ${result.blockNumber}`);
      console.log(`discovered pool address: ${result.pool.pairAddress}`);
      for (const e of result.evidence) {
        console.log(
          `  [${e.kind}] support=${e.support} observed=${e.observed ?? "-"} expected=${e.expected ?? "-"} :: ${e.detail}`,
        );
      }
      console.log(`final status: ${result.status}`);

      expect(result.blockNumber).not.toBeNull();
      expect(result.blockNumber! > 0n).toBe(true);
      expect(result.evidence.length).toBeGreaterThan(0);
      // The whole point of this smoke test: a real, currently-classified V3
      // pool's on-chain state should actually verify. A failure here is
      // itself a meaningful signal (either a real on-chain discrepancy or a
      // wrong assumption in this phase's implementation), not just noise.
      expect(result.status).toBe("VERIFIED");
    },
    30000,
  );

  it(
    "flags a deliberately contradictory variant (wrong canonical asset address) as CONTRADICTED",
    async () => {
      const rpc = await createVerifiedRobinhoodRpcClient();
      const { pools } = await getDexScreenerPoolsBySymbol("NVDA");

      const v3Pool = pools
        .map((pool) => ({ pool, classification: classifyPoolProtocol(pool) }))
        .find(({ classification }) => classification.status === "CLASSIFIED" && classification.family === "UNISWAP_V3");

      if (!v3Pool) {
        throw new Error("No CLASSIFIED UNISWAP_V3 pool found among NVDA's currently discovered pools.");
      }

      // A real, valid 20-byte address that is not part of this specific
      // pool — swapping it in as the "canonical asset" should make the
      // CANONICAL_ASSET_MATCH check fail even though everything else about
      // the pool is genuinely valid on-chain.
      const wrongCanonicalAsset = "0x0000000000000000000000000000000000dEaD" as typeof v3Pool.pool.canonicalAssetAddress;
      const contradictoryPool = { ...v3Pool.pool, canonicalAssetAddress: wrongCanonicalAsset };

      const result = await verifyPoolIdentity({
        pool: contradictoryPool,
        classification: v3Pool.classification,
        rpc,
      });

      console.log("\n=== Phase 6C.1 live smoke: deliberately contradictory variant ===");
      console.log(`final status: ${result.status}`);
      console.log(
        result.evidence
          .filter((e) => e.kind === "CANONICAL_ASSET_MATCH")
          .map((e) => `  [${e.kind}] support=${e.support} :: ${e.detail}`)
          .join("\n"),
      );

      expect(result.status).toBe("CONTRADICTED");
      expect(result.evidence.find((e) => e.kind === "CANONICAL_ASSET_MATCH")?.support).toBe("CONTRADICTS");
    },
    30000,
  );
});
