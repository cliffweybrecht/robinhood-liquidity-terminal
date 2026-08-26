import { zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { encodeQuoteExactInputSingleV4Call } from "../abi/selectors";
import { compareVerifiedPoolsExactInput } from "../compare-verified-pools";
import {
  DuplicateCandidateError,
  EmptyCandidatesError,
  IdentityNotVerifiedError,
  InvalidAmountInError,
  InvalidTokenInError,
  MismatchedComparisonGroupError,
  MissingVerifiedPoolKeyError,
  MissingVerifiedV3PoolKeyError,
  PoolIdentityMismatchError,
  UnsupportedComparisonIdentityFamilyError,
} from "../errors";
import { UINT128_MAX } from "../read-uniswap-v4-quote";
import type { UniswapV3ComparisonCandidate, UniswapV4ComparisonCandidate } from "../types";
import {
  buildFakeMultiPoolRpc,
  DEFAULT_TICK_SPACING,
  errorStringRevert,
  HOOK_ADDRESS,
  NVDA,
  oversizedWord,
  OTHER_TOKEN,
  QUOTE_BLOCK,
  slot0V3Return,
  USDG,
  v3ComparisonCandidate,
  v3QuoteReturn,
  v4ComparisonCandidate,
  v4QuoteReturn,
  verifiedV3Identity,
  verifiedV4Identity,
  WETH,
} from "./fixtures";

const V3_A = "0x0100000000000000000000000000000000000001" as Address;
const V3_B = "0x0200000000000000000000000000000000000002" as Address;
const V3_C = "0x0300000000000000000000000000000000000003" as Address;
const V4_A = "0xaa000000000000000000000000000000000000000000000000000000000000aa" as Hex;
const V4_B = "0xbb000000000000000000000000000000000000000000000000000000000000bb" as Hex;
const V4_NATIVE = "0xcc000000000000000000000000000000000000000000000000000000000000cc" as Hex;

const DEFAULT_AMOUNT_IN = 1_000_000_000_000_000_000n;

describe("compareVerifiedPoolsExactInput — structural validation (before any RPC)", () => {
  it("throws EmptyCandidatesError for zero candidates, performs zero RPC calls", async () => {
    const { rpc, calls } = buildFakeMultiPoolRpc([]);
    await expect(compareVerifiedPoolsExactInput({ candidates: [], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc })).rejects.toThrow(
      EmptyCandidatesError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws InvalidAmountInError for amountIn === 0n, performs zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A });
    const { rpc, calls } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 500 }]);
    await expect(compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: NVDA, amountIn: 0n, rpc })).rejects.toThrow(
      InvalidAmountInError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws InvalidAmountInError for a negative amountIn, performs zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A });
    const { rpc, calls } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 500 }]);
    await expect(compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: NVDA, amountIn: -1n, rpc })).rejects.toThrow(
      InvalidAmountInError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws IdentityNotVerifiedError for a non-VERIFIED candidate, performs zero RPC calls", async () => {
    const { pool, identity } = verifiedV3Identity({}, { status: "INDETERMINATE" });
    const { rpc, calls } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: pool.pairAddress as Address, fee: 500 }]);
    await expect(compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc })).rejects.toThrow(
      IdentityNotVerifiedError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws UnsupportedComparisonIdentityFamilyError for an unsupported family, performs zero RPC calls", async () => {
    const { pool, identity } = verifiedV3Identity({}, { family: "UNISWAP_V2_LIKE", status: "UNSUPPORTED" });
    const { rpc, calls } = buildFakeMultiPoolRpc([]);
    await expect(compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc })).rejects.toThrow(
      UnsupportedComparisonIdentityFamilyError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws MissingVerifiedV3PoolKeyError when identity.v3PoolKey is missing, performs zero RPC calls", async () => {
    const { pool, identity } = verifiedV3Identity();
    const brokenIdentity = { ...identity, v3PoolKey: undefined };
    const { rpc, calls } = buildFakeMultiPoolRpc([]);
    await expect(
      compareVerifiedPoolsExactInput({ candidates: [{ pool, identity: brokenIdentity }], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(MissingVerifiedV3PoolKeyError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws MissingVerifiedPoolKeyError when identity.poolKey is missing (V4), performs zero RPC calls", async () => {
    const { pool, identity } = verifiedV4Identity();
    const brokenIdentity = { ...identity, poolKey: undefined };
    const { rpc, calls } = buildFakeMultiPoolRpc([]);
    await expect(
      compareVerifiedPoolsExactInput({ candidates: [{ pool, identity: brokenIdentity }], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(MissingVerifiedPoolKeyError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws PoolIdentityMismatchError when a candidate's pool/identity pairAddress disagree, performs zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A });
    const mismatchedPool = { ...pool, pairAddress: V3_B };
    const { rpc, calls } = buildFakeMultiPoolRpc([]);
    await expect(
      compareVerifiedPoolsExactInput({ candidates: [{ pool: mismatchedPool, identity }], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(PoolIdentityMismatchError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws InvalidTokenInError when tokenIn is not one of a candidate's verified tokens, performs zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A });
    const { rpc, calls } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 500 }]);
    await expect(
      compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: OTHER_TOKEN, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(InvalidTokenInError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws MismatchedComparisonGroupError when candidates resolve to different verified tokenOut addresses, performs zero RPC calls", async () => {
    const a = v3ComparisonCandidate({ pairAddress: V3_A, token0: NVDA, token1: USDG });
    const b = v3ComparisonCandidate({ pairAddress: V3_B, token0: NVDA, token1: WETH });
    const { rpc, calls } = buildFakeMultiPoolRpc([]);
    await expect(
      compareVerifiedPoolsExactInput({ candidates: [a, b], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(MismatchedComparisonGroupError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws DuplicateCandidateError for the exact same pool (chainId+pairAddress) supplied twice, performs zero RPC calls", async () => {
    const a = v3ComparisonCandidate({ pairAddress: V3_A });
    const aAgain = v3ComparisonCandidate({ pairAddress: V3_A });
    const { rpc, calls } = buildFakeMultiPoolRpc([]);
    await expect(
      compareVerifiedPoolsExactInput({ candidates: [a, aAgain], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(DuplicateCandidateError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("duplicate detection is case-insensitive on pairAddress", async () => {
    const a = v3ComparisonCandidate({ pairAddress: V3_A });
    const aUpper = v3ComparisonCandidate({ pairAddress: V3_A.toUpperCase() as Address });
    const { rpc } = buildFakeMultiPoolRpc([]);
    await expect(
      compareVerifiedPoolsExactInput({ candidates: [a, aUpper], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc }),
    ).rejects.toThrow(DuplicateCandidateError);
  });
});

describe("compareVerifiedPoolsExactInput — hookData is per-candidate, missing hookData is a candidate-level PRECONDITION_FAILED", () => {
  it("a hooked V4 candidate with missing hookData becomes PRECONDITION_FAILED, performs no spot/quote RPC for that candidate, and does not abort the request", async () => {
    const { pool, identity } = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS });
    const { rpc, calls } = buildFakeMultiPoolRpc([]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0] as UniswapV4ComparisonCandidate;
    expect(candidate.status).toBe("PRECONDITION_FAILED");
    expect(candidate.preconditionFailure?.code).toBe("MISSING_HOOK_DATA");
    expect(candidate.amountOut).toBeUndefined();
    // Only the shared decimals calls (2) — zero spot/quote calls for this one candidate.
    expect(calls.callCalls).toHaveLength(2);
  });

  it("a hooked V4 candidate WITH explicit hookData is quoted normally", async () => {
    const { pool, identity } = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS });
    const { rpc } = buildFakeMultiPoolRpc([{ kind: "v4", poolId: V4_A, fee: 500, tickSpacing: DEFAULT_TICK_SPACING, hooks: HOOK_ADDRESS }]);

    const result = await compareVerifiedPoolsExactInput({
      candidates: [{ pool, identity, hookData: "0xdead" }],
      tokenIn: WETH,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
    });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    const candidate = result.candidates[0] as UniswapV4ComparisonCandidate;
    expect(candidate.status).toBe("QUOTED");
    expect(candidate.hookDataCallerSupplied).toBe(true);
  });

  it("one candidate's missing hookData does not affect a valid sibling — the sibling still executes and ranks", async () => {
    const missingHook = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS, fee: 500, tickSpacing: 10, currency0: NVDA, currency1: USDG });
    const valid = v3ComparisonCandidate({ pairAddress: V3_A, fee: 3000 });
    const { rpc } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 3000, quote: v3QuoteReturn({ amountOut: 999n }) }]);

    const result = await compareVerifiedPoolsExactInput({
      candidates: [{ pool: missingHook.pool, identity: missingHook.identity }, valid],
      tokenIn: NVDA,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
    });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    const [hookCandidate, v3Candidate] = result.candidates as [UniswapV4ComparisonCandidate, UniswapV3ComparisonCandidate];
    expect(hookCandidate.status).toBe("PRECONDITION_FAILED");
    expect(v3Candidate.status).toBe("QUOTED");
    expect(v3Candidate.amountOut).toBe(999n);
    expect(result.ranking.rankedQuotedPoolAddresses).toEqual([V3_A]);
    expect(result.ranking.bestCandidatePoolAddresses).toEqual([V3_A]);
  });

  it("different hooked V4 candidates receive DIFFERENT hookData, and one candidate's hookData is never sent to another — proven by exact calldata equality against the real encoder", async () => {
    const poolKeyA = { currency0: WETH, currency1: NVDA, fee: 500, tickSpacing: 10, hooks: HOOK_ADDRESS };
    const poolKeyB = { currency0: WETH, currency1: NVDA, fee: 3000, tickSpacing: 60, hooks: HOOK_ADDRESS };
    const a = v4ComparisonCandidate({ poolId: V4_A, ...poolKeyA });
    const b = v4ComparisonCandidate({ poolId: V4_B, ...poolKeyB });
    const { rpc, calls } = buildFakeMultiPoolRpc([
      { kind: "v4", poolId: V4_A, ...poolKeyA, quote: v4QuoteReturn({ amountOut: 111n }) },
      { kind: "v4", poolId: V4_B, ...poolKeyB, quote: v4QuoteReturn({ amountOut: 222n }) },
    ]);

    const result = await compareVerifiedPoolsExactInput({
      candidates: [
        { pool: a.pool, identity: a.identity, hookData: "0xaaaa" },
        { pool: b.pool, identity: b.identity, hookData: "0xbbbb" },
      ],
      tokenIn: WETH,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
    });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.candidates.every((c) => c.status === "QUOTED")).toBe(true);

    const expectedCalldataA = encodeQuoteExactInputSingleV4Call(poolKeyA, true, DEFAULT_AMOUNT_IN, "0xaaaa");
    const expectedCalldataB = encodeQuoteExactInputSingleV4Call(poolKeyB, true, DEFAULT_AMOUNT_IN, "0xbbbb");
    expect(calls.callCalls.some((c) => c.data === expectedCalldataA)).toBe(true);
    expect(calls.callCalls.some((c) => c.data === expectedCalldataB)).toBe(true);

    // The CROSS combination (A's hookData with B's poolKey, or vice versa) must never have been sent.
    const crossedAB = encodeQuoteExactInputSingleV4Call(poolKeyA, true, DEFAULT_AMOUNT_IN, "0xbbbb");
    const crossedBA = encodeQuoteExactInputSingleV4Call(poolKeyB, true, DEFAULT_AMOUNT_IN, "0xaaaa");
    expect(calls.callCalls.some((c) => c.data === crossedAB)).toBe(false);
    expect(calls.callCalls.some((c) => c.data === crossedBA)).toBe(false);
  });
});

describe("compareVerifiedPoolsExactInput — call-count model", () => {
  it("E=3 fully-executable ERC20/ERC20 V3 candidates -> 2E+2 = 8 eth_calls, exactly one eth_blockNumber", async () => {
    const candidates = [
      v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }),
      v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 }),
      v3ComparisonCandidate({ pairAddress: V3_C, fee: 10000 }),
    ];
    const { rpc, calls } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_A, fee: 500 },
      { kind: "v3", pairAddress: V3_B, fee: 3000 },
      { kind: "v3", pairAddress: V3_C, fee: 10000 },
    ]);

    const result = await compareVerifiedPoolsExactInput({ candidates, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    expect(calls.getBlockNumberCalls).toBe(1);
    expect(calls.callCalls).toHaveLength(8);
    for (const c of calls.callCalls) expect(c.blockTag).toBe(QUOTE_BLOCK);
  });

  it("E=1 native-ETH-side V4 candidate -> 2E+1 = 3 eth_calls (one shared decimals call, not two)", async () => {
    const { pool, identity } = v4ComparisonCandidate({ poolId: V4_NATIVE, currency0: zeroAddress as Address, currency1: NVDA });
    const { rpc, calls } = buildFakeMultiPoolRpc([{ kind: "v4", poolId: V4_NATIVE, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" as Address }]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: zeroAddress as Address, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.tokenInDecimals).toBe(18);
    expect(calls.callCalls).toHaveLength(3);
    expect(calls.callCalls.some((c) => c.to.toLowerCase() === zeroAddress)).toBe(false);
  });

  it("a PRECONDITION_FAILED candidate contributes ZERO calls to the total — call count reflects executable candidates only, not the raw candidate count", async () => {
    const missingHook = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS, fee: 500, tickSpacing: 10, currency0: NVDA, currency1: USDG });
    const executable = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 500 }]);

    await compareVerifiedPoolsExactInput({
      candidates: [{ pool: missingHook.pool, identity: missingHook.identity }, executable],
      tokenIn: NVDA,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
    });

    // E=1 executable (the V3 candidate) -> 2*1+2 = 4, NOT 2*2+2=6.
    expect(calls.callCalls).toHaveLength(4);
  });
});

describe("compareVerifiedPoolsExactInput — V4 amountIn uint128 bound is candidate-level, never global", () => {
  it("mixed V3+V4 same pair, amountIn = UINT128_MAX+1: the V4 candidate becomes PRECONDITION_FAILED with AMOUNT_IN_EXCEEDS_V4_BOUND, performs zero spot/quote calls, and the V3 sibling is still attempted, QUOTED, and ranks normally", async () => {
    const overLimit = UINT128_MAX + 1n;
    const v3 = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const v4 = v4ComparisonCandidate({ poolId: V4_A, fee: 500, tickSpacing: 10, currency0: NVDA, currency1: USDG });
    const { rpc, calls } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 777n }) }]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [v4, v3], tokenIn: NVDA, amountIn: overLimit, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");

    const v4Candidate = result.candidates.find((c) => c.family === "UNISWAP_V4") as UniswapV4ComparisonCandidate;
    const v3Candidate = result.candidates.find((c) => c.family === "UNISWAP_V3") as UniswapV3ComparisonCandidate;

    // (4) exact typed amount-range code
    expect(v4Candidate.status).toBe("PRECONDITION_FAILED");
    expect(v4Candidate.preconditionFailure?.code).toBe("AMOUNT_IN_EXCEEDS_V4_BOUND");
    expect(v4Candidate.amountOut).toBeUndefined();

    // (7)/(8) V3 sibling still attempted, QUOTED, and ranks normally
    expect(v3Candidate.status).toBe("QUOTED");
    expect(v3Candidate.amountOut).toBe(777n);
    expect(result.ranking.rankedQuotedPoolAddresses).toEqual([V3_A]);
    expect(result.ranking.bestCandidatePoolAddresses).toEqual([V3_A]);

    // (9) exactly one eth_blockNumber
    expect(calls.getBlockNumberCalls).toBe(1);

    // (5)/(10) V4 candidate performs zero spot/quote calls — E=1 (V3 only) -> 2*1+2 = 4, NOT 2*2+2=6.
    expect(calls.callCalls).toHaveLength(4);
  });

  it("V4-only comparison with amountIn > UINT128_MAX returns an OK snapshot containing one PRECONDITION_FAILED candidate rather than throwing the entire comparison", async () => {
    const { pool, identity } = v4ComparisonCandidate({ poolId: V4_A, fee: 500, tickSpacing: 10 });
    const { rpc, calls } = buildFakeMultiPoolRpc([]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: WETH, amountIn: UINT128_MAX + 1n, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0] as UniswapV4ComparisonCandidate;
    expect(candidate.status).toBe("PRECONDITION_FAILED");
    expect(candidate.preconditionFailure?.code).toBe("AMOUNT_IN_EXCEEDS_V4_BOUND");
    expect(result.ranking.rankedQuotedPoolAddresses).toEqual([]);
    expect(result.ranking.bestCandidatePoolAddresses).toEqual([]);
    // Shared block/decimals still occur (E=0 executable, but the shared
    // decimals read is unconditional once structural validation passes)
    // — only the candidate's own spot/quote calls are skipped.
    expect(calls.getBlockNumberCalls).toBe(1);
    expect(calls.callCalls).toHaveLength(2);
  });

  it("amountIn === UINT128_MAX exactly (the boundary itself) remains fully executable for V4 — not PRECONDITION_FAILED", async () => {
    const { pool, identity } = v4ComparisonCandidate({ poolId: V4_A, fee: 500, tickSpacing: 10 });
    const { rpc } = buildFakeMultiPoolRpc([{ kind: "v4", poolId: V4_A, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" as Address, quote: v4QuoteReturn({ amountOut: 55n }) }]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: WETH, amountIn: UINT128_MAX, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    const candidate = result.candidates[0] as UniswapV4ComparisonCandidate;
    expect(candidate.status).toBe("QUOTED");
    expect(candidate.amountOut).toBe(55n);
  });

  it("amountIn <= 0 still throws globally, before ANY RPC call, even when the candidate list includes a V4 candidate", async () => {
    const v3 = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const v4 = v4ComparisonCandidate({ poolId: V4_A, fee: 500, tickSpacing: 10, currency0: NVDA, currency1: USDG });
    const { rpc, calls } = buildFakeMultiPoolRpc([]);

    await expect(compareVerifiedPoolsExactInput({ candidates: [v4, v3], tokenIn: NVDA, amountIn: 0n, rpc })).rejects.toThrow(InvalidAmountInError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });
});

describe("compareVerifiedPoolsExactInput — block-pin failure", () => {
  it("eth_blockNumber failure returns a comparison-level BLOCK_PIN_FAILURE, with zero downstream RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A });
    const { rpc, calls } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 500 }], { getBlockNumber: { error: new Error("boom") } });

    const result = await compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("BLOCK_PIN_FAILURE");
    if (result.status !== "BLOCK_PIN_FAILURE") throw new Error("unreachable");
    expect(result.tokenIn.toLowerCase()).toBe(NVDA.toLowerCase());
    expect(result.evidence).toHaveLength(1);
    expect(calls.callCalls).toHaveLength(0);
  });
});

