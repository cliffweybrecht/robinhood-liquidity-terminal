import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  IdentityNotVerifiedError,
  InvalidAmountInError,
  InvalidTokenInError,
  MissingIdentityBlockError,
  PoolIdentityMismatchError,
  UnsupportedIdentityFamilyError,
} from "../errors";
import { quoteVerifiedUniswapV3ExactInput } from "../read-uniswap-v3-quote";
import {
  buildFakeRpc,
  DEFAULT_AMOUNT_IN,
  errorStringRevert,
  feeReturn,
  IDENTITY_BLOCK,
  NVDA,
  OTHER_TOKEN,
  oversizedWord,
  QUOTE_BLOCK,
  USDG,
  v3QuoteReturn,
  verifiedV3Identity,
  verifiedV4Identity,
} from "./fixtures";

describe("quoteVerifiedUniswapV3ExactInput — precondition", () => {
  it("accepts a VERIFIED UNISWAP_V3 identity and proceeds to RPC", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(calls.callCalls.length).toBeGreaterThan(0);
  });

  it("throws IdentityNotVerifiedError for a non-VERIFIED identity, before any RPC call", async () => {
    const { pool, identity } = verifiedV3Identity({}, { status: "CONTRADICTED" });
    const { rpc, calls } = buildFakeRpc();

    await expect(quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc })).rejects.toThrow(
      IdentityNotVerifiedError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws UnsupportedIdentityFamilyError for a VERIFIED UNISWAP_V4 identity, before any RPC call", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc })).rejects.toThrow(
      UnsupportedIdentityFamilyError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws PoolIdentityMismatchError when identity.pool doesn't match the supplied pool, before any RPC call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const mismatched = { ...pool, pairAddress: OTHER_TOKEN };
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV3ExactInput({ pool: mismatched, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(PoolIdentityMismatchError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws MissingIdentityBlockError for a VERIFIED identity with a null blockNumber, before any RPC call", async () => {
    const { pool, identity } = verifiedV3Identity({}, { blockNumber: null });
    const { rpc, calls } = buildFakeRpc();

    await expect(quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc })).rejects.toThrow(
      MissingIdentityBlockError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws InvalidAmountInError for amountIn === 0, before any RPC call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: 0n, rpc })).rejects.toThrow(InvalidAmountInError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws InvalidTokenInError when tokenIn is not one of the verified pool's tokens, before any RPC call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(
      quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: OTHER_TOKEN, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(InvalidTokenInError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("derives tokenOut from the verified pool, never accepting a caller-supplied tokenOut", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.tokenIn.toLowerCase()).toBe(NVDA.toLowerCase());
    expect(result.tokenOut.toLowerCase()).toBe(USDG.toLowerCase());
  });
});

describe("quoteVerifiedUniswapV3ExactInput — block pinning", () => {
  it("calls getBlockNumber exactly once and pins fee()/quote reads to that exact block", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: async () => 999888n });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(result.quoteBlockNumber).toBe(999888n);
    expect(calls.callCalls.length).toBe(2); // fee() + quoter
    for (const c of calls.callCalls) expect(c.blockTag).toBe(999888n);
  });

  it("returns RPC_ERROR with a null quoteBlockNumber when getBlockNumber itself fails, and never attempts any call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: { error: new Error("boom") } });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.quoteBlockNumber).toBeNull();
    expect(result.identityVerificationBlock).toBe(IDENTITY_BLOCK);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.kind).toBe("BLOCK_PIN_FAILURE");
    expect(calls.callCalls).toHaveLength(0);
  });

  it("exactly one canonical quoter call is made per attempt", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    const quoterCalls = calls.callCalls.filter((c) => c.to.toLowerCase() === "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
    expect(quoterCalls).toHaveLength(1);
  });

  it("pins the quote to a NEW block distinct from the identity verification block", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.identityVerificationBlock).toBe(IDENTITY_BLOCK);
    expect(result.quoteBlockNumber).toBe(QUOTE_BLOCK);
    expect(result.identityVerificationBlock).not.toBe(result.quoteBlockNumber);
  });
});

describe("quoteVerifiedUniswapV3ExactInput — VERIFIED happy path", () => {
  it("returns a fully populated QUOTED result", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.family).toBe("UNISWAP_V3");
    expect(result.amountOut).toBe(212875n);
    expect(result.metadata?.sqrtPriceX96After).toBe(5428855367745061334802449001776699n);
    expect(result.metadata?.initializedTicksCrossed).toBe(1);
    expect(result.metadata?.gasEstimate).toBe(101560n);
  });

  it("remains QUOTED for an economically terrible but successfully-decoded quote (no invented rejection thresholds)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({
      v3Quote: v3QuoteReturn({
        amountOut: 1621839541279n,
        sqrtPriceX96After: 4323317069948755003526566860387744627496273n,
        initializedTicksCrossed: 169,
        gasEstimate: 9505823n,
      }),
    });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.metadata?.initializedTicksCrossed).toBe(169);
  });

  it("treats amountOut === 0 as a valid QUOTED result (V3 rounds output down; zero is a legitimate protocol outcome)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ v3Quote: v3QuoteReturn({ amountOut: 0n }) });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    expect(result.amountOut).toBe(0n);
  });
});

