import { describe, expect, it } from "vitest";
import { getDexScreenerPoolsBySymbol } from "@/domain/pool";
import { classifyPoolProtocol } from "@/domain/protocol";
import { verifyPoolIdentity } from "@/domain/pool-verification";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { largestQuotedSample, sampledDepthAtBps } from "../depth-math";
import { quoteVerifiedUniswapV3ExactInputDepthCurve } from "../read-uniswap-v3-depth-curve";

/**
 * Manual live smoke test for Phase 6F.1. Skipped by default — like every
 * other manual test in this project, normal `npm test` never touches the
 * network. Run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run --reporter=verbose src/domain/pool-quote/__tests__/live-smoke-v3-depth-curve.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set. Same discovery-then-verify
 * pattern as every other live smoke in this project — a real
 * CLASSIFIED/UNISWAP_V3 NVDA pool, identity-VERIFIED — then a multi-
 * point depth curve against it, instrumented to prove exactly one
 * `eth_blockNumber` call and that every read shares the identical
 * pinned block.
 *
 * Deliberately does NOT assert exact market prices/amountOut values
 * (those change block to block) — only structural/consistency
 * invariants that must hold regardless of current market conditions.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

const LADDER = [
  10_000_000_000_000_000n, // 0.01
  100_000_000_000_000_000n, // 0.1
  1_000_000_000_000_000_000n, // 1
  10_000_000_000_000_000_000n, // 10
  50_000_000_000_000_000_000n, // 50
] as const;

describe.skipIf(!RUN_LIVE)("Phase 6F.1 verified Uniswap V3 executable depth curve (live smoke)", () => {
  it(
    "computes a same-block, multi-point depth curve for a real, identity-VERIFIED Uniswap V3 pool",
    async () => {
      const rpc = await createVerifiedRobinhoodRpcClient();
      const { pools } = await getDexScreenerPoolsBySymbol("NVDA");

      const v3Pool = pools
        .map((pool) => ({ pool, classification: classifyPoolProtocol(pool) }))
        .find(({ classification }) => classification.status === "CLASSIFIED" && classification.family === "UNISWAP_V3");
      if (!v3Pool) {
        throw new Error("No CLASSIFIED UNISWAP_V3 pool found for NVDA — cannot exercise the Phase 6F.1 depth-curve reader.");
      }

      const identity = await verifyPoolIdentity({ pool: v3Pool.pool, classification: v3Pool.classification, rpc });
      if (identity.status !== "VERIFIED") {
        throw new Error(`Expected VERIFIED identity, got "${identity.status}".`);
      }

      let blockNumberCalls = 0;
      const calls: Array<{ to: string; data: string; blockTag: unknown }> = [];
      const instrumentedRpc: typeof rpc = {
        ...rpc,
        getBlockNumber: async () => {
          blockNumberCalls += 1;
          return rpc.getBlockNumber();
        },
        call: async (request, blockTag) => {
          calls.push({ to: request.to, data: request.data, blockTag });
          return rpc.call(request, blockTag);
        },
      };

      const tokenIn = v3Pool.pool.baseToken.address;
      const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({
        pool: v3Pool.pool,
        identity,
        tokenIn,
        amountsIn: [...LADDER],
        rpc: instrumentedRpc,
      });

      console.log("\n=== Phase 6F.1 live smoke: verified Uniswap V3 depth curve ===");
      console.log(`pool: ${curve.pool.pairAddress}`);
      console.log(`tokenIn: ${curve.tokenIn} tokenOut: ${curve.tokenOut}`);
      console.log(`blockNumber: ${curve.blockNumber}`);
      console.log(`spotStatus: ${curve.spotStatus} spotPrice num/den: ${curve.spotPrice?.numerator}/${curve.spotPrice?.denominator}`);
      console.log(`tokenInDecimals: ${curve.tokenInDecimals} tokenOutDecimals: ${curve.tokenOutDecimals}`);
      for (const p of curve.points) {
        console.log(
          `  amountIn=${p.amountIn} status=${p.status} amountOut=${p.amountOut ?? "-"} impactBps(num/den)=${p.priceImpactBps?.numerator ?? "-"}/${p.priceImpactBps?.denominator ?? "-"} ticks=${p.metadata && "initializedTicksCrossed" in p.metadata ? p.metadata.initializedTicksCrossed : "-"} gas=${p.metadata?.gasEstimate ?? "-"}`,
        );
      }
      console.log(`largestQuotedSample: ${largestQuotedSample(curve.points)}`);
      console.log(`sampledDepthAtBps(50): ${sampledDepthAtBps(curve.points, 50)}`);
      console.log(`sampledDepthAtBps(10): ${sampledDepthAtBps(curve.points, 10)}`);
      console.log(`eth_blockNumber calls: ${blockNumberCalls}`);
      console.log(`total eth_call count: ${calls.length} (expect ${LADDER.length + 3}: slot0 + decimalsIn + decimalsOut + ${LADDER.length} quoter calls)`);

      // Block pinning discipline.
      expect(blockNumberCalls).toBe(1);
      expect(calls).toHaveLength(LADDER.length + 3);
      for (const c of calls) expect(c.blockTag).toBe(curve.blockNumber);

      // Every requested size produced independently produced a point, in order.
      expect(curve.points).toHaveLength(LADDER.length);
      expect(curve.points.map((p) => p.amountIn)).toEqual(LADDER);

      // Analytics available for a real, currently-live pool under normal conditions.
      expect(curve.spotStatus).toBe("OK");
      expect(curve.spotPrice).toBeDefined();

      // The threshold helper is internally consistent with the observed points.
      const largest = largestQuotedSample(curve.points);
      const depthAt50 = sampledDepthAtBps(curve.points, 50);
      if (depthAt50 !== null) {
        expect(largest === null || depthAt50 <= largest).toBe(true);
      }
    },
    60000,
  );
});