describe("compareVerifiedPoolsExactInput — ranking", () => {
  it("ranks QUOTED candidates strictly descending by exact bigint amountOut", async () => {
    const candidates = [
      v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }),
      v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 }),
      v3ComparisonCandidate({ pairAddress: V3_C, fee: 10000 }),
    ];
    const { rpc } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 100n }) },
      { kind: "v3", pairAddress: V3_B, fee: 3000, quote: v3QuoteReturn({ amountOut: 300n }) },
      { kind: "v3", pairAddress: V3_C, fee: 10000, quote: v3QuoteReturn({ amountOut: 200n }) },
    ]);

    const result = await compareVerifiedPoolsExactInput({ candidates, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.ranking.rankedQuotedPoolAddresses).toEqual([V3_B, V3_C, V3_A]);
    expect(result.ranking.bestCandidatePoolAddresses).toEqual([V3_B]);
  });

  it("amountOut === 0 is a valid QUOTED result and ranks normally (never treated as missing)", async () => {
    const candidates = [v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }), v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 })];
    const { rpc } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 0n }) },
      { kind: "v3", pairAddress: V3_B, fee: 3000, quote: v3QuoteReturn({ amountOut: 50n }) },
    ]);

    const result = await compareVerifiedPoolsExactInput({ candidates, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    const zeroCandidate = result.candidates.find((c) => c.pool.pairAddress === V3_A);
    expect(zeroCandidate?.status).toBe("QUOTED");
    expect(zeroCandidate?.amountOut).toBe(0n);
    expect(result.ranking.rankedQuotedPoolAddresses).toEqual([V3_B, V3_A]);
  });

  it("INDETERMINATE and RPC_ERROR candidates are excluded from ranking, never treated as amountOut=0 or ranked worst", async () => {
    const candidates = [
      v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }),
      v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 }),
      v3ComparisonCandidate({ pairAddress: V3_C, fee: 10000 }),
    ];
    const { rpc } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 42n }) },
      { kind: "v3", pairAddress: V3_B, fee: 3000, quote: { revert: errorStringRevert("unrecognized") } },
      { kind: "v3", pairAddress: V3_C, fee: 10000, quote: { error: new Error("transport down") } },
    ]);

    const result = await compareVerifiedPoolsExactInput({ candidates, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.candidates.find((c) => c.pool.pairAddress === V3_B)?.status).toBe("INDETERMINATE");
    expect(result.candidates.find((c) => c.pool.pairAddress === V3_C)?.status).toBe("RPC_ERROR");
    expect(result.ranking.rankedQuotedPoolAddresses).toEqual([V3_A]);
    expect(result.ranking.bestCandidatePoolAddresses).toEqual([V3_A]);
  });

  it("an exact amountOut tie is reported truthfully — both addresses appear in bestCandidatePoolAddresses, no fake single winner", async () => {
    const candidates = [v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 }), v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 })];
    const { rpc } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 500n }) },
      { kind: "v3", pairAddress: V3_B, fee: 3000, quote: v3QuoteReturn({ amountOut: 500n }) },
    ]);

    const result = await compareVerifiedPoolsExactInput({ candidates, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.ranking.bestCandidatePoolAddresses.length).toBe(2);
    expect(new Set(result.ranking.bestCandidatePoolAddresses)).toEqual(new Set([V3_A, V3_B]));
    // Deterministic PRESENTATION tie-break: ascending pairAddress — documented as non-economic.
    expect(result.ranking.rankedQuotedPoolAddresses).toEqual([V3_A, V3_B]);
  });

  it("zero QUOTED candidates -> both ranking arrays are empty, never a fabricated winner", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 500, quote: { revert: errorStringRevert("x") } }]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.ranking.rankedQuotedPoolAddresses).toEqual([]);
    expect(result.ranking.bestCandidatePoolAddresses).toEqual([]);
  });
});

