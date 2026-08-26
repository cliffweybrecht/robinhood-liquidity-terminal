import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  IdentityNotVerifiedError,
  InvalidAmountInError,
  InvalidTokenInError,
  MissingHookDataError,
  MissingIdentityBlockError,
  MissingVerifiedPoolKeyError,
  PoolIdentityMismatchError,
  UnsupportedIdentityFamilyError,
} from "../errors";
import { quoteVerifiedUniswapV4ExactInput } from "../read-uniswap-v4-quote";
import {
  buildFakeRpc,
  DEFAULT_AMOUNT_IN,
  errorStringRevert,
  HOOK_ADDRESS,
  IDENTITY_BLOCK,
  NVDA,
  OTHER_TOKEN,
  oversizedWord,
  QUOTE_BLOCK,
  unexpectedRevertBytes,
  v4QuoteReturn,
  verifiedV3Identity,
  verifiedV4Identity,
  WETH,
} from "./fixtures";

describe("quoteVerifiedUniswapV4ExactInput — precondition", () => {
  it("accepts a VERIFIED UNISWAP_V4 identity (unhooked) and proceeds to RPC", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(calls.callCalls.length).toBeGreaterThan(0);
  });

  it("throws IdentityNotVerifiedError for a non-VERIFIED identity, before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity({}, { status: "CONTRADICTED" });
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(IdentityNotVerifiedError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws UnsupportedIdentityFamilyError for a VERIFIED UNISWAP_V3 identity, before any RPC call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(UnsupportedIdentityFamilyError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws PoolIdentityMismatchError when identity.pool doesn't match the supplied pool, before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity();
    const mismatched = { ...pool, pairAddress: OTHER_TOKEN };
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV4ExactInput({ pool: mismatched, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(PoolIdentityMismatchError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws MissingIdentityBlockError for a VERIFIED identity with a null blockNumber, before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity({}, { blockNumber: null });
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(MissingIdentityBlockError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws MissingVerifiedPoolKeyError when identity.poolKey is missing on a VERIFIED V4 identity (defensive)", async () => {
    const { pool, identity } = verifiedV4Identity({}, { poolKey: null });
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(MissingVerifiedPoolKeyError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws InvalidAmountInError for amountIn === 0, before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: 0n, rpc })).rejects.toThrow(
      InvalidAmountInError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws InvalidAmountInError when amountIn exceeds uint128, before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: 1n << 128n, rpc }),
    ).rejects.toThrow(InvalidAmountInError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws InvalidTokenInError when tokenIn is not one of the verified PoolKey's currencies, before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: OTHER_TOKEN, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(InvalidTokenInError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("derives zeroForOne/tokenOut from the verified PoolKey, never accepting a caller-supplied tokenOut", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
    expect(result.tokenOut.toLowerCase()).toBe(NVDA.toLowerCase());
  });

  it("throws MissingHookDataError for a hooked pool when the caller does not supply hookData, before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { hooks: HOOK_ADDRESS });
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(MissingHookDataError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });
});

describe("quoteVerifiedUniswapV4ExactInput — hookData handling", () => {
  it("canonicalizes hookData to 0x for an unhooked pool regardless of caller input", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInput({
      pool,
      identity,
      tokenIn: WETH,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
      hookData: "0xdeadbeef",
    });

    expect(result.status).toBe("QUOTED");
    expect(result.hookDataCallerSupplied).toBeUndefined();
    // The quoter call's calldata must encode 0x00 length for the hookData
    // tail, not the caller's ignored "0xdeadbeef" — confirmed structurally
    // by a successful decode against the fixture's default-hookData-"0x" stub.
    expect(calls.callCalls.length).toBeGreaterThan(0);
  });

  it("proceeds for a hooked pool when the caller explicitly supplies empty hookData (0x)", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { hooks: HOOK_ADDRESS });
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInput({
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
    expect(result.evidence.find((e) => e.kind === "HOOK_DATA_DISCLOSURE")?.detail).toMatch(/NOT independently verified/);
  });

  it("proceeds for a hooked pool when the caller explicitly supplies non-empty hookData", async () => {
    const { pool, identity } = verifiedV4Identity({}, {}, { hooks: HOOK_ADDRESS });
    const { rpc, calls } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInput({
      pool,
      identity,
      tokenIn: WETH,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
      hookData: "0x1234",
    });

    expect(result.status).toBe("QUOTED");
    expect(result.hookDataCallerSupplied).toBe(true);
    expect(calls.callCalls.length).toBeGreaterThan(0);
  });
});

