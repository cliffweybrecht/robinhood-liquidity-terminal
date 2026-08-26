import { describe, expect, it } from "vitest";
import { largestQuotedSample, sampledDepthAtBps } from "../depth-math";
import { EmptyAmountsLadderError, InvalidAmountInError, InvalidTokenInError, MissingVerifiedV3PoolKeyError } from "../errors";
import { quoteVerifiedUniswapV3ExactInputDepthCurve } from "../read-uniswap-v3-depth-curve";
import {
  buildFakeRpc,
  NVDA,
  OTHER_TOKEN,
  QUOTE_BLOCK,
  USDG,
  v3QuoteReturn,
  verifiedV3Identity,
  WETH,
} from "./fixtures";

const LADDER: readonly [bigint, bigint, bigint] = [1_000_000_000_000_000n, 2_000_000_000_000_000n, 3_000_000_000_000_000n];

describe("quoteVerifiedUniswapV3ExactInputDepthCurve — shared block", () => {
  it("calls getBlockNumber exactly once, and every eth_call (slot0, both decimals, all N quoter calls) uses the identical pinned block", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: async () => 999999n });

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: LADDER, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(curve.blockNumber).toBe(999999n);
    for (const c of calls.callCalls) expect(c.blockTag).toBe(999999n);
  });
});

describe("quoteVerifiedUniswapV3ExactInputDepthCurve — call counts", () => {
  it("N ladder points -> N + 3 total eth_calls (slot0 + decimalsIn + decimalsOut + N quoter calls), no fee() read", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: LADDER, rpc });

    expect(calls.callCalls).toHaveLength(LADDER.length + 3);
  });

  it("a single-point ladder -> 1 + 3 = 4 total eth_calls", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: [1_000_000_000_000_000n], rpc });

    expect(calls.callCalls).toHaveLength(4);
  });
});

describe("quoteVerifiedUniswapV3ExactInputDepthCurve — point independence", () => {
  it("a middle point INDETERMINATE (malformed return) does not affect sibling points, and every point is still attempted", async () => {
    const { pool, identity } = verifiedV3Identity();
    const [a, b, c] = LADDER;
    const { rpc } = buildFakeRpc({
      v3QuoteByAmountIn: {
        [b.toString()]: "0xdeadbeef", // malformed -> INDETERMINATE
      },
    });

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: [a, b, c], rpc });

    expect(curve.points).toHaveLength(3);
    expect(curve.points[0]?.status).toBe("QUOTED");
    expect(curve.points[1]?.status).toBe("INDETERMINATE");
    expect(curve.points[2]?.status).toBe("QUOTED");
    expect(curve.points[2]?.amountOut).toBeDefined();
  });

  it("a middle point RPC_ERROR does not affect sibling points", async () => {
    const { pool, identity } = verifiedV3Identity();
    const [a, b, c] = LADDER;
    const { rpc } = buildFakeRpc({
      v3QuoteByAmountIn: {
        [b.toString()]: { error: new Error("transport down") },
      },
    });

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: [a, b, c], rpc });

    expect(curve.points[0]?.status).toBe("QUOTED");
    expect(curve.points[1]?.status).toBe("RPC_ERROR");
    expect(curve.points[2]?.status).toBe("QUOTED");
  });

  it("sampling never stops early — a later, larger point still succeeds after an earlier point failed", async () => {
    const { pool, identity } = verifiedV3Identity();
    const [a, b, c] = LADDER;
    const { rpc, calls } = buildFakeRpc({
      v3QuoteByAmountIn: { [a.toString()]: { error: new Error("boom") } },
    });

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: [a, b, c], rpc });

    expect(curve.points[0]?.status).toBe("RPC_ERROR");
    expect(curve.points[1]?.status).toBe("QUOTED");
    expect(curve.points[2]?.status).toBe("QUOTED");
    // All 3 quoter calls were still attempted (plus slot0 + 2 decimals = 6 total).
    expect(calls.callCalls).toHaveLength(6);
  });

  it("does not infer failure for larger untested/sibling sizes from one known point's INDETERMINATE result", async () => {
    const { pool, identity } = verifiedV3Identity();
    const [a, b, c] = LADDER;
    const { rpc } = buildFakeRpc({ v3QuoteByAmountIn: { [b.toString()]: "0xbad" } });

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: [a, b, c], rpc });

    // c > b, b failed, but c must still be independently QUOTED — no inference.
    expect(curve.points[2]?.status).toBe("QUOTED");
  });
});