describe("quoteVerifiedUniswapV3ExactInput — fee() supporting read", () => {
  it("returns RPC_ERROR when fee() fails, without ever attempting the quoter call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ fee: { error: new Error("transport down") } });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("RPC_ERROR");
    const quoterCalls = calls.callCalls.filter((c) => c.to.toLowerCase() === "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
    expect(quoterCalls).toHaveLength(0);
  });

  it("returns INDETERMINATE when fee() returns malformed data, without ever attempting the quoter call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ fee: `0x${oversizedWord()}` as Hex });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
    const quoterCalls = calls.callCalls.filter((c) => c.to.toLowerCase() === "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
    expect(quoterCalls).toHaveLength(0);
  });

  it("uses the fee() read result as an input to the quoter call, never a hardcoded value", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ fee: feeReturn(3000) });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
    // The quoter call's calldata is a single static tuple
    // (tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96) — word index 3
    // (0-indexed, after the 4-byte selector) is the fee field. Confirm it
    // reflects fee()'s stubbed 3000 (0xbb8), not the default 500.
    const quoterCall = calls.callCalls.find((c) => c.to.toLowerCase() === "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
    expect(quoterCall).toBeDefined();
    const feeWord = quoterCall?.data.slice(10 + 64 * 3, 10 + 64 * 4);
    expect(BigInt(`0x${feeWord}`)).toBe(3000n);
  });
});

describe("quoteVerifiedUniswapV3ExactInput — RPC failures", () => {
  it("returns RPC_ERROR when the quoter call fails at the transport level", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ v3Quote: { error: new Error("transport down") } });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.evidence.find((e) => e.kind === "QUOTE_CALL")?.outcome).toBe("rpc_error");
  });
});

describe("quoteVerifiedUniswapV3ExactInput — revert classification", () => {
  it("classifies Error(string) \"AS\" as INDETERMINATE — NOT allowlisted, because it is unreachable through this reader's own valid precondition domain (amountIn <= 0 is already rejected before any RPC call)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ v3Quote: { revert: errorStringRevert("AS") } });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "QUOTE_CALL")?.outcome).toBe("decode_error");
  });

  it("classifies a bare 0x revert as INDETERMINATE, never UNQUOTABLE", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ v3Quote: { revert: "0x" as Hex } });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("classifies an unknown Error(string) reason as INDETERMINATE, never UNQUOTABLE", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ v3Quote: { revert: errorStringRevert("SPL") } });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("classifies a malformed Error(string) payload as INDETERMINATE", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ v3Quote: { revert: "0x08c379a0deadbeef" as Hex } });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });
});

describe("quoteVerifiedUniswapV3ExactInput — ABI malformation on success path", () => {
  it("returns INDETERMINATE for malformed (non-hex) quote return data", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ v3Quote: "not-hex-at-all" as Hex });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("returns INDETERMINATE for truncated quote return data (fewer than 4 words)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const full = v3QuoteReturn();
    const truncated = full.slice(0, full.length - 64) as Hex;
    const { rpc } = buildFakeRpc({ v3Quote: truncated });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("returns INDETERMINATE for oversized quote return data (more than 4 words, trailing bytes)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const oversized = (v3QuoteReturn() + oversizedWord()) as Hex;
    const { rpc } = buildFakeRpc({ v3Quote: oversized });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("returns INDETERMINATE when sqrtPriceX96After's high bits exceed uint160", async () => {
    const { pool, identity } = verifiedV3Identity();
    const base = v3QuoteReturn();
    const dirty = (base.slice(0, 2 + 64) + oversizedWord() + base.slice(2 + 128)) as Hex;
    const { rpc } = buildFakeRpc({ v3Quote: dirty });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });

  it("returns INDETERMINATE when initializedTicksCrossed exceeds uint32", async () => {
    const { pool, identity } = verifiedV3Identity();
    const base = v3QuoteReturn();
    const dirty = (base.slice(0, 2 + 128) + oversizedWord() + base.slice(2 + 192)) as Hex;
    const { rpc } = buildFakeRpc({ v3Quote: dirty });

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("INDETERMINATE");
  });
});

describe("quoteVerifiedUniswapV3ExactInput — no getCode/getLogs usage", () => {
  it("never calls eth_getCode or eth_getLogs", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await quoteVerifiedUniswapV3ExactInput({ pool, identity, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("QUOTED");
  });
});