describe("compareVerifiedPoolsExactInput — mixed protocol and spoof resistance", () => {
  it("a V3 and a V4 candidate coexist in one valid group; the correct winner is chosen regardless of family", async () => {
    const v3 = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token0: WETH, token1: NVDA });
    const v4 = v4ComparisonCandidate({ poolId: V4_A, fee: 3000, tickSpacing: 60, currency0: WETH, currency1: NVDA });
    const { rpc } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 10n }) },
      { kind: "v4", poolId: V4_A, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" as Address, quote: v4QuoteReturn({ amountOut: 99n }) },
    ]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [v3, v4], tokenIn: WETH, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.ranking.bestCandidatePoolAddresses).toEqual([V4_A]);
  });

  it("spoofed LiquidityPool.baseToken/quoteToken metadata cannot redirect a V3 candidate's execution identity", async () => {
    const genuine = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token0: NVDA, token1: USDG });
    const spoofedPool = { ...genuine.pool, baseToken: { address: WETH, name: "fake", symbol: "FAKE" }, quoteToken: { address: OTHER_TOKEN, name: "fake2", symbol: "FAKE2" } };
    const { rpc } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 77n }) }]);

    const result = await compareVerifiedPoolsExactInput({
      candidates: [{ pool: spoofedPool, identity: genuine.identity }],
      tokenIn: NVDA,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
    });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.tokenOut.toLowerCase()).toBe(USDG.toLowerCase());
    expect(result.candidates[0]?.status).toBe("QUOTED");
    expect((result.candidates[0] as UniswapV3ComparisonCandidate).amountOut).toBe(77n);
  });

  it("spoofed LiquidityPool metadata cannot redirect a V4 candidate's execution identity", async () => {
    const genuine = v4ComparisonCandidate({ poolId: V4_A, fee: 500, tickSpacing: 10, currency0: WETH, currency1: NVDA });
    const spoofedPool = { ...genuine.pool, baseToken: { address: OTHER_TOKEN, name: "fake", symbol: "FAKE" }, quoteToken: { address: USDG, name: "fake2", symbol: "FAKE2" } };
    const { rpc } = buildFakeMultiPoolRpc([{ kind: "v4", poolId: V4_A, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" as Address, quote: v4QuoteReturn({ amountOut: 88n }) }]);

    const result = await compareVerifiedPoolsExactInput({
      candidates: [{ pool: spoofedPool, identity: genuine.identity }],
      tokenIn: WETH,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
    });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.tokenOut.toLowerCase()).toBe(NVDA.toLowerCase());
    expect((result.candidates[0] as UniswapV4ComparisonCandidate).amountOut).toBe(88n);
  });
});

