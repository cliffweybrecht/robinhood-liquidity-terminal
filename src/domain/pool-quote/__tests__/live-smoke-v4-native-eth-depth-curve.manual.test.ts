import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { getDexScreenerPoolsBySymbol } from "@/domain/pool";
import { classifyPoolProtocol } from "@/domain/protocol";
import { verifyPoolIdentity } from "@/domain/pool-verification";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { quoteVerifiedUniswapV4ExactInputDepthCurve } from "../read-uniswap-v4-depth-curve";

/**
 * Manual live smoke test for Phase 6F.1's native-ETH decimals rule. Run
 * on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run --reporter=verbose src/domain/pool-quote/__tests__/live-smoke-v4-native-eth-depth-curve.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set. Searches several canonical
 * Robinhood Stock Token symbols for the first real CLASSIFIED/UNISWAP_V4
 * pool whose identity-VERIFIED `poolKey` has a currency exactly equal to
 * the native-currency zero-address sentinel (confirmed present live
 * during both Phase 6F architecture research and this phase's own
 * pre-implementation probe — a real, stable, currently-VERIFIED
 * NVDA/native-ETH pool exists on Robinhood Chain). If no such pool is
 * discoverable at run time (live pool population can change), this test
 * fails with a clear message rather than silently skipping — deterministic
 * fixture coverage (`read-uniswap-v4-depth-curve.test.ts`'s "native ETH"
 * describe block) is what's actually required/mandatory per this phase's
 * instructions; this live smoke is corroborating evidence, not the sole
 * proof.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

const CANDIDATE_SYMBOLS = ["NVDA", "AAPL", "TSLA", "GOOGL", "AMZN", "META", "MSFT"];

describe.skipIf(!RUN_LIVE)("Phase 6F.1 verified Uniswap V4 native-ETH depth curve (live smoke)", () => {
  it(
    "resolves native-currency decimals as the protocol-defined 18 with no eth_call to the zero address, against a real verified native-ETH V4 pool",
    async () => {
      const rpc = await createVerifiedRobinhoodRpcClient();

      let discovered: { pool: Awaited<ReturnType<typeof getDexScreenerPoolsBySymbol>>["pools"][number]; identity: Awaited<ReturnType<typeof verifyPoolIdentity>> } | null = null;
      for (const symbol of CANDIDATE_SYMBOLS) {
        const { pools } = await getDexScreenerPoolsBySymbol(symbol);
        for (const pool of pools) {
          const classification = classifyPoolProtocol(pool);
          if (classification.status !== "CLASSIFIED" || classification.family !== "UNISWAP_V4") continue;
          const identity = await verifyPoolIdentity({ pool, classification, rpc });
          if (identity.status !== "VERIFIED" || !identity.poolKey) continue;
          const isNative =
            identity.poolKey.currency0.toLowerCase() === zeroAddress.toLowerCase() ||
            identity.poolKey.currency1.toLowerCase() === zeroAddress.toLowerCase();
          if (isNative) {
            discovered = { pool, identity };
            break;
          }
        }
        if (discovered) break;
      }

      if (!discovered) {
        throw new Error(
          "No CLASSIFIED/VERIFIED UNISWAP_V4 pool with a native-currency (zero-address) side was found among the candidate symbols — live pool population may have changed. Deterministic fixture coverage for this rule remains mandatory and unaffected (see read-uniswap-v4-depth-curve.test.ts).",
        );
      }

      const { pool, identity } = discovered;
      const poolKey = identity.poolKey!;
      console.log(`\ndiscovered native pool: ${pool.pairAddress}`, poolKey);

      const calls: Array<{ to: string; data: string; blockTag: unknown }> = [];
      const instrumentedRpc: typeof rpc = {
        ...rpc,
        call: async (request, blockTag) => {
          calls.push({ to: request.to, data: request.data, blockTag });
          return rpc.call(request, blockTag);
        },
      };

      const tokenIn = poolKey.currency0.toLowerCase() === zeroAddress.toLowerCase() ? poolKey.currency0 : poolKey.currency1;
      const isHooked = poolKey.hooks.toLowerCase() !== zeroAddress.toLowerCase();

      const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({
        pool,
        identity,
        tokenIn,
        amountsIn: [1_000_000_000_000_000n, 1_000_000_000_000_000_000n],
        rpc: instrumentedRpc,
        ...(isHooked ? { hookData: "0x" as const } : {}),
      });

      console.log(`tokenIn: ${curve.tokenIn} tokenInDecimals: ${curve.tokenInDecimals}`);
      console.log(`tokenOut: ${curve.tokenOut} tokenOutDecimals: ${curve.tokenOutDecimals}`);
      console.log(`spotStatus: ${curve.spotStatus}`);
      for (const p of curve.points) console.log(`  amountIn=${p.amountIn} status=${p.status} amountOut=${p.amountOut ?? "-"}`);

      const zeroAddressCalls = calls.filter((c) => c.to.toLowerCase() === zeroAddress.toLowerCase());
      console.log(`eth_call attempts to the zero address: ${zeroAddressCalls.length} (must be 0)`);

      expect(zeroAddressCalls).toHaveLength(0);
      expect(tokenIn.toLowerCase()).toBe(zeroAddress.toLowerCase());
      expect(curve.tokenInDecimals).toBe(18);
      expect(curve.spotStatus).toBe("OK");
    },
    60000,
  );
});
