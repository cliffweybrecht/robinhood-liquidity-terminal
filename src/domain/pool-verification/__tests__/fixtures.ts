import type { Address, Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolProtocolClassification } from "@/domain/protocol";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { encodeFactoryCall, encodeFeeCall, encodeGetPoolCall, encodeToken0Call, encodeToken1Call } from "../abi/selectors";

// Real 20-byte address forms reused verbatim from earlier phases' test
// fixtures (src/domain/pool/__tests__/, src/domain/protocol/__tests__/)
// for consistency, not invented shapes.
export const POOL_ADDRESS = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3" as Address;
// The canonical Robinhood Chain Uniswap V3 factory from deployments.ts,
// duplicated here (not imported) so a test that accidentally breaks the
// real deployments.ts constant fails loudly instead of silently testing
// against whatever the constant currently says.
export const CANONICAL_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address;
export const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
export const OTHER_POOL_ADDRESS = "0x1234567890123456789012345678901234567890" as Address;
export const FEE_TIER = 3000;
export const DEFAULT_CODE: Hex = "0x6080604052348015600f57600080fd5b50";

export function addressReturn(address: string): Hex {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as Hex;
}

export function uint24Return(fee: number): Hex {
  return `0x${fee.toString(16).padStart(64, "0")}` as Hex;
}

export function pool(overrides: Partial<LiquidityPool> = {}): LiquidityPool {
  return {
    provider: "dexscreener",
    chainId: "robinhood",
    dexId: "uniswap",
    pairAddress: POOL_ADDRESS,
    canonicalAssetAddress: NVDA,
    canonicalAssetSymbol: "NVDA",
    canonicalAssetSide: "base",
    baseToken: { address: NVDA, name: "NVIDIA • Robinhood Token", symbol: "NVDA" },
    quoteToken: { address: USDG, name: "Global Dollar", symbol: "USDG" },
    priceUsd: 215.18,
    priceNative: 215.1838,
    liquidityUsd: 2762395.14,
    liquidityBase: 4390.08415,
    liquidityQuote: 1817719,
    volume5m: null,
    volume1h: null,
    volume6h: null,
    volume24h: null,
    buys5m: null,
    sells5m: null,
    buys1h: null,
    sells1h: null,
    buys6h: null,
    sells6h: null,
    buys24h: null,
    sells24h: null,
    priceChange5m: null,
    priceChange1h: null,
    priceChange6h: null,
    priceChange24h: null,
    fdv: null,
    marketCap: null,
    pairCreatedAt: null,
    dexScreenerUrl: null,
    labels: ["v3"],
    ...overrides,
  };
}

/** Builds a pool + a classification guaranteed to reference that same pool (avoids PoolClassificationMismatchError by construction). */
export function classifiedPool(
  poolOverrides: Partial<LiquidityPool> = {},
  classificationOverrides: Partial<Omit<PoolProtocolClassification, "pool">> = {},
): { pool: LiquidityPool; classification: PoolProtocolClassification } {
  const p = pool(poolOverrides);
  const classification: PoolProtocolClassification = {
    pool: {
      chainId: p.chainId,
      pairAddress: p.pairAddress,
      dexId: p.dexId,
      canonicalAssetAddress: p.canonicalAssetAddress,
      canonicalAssetSymbol: p.canonicalAssetSymbol,
      canonicalAssetSide: p.canonicalAssetSide,
    },
    identifierShape: "ADDRESS_20_BYTE",
    family: "UNISWAP_V3",
    version: "v3",
    status: "CLASSIFIED",
    evidence: [],
    ...classificationOverrides,
  };
  return { pool: p, classification };
}

export type RpcStub = Hex | (() => Promise<Hex>) | { error: unknown };

function toFn(stub: RpcStub | undefined, fallback: Hex): () => Promise<Hex> {
  if (stub === undefined) return async () => fallback;
  if (typeof stub === "function") return stub;
  if (typeof stub === "object" && "error" in stub) {
    return async () => {
      throw stub.error;
    };
  }
  return async () => stub;
}

export interface FakeRpcStubs {
  readonly chainId?: number;
  readonly getBlockNumber?: (() => Promise<bigint>) | { error: unknown };
  readonly code?: RpcStub;
  readonly token0?: RpcStub;
  readonly token1?: RpcStub;
  readonly factory?: RpcStub;
  readonly fee?: RpcStub;
  readonly getPool?: RpcStub;
}

export interface FakeRpcCallLog {
  getBlockNumberCalls: number;
  getCodeCalls: Array<{ address: string; blockTag: unknown }>;
  callCalls: Array<{ to: string; data: string; blockTag: unknown }>;
}

/**
 * A fake `VerifiedRobinhoodRpcClient` that routes `call(...)` by target
 * address + 4-byte selector, using the real `encode*Call` helpers to
 * compute selectors — so a fixture never hand-transcribes a selector
 * that could silently drift from what `abi/selectors.ts` actually
 * produces. Defaults represent a fully valid VERIFIED path; each test
 * overrides only what it needs.
 */
export function buildFakeRpc(stubs: FakeRpcStubs = {}): { rpc: VerifiedRobinhoodRpcClient; calls: FakeRpcCallLog } {
  const calls: FakeRpcCallLog = { getBlockNumberCalls: 0, getCodeCalls: [], callCalls: [] };

  const codeFn = toFn(stubs.code, DEFAULT_CODE);
  const token0Fn = toFn(stubs.token0, addressReturn(NVDA));
  const token1Fn = toFn(stubs.token1, addressReturn(USDG));
  const factoryFn = toFn(stubs.factory, addressReturn(CANONICAL_FACTORY));
  const feeFn = toFn(stubs.fee, uint24Return(FEE_TIER));
  const getPoolFn = toFn(stubs.getPool, addressReturn(POOL_ADDRESS));

  const token0Selector = encodeToken0Call().slice(0, 10);
  const token1Selector = encodeToken1Call().slice(0, 10);
  const factorySelector = encodeFactoryCall().slice(0, 10);
  const feeSelector = encodeFeeCall().slice(0, 10);
  const getPoolSelector = encodeGetPoolCall(NVDA, USDG, FEE_TIER).slice(0, 10);

  const rpc: VerifiedRobinhoodRpcClient = {
    chainId: stubs.chainId ?? 4663,
    getBlockNumber: async () => {
      calls.getBlockNumberCalls += 1;
      if (stubs.getBlockNumber && typeof stubs.getBlockNumber !== "function") throw stubs.getBlockNumber.error;
      return stubs.getBlockNumber ? (stubs.getBlockNumber as () => Promise<bigint>)() : 12345n;
    },
    getCode: async (address, blockTag) => {
      calls.getCodeCalls.push({ address, blockTag });
      return codeFn();
    },
    call: async (request, blockTag) => {
      calls.callCalls.push({ to: request.to, data: request.data, blockTag });
      const selector = request.data.slice(0, 10);
      if (request.to.toLowerCase() === POOL_ADDRESS.toLowerCase()) {
        if (selector === token0Selector) return token0Fn();
        if (selector === token1Selector) return token1Fn();
        if (selector === factorySelector) return factoryFn();
        if (selector === feeSelector) return feeFn();
      }
      if (request.to.toLowerCase() === CANONICAL_FACTORY.toLowerCase() && selector === getPoolSelector) {
        return getPoolFn();
      }
      throw new Error(`unstubbed fake RPC call: to=${request.to} data=${request.data}`);
    },
  };

  return { rpc, calls };
}
