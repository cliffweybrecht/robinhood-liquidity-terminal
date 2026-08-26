import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { computeSpotPrice } from "../analytics";
import { quoteVerifiedUniswapV3ExactInputWithAnalytics } from "../read-uniswap-v3-quote";
import {
  buildFakeRpc,
  decimalsReturn,
  DEFAULT_AMOUNT_IN,
  DEFAULT_DECIMALS_BY_ADDRESS,
  DEFAULT_V3_SPOT_SQRT_PRICE_X96,
  errorStringRevert,
  NVDA,
  oversizedWord,
  QUOTE_BLOCK,
  slot0V3Return,
  USDG,
  v3QuoteReturn,
  verifiedV3Identity,
} from "./fixtures";

describe("quoteVerifiedUniswapV3ExactInputWithAnalytics — happy path", () => {
  it("returns analytics.status OK with a fully populated result for a valid QUOTED quote", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics).toBeDefined();
    expect(result.analytics?.status).toBe("OK");
    expect(result.analytics?.tokenInDecimals).toBe(DEFAULT_DECIMALS_BY_ADDRESS[NVDA.toLowerCase()]);
    expect(result.analytics?.tokenOutDecimals).toBe(DEFAULT_DECIMALS_BY_ADDRESS[USDG.toLowerCase()]);
    expect(result.analytics?.priceUnit).toBe("tokenOut_per_tokenIn");
    expect(result.analytics?.spotPrice).toBeDefined();
    expect(result.analytics?.executionPrice).toBeDefined();
    expect(result.analytics?.priceImpactBps).toBeDefined();
    expect(result.analytics?.evidence.filter((e) => e.outcome === "ok")).toHaveLength(3);
  });

  it("computes tokenInIsToken0 correctly from address ordering — spotPrice matches computeSpotPrice with the right boolean, for tokenIn = NVDA (token1, since USDG < NVDA)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    const decIn = DEFAULT_DECIMALS_BY_ADDRESS[NVDA.toLowerCase()] ?? 18;
    const decOut = DEFAULT_DECIMALS_BY_ADDRESS[USDG.toLowerCase()] ?? 18;
    const expected = computeSpotPrice(DEFAULT_V3_SPOT_SQRT_PRICE_X96, false, decIn, decOut); // NVDA > USDG -> tokenIn is token1
    expect(result.analytics?.spotPrice?.numerator).toBe(expected.numerator);
    expect(result.analytics?.spotPrice?.denominator).toBe(expected.denominator);
  });

  it("computes tokenInIsToken0 correctly for the OTHER direction, tokenIn = USDG (token0)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: USDG, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    const decIn = DEFAULT_DECIMALS_BY_ADDRESS[USDG.toLowerCase()] ?? 18;
    const decOut = DEFAULT_DECIMALS_BY_ADDRESS[NVDA.toLowerCase()] ?? 18;
    const expected = computeSpotPrice(DEFAULT_V3_SPOT_SQRT_PRICE_X96, true, decIn, decOut); // USDG < NVDA -> tokenIn is token0
    expect(result.analytics?.spotPrice?.numerator).toBe(expected.numerator);
    expect(result.analytics?.spotPrice?.denominator).toBe(expected.denominator);
  });

  it("amountOut === 0 (a legitimate QUOTED result) produces analytics.status OK with executionPrice 0 and priceImpactBps exactly +10000", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ v3Quote: v3QuoteReturn({ amountOut: 0n }) });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

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

describe("quoteVerifiedUniswapV3ExactInputWithAnalytics — block consistency", () => {
  it("calls getBlockNumber exactly once, and every read (quoter, slot0, both decimals) uses the identical pinned block", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: async () => 555444n });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(result.quoteBlockNumber).toBe(555444n);
    expect(calls.callCalls.length).toBe(4); // quoter + slot0 + decimalsIn + decimalsOut (no fee() read — fee is now a typed identity fact)
    for (const c of calls.callCalls) expect(c.blockTag).toBe(555444n);
  });

  it("existing quoteVerifiedUniswapV3ExactInput (no analytics) still performs exactly 1 call at 1 pinned block — unaffected by the analytics refactor", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();
    const { quoteVerifiedUniswapV3ExactInput } = await import("../read-uniswap-v3-quote");

    await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(calls.callCalls).toHaveLength(1);
  });
});

