import { describe, expect, it } from "vitest";
import { getDexScreenerPoolsBySymbol } from "@/domain/pool";
import { classifyPoolProtocol } from "@/domain/protocol";
import { verifyPoolIdentity } from "@/domain/pool-verification";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { quoteVerifiedUniswapV3ExactInput } from "../read-uniswap-v3-quote";

/**
 * Manual live smoke test for Phase 6E.1. Skipped by default — like every
 * other manual test in this project, normal `npm test` never touches the
 * network. Run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run --reporter=verbose src/domain/pool-quote/__tests__/live-smoke.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set. Does not invent a pool address:
 * this test discovers a real CLASSIFIED/UNISWAP_V3 pool for NVDA and proves
 * its identity via the production Phase 6C.1 path (`verifyPoolIdentity`) —
 * the same discovery-then-verify pattern the pool-state and pool-verification
 * live smokes already established — before calling the production Phase
 * 6E.1 quote reader on that same, now-VERIFIED pool via the canonical
 * QuoterV2 deployment.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

describe.skipIf(!RUN_LIVE)("Phase 6E.1 verified Uniswap V3 exact-input quote (live smoke)", () => {
  it(
    "quotes a real, identity-VERIFIED Uniswap V3 pool via the canonical QuoterV2",
    async () => {
      const rpc = await createVerifiedRobinhoodRpcClient();
      const { pools } = await getDexScreenerPoolsBySymbol("NVDA");

      const v3Pool = pools
        .map((pool) => ({ pool, classification: classifyPoolProtocol(pool) }))
        .find(({ classification }) => classification.status === "CLASSIFIED" && classification.family === "UNISWAP_V3");

      if (!v3Pool) {
        throw new Error(
          "No CLASSIFIED UNISWAP_V3 pool found among NVDA's currently discovered pools — live pool population may have changed; this smoke test needs at least one to exercise the Phase 6E.1 quote reader.",
        );
      }

      const identity = await verifyPoolIdentity({ pool: v3Pool.pool, classification: v3Pool.classification, rpc });
      if (identity.status !== "VERIFIED") {
        throw new Error(`Expected the discovered pool's identity to verify as VERIFIED, got "${identity.status}" — cannot proceed to a quote.`);
      }

      let blockNumberCalls = 0;
      const quoteCalls: Array<{ to: string; data: string; blockTag: unknown }> = [];
      const instrumentedRpc: typeof rpc = {
        ...rpc,
        getBlockNumber: async () => {
          blockNumberCalls += 1;
          return rpc.getBlockNumber();
        },
        call: async (request, blockTag) => {
          quoteCalls.push({ to: request.to, data: request.data, blockTag });
          return rpc.call(request, blockTag);
        },
      };

      const tokenIn = v3Pool.pool.baseToken.address;
      const amountIn = 1_000_000_000_000_000_000n; // 1 unit, 18 decimals

      const result = await quoteVerifiedUniswapV3ExactInput({
        pool: v3Pool.pool,
        identity,
        tokenIn,
        amountIn,
        rpc: instrumentedRpc,
      });

      console.log("\n=== Phase 6E.1 live smoke: verified Uniswap V3 exact-input quote ===");
      console.log(`family: ${result.family}`);
      console.log(`pool: ${result.pool.pairAddress}`);
      console.log(`tokenIn: ${result.tokenIn}`);
      console.log(`tokenOut: ${result.tokenOut}`);
      console.log(`amountIn: ${result.amountIn}`);
      console.log(`amountOut: ${result.amountOut}`);
      console.log(`identityVerificationBlock: ${result.identityVerificationBlock}`);
      console.log(`quoteBlockNumber: ${result.quoteBlockNumber}`);
      console.log(`canonical quoter address: 0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7`);
      console.log(`sqrtPriceX96After: ${result.metadata?.sqrtPriceX96After}`);
      console.log(`initializedTicksCrossed: ${result.metadata?.initializedTicksCrossed}`);
      console.log(`gasEstimate: ${result.metadata?.gasEstimate}`);
      console.log(`status: ${result.status}`);
      for (const e of result.evidence) {
        console.log(`  [${e.kind}] outcome=${e.outcome} observed=${e.observed ?? "-"} :: ${e.detail}`);
      }
      console.log(`eth_blockNumber calls: ${blockNumberCalls}`);
      console.log(`total eth_call count: ${quoteCalls.length} (fee() supporting read + one canonical quoter call)`);

      // Block pinning discipline: getBlockNumber exactly once.
      expect(blockNumberCalls).toBe(1);
      // Every eth_call (fee() + the single quoter call) used the exact same pinned block.
      expect(quoteCalls.length).toBeGreaterThan(0);
      for (const c of quoteCalls) expect(c.blockTag).toBe(result.quoteBlockNumber);
      // Exactly one call actually went to the canonical quoter contract.
      const quoterCalls = quoteCalls.filter((c) => c.to.toLowerCase() === "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
      expect(quoterCalls).toHaveLength(1);

      expect(result.identityVerificationBlock).not.toBeNull();
      expect(result.quoteBlockNumber).not.toBeNull();
      expect(result.status).toBe("QUOTED");
      expect(result.amountOut).not.toBeNull();
    },
    30000,
  );
});
