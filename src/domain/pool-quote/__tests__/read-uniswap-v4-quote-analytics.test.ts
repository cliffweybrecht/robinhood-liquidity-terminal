import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MissingHookDataError } from "../errors";
import { computeSpotPrice } from "../analytics";
import { quoteVerifiedUniswapV4ExactInputWithAnalytics } from "../read-uniswap-v4-quote";
import {
  buildFakeRpc,
  decimalsReturn,
  DEFAULT_AMOUNT_IN,
  DEFAULT_DECIMALS_BY_ADDRESS,
  DEFAULT_V4_SPOT_SQRT_PRICE_X96,
  HOOK_ADDRESS,
  NVDA,
  oversizedWord,
  QUOTE_BLOCK,
  slot0V4Return,
  v4QuoteReturn,
  verifiedV4Identity,
  WETH,
} from "./fixtures";

describe("quoteVerifiedUniswapV4ExactInputWithAnalytics — happy path", () => {
  it("returns analytics.status OK with a fully populated result for a valid QUOTED quote (unhooked)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("OK");
    expect(result.analytics?.tokenInDecimals).toBe(DEFAULT_DECIMALS_BY_ADDRESS[WETH.toLowerCase()]);
    expect(result.analytics?.tokenOutDecimals).toBe(DEFAULT_DECIMALS_BY_ADDRESS[NVDA.toLowerCase()]);
    expect(result.analytics?.priceUnit).toBe("tokenOut_per_tokenIn");
    expect(result.analytics?.spotPrice).toBeDefined();
    expect(result.analytics?.executionPrice).toBeDefined();
    expect(result.analytics?.priceImpactBps).toBeDefined();
  });

  it("computes tokenInIsToken0 correctly — tokenIn = WETH = currency0", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    const decIn = DEFAULT_DECIMALS_BY_ADDRESS[WETH.toLowerCase()] ?? 18;
    const decOut = DEFAULT_DECIMALS_BY_ADDRESS[NVDA.toLowerCase()] ?? 18;
    const expected = computeSpotPrice(DEFAULT_V4_SPOT_SQRT_PRICE_X96, true, decIn, decOut);
    expect(result.analytics?.spotPrice?.numerator).toBe(expected.numerator);
    expect(result.analytics?.spotPrice?.denominator).toBe(expected.denominator);
  });

  it("computes tokenInIsToken0 correctly for the OTHER direction — tokenIn = NVDA = currency1", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    const decIn = DEFAULT_DECIMALS_BY_ADDRESS[NVDA.toLowerCase()] ?? 18;
    const decOut = DEFAULT_DECIMALS_BY_ADDRESS[WETH.toLowerCase()] ?? 18;
    const expected = computeSpotPrice(DEFAULT_V4_SPOT_SQRT_PRICE_X96, false, decIn, decOut);
    expect(result.analytics?.spotPrice?.numerator).toBe(expected.numerator);
    expect(result.analytics?.spotPrice?.denominator).toBe(expected.denominator);
  });

  it("amountOut === 0 produces analytics.status OK with executionPrice 0 and priceImpactBps exactly +10000", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ v4Quote: v4QuoteReturn({ amountOut: 0n }) });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.amountOut).toBe(0n);
    expect(result.analytics?.status).toBe("OK");
    expect(result.analytics?.executionPrice?.numerator).toBe(0n);
    const impact = result.analytics?.priceImpactBps;
    expect(impact).toBeDefined();
    if (impact) {
      expect(impact.numerator / impact.denominator).toBe(10000n);
      expect(impact.numerator % impact.denominator).toBe(0n);
    }
  });
});

describe("quoteVerifiedUniswapV4ExactInputWithAnalytics — block consistency", () => {
  it("calls getBlockNumber exactly once, and every read (quoter, StateView.getSlot0, both decimals) uses the identical pinned block", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: async () => 777888n });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(result.quoteBlockNumber).toBe(777888n);
    expect(calls.callCalls.length).toBe(4); // quoter + getSlot0 + decimalsIn + decimalsOut (no fee() for V4)
    for (const c of calls.callCalls) expect(c.blockTag).toBe(777888n);
  });

  it("existing quoteVerifiedUniswapV4ExactInput (no analytics) still performs exactly 1 call at 1 pinned block — unaffected by the analytics refactor", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();
    const { quoteVerifiedUniswapV4ExactInput } = await import("../read-uniswap-v4-quote");

    await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(calls.callCalls).toHaveLength(1);
  });
});

