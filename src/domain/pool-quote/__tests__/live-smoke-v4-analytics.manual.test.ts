import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { getDexScreenerPoolsBySymbol } from "@/domain/pool";
import { classifyPoolProtocol } from "@/domain/protocol";
import { verifyPoolIdentity } from "@/domain/pool-verification";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { quoteVerifiedUniswapV4ExactInputWithAnalytics } from "../read-uniswap-v4-quote";

/**
 * Manual live smoke test for Phase 6E.2. Skipped by default — like every
 * other manual test in this project, normal `npm test` never touches the
 * network. Run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run --reporter=verbose src/domain/pool-quote/__tests__/live-smoke-v4-analytics.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set. Same discovery-then-verify
 * pattern as Phase 6E.1's own V4 live smoke — searches several canonical
 * Robinhood Stock Token symbols for the first real CLASSIFIED/UNISWAP_V4
 * pool, identity-VERIFIES it, then calls the production Phase 6E.2
 * analytics-quote reader with EXPLICIT hookData (never relying on the
 * reader to silently inject empty bytes for a hooked pool), instrumented
 * to prove every read in the attempt (quoter, StateView.getSlot0, both
 * decimals()) shares the exact same pinned block, with exactly one
 * `eth_blockNumber` call total.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

const CANDIDATE_SYMBOLS = ["NVDA", "AAPL", "TSLA", "GOOGL", "AMZN", "META", "MSFT"];

describe.skipIf(!RUN_LIVE)("Phase 6E.2 verified Uniswap V4 execution analytics (live smoke)", () => {
  it(
    "computes same-block execution analytics for a real, identity-VERIFIED Uniswap V4 pool",
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
          `No CLASSIFIED UNISWAP_V4 pool found among currently discovered pools for any of [${CANDIDATE_SYMBOLS.join(", ")}] — live pool population may have changed; this smoke test needs at least one to exercise the Phase 6E.2 analytics reader.`,
        );
      }

      const identity = await verifyPoolIdentity({ pool: discovered.pool, classification: discovered.classification, rpc });
      if (identity.status !== "VERIFIED") {
        throw new Error(`Expected the discovered pool's identity to verify as VERIFIED, got "${identity.status}" — cannot proceed to a quote.`);
      }
      if (!identity.poolKey) {
        throw new Error("Expected a VERIFIED UNISWAP_V4 identity to expose a typed poolKey — cannot proceed to a quote.");
      }

      const isHooked = identity.poolKey.hooks.toLowerCase() !== zeroAddress.toLowerCase();
      console.log(`\ndiscovered pool hooks: ${identity.poolKey.hooks} (hooked: ${isHooked})`);

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

      const tokenIn = identity.poolKey.currency0;
      const amountIn = 1_000_000_000_000_000_000n; // 1 unit, 18 decimals

      const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({
        pool: discovered.pool,
        identity,
        tokenIn,
        amountIn,
        rpc: instrumentedRpc,
        // Explicitly supplied here — never silently injected by the reader.
        hookData: "0x",
      });

      const fmt = (v?: { numerator: bigint; denominator: bigint }, scale = 10n ** 18n) =>
        v ? `${(v.numerator * scale) / v.denominator} / 1e18 (raw num=${v.numerator} den=${v.denominator})` : "undefined";

      console.log("\n=== Phase 6E.2 live smoke: verified Uniswap V4 execution analytics ===");
      console.log(`poolId: ${result.pool.pairAddress}`);
      console.log(`tokenIn: ${result.tokenIn}`);
      console.log(`tokenOut: ${result.tokenOut}`);
      console.log(`amountIn: ${result.amountIn}`);
      console.log(`amountOut: ${result.amountOut}`);
      console.log(`quoteBlockNumber: ${result.quoteBlockNumber}`);
      console.log(`base quote status: ${result.status}`);
      console.log(`hookDataCallerSupplied: ${result.hookDataCallerSupplied}`);
      console.log(`analytics.status: ${result.analytics?.status}`);
      console.log(`analytics.tokenInDecimals: ${result.analytics?.tokenInDecimals}`);
      console.log(`analytics.tokenOutDecimals: ${result.analytics?.tokenOutDecimals}`);
      console.log(`analytics.spotPrice ~= ${fmt(result.analytics?.spotPrice)}`);
      console.log(`analytics.executionPrice ~= ${fmt(result.analytics?.executionPrice)}`);
      console.log(`analytics.priceImpactBps ~= ${fmt(result.analytics?.priceImpactBps, 1n)}`);
      for (const e of result.analytics?.evidence ?? []) {
        console.log(`  [${e.kind}] outcome=${e.outcome} observed=${e.observed ?? "-"} :: ${e.detail}`);
      }
      console.log(`eth_blockNumber calls: ${blockNumberCalls}`);
      console.log(`total eth_call count: ${quoteCalls.length} (expect 4: quoter + getSlot0 + decimalsIn + decimalsOut)`);

      expect(blockNumberCalls).toBe(1);
      expect(quoteCalls.length).toBe(4);
      for (const c of quoteCalls) expect(c.blockTag).toBe(result.quoteBlockNumber);

      expect(result.status).toBe("QUOTED");
      expect(result.analytics?.status).toBe("OK");
      expect(result.analytics?.spotPrice).toBeDefined();
      expect(result.analytics?.executionPrice).toBeDefined();
      expect(result.analytics?.priceImpactBps).toBeDefined();
    },
    30000,
  );
});
