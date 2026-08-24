import { describe, expect, it } from "vitest";
import { createVerifiedRobinhoodRpcClient } from "../client";

/**
 * Manual live-network smoke test for the Phase 6A RPC foundation.
 * Skipped by default — every other test in this project (this file
 * included, when `RUN_LIVE_SMOKE` is unset) runs fully deterministic
 * with zero live network calls. Run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run src/providers/robinhood-rpc/__tests__/live-smoke.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set in the environment.
 *
 * Deliberately narrow scope, matching the Phase 6A foundation's own
 * scope: this proves only that `createVerifiedRobinhoodRpcClient`
 * succeeds against the configured endpoint (i.e. it reports chain ID
 * 4663) and that the resulting client's `getBlockNumber()` returns a
 * plausible current block. It does NOT touch Dexscreener, Uniswap,
 * token contracts, pools, or anything protocol-specific — that
 * verification is explicitly future work, not part of this phase.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

describe.skipIf(!RUN_LIVE)("Robinhood Chain RPC live smoke test", () => {
  it("constructs a verified client against the configured RPC and reads a valid current block", async () => {
    const rpc = await createVerifiedRobinhoodRpcClient();
    console.log(`\n=== Robinhood Chain RPC live smoke ===`);
    console.log(`chainId: ${rpc.chainId}`);
    expect(rpc.chainId).toBe(4663);

    const blockNumber = await rpc.getBlockNumber();
    console.log(`blockNumber: ${blockNumber}`);
    expect(typeof blockNumber).toBe("bigint");
    expect(blockNumber).toBeGreaterThan(0n);
  }, 30000);

  /**
   * Phase 6A.1 — proves the generic `getLogs` primitive against a real
   * endpoint. Deliberately protocol-agnostic: queries a small, bounded,
   * recent block range with no topic filter, against Permit2
   * (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) purely because it is
   * a well-known, generically-deployed contract already confirmed
   * present on Robinhood Chain — not because this test or the client it
   * exercises knows anything about what Permit2 is or does. This test
   * asserts only the generic shape (`getLogs` resolves, returns an
   * array, and every entry — if any — satisfies `LogEntry`'s fully
   * validated, already-mined shape); it makes no assertion about how
   * many logs exist, since that's real, changing chain data, not this
   * test's concern.
   */
  it("getLogs queries a small bounded recent range and returns a validated array", async () => {
    const rpc = await createVerifiedRobinhoodRpcClient();
    const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

    const currentBlock = await rpc.getBlockNumber();
    const fromBlock = currentBlock > 500n ? currentBlock - 500n : 0n;

    const logs = await rpc.getLogs({
      address: PERMIT2,
      topics: [],
      fromBlock,
      toBlock: currentBlock,
    });

    console.log(`\n=== Robinhood Chain RPC getLogs live smoke ===`);
    console.log(`queried block range: ${fromBlock} .. ${currentBlock}`);
    console.log(`logs found: ${logs.length}`);
    if (logs[0]) {
      console.log(`first log: block=${logs[0].blockNumber} tx=${logs[0].transactionHash} logIndex=${logs[0].logIndex}`);
    }

    expect(Array.isArray(logs)).toBe(true);
    for (const log of logs) {
      expect(log.removed).toBe(false);
      expect(log.blockNumber).toBeGreaterThanOrEqual(fromBlock);
      expect(log.blockNumber).toBeLessThanOrEqual(currentBlock);
    }
  }, 30000);
});