describe("compareVerifiedPoolsExactInput — per-candidate analytics (spot) independence", () => {
  it("candidate analyticsStatus OK on the happy path, with executionPrice/priceImpactBps populated", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 500 }]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    const candidate = result.candidates[0] as UniswapV3ComparisonCandidate;
    expect(candidate.analyticsStatus).toBe("OK");
    expect(candidate.executionPrice).toBeDefined();
    expect(candidate.priceImpactBps).toBeDefined();
  });

  it("one candidate's spot RPC_ERROR does not affect its own QUOTED status/amountOut, does not affect ranking, and does not affect a sibling's analyticsStatus", async () => {
    const a = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const b = v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 });
    const { rpc } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_A, fee: 500, slot0: { error: new Error("transport down") }, quote: v3QuoteReturn({ amountOut: 500n }) },
      { kind: "v3", pairAddress: V3_B, fee: 3000, quote: v3QuoteReturn({ amountOut: 100n }) },
    ]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [a, b], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    const candA = result.candidates.find((c) => c.pool.pairAddress === V3_A) as UniswapV3ComparisonCandidate;
    const candB = result.candidates.find((c) => c.pool.pairAddress === V3_B) as UniswapV3ComparisonCandidate;
    expect(candA.status).toBe("QUOTED");
    expect(candA.amountOut).toBe(500n);
    expect(candA.analyticsStatus).toBe("RPC_ERROR");
    expect(candA.executionPrice).toBeUndefined();
    expect(candB.analyticsStatus).toBe("OK");
    expect(result.ranking.bestCandidatePoolAddresses).toEqual([V3_A]);
  });

  it("one candidate's malformed spot (INDETERMINATE) does not affect a sibling's own analyticsStatus", async () => {
    const a = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const b = v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 });
    const malformed = (slot0V3Return() + oversizedWord()) as Hex;
    const { rpc } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_A, fee: 500, slot0: malformed },
      { kind: "v3", pairAddress: V3_B, fee: 3000 },
    ]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [a, b], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    const candA = result.candidates.find((c) => c.pool.pairAddress === V3_A) as UniswapV3ComparisonCandidate;
    const candB = result.candidates.find((c) => c.pool.pairAddress === V3_B) as UniswapV3ComparisonCandidate;
    expect(candA.analyticsStatus).toBe("INDETERMINATE");
    expect(candA.status).toBe("QUOTED");
    expect(candB.analyticsStatus).toBe("OK");
  });
});

