import { describe, expect, it } from "vitest";
import { getDexScreenerPoolsBySymbol } from "@/domain/pool";
import { classifyPoolProtocol } from "@/domain/protocol";
import { verifyPoolIdentity } from "@/domain/pool-verification";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { readVerifiedUniswapV3PoolState } from "../read-uniswap-v3-state";

/**
 * Manual live smoke test for Phase 6D.1. Skipped by default — like
 * every other manual test in this project, normal `npm test` never
 * touches the network. Run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run --reporter=verbose src/domain/pool-state/__tests__/live-smoke.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set. Does not invent a pool
 * address: this test discovers a real CLASSIFIED/UNISWAP_V3 pool for
 * NVDA and proves its identity via the production Phase 6C.1 path
 * (`verifyPoolIdentity`) — the exact same discovery-then-verify pattern
 * `pool-verification/__tests__/live-smoke.manual.test.ts` already
 * established and proved live — before calling the production Phase
 * 6D.1 state reader on that same, now-VERIFIED pool. This is the "known
 * real V3 pool already supported by the repository" the task asks for:
 * whichever real pool this discovery/verification path finds live,
 * rather than a hardcoded address that could go stale.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

describe.skipIf(!RUN_LIVE)("Phase 6D.1 current Uniswap V3 pool state (live smoke)", () => {
  it(
    "reads current on-chain state for a real, identity-VERIFIED Uniswap V3 pool",
    async () => {
      const rpc = await createVerifiedRobinhoodRpcClient();
      const { pools } = await getDexScreenerPoolsBySymbol("NVDA");

      const v3Pool = pools
        .map((pool) => ({ pool, classification: classifyPoolProtocol(pool) }))
        .find(({ classification }) => classification.status === "CLASSIFIED" && classification.family === "UNISWAP_V3");

      if (!v3Pool) {
        throw new Error(
          "No CLASSIFIED UNISWAP_V3 pool found among NVDA's currently discovered pools — live pool population may have changed; this smoke test needs at least one to exercise the Phase 6D.1 state reader.",
        );
      }

      const identity = await verifyPoolIdentity({ pool: v3Pool.pool, classification: v3Pool.classification, rpc });
      if (identity.status !== "VERIFIED") {
        throw new Error(`Expected the discovered pool's identity to verify as VERIFIED, got "${identity.status}" — cannot proceed to state reads.`);
      }

      const stateStartCalls: Array<{ to: string; data: string; blockTag: unknown }> = [];
      const instrumentedRpc: typeof rpc = {
        ...rpc,
        call: async (request, blockTag) => {
          stateStartCalls.push({ to: request.to, data: request.data, blockTag });
          return rpc.call(request, blockTag);
        },
      };

      const result = await readVerifiedUniswapV3PoolState({ pool: v3Pool.pool, identity, rpc: instrumentedRpc });

      console.log("\n=== Phase 6D.1 live smoke: current Uniswap V3 pool state ===");
      console.log(`pool address: ${result.pool.pairAddress}`);
      console.log(`identity status: ${identity.status}`);
      console.log(`identity verification block: ${result.identityVerificationBlock}`);
      console.log(`state block: ${result.stateBlockNumber}`);
      console.log(`sqrtPriceX96: ${result.state?.sqrtPriceX96}`);
      console.log(`tick: ${result.state?.tick}`);
      console.log(`activeLiquidity: ${result.state?.activeLiquidity}`);
      console.log(`fee: ${result.state?.fee}`);
      console.log(`tickSpacing: ${result.state?.tickSpacing}`);
      console.log(`final state status: ${result.status}`);
      for (const e of result.evidence) {
        console.log(`  [${e.kind}] outcome=${e.outcome} observed=${e.observed ?? "-"} :: ${e.detail}`);
      }

      // Every state eth_call used the exact same pinned block.
      expect(stateStartCalls.length).toBeGreaterThan(0);
      for (const c of stateStartCalls) expect(c.blockTag).toBe(result.stateBlockNumber);

      expect(result.identityVerificationBlock).not.toBeNull();
      expect(result.stateBlockNumber).not.toBeNull();
      expect(result.state).toBeDefined();
      expect(result.status).toBe("VERIFIED");
    },
    30000,
  );
});