describe("quoteVerifiedUniswapV3ExactInputWithAnalytics — analytics RPC_ERROR", () => {
  it("spot (slot0) RPC failure -> analytics RPC_ERROR, base quote remains QUOTED with amountOut present", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ slot0: { error: new Error("transport down") } });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.amountOut).toBeDefined();
    expect(result.analytics?.status).toBe("RPC_ERROR");
    expect(result.analytics?.spotPrice).toBeUndefined();
  });

  it("tokenIn decimals RPC failure -> analytics RPC_ERROR", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ decimalsByAddress: { [NVDA.toLowerCase()]: { error: new Error("transport down") } } });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("RPC_ERROR");
  });

  it("tokenOut decimals RPC failure -> analytics RPC_ERROR", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ decimalsByAddress: { [USDG.toLowerCase()]: { error: new Error("transport down") } } });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("RPC_ERROR");
  });
});

describe("quoteVerifiedUniswapV3ExactInputWithAnalytics — analytics INDETERMINATE", () => {
  it("malformed slot0 (truncated) -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV3Identity();
    const full = slot0V3Return();
    const truncated = full.slice(0, full.length - 64) as Hex;
    const { rpc } = buildFakeRpc({ slot0: truncated });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("malformed slot0 (trailing bytes) -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV3Identity();
    const oversized = (slot0V3Return() + oversizedWord()) as Hex;
    const { rpc } = buildFakeRpc({ slot0: oversized });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("dirty uint160 sqrtPriceX96 in slot0 -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV3Identity();
    const base = slot0V3Return();
    const dirty = (base.slice(0, 2) + oversizedWord() + base.slice(2 + 64)) as Hex;
    const { rpc } = buildFakeRpc({ slot0: dirty });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("sqrtPriceX96 === 0 -> analytics INDETERMINATE (semantically impossible on a VERIFIED pool)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ slot0: slot0V3Return({ sqrtPriceX96: 0n }) });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("malformed decimals (dirty high bits) -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ decimalsByAddress: { [NVDA.toLowerCase()]: `0x${oversizedWord()}` as Hex } });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("malformed decimals (truncated return) -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ decimalsByAddress: { [USDG.toLowerCase()]: "0x01" as Hex } });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });

  it("malformed decimals (trailing bytes) -> analytics INDETERMINATE", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ decimalsByAddress: { [NVDA.toLowerCase()]: (decimalsReturn(18) + oversizedWord()) as Hex } });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.analytics?.status).toBe("INDETERMINATE");
  });
});

describe("quoteVerifiedUniswapV3ExactInputWithAnalytics — non-QUOTED base result", () => {
  it("a non-QUOTED base result (INDETERMINATE revert) never fabricates analytics, and never performs any spot/decimals reads", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ v3Quote: { revert: errorStringRevert("SPL") } });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.analytics).toBeUndefined();
    // Only the quoter call — no slot0/decimals reads at all.
    expect(calls.callCalls).toHaveLength(1);
  });

  it("an RPC_ERROR base result never fabricates analytics", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ getBlockNumber: { error: new Error("boom") } });

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.analytics).toBeUndefined();
  });
});

describe("quoteVerifiedUniswapV3ExactInputWithAnalytics — QUOTE_BLOCK sanity", () => {
  it("uses the default fixture QUOTE_BLOCK when getBlockNumber is not overridden", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV3ExactInputWithAnalytics({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.quoteBlockNumber).toBe(QUOTE_BLOCK);
  });
});
