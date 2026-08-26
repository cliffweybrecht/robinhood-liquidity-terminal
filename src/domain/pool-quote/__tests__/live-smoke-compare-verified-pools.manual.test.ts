import { zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { getDexScreenerPoolsBySymbol } from "@/domain/pool";
import { classifyPoolProtocol } from "@/domain/protocol";
import { verifyPoolIdentity, type PoolIdentityVerification } from "@/domain/pool-verification";
import { createVerifiedRobinhoodRpcClient, type VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { compareVerifiedPoolsExactInput, type ComparisonCandidateInput } from "../compare-verified-pools";
import type { CrossPoolComparisonSnapshot } from "../types";
import { NVDA, USDG, WETH } from "./fixtures";

/**
 * Manual live smoke for Phase 6F.2. Skipped by default — like every
 * other manual test in this project, normal `npm test` never touches
 * the network. Run on demand only:
 *
 *   RUN_LIVE_SMOKE=1 npx vitest run --reporter=verbose src/domain/pool-quote/__tests__/live-smoke-compare-verified-pools.manual.test.ts
 *
 * Requires `ROBINHOOD_RPC_URL` to be set.
 *
 * Discovery/classification/identity-verification happen HERE, in this
 * manual test file only — `compareVerifiedPoolsExactInput` itself never
 * calls Dexscreener/classifies/verifies (see that function's own doc
 * comment). This mirrors every other live smoke in this project.
 *
 * hookData: for every hooked V4 candidate, this smoke explicitly
 * discloses `"0x"` — a deliberate, disclosed choice (never a guess at
 * the pool's REAL required hookData). Per this phase's architecture
 * review (sections 22/25/17(c)): a naive shared "0x" is expected to
 * leave many real hooked candidates unable to quote (INDETERMINATE) —
 * that is the CORRECT, fail-closed outcome for an unknown hook, not a
 * bug in this smoke. No transactions are sent.
 */
const RUN_LIVE = process.env.RUN_LIVE_SMOKE === "1";

const MODEST_AMOUNT_IN = 1_000_000_000_000_000_000n; // 1 NVDA
const LARGER_AMOUNT_IN = 1_000_000_000_000_000_000_000n; // 1000 NVDA

interface InstrumentedRpc {
  readonly rpc: VerifiedRobinhoodRpcClient;
  readonly state: { blockNumberCalls: number; calls: Array<{ to: string; data: string; blockTag: unknown }> };
}

function instrument(rpc: VerifiedRobinhoodRpcClient): InstrumentedRpc {
  const state = { blockNumberCalls: 0, calls: [] as Array<{ to: string; data: string; blockTag: unknown }> };
  const instrumentedRpc: VerifiedRobinhoodRpcClient = {
    ...rpc,
    getBlockNumber: async () => {
      state.blockNumberCalls += 1;
      return rpc.getBlockNumber();
    },
    call: async (request, blockTag) => {
      state.calls.push({ to: request.to, data: request.data, blockTag });
      return rpc.call(request, blockTag);
    },
  };
  return { rpc: instrumentedRpc, state };
}

/** Discovers, classifies, and identity-verifies NVDA's real pools, then groups VERIFIED candidates by exact verified tokenOut address (NATIVE_ETH sentinel for the V4 zero-address side). */
async function buildVerifiedGroups(rpc: VerifiedRobinhoodRpcClient): Promise<Map<string, ComparisonCandidateInput[]>> {
  const { asset, pools } = await getDexScreenerPoolsBySymbol("NVDA");
  const nvdaLower = asset.contractAddress.toLowerCase();

  const classified = pools
    .map((pool) => ({ pool, classification: classifyPoolProtocol(pool) }))
    .filter(({ classification }) => classification.status === "CLASSIFIED" && (classification.family === "UNISWAP_V3" || classification.family === "UNISWAP_V4"));

  const verified: Array<{ pool: (typeof pools)[number]; identity: PoolIdentityVerification }> = [];
  for (const { pool, classification } of classified) {
    const identity = await verifyPoolIdentity({ pool, classification, rpc });
    if (identity.status === "VERIFIED") verified.push({ pool, identity });
  }

  const groups = new Map<string, ComparisonCandidateInput[]>();
  for (const { pool, identity } of verified) {
    let tokenOutKey: string | null = null;
    let hookData: Hex | undefined;

    if (identity.family === "UNISWAP_V3" && identity.v3PoolKey) {
      const { token0, token1 } = identity.v3PoolKey;
      const tokenIn = token0.toLowerCase() === nvdaLower ? token0 : token1;
      if (tokenIn.toLowerCase() !== nvdaLower) continue;
      tokenOutKey = (token0.toLowerCase() === nvdaLower ? token1 : token0).toLowerCase();
    } else if (identity.family === "UNISWAP_V4" && identity.poolKey) {
      const { currency0, currency1, hooks } = identity.poolKey;
      const tokenIn = currency0.toLowerCase() === nvdaLower ? currency0 : currency1;
      if (tokenIn.toLowerCase() !== nvdaLower) continue;
      const tokenOut = currency0.toLowerCase() === nvdaLower ? currency1 : currency0;
      tokenOutKey = tokenOut.toLowerCase() === zeroAddress ? "NATIVE_ETH" : tokenOut.toLowerCase();
      if (hooks.toLowerCase() !== zeroAddress) hookData = "0x"; // explicitly disclosed, never guessed to be correct
    }
    if (tokenOutKey === null) continue;

    const list = groups.get(tokenOutKey) ?? [];
    list.push({ pool, identity, hookData });
    groups.set(tokenOutKey, list);
  }

  return groups;
}

function runComparisonAndValidate(
  label: string,
  result: CrossPoolComparisonSnapshot,
  instrumented: InstrumentedRpc,
  executableCount: number,
  isNativeSide: boolean,
) {
  console.log(`\n--- ${label} ---`);
  console.log(`block: ${result.blockNumber} tokenIn: ${result.tokenIn} tokenOut: ${result.tokenOut} amountIn: ${result.amountIn}`);
  console.log(
    `sharedAnalyticsStatus: ${result.sharedAnalyticsStatus} tokenInDecimals: ${result.tokenInDecimals} tokenOutDecimals: ${result.tokenOutDecimals}`,
  );
  for (const c of result.candidates) {
    console.log(
      `  ${c.family} ${c.pool.pairAddress} status=${c.status} amountOut=${c.amountOut ?? "-"} analyticsStatus=${c.analyticsStatus}${
        c.status === "PRECONDITION_FAILED" ? ` reason=${c.preconditionFailure?.code}` : ""
      }`,
    );
  }
  console.log(`rankedQuotedPoolAddresses: ${JSON.stringify(result.ranking.rankedQuotedPoolAddresses)}`);
  console.log(`bestCandidatePoolAddresses: ${JSON.stringify(result.ranking.bestCandidatePoolAddresses)}`);
  console.log(`eth_blockNumber calls: ${instrumented.state.blockNumberCalls} total eth_call count: ${instrumented.state.calls.length}`);

  expect(instrumented.state.blockNumberCalls).toBe(1);
  for (const c of instrumented.state.calls) expect(c.blockTag).toBe(result.blockNumber);

  const expectedCalls = isNativeSide ? 2 * executableCount + 1 : 2 * executableCount + 2;
  expect(instrumented.state.calls.length).toBe(expectedCalls);

  const quoted = result.candidates.filter((c): c is typeof c & { amountOut: bigint } => c.status === "QUOTED" && c.amountOut !== undefined);
  expect(result.ranking.rankedQuotedPoolAddresses).toHaveLength(quoted.length);
  if (quoted.length > 0) {
    const maxAmountOut = quoted.reduce((max, c) => (c.amountOut > max ? c.amountOut : max), quoted[0]!.amountOut);
    for (const bestAddr of result.ranking.bestCandidatePoolAddresses) {
      const candidate = result.candidates.find((c) => c.pool.pairAddress === bestAddr);
      expect(candidate?.amountOut).toBe(maxAmountOut);
    }
  }
}

describe.skipIf(!RUN_LIVE)("Phase 6F.2 cross-pool comparison (live smoke)", () => {
  it(
    "A: NVDA -> WETH — real multi-pool comparison at one shared block",
    async () => {
      const baseRpc = await createVerifiedRobinhoodRpcClient();
      const groups = await buildVerifiedGroups(baseRpc);
      const wethGroup = groups.get(WETH.toLowerCase());
      if (!wethGroup || wethGroup.length < 2) {
        throw new Error(`Expected >= 2 verified NVDA -> WETH candidates, found ${wethGroup?.length ?? 0}.`);
      }

      const instrumented = instrument(baseRpc);
      const result = await compareVerifiedPoolsExactInput({ candidates: wethGroup, tokenIn: NVDA, amountIn: MODEST_AMOUNT_IN, rpc: instrumented.rpc });
      expect(result.status).toBe("OK");
      if (result.status !== "OK") return;

      const executableCount = result.candidates.filter((c) => c.status !== "PRECONDITION_FAILED").length;
      runComparisonAndValidate("NVDA -> WETH", result, instrumented, executableCount, false);
    },
    120000,
  );

  it(
    "B: NVDA -> USDG — independent real multi-pool comparison",
    async () => {
      const baseRpc = await createVerifiedRobinhoodRpcClient();
      const groups = await buildVerifiedGroups(baseRpc);
      const usdgGroup = groups.get(USDG.toLowerCase());
      if (!usdgGroup || usdgGroup.length < 2) {
        throw new Error(`Expected >= 2 verified NVDA -> USDG candidates, found ${usdgGroup?.length ?? 0}.`);
      }

      const instrumented = instrument(baseRpc);
      const result = await compareVerifiedPoolsExactInput({ candidates: usdgGroup, tokenIn: NVDA, amountIn: MODEST_AMOUNT_IN, rpc: instrumented.rpc });
      expect(result.status).toBe("OK");
      if (result.status !== "OK") return;

      const executableCount = result.candidates.filter((c) => c.status !== "PRECONDITION_FAILED").length;
      runComparisonAndValidate("NVDA -> USDG", result, instrumented, executableCount, false);
    },
    120000,
  );

  it(
    "C: larger-size informational comparison — does the winner change?",
    async () => {
      const baseRpc = await createVerifiedRobinhoodRpcClient();
      const groups = await buildVerifiedGroups(baseRpc);
      const wethGroup = groups.get(WETH.toLowerCase());
      if (!wethGroup || wethGroup.length < 2) {
        throw new Error(`Expected >= 2 verified NVDA -> WETH candidates, found ${wethGroup?.length ?? 0}.`);
      }

      const modest = await compareVerifiedPoolsExactInput({ candidates: wethGroup, tokenIn: NVDA, amountIn: MODEST_AMOUNT_IN, rpc: baseRpc });
      const larger = await compareVerifiedPoolsExactInput({ candidates: wethGroup, tokenIn: NVDA, amountIn: LARGER_AMOUNT_IN, rpc: baseRpc });

      expect(modest.status).toBe("OK");
      expect(larger.status).toBe("OK");
      if (modest.status !== "OK" || larger.status !== "OK") return;

      console.log(`\n--- C: larger-size informational comparison ---`);
      console.log(`modest (amountIn=${MODEST_AMOUNT_IN}) best: ${JSON.stringify(modest.ranking.bestCandidatePoolAddresses)}`);
      console.log(`larger (amountIn=${LARGER_AMOUNT_IN}) best: ${JSON.stringify(larger.ranking.bestCandidatePoolAddresses)}`);
      const winnerChanged =
        JSON.stringify([...modest.ranking.bestCandidatePoolAddresses].sort()) !== JSON.stringify([...larger.ranking.bestCandidatePoolAddresses].sort());
      console.log(`winner changed by size: ${winnerChanged}`);
      // Informational only — this phase's own architecture research already
      // proved the winner CAN change by size; it is not required to change
      // on every single run at every block, so this is never a hard-fail
      // either way.
    },
    180000,
  );
});