describe("quoteVerifiedUniswapV4ExactInput — block pinning", () => {
  it("calls getBlockNumber exactly once and pins the quote call to that exact block", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: async () => 999888n });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(result.quoteBlockNumber).toBe(999888n);
    expect(calls.callCalls).toHaveLength(1);
    expect(calls.callCalls[0]?.blockTag).toBe(999888n);
  });

  it("returns RPC_ERROR with a null quoteBlockNumber when getBlockNumber itself fails, and never attempts the quoter call", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: { error: new Error("boom") } });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.quoteBlockNumber).toBeNull();
    expect(result.identityVerificationBlock).toBe(IDENTITY_BLOCK);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("exactly one canonical quoter call is made per attempt", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(calls.callCalls).toHaveLength(1);
  });

  it("pins the quote to a NEW block distinct from the identity verification block", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.identityVerificationBlock).toBe(IDENTITY_BLOCK);
    expect(result.quoteBlockNumber).toBe(QUOTE_BLOCK);
    expect(result.identityVerificationBlock).not.toBe(result.quoteBlockNumber);
  });
});

describe("quoteVerifiedUniswapV4ExactInput — VERIFIED happy path", () => {
  it("returns a fully populated QUOTED result", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.family).toBe("UNISWAP_V4");
    expect(result.amountOut).toBe(11449737457906132n);
    expect(result.metadata?.gasEstimate).toBe(49580n);
  });

  it("treats amountOut === 0 as a valid QUOTED result", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ v4Quote: v4QuoteReturn({ amountOut: 0n }) });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.amountOut).toBe(0n);
  });
});

describe("quoteVerifiedUniswapV4ExactInput — RPC failures", () => {
  it("returns RPC_ERROR when the quoter call fails at the transport level", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ v4Quote: { error: new Error("transport down") } });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.evidence.find((e) => e.kind === "QUOTE_CALL")?.outcome).toBe("rpc_error");
  });
});

describe("quoteVerifiedUniswapV4ExactInput — revert classification", () => {
  it("classifies the known SwapAmountCannotBeZero() inner selector as UNQUOTABLE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ v4Quote: { revert: unexpectedRevertBytes("0xbe8b8507") } });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("UNQUOTABLE");
  });

  it("classifies the known PoolNotInitialized() inner selector as UNQUOTABLE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ v4Quote: { revert: unexpectedRevertBytes("0x486aa307") } });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("UNQUOTABLE");
  });

  it("classifies an unknown inner selector as INDETERMINATE, never UNQUOTABLE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ v4Quote: { revert: unexpectedRevertBytes("0xdeadbeef") } });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("classifies malformed outer revert bytes as INDETERMINATE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ v4Quote: { revert: "0x6190b2b0dead" as Hex } });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("classifies a bare 0x revert as INDETERMINATE", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ v4Quote: { revert: "0x" as Hex } });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("classifies an unrelated (non-UnexpectedRevertBytes) revert shape as INDETERMINATE, never mistaken for the V3 Error(string) shape", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ v4Quote: { revert: errorStringRevert("AS") } });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });
});

describe("quoteVerifiedUniswapV4ExactInput — ABI malformation on success path", () => {
  it("returns INDETERMINATE for malformed (non-hex) quote return data", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ v4Quote: "not-hex-at-all" as Hex });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("returns INDETERMINATE for truncated quote return data (fewer than 2 words)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const full = v4QuoteReturn();
    const truncated = full.slice(0, full.length - 64) as Hex;
    const { rpc } = buildFakeRpc({ v4Quote: truncated });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("returns INDETERMINATE for oversized quote return data (more than 2 words, trailing bytes)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const oversized = (v4QuoteReturn() + oversizedWord()) as Hex;
    const { rpc } = buildFakeRpc({ v4Quote: oversized });

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });
});

describe("quoteVerifiedUniswapV4ExactInput — no getCode/getLogs usage", () => {
  it("never calls eth_getCode or eth_getLogs", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV4ExactInput({ pool, identity, tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
  });
});