describe("quoteVerifiedUniswapV3ExactInputDepthCurve — analytics independence", () => {
  it("spot (slot0) read failure leaves every successful quote's amountOut intact, but curve spotStatus is RPC_ERROR and no point gets executionPrice/priceImpactBps", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ slot0: { error: new Error("transport down") } });

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: LADDER, rpc });

    expect(curve.spotStatus).toBe("RPC_ERROR");
    expect(curve.spotPrice).toBeUndefined();
    for (const p of curve.points) {
      expect(p.status).toBe("QUOTED");
      expect(p.amountOut).toBeDefined();
      expect(p.executionPrice).toBeUndefined();
      expect(p.priceImpactBps).toBeUndefined();
    }
  });

  it("one decimals() read failure degrades spotStatus but does not remove any point's amountOut", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ decimalsByAddress: { [NVDA.toLowerCase()]: { error: new Error("transport down") } } });

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: LADDER, rpc });

    expect(curve.spotStatus).toBe("RPC_ERROR");
    for (const p of curve.points) {
      expect(p.status).toBe("QUOTED");
      expect(p.amountOut).toBeDefined();
    }
  });

  it("analytics status correctly reports OK with full spot/decimals when everything succeeds", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: LADDER, rpc });

    expect(curve.spotStatus).toBe("OK");
    expect(curve.spotPrice).toBeDefined();
    expect(curve.tokenInDecimals).toBeDefined();
    expect(curve.tokenOutDecimals).toBeDefined();
    for (const p of curve.points) {
      expect(p.executionPrice).toBeDefined();
      expect(p.priceImpactBps).toBeDefined();
    }
  });
});

describe("quoteVerifiedUniswapV3ExactInputDepthCurve — ladder validation", () => {
  it("empty ladder throws EmptyAmountsLadderError before any RPC call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: [], rpc })).rejects.toThrow(
      EmptyAmountsLadderError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("a zero amount anywhere in the ladder throws InvalidAmountInError before any RPC call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: [1_000n, 0n, 2_000n], rpc }),
    ).rejects.toThrow(InvalidAmountInError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("a negative amount anywhere in the ladder throws InvalidAmountInError before any RPC call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: [1_000n, -1n], rpc }),
    ).rejects.toThrow(InvalidAmountInError);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("duplicate amounts are deterministically supported — each occurrence produces its own independent, identical point", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();
    const amount = 1_000_000_000_000_000n;

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: [amount, amount], rpc });

    expect(curve.points).toHaveLength(2);
    expect(curve.points[0]?.amountIn).toBe(amount);
    expect(curve.points[1]?.amountIn).toBe(amount);
    expect(curve.points[0]?.amountOut).toBe(curve.points[1]?.amountOut);
    // Two independent quoter calls were actually made (not deduplicated/cached).
    const quoterCalls = calls.callCalls.filter((c) => c.to.toLowerCase() === "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
    expect(quoterCalls).toHaveLength(2);
  });

  it("an unsorted ladder is NOT silently sorted — output order matches input order exactly", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();
    const unsorted = [3_000_000_000_000_000n, 1_000_000_000_000_000n, 2_000_000_000_000_000n];

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: unsorted, rpc });

    expect(curve.points.map((p) => p.amountIn)).toEqual(unsorted);
  });

  it("an extremely large bigint amount is accepted (no artificial upper bound for V3)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();
    const huge = 10n ** 30n;

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: [huge], rpc });

    expect(curve.points).toHaveLength(1);
    expect(curve.points[0]?.amountIn).toBe(huge);
  });
});