describe("compareVerifiedPoolsExactInput — shared decimals", () => {
  it("shared decimals are read exactly ONCE total, reused across every candidate (not once per candidate)", async () => {
    const candidates = [
      v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }),
      v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 }),
      v3ComparisonCandidate({ pairAddress: V3_C, fee: 10000 }),
    ];
    const { rpc, calls } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_A, fee: 500 },
      { kind: "v3", pairAddress: V3_B, fee: 3000 },
      { kind: "v3", pairAddress: V3_C, fee: 10000 },
    ]);

    await compareVerifiedPoolsExactInput({ candidates, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    const decimalsCalls = calls.callCalls.filter((c) => c.to.toLowerCase() === NVDA.toLowerCase() || c.to.toLowerCase() === USDG.toLowerCase());
    expect(decimalsCalls).toHaveLength(2);
  });

  it("a caller-supplied zero-address token in spoofed LiquidityPool metadata never triggers native-ETH handling on a V3-only group", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token0: NVDA, token1: USDG });
    const spoofedPool = { ...pool, baseToken: { address: zeroAddress as Address, name: "fake native", symbol: "ETH" } };
    const { rpc, calls } = buildFakeMultiPoolRpc([{ kind: "v3", pairAddress: V3_A, fee: 500 }]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [{ pool: spoofedPool, identity }], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.tokenInDecimals).toBe(18); // NVDA's real fixture decimals, via a REAL eth_call — not the native shortcut.
    expect(calls.callCalls.some((c) => c.to.toLowerCase() === NVDA.toLowerCase())).toBe(true);
  });

  it("native-ETH-side denomination is derived ONLY from a verified V4 PoolKey currency, resolves 18 decimals with no eth_call to the zero address", async () => {
    const { pool, identity } = v4ComparisonCandidate({ poolId: V4_NATIVE, currency0: zeroAddress as Address, currency1: NVDA });
    const { rpc, calls } = buildFakeMultiPoolRpc([{ kind: "v4", poolId: V4_NATIVE, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" as Address }]);

    const result = await compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: zeroAddress as Address, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.tokenInDecimals).toBe(18);
    expect(calls.callCalls.some((c) => c.to.toLowerCase() === zeroAddress)).toBe(false);
  });

  it("shared decimals RPC_ERROR does not stop candidates from being quoted/ranked — only executionPrice/priceImpactBps become unavailable", async () => {
    const candidates = [v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }), v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 })];
    const { rpc } = buildFakeMultiPoolRpc(
      [
        { kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 10n }) },
        { kind: "v3", pairAddress: V3_B, fee: 3000, quote: v3QuoteReturn({ amountOut: 20n }) },
      ],
      { decimalsByAddress: { [NVDA.toLowerCase()]: { error: new Error("transport down") } } },
    );

    const result = await compareVerifiedPoolsExactInput({ candidates, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.sharedAnalyticsStatus).toBe("RPC_ERROR");
    for (const c of result.candidates) {
      expect(c.status).toBe("QUOTED");
      expect(c.executionPrice).toBeUndefined();
    }
    expect(result.ranking.bestCandidatePoolAddresses).toEqual([V3_B]);
  });

  it("malformed shared decimals -> INDETERMINATE, quotes still rank", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc } = buildFakeMultiPoolRpc(
      [{ kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 5n }) }],
      { decimalsByAddress: { [USDG.toLowerCase()]: "0x01" as Hex } },
    );

    const result = await compareVerifiedPoolsExactInput({ candidates: [{ pool, identity }], tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.sharedAnalyticsStatus).toBe("INDETERMINATE");
    expect(result.candidates[0]?.status).toBe("QUOTED");
    expect(result.ranking.rankedQuotedPoolAddresses).toEqual([V3_A]);
  });
});

