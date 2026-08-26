import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { largestQuotedSample, sampledDepthAtBps } from "../depth-math";
import { EmptyAmountsLadderError, InvalidTokenInError, MissingHookDataError, MissingVerifiedPoolKeyError } from "../errors";
import { quoteVerifiedUniswapV4ExactInputDepthCurve } from "../read-uniswap-v4-depth-curve";
import {
  buildFakeRpc,
  HOOK_ADDRESS,
  NVDA,
  OTHER_TOKEN,
  QUOTE_BLOCK,
  v4QuoteReturn,
  verifiedV4Identity,
  WETH,
} from "./fixtures";

const LADDER: readonly [bigint, bigint, bigint] = [1_000_000_000_000_000n, 2_000_000_000_000_000n, 3_000_000_000_000_000n];

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — shared block", () => {
  it("calls getBlockNumber exactly once, and every eth_call uses the identical pinned block", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: async () => 888888n });

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: LADDER, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(curve.blockNumber).toBe(888888n);
    for (const c of calls.callCalls) expect(c.blockTag).toBe(888888n);
  });
});

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — call counts", () => {
  it("N ladder points against ordinary ERC20/ERC20 currencies -> N + 3 total eth_calls", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: LADDER, rpc });

    expect(calls.callCalls).toHaveLength(LADDER.length + 3);
  });
});

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — point independence", () => {
  it("a middle point INDETERMINATE does not affect sibling points", async () => {
    const { pool, identity } = verifiedV4Identity();
    const [a, b, c] = LADDER;
    const { rpc } = buildFakeRpc({ v4QuoteByAmountIn: { [b.toString()]: "0xdead" } });

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: [a, b, c], rpc });

    expect(curve.points[0]?.status).toBe("QUOTED");
    expect(curve.points[1]?.status).toBe("INDETERMINATE");
    expect(curve.points[2]?.status).toBe("QUOTED");
  });

  it("a middle point RPC_ERROR does not affect sibling points, and later points are still attempted", async () => {
    const { pool, identity } = verifiedV4Identity();
    const [a, b, c] = LADDER;
    const { rpc, calls } = buildFakeRpc({ v4QuoteByAmountIn: { [b.toString()]: { error: new Error("boom") } } });

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: [a, b, c], rpc });

    expect(curve.points[0]?.status).toBe("QUOTED");
    expect(curve.points[1]?.status).toBe("RPC_ERROR");
    expect(curve.points[2]?.status).toBe("QUOTED");
    expect(calls.callCalls).toHaveLength(6);
  });

  it("a known UNQUOTABLE point does not stop the curve", async () => {
    const { pool, identity } = verifiedV4Identity();
    const [a, b, c] = LADDER;
    const { unexpectedRevertBytes } = await import("./fixtures");
    const { rpc } = buildFakeRpc({ v4QuoteByAmountIn: { [b.toString()]: { revert: unexpectedRevertBytes("0xbe8b8507") } } });

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: [a, b, c], rpc });

    expect(curve.points[1]?.status).toBe("UNQUOTABLE");
    expect(curve.points[0]?.status).toBe("QUOTED");
    expect(curve.points[2]?.status).toBe("QUOTED");
  });
});

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — analytics independence", () => {
  it("spot (getSlot0) read failure leaves every successful quote's amountOut intact", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0: { error: new Error("transport down") } });

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: LADDER, rpc });

    expect(curve.spotStatus).toBe("RPC_ERROR");
    for (const p of curve.points) {
      expect(p.status).toBe("QUOTED");
      expect(p.amountOut).toBeDefined();
      expect(p.executionPrice).toBeUndefined();
    }
  });
});

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — ladder validation", () => {
  it("empty ladder throws EmptyAmountsLadderError before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: [], rpc })).rejects.toThrow(
      EmptyAmountsLadderError,
    );
    expect(calls.callCalls).toHaveLength(0);
  });

  it("an unsorted ladder is preserved exactly, not sorted", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();
    const unsorted = [3_000_000_000_000_000n, 1_000_000_000_000_000n, 2_000_000_000_000_000n];

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: unsorted, rpc });

    expect(curve.points.map((p) => p.amountIn)).toEqual(unsorted);
  });

  it("duplicates are deterministically supported", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();
    const amount = 1_000_000_000_000_000n;

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: [amount, amount], rpc });

    expect(curve.points).toHaveLength(2);
    expect(curve.points[0]?.amountOut).toBe(curve.points[1]?.amountOut);
  });
});

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — exact arithmetic + threshold helpers", () => {
  it("computes per-point analytics and threshold helpers operate over the real produced points", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({
      v4QuoteByAmountIn: {
        [LADDER[0]!.toString()]: v4QuoteReturn({ amountOut: 11_000_000_000_000_000_00n }),
        [LADDER[1]!.toString()]: v4QuoteReturn({ amountOut: 22_000_000_000_000_000_00n }),
        [LADDER[2]!.toString()]: v4QuoteReturn({ amountOut: 33_000_000_000_000_000_00n }),
      },
    });

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: LADDER, rpc });

    expect(largestQuotedSample(curve.points)).toBe(LADDER[2]);
    expect(sampledDepthAtBps(curve.points, 1_000_000)).toBe(LADDER[2]);
  });
});

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — V4 identity preserved", () => {
  it("missing poolKey on an otherwise-VERIFIED identity fails BEFORE any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity({}, { poolKey: null });
    const { rpc, calls } = buildFakeRpc();

    await expect(quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: LADDER, rpc })).rejects.toThrow(
      MissingVerifiedPoolKeyError,
    );
    expect(calls.callCalls).toHaveLength(0);
  });

  it("tokenIn/tokenOut come exclusively from the verified PoolKey — spoofed pool metadata cannot redirect the curve", async () => {
    const { pool: genuinePool, identity } = verifiedV4Identity();
    const spoofedPool = {
      ...genuinePool,
      baseToken: { address: OTHER_TOKEN, name: "OTHER", symbol: "OTHER" },
      quoteToken: { address: OTHER_TOKEN, name: "OTHER", symbol: "OTHER" },
    };
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV4ExactInputDepthCurve({ pool: spoofedPool, identity, tokenIn: OTHER_TOKEN, amountsIn: LADDER, rpc }),
    ).rejects.toThrow(InvalidTokenInError);
    expect(calls.callCalls).toHaveLength(0);
  });
});

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — hookData shared across the whole ladder", () => {
  it("hooked pool, missing hookData -> MissingHookDataError before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { hooks: HOOK_ADDRESS });
    const { rpc, calls } = buildFakeRpc();

    await expect(quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: LADDER, rpc })).rejects.toThrow(
      MissingHookDataError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("hooked pool, explicit hookData -> applies to EVERY point, discloses once at curve level (not per point)", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { hooks: HOOK_ADDRESS });
    const { rpc, calls } = buildFakeRpc();

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({
      pool,
      identity,
      tokenIn: WETH,
      amountsIn: LADDER,
      rpc,
      hookData: "0x1234",
    });

    expect(curve.hookDataCallerSupplied).toBe(true);
    expect(curve.spotEvidence.filter((e) => e.kind === "HOOK_DATA_DISCLOSURE")).toHaveLength(1);
    for (const p of curve.points) expect(p.status).toBe("QUOTED");
    // Every quoter call's calldata carries the SAME hookData (curve-level, not per-point).
    const quoterCalls = calls.callCalls.filter((c) => c.to.toLowerCase() === "0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
    expect(quoterCalls).toHaveLength(LADDER.length);
    for (const call of quoterCalls) expect(call.data.endsWith("1234000000000000000000000000000000000000000000000000000000000000")).toBe(true);
  });
});

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — native ETH (protocol-defined, resolved from verified PoolKey only)", () => {
  it("a verified PoolKey with currency0 == the native zero-address sentinel resolves decimals=18 for that side with NO decimals() eth_call sent to the zero address", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { currency0: zeroAddress });
    const { rpc, calls } = buildFakeRpc();

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: zeroAddress, amountsIn: LADDER, rpc });

    expect(curve.spotStatus).toBe("OK");
    expect(curve.tokenInDecimals).toBe(18);
    // No eth_call was ever sent to the zero address.
    expect(calls.callCalls.some((c) => c.to.toLowerCase() === zeroAddress)).toBe(false);
    // Total calls: getSlot0 (1) + decimals for the NON-native side only (1) + N quoter calls — one fewer than the ERC20/ERC20 case.
    expect(calls.callCalls).toHaveLength(LADDER.length + 2);
  });

  it("a verified PoolKey with currency1 == the native zero-address sentinel resolves decimals=18 for that side too — the opposite trade direction, same rule", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { currency1: zeroAddress });
    const { rpc, calls } = buildFakeRpc();

    // tokenIn = currency0 (WETH, still a real ERC20 here); tokenOut resolves to the native side (currency1).
    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: LADDER, rpc });

    expect(curve.spotStatus).toBe("OK");
    expect(curve.tokenOutDecimals).toBe(18);
    expect(calls.callCalls.some((c) => c.to.toLowerCase() === zeroAddress)).toBe(false);
    expect(calls.callCalls).toHaveLength(LADDER.length + 2);
  });

  it("the non-zero-address side of the SAME native pool still requires a real decimals() call", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { currency0: zeroAddress });
    const { rpc, calls } = buildFakeRpc();

    await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: zeroAddress, amountsIn: LADDER, rpc });

    // currency1 (NVDA) is a real ERC20 — a decimals() call was made to it.
    const decimalsCalls = calls.callCalls.filter((c) => c.to.toLowerCase() === NVDA.toLowerCase());
    expect(decimalsCalls).toHaveLength(1);
  });

  it("an ordinary (non-native) V4 pool is unaffected — both sides still require decimals()", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: LADDER, rpc });

    expect(calls.callCalls).toHaveLength(LADDER.length + 3);
    expect(calls.callCalls.some((c) => c.to.toLowerCase() === WETH.toLowerCase())).toBe(true);
    expect(calls.callCalls.some((c) => c.to.toLowerCase() === NVDA.toLowerCase())).toBe(true);
  });

  it("the native-ETH exception cannot be triggered by spoofed LiquidityPool metadata claiming a zero-address token that is NOT the verified PoolKey's currency", async () => {
    // Verified PoolKey has NO zero-address currency (ordinary WETH/NVDA pool).
    const { pool: genuinePool, identity } = verifiedV4Identity();
    // Spoofed pool metadata claims baseToken is the zero address — but this
    // is never consulted for decimals resolution; tokenIn/tokenOut are
    // derived exclusively from the verified poolKey (WETH/NVDA), so the
    // zero address never reaches the decimals-resolution layer at all.
    const spoofedPool = { ...genuinePool, baseToken: { address: zeroAddress, name: "fake native", symbol: "ETH" } };
    const { rpc, calls } = buildFakeRpc();

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool: spoofedPool, identity, tokenIn: WETH, amountsIn: LADDER, rpc });

    // Both real decimals() calls still happened — the spoofed zero-address claim was never honored.
    expect(calls.callCalls).toHaveLength(LADDER.length + 3);
    expect(curve.tokenInDecimals).toBe(18); // WETH's REAL decimals() read, not a native-ETH shortcut
  });
});

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — block-pin failure", () => {
  it("returns blockNumber null, spotStatus RPC_ERROR, empty points on eth_blockNumber failure", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ getBlockNumber: { error: new Error("boom") } });

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: LADDER, rpc });

    expect(curve.blockNumber).toBeNull();
    expect(curve.spotStatus).toBe("RPC_ERROR");
    expect(curve.points).toHaveLength(0);
  });
});

describe("quoteVerifiedUniswapV4ExactInputDepthCurve — QUOTE_BLOCK sanity", () => {
  it("uses the default fixture QUOTE_BLOCK when getBlockNumber is not overridden", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const curve = await quoteVerifiedUniswapV4ExactInputDepthCurve({ pool, identity, tokenIn: WETH, amountsIn: LADDER, rpc });

    expect(curve.blockNumber).toBe(QUOTE_BLOCK);
  });
});