describe("quoteVerifiedUniswapV3ExactInputDepthCurve — exact arithmetic", () => {
  it("computes executionPrice/priceImpactBps per point using the same formulas as the single-quote analytics path, and threshold helpers see exact values", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({
      v3QuoteByAmountIn: {
        [LADDER[0]!.toString()]: v3QuoteReturn({ amountOut: 211_000n }),
        [LADDER[1]!.toString()]: v3QuoteReturn({ amountOut: 421_000n }),
        [LADDER[2]!.toString()]: v3QuoteReturn({ amountOut: 630_000n }),
      },
    });

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: LADDER, rpc });

    for (const p of curve.points) {
      expect(p.priceImpactBps?.denominator).toBeGreaterThan(0n);
    }
    // largestQuotedSample/sampledDepthAtBps operate on the real produced points.
    expect(largestQuotedSample(curve.points)).toBe(LADDER[2]);
    const depth = sampledDepthAtBps(curve.points, 1_000_000); // absurdly high threshold, everything qualifies
    expect(depth).toBe(LADDER[2]);
  });
});

describe("quoteVerifiedUniswapV3ExactInputDepthCurve — V3 identity / spoof resistance", () => {
  it("missing v3PoolKey on an otherwise-VERIFIED identity fails BEFORE any RPC call", async () => {
    const { pool, identity } = verifiedV3Identity({}, { v3PoolKey: null });
    const { rpc, calls } = buildFakeRpc();

    await expect(quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: LADDER, rpc })).rejects.toThrow(
      MissingVerifiedV3PoolKeyError,
    );
    expect(calls.callCalls).toHaveLength(0);
  });

  it("token direction and fee come exclusively from the verified v3PoolKey — a spoofed LiquidityPool cannot redirect the curve's quotes", async () => {
    const { pool: genuinePool, identity } = verifiedV3Identity();
    const spoofedPool = {
      ...genuinePool,
      baseToken: { address: WETH, name: "WETH", symbol: "WETH" },
      quoteToken: { address: OTHER_TOKEN, name: "OTHER", symbol: "OTHER" },
    };
    const { rpc, calls } = buildFakeRpc();

    // tokenIn from the SPOOFED pair is rejected even though the pool object claims it.
    await expect(
      quoteVerifiedUniswapV3ExactInputDepthCurve({ pool: spoofedPool, identity, tokenIn: WETH, amountsIn: LADDER, rpc }),
    ).rejects.toThrow(InvalidTokenInError);
    expect(calls.callCalls).toHaveLength(0);

    // A genuinely verified tokenIn still works, and tokenOut is the verified USDG, never OTHER_TOKEN/WETH.
    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool: spoofedPool, identity, tokenIn: NVDA, amountsIn: LADDER, rpc });
    expect(curve.tokenOut.toLowerCase()).toBe(USDG.toLowerCase());
    expect(curve.tokenOut.toLowerCase()).not.toBe(OTHER_TOKEN.toLowerCase());
  });
});

describe("quoteVerifiedUniswapV3ExactInputDepthCurve — block-pin failure", () => {
  it("returns blockNumber null, spotStatus RPC_ERROR, and an empty points array when eth_blockNumber itself fails", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: { error: new Error("boom") } });

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: LADDER, rpc });

    expect(curve.blockNumber).toBeNull();
    expect(curve.spotStatus).toBe("RPC_ERROR");
    expect(curve.points).toHaveLength(0);
    expect(calls.callCalls).toHaveLength(0);
  });
});

describe("quoteVerifiedUniswapV3ExactInputDepthCurve — QUOTE_BLOCK sanity", () => {
  it("uses the default fixture QUOTE_BLOCK when getBlockNumber is not overridden", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const curve = await quoteVerifiedUniswapV3ExactInputDepthCurve({ pool, identity, tokenIn: NVDA, amountsIn: LADDER, rpc });

    expect(curve.blockNumber).toBe(QUOTE_BLOCK);
  });
});
