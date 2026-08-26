import { describe, expect, it } from "vitest";
import { getDexScreenerPoolsBySymbol } from "@/domain/pool";
import { classifyPoolProtocol } from "@/domain/protocol";
import { verifyPoolIdentity } from "@/domain/pool-verification";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { readVerifiedUniswapV4PoolState } from "../read-uniswap-v4-state";

/**
 * Manual live smoke test for Phase 6D.2. Skipped by default — like
 * every other manual test in this project, normal `npm test` never
 * touches the network. Run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run --reporter=verbose src/domain/pool-state/__tests__/live-smoke-v4.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set. Does not invent/hardcode a
 * single PoolId as the only candidate: this test searches several
 * canonical Robinhood Stock Token symbols for the first real
 * CLASSIFIED/UNISWAP_V4 pool discovery finds, proves its identity via
 * the production Phase 6C.2 path (`verifyPoolIdentity`) — the same
 * discovery-then-verify pattern `pool-verification`'s own V4 live smoke
 * already established and proved live — then calls the production
 * Phase 6D.2 state reader on that same, now-VERIFIED pool.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

// Tried in order until one symbol has a currently CLASSIFIED/UNISWAP_V4
// pool — not a claim that all of these have one, just a reasonable
// search list of canonical Robinhood Stock Token symbols.
const CANDIDATE_SYMBOLS = ["NVDA", "AAPL", "TSLA", "GOOGL", "AMZN", "META", "MSFT"];

describe.skipIf(!RUN_LIVE)("Phase 6D.2 current Uniswap V4 pool state (live smoke)", () => {
  it(
    "reads current on-chain state for a real, identity-VERIFIED Uniswap V4 pool",
    async () => {
      const rpc = await createVerifiedRobinhoodRpcClient();

      let discovered: { pool: Awaited<ReturnType<typeof getDexScreenerPoolsBySymbol>>["pools"][number]; classification: ReturnType<typeof classifyPoolProtocol> } | null = null;
      for (const symbol of CANDIDATE_SYMBOLS) {
        const { pools } = await getDexScreenerPoolsBySymbol(symbol);
        const v4Pool = pools
          .map((pool) => ({ pool, classification: classifyPoolProtocol(pool) }))
          .find(({ classification }) => classification.status === "CLASSIFIED" && classification.family === "UNISWAP_V4");
        if (v4Pool) {
          discovered = v4Pool;
          break;
        }
      }

      if (!discovered) {
        throw new Error(
          `No CLASSIFIED UNISWAP_V4 pool found among currently discovered pools for any of [${CANDIDATE_SYMBOLS.join(", ")}] — live pool population may have changed; this smoke test needs at least one to exercise the Phase 6D.2 state reader.`,
        );
      }

      const identity = await verifyPoolIdentity({ pool: discovered.pool, classification: discovered.classification, rpc });
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

      const result = await readVerifiedUniswapV4PoolState({ pool: discovered.pool, identity, rpc: instrumentedRpc });

      console.log("\n=== Phase 6D.2 live smoke: current Uniswap V4 pool state ===");
      console.log(`poolId: ${result.pool.pairAddress}`);
      console.log(`identity status: ${identity.status}`);
      console.log(`identity verification block: ${result.identityVerificationBlock}`);
      console.log(`state block: ${result.stateBlockNumber}`);
      console.log(`sqrtPriceX96: ${result.state?.sqrtPriceX96}`);
      console.log(`tick: ${result.state?.tick}`);
      console.log(`activeLiquidity: ${result.state?.activeLiquidity}`);
      console.log(`protocolFee: ${result.state?.protocolFee}`);
      console.log(`lpFee: ${result.state?.lpFee}`);
      console.log(`final state status: ${result.status}`);
      for (const e of result.evidence) {
        console.log(`  [${e.kind}] outcome=${e.outcome} observed=${e.observed ?? "-"} :: ${e.detail}`);
      }

      // Both StateView eth_calls used the exact same pinned block.
      expect(stateStartCalls.length).toBe(2);
      for (const c of stateStartCalls) expect(c.blockTag).toBe(result.stateBlockNumber);

      expect(result.identityVerificationBlock).not.toBeNull();
      expect(result.stateBlockNumber).not.toBeNull();
      expect(result.state).toBeDefined();
      expect(result.status).toBe("VERIFIED");
    },
    30000,
  );
});
