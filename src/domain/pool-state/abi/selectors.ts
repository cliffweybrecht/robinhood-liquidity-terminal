import { encodeFunctionData, type Hex } from "viem";

/**
 * Minimal local ABI fragments for exactly the calls Phase 6D.1 needs —
 * not a contract SDK, not a full Uniswap V3 ABI. Calldata encoding is
 * delegated to viem's `encodeFunctionData`, the same established
 * approach `pool-verification/abi/selectors.ts` uses, for the same
 * reason: viem computes the 4-byte selector from the function signature
 * itself, rather than trusting a hand-transcribed hex constant that
 * could silently drift. `fee()`'s selector is identical to
 * `pool-verification`'s own `encodeFeeCall` (same function signature on
 * the same contract) but is re-declared here rather than imported —
 * see `../abi/decode.ts`'s doc comment for why this module does not
 * reach into `pool-verification`'s internals.
 */
const v3PoolStateAbi = [
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
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
] as const;

export function encodeSlot0Call(): Hex {
  return encodeFunctionData({ abi: v3PoolStateAbi, functionName: "slot0" });
}

export function encodeLiquidityCall(): Hex {
  return encodeFunctionData({ abi: v3PoolStateAbi, functionName: "liquidity" });
}

export function encodeFeeCall(): Hex {
  return encodeFunctionData({ abi: v3PoolStateAbi, functionName: "fee" });
}

export function encodeTickSpacingCall(): Hex {
  return encodeFunctionData({ abi: v3PoolStateAbi, functionName: "tickSpacing" });
}

/**
 * `StateView` (Uniswap V4 periphery lens contract) ABI fragments.
 * `PoolId` is a `bytes32`-underlying value type in v4-core — ABI-encodes
 * as exactly one 32-byte word, so `{ type: "bytes32" }` here is exact,
 * not an approximation.
 */
const v4StateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
  },
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint128" }],
  },
] as const;

export function encodeGetSlot0Call(poolId: Hex): Hex {
  return encodeFunctionData({ abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId] });
}

export function encodeGetLiquidityCall(poolId: Hex): Hex {
  return encodeFunctionData({ abi: v4StateViewAbi, functionName: "getLiquidity", args: [poolId] });
}
