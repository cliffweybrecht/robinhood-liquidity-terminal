import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { getDexScreenerPoolsBySymbol } from "@/domain/pool";
import { classifyPoolProtocol } from "@/domain/protocol";
import { verifyPoolIdentity } from "@/domain/pool-verification";
import { createVerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { quoteVerifiedUniswapV4ExactInput } from "../read-uniswap-v4-quote";

/**
 * Manual live smoke test for Phase 6E.1. Skipped by default — like every
 * other manual test in this project, normal `npm test` never touches the
 * network. Run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run --reporter=verbose src/domain/pool-quote/__tests__/live-smoke-v4.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set. Does not invent/hardcode a single
 * PoolId as the only candidate: this test searches several canonical
 * Robinhood Stock Token symbols for the first real CLASSIFIED/UNISWAP_V4
 * pool discovery finds, proves its identity via the production Phase 6C.2
 * path (`verifyPoolIdentity`), then calls the production Phase 6E.1 V4
 * quote reader via the canonical V4Quoter deployment.
 *
 * hookData discipline: if the discovered pool turns out to be hooked
 * (`identity.poolKey.hooks !== zeroAddress`), this test explicitly supplies
 * hookData ("0x") itself — it never relies on the reader to silently inject
 * empty bytes for a hooked pool. That silent behavior would in fact be
 * rejected by the reader (`MissingHookDataError`), by design.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

const CANDIDATE_SYMBOLS = ["NVDA", "AAPL", "TSLA", "GOOGL", "AMZN", "META", "MSFT"];

describe.skipIf(!RUN_LIVE)("Phase 6E.1 verified Uniswap V4 exact-input quote (live smoke)", () => {
  it(
    "quotes a real, identity-VERIFIED Uniswap V4 pool via the canonical V4Quoter",
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
          `No CLASSIFIED UNISWAP_V4 pool found among currently discovered pools for any of [${CANDIDATE_SYMBOLS.join(", ")}] — live pool population may have changed; this smoke test needs at least one to exercise the Phase 6E.1 quote reader.`,
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

      const result = await quoteVerifiedUniswapV4ExactInput({
        pool: discovered.pool,
        identity,
        tokenIn,
        amountIn,
        rpc: instrumentedRpc,
        // Explicitly supplied here (never silently injected by the reader)
        // regardless of whether the discovered pool is hooked or not.
        hookData: "0x",
      });

      console.log("\n=== Phase 6E.1 live smoke: verified Uniswap V4 exact-input quote ===");
      console.log(`family: ${result.family}`);
      console.log(`poolId: ${result.pool.pairAddress}`);
      console.log(`tokenIn: ${result.tokenIn}`);
      console.log(`tokenOut: ${result.tokenOut}`);
      console.log(`amountIn: ${result.amountIn}`);
      console.log(`amountOut: ${result.amountOut}`);
      console.log(`identityVerificationBlock: ${result.identityVerificationBlock}`);
      console.log(`quoteBlockNumber: ${result.quoteBlockNumber}`);
      console.log(`canonical quoter address: 0x8dc178efb8111bb0973dd9d722ebeff267c98f94`);
      console.log(`hookDataCallerSupplied: ${result.hookDataCallerSupplied}`);
      console.log(`gasEstimate: ${result.metadata?.gasEstimate}`);
      console.log(`status: ${result.status}`);
      for (const e of result.evidence) {
        console.log(`  [${e.kind}] outcome=${e.outcome} observed=${e.observed ?? "-"} :: ${e.detail}`);
      }
      console.log(`eth_blockNumber calls: ${blockNumberCalls}`);
      console.log(`total eth_call count: ${quoteCalls.length}`);

      // Block pinning discipline: getBlockNumber exactly once.
      expect(blockNumberCalls).toBe(1);
      expect(quoteCalls.length).toBeGreaterThan(0);
      for (const c of quoteCalls) expect(c.blockTag).toBe(result.quoteBlockNumber);
      // Exactly one call actually went to the canonical V4Quoter contract.
      const quoterCalls = quoteCalls.filter((c) => c.to.toLowerCase() === "0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
      expect(quoterCalls).toHaveLength(1);

      expect(result.identityVerificationBlock).not.toBeNull();
      expect(result.quoteBlockNumber).not.toBeNull();
      expect(result.status).toBe("QUOTED");
      expect(result.amountOut).not.toBeNull();
      // hookData was explicitly supplied by this test; the reader must
      // disclose that fact only when the pool is actually hooked.
      expect(result.hookDataCallerSupplied).toBe(isHooked ? true : undefined);
    },
    30000,
  );
});
