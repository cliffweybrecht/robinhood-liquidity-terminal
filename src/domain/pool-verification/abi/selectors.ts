import { encodeFunctionData, type Address, type Hex } from "viem";

/**
 * Minimal local ABI fragments for exactly the calls Phase 6C.1 needs —
 * not a contract SDK, not a full Uniswap V3 ABI. Calldata encoding is
 * delegated to viem's `encodeFunctionData` (already a repository
 * dependency) rather than hand-typed 4-byte selector constants: viem
 * computes the selector from the function signature via `keccak256`
 * itself, which is strictly safer than transcribing a selector by hand
 * and hoping it's correct. Decoding is handled separately in
 * `./decode.ts` with its own, stricter-than-viem-default validation —
 * see that module's doc comment for why.
 */
const v3PoolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;

const v3FactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }],
  },
] as const;

export function encodeToken0Call(): Hex {
  return encodeFunctionData({ abi: v3PoolAbi, functionName: "token0" });
}

export function encodeToken1Call(): Hex {
  return encodeFunctionData({ abi: v3PoolAbi, functionName: "token1" });
}

export function encodeFactoryCall(): Hex {
  return encodeFunctionData({ abi: v3PoolAbi, functionName: "factory" });
}

export function encodeFeeCall(): Hex {
  return encodeFunctionData({ abi: v3PoolAbi, functionName: "fee" });
}

export function encodeGetPoolCall(token0: Address, token1: Address, fee: number): Hex {
  return encodeFunctionData({ abi: v3FactoryAbi, functionName: "getPool", args: [token0, token1, fee] });
}