describe("quoteVerifiedUniswapV4ExactInputWithAnalytics — analytics RPC_ERROR", () => {
  it("spot (StateView.getSlot0) RPC failure -> analytics RPC_ERROR, base quote remains QUOTED with amountOut present", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0: { error: new Error("transport down") } });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.amountOut).toBeDefined();
    expect(result.analytics?.status).toBe("RPC_ERROR");
  });

  it("tokenIn decimals RPC failure -> analytics RPC_ERROR", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ decimalsByAddress: { [WETH.toLowerCase()]: { error: new Error("transport down") } } });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("RPC_ERROR");
  });

  it("tokenOut decimals RPC failure -> analytics RPC_ERROR", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ decimalsByAddress: { [NVDA.toLowerCase()]: { error: new Error("transport down") } } });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("RPC_ERROR");
  });
});

describe("quoteVerifiedUniswapV4ExactInputWithAnalytics — analytics INDETERMINATE", () => {
  it("malformed getSlot0 (truncated) -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const full = slot0V4Return();
    const truncated = full.slice(0, full.length - 64) as Hex;
    const { rpc } = buildFakeRpc({ slot0: truncated });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("malformed getSlot0 (trailing bytes) -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const oversized = (slot0V4Return() + oversizedWord()) as Hex;
    const { rpc } = buildFakeRpc({ slot0: oversized });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("dirty uint160 sqrtPriceX96 in getSlot0 -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const base = slot0V4Return();
    const dirty = (base.slice(0, 2) + oversizedWord() + base.slice(2 + 64)) as Hex;
    const { rpc } = buildFakeRpc({ slot0: dirty });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("sqrtPriceX96 === 0 -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0: slot0V4Return({ sqrtPriceX96: 0n }) });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("malformed decimals (dirty high bits) -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ decimalsByAddress: { [WETH.toLowerCase()]: `0x${oversizedWord()}` as Hex } });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("malformed decimals (trailing bytes) -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ decimalsByAddress: { [NVDA.toLowerCase()]: (decimalsReturn(18) + oversizedWord()) as Hex } });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });
});

describe("quoteVerifiedUniswapV4ExactInputWithAnalytics — non-QUOTED base result", () => {
  it("a non-QUOTED base result never fabricates analytics, and never performs any spot/decimals reads", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc({ v4Quote: { error: new Error("transport down") } });

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.analytics).toBeUndefined();
    expect(calls.callCalls).toHaveLength(1); // only the quoter attempt
  });
});

describe("quoteVerifiedUniswapV4ExactInputWithAnalytics — V4 hook semantics preserved exactly", () => {
  it("hooked pool, missing explicit hookData -> still throws MissingHookDataError before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { hooks: HOOK_ADDRESS });
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(MissingHookDataError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("hooked pool, explicit 0x hookData -> proceeds, QUOTED, and analytics still computed honestly", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { hooks: HOOK_ADDRESS });
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({
      pool,
      identity,
      tokenIn: WETH,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
      hookData: "0x",
    });

    expect(result.status).toBe("QUOTED");
    expect(result.hookDataCallerSupplied).toBe(true);
    expect(result.evidence.find((e) => e.kind === "HOOK_DATA_DISCLOSURE")).toBeDefined();
    expect(result.analytics?.status).toBe("OK");
  });

  it("hooked pool, explicit nonempty hookData -> proceeds, QUOTED, and analytics still computed honestly", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { hooks: HOOK_ADDRESS });
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({
      pool,
      identity,
      tokenIn: WETH,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
      hookData: "0x1234",
    });

    expect(result.status).toBe("QUOTED");
    expect(result.hookDataCallerSupplied).toBe(true);
    expect(result.analytics?.status).toBe("OK");
  });
});

describe("quoteVerifiedUniswapV4ExactInputWithAnalytics — QUOTE_BLOCK sanity", () => {
  it("uses the default fixture QUOTE_BLOCK when getBlockNumber is not overridden", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInputWithAnalytics({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.quoteBlockNumber).toBe(QUOTE_BLOCK);
  });
});
