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
});
