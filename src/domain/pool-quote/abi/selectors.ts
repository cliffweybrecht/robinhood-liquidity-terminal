import { encodeFunctionData, type Address, type Hex } from "viem";

/**
 * Minimal local ABI fragments for exactly the calls Phase 6E.1 needs —
 * not a contract SDK. Calldata encoding is delegated to viem's
 * `encodeFunctionData`, the same established approach `pool-verification/
 * abi/selectors.ts` and `pool-state/abi/selectors.ts` use, for the same
 * reason: viem computes the 4-byte selector from the function signature
 * itself, rather than trusting a hand-transcribed hex constant. `fee()`'s
 * selector is identical to `pool-verification`'s/`pool-state`'s own
 * `encodeFeeCall` (same function signature on the same contract) but is
 * re-declared here rather than imported — this module does not reach
 * into either of those modules' internals, matching the established
 * module-independence policy.
 */
const v3PoolAbi = [
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;

export function encodeFeeCall(): Hex {
  return encodeFunctionData({ abi: v3PoolAbi, functionName: "fee" });
}

const v3QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        components: [
          { type: "address", name: "tokenIn" },
          { type: "address", name: "tokenOut" },
          { type: "uint256", name: "amountIn" },
          { type: "uint24", name: "fee" },
          { type: "uint160", name: "sqrtPriceLimitX96" },
        ],
      },
    ],
    outputs: [
      { type: "uint256", name: "amountOut" },
      { type: "uint160", name: "sqrtPriceX96After" },
      { type: "uint32", name: "initializedTicksCrossed" },
      { type: "uint256", name: "gasEstimate" },
    ],
  },
] as const;

/** No price limit — the canonical "no limit" value QuoterV2 expects (`sqrtPriceLimitX96: 0`). */
export function encodeQuoteExactInputSingleV3Call(tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number): Hex {
  return encodeFunctionData({
    abi: v3QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
}

const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          {
            type: "tuple",
            name: "poolKey",
            components: [
              { type: "address", name: "currency0" },
              { type: "address", name: "currency1" },
              { type: "uint24", name: "fee" },
              { type: "int24", name: "tickSpacing" },
              { type: "address", name: "hooks" },
            ],
          },
          { type: "bool", name: "zeroForOne" },
          { type: "uint128", name: "exactAmount" },
          { type: "bytes", name: "hookData" },
        ],
      },
    ],
    outputs: [
      { type: "uint256", name: "amountOut" },
      { type: "uint256", name: "gasEstimate" },
    ],
  },
] as const;

export interface V4QuotePoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

export function encodeQuoteExactInputSingleV4Call(
  poolKey: V4QuotePoolKey,
  zeroForOne: boolean,
  exactAmount: bigint,
  hookData: Hex,
): Hex {
  return encodeFunctionData({
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey, zeroForOne, exactAmount, hookData }],
  });
}

/** Standard ERC20 `decimals()` — used for both `tokenIn`/`tokenOut` in Phase 6E.2's execution analytics, never assumed/inferred. */
const erc20Abi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;

export function encodeDecimalsCall(): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "decimals" });
}

/**
 * Uniswap V3 pool `slot0()` — re-declared here (not imported from
 * `pool-state/abi/selectors.ts`) for the same module-independence reason
 * `encodeFeeCall` above already documents. Full 7-output signature
 * required for viem's selector computation to match the real function
 * even though `abi/decode.ts`'s `decodeV3Slot0SqrtPriceX96` only
 * surfaces the first word.
 */
const v3PoolSlot0Abi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint160" },
      { type: "int24" },
      { type: "uint16" },
      { type: "uint16" },
      { type: "uint16" },
      { type: "uint8" },
      { type: "bool" },
    ],
  },
] as const;

export function encodeSlot0Call(): Hex {
  return encodeFunctionData({ abi: v3PoolSlot0Abi, functionName: "slot0" });
}

/** Canonical `StateView.getSlot0(poolId)` (Uniswap V4 periphery lens contract). `PoolId` ABI-encodes as exactly one `bytes32` word. */
const v4StateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
  },
] as const;

export function encodeGetSlot0Call(poolId: Hex): Hex {
  return encodeFunctionData({ abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId] });
}