describe("compareVerifiedPoolsExactInput — quote-outcome independence (QUOTED/UNQUOTABLE/INDETERMINATE/RPC_ERROR/PRECONDITION_FAILED coexist)", () => {
  it("all five outcomes can appear in one comparison, each independently, without any one affecting another", async () => {
    const quoted = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const indeterminate = v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 });
    const rpcError = v3ComparisonCandidate({ pairAddress: V3_C, fee: 10000 });
    const missingHook = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS, fee: 500, tickSpacing: 10, currency0: NVDA, currency1: USDG });

    const { rpc } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 1n }) },
      { kind: "v3", pairAddress: V3_B, fee: 3000, quote: { revert: errorStringRevert("unrecognized") } },
      { kind: "v3", pairAddress: V3_C, fee: 10000, quote: { error: new Error("down") } },
    ]);

    const result = await compareVerifiedPoolsExactInput({
      candidates: [quoted, indeterminate, rpcError, { pool: missingHook.pool, identity: missingHook.identity }],
      tokenIn: NVDA,
      amountIn: DEFAULT_AMOUNT_IN,
      rpc,
    });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.candidates.find((c) => c.pool.pairAddress === V3_A)?.status).toBe("QUOTED");
    expect(result.candidates.find((c) => c.pool.pairAddress === V3_B)?.status).toBe("INDETERMINATE");
    expect(result.candidates.find((c) => c.pool.pairAddress === V3_C)?.status).toBe("RPC_ERROR");
    expect(result.candidates.find((c) => c.pool.pairAddress === V4_A)?.status).toBe("PRECONDITION_FAILED");
    expect(result.candidates).toHaveLength(4);
    expect(result.ranking.rankedQuotedPoolAddresses).toEqual([V3_A]);
  });
});

describe("compareVerifiedPoolsExactInput — candidate ordering", () => {
  it("candidates[] preserves caller input order regardless of RPC completion timing", async () => {
    const candidates = [
      v3ComparisonCandidate({ pairAddress: V3_C, fee: 10000 }),
      v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }),
      v3ComparisonCandidate({ pairAddress: V3_B, fee: 3000 }),
    ];
    // Deliberately vary per-candidate response latency to prove output order is NOT completion order.
    const { rpc } = buildFakeMultiPoolRpc([
      { kind: "v3", pairAddress: V3_C, fee: 10000, quote: async () => v3QuoteReturn({ amountOut: 1n }) },
      { kind: "v3", pairAddress: V3_A, fee: 500, quote: v3QuoteReturn({ amountOut: 2n }) },
      { kind: "v3", pairAddress: V3_B, fee: 3000, quote: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return v3QuoteReturn({ amountOut: 3n });
      } },
    ]);

    const result = await compareVerifiedPoolsExactInput({ candidates, tokenIn: NVDA, amountIn: DEFAULT_AMOUNT_IN, rpc });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.candidates.map((c) => c.pool.pairAddress)).toEqual([V3_C, V3_A, V3_B]);
  });
});
