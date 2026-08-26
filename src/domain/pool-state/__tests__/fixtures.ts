import type { Address, Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolIdentityVerification } from "@/domain/pool-verification";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import {
  encodeFeeCall,
  encodeGetLiquidityCall,
  encodeGetSlot0Call,
  encodeLiquidityCall,
  encodeSlot0Call,
  encodeTickSpacingCall,
} from "../abi/selectors";

// Real 20-byte address forms reused verbatim from earlier phases' test
// fixtures for consistency, not invented shapes. Deliberately duplicated
// here rather than imported from `pool-verification/__tests__/fixtures`
// — see `../abi/decode.ts`'s doc comment for why this module's tests
// stay self-contained rather than depending on another domain module's
// test internals.
export const POOL_ADDRESS = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3" as Address;
export const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
export const OTHER_POOL_ADDRESS = "0x1234567890123456789012345678901234567890" as Address;
export const V4_POOL_ID = "0x401bc4b106c6deac5c66c251743efce2776a7eb0ce49d122d870308a4d209e43" as Hex;

// The canonical Robinhood Chain Uniswap V4 StateView from the shared
// pool-verification deployment registry, duplicated here (not imported)
// for the same reason CANONICAL_FACTORY/V4_POOL_MANAGER are duplicated
// in pool-verification's own test fixtures: a test that accidentally
// breaks the real registry constant should fail loudly, not silently
// compare against whatever it currently says.
export const V4_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address;

export const IDENTITY_BLOCK = 11111n;
export const STATE_BLOCK = 22222n;

export const DEFAULT_SQRT_PRICE_X96 = 1n << 96n;
export const DEFAULT_TICK = 12345;
export const DEFAULT_OBSERVATION_INDEX = 1;
export const DEFAULT_OBSERVATION_CARDINALITY = 5;
export const DEFAULT_OBSERVATION_CARDINALITY_NEXT = 5;
export const DEFAULT_FEE_PROTOCOL = 0;
export const DEFAULT_UNLOCKED = true;
export const DEFAULT_LIQUIDITY = 123456789n;
export const DEFAULT_FEE = 3000;
export const DEFAULT_TICK_SPACING = 60;

function uintWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function intWord(value: number | bigint): string {
  const v = BigInt(value);
  const unsigned = v < 0n ? v + (1n << 256n) : v;
  return unsigned.toString(16).padStart(64, "0");
}

function boolWord(value: boolean): string {
  return (value ? 1n : 0n).toString(16).padStart(64, "0");
}

export interface Slot0Fields {
  sqrtPriceX96: bigint;
  tick: number;
  observationIndex: number;
  observationCardinality: number;
  observationCardinalityNext: number;
  feeProtocol: number;
  unlocked: boolean;
}

export const DEFAULT_SLOT0: Slot0Fields = {
  sqrtPriceX96: DEFAULT_SQRT_PRICE_X96,
  tick: DEFAULT_TICK,
  observationIndex: DEFAULT_OBSERVATION_INDEX,
  observationCardinality: DEFAULT_OBSERVATION_CARDINALITY,
  observationCardinalityNext: DEFAULT_OBSERVATION_CARDINALITY_NEXT,
  feeProtocol: DEFAULT_FEE_PROTOCOL,
  unlocked: DEFAULT_UNLOCKED,
};

/** Builds a valid raw `slot0()` return (7 ABI words) from field overrides — a plain word-concatenation builder, independent of the production decoder it's used to test. */
export function slot0Return(overrides: Partial<Slot0Fields> = {}): Hex {
  const f = { ...DEFAULT_SLOT0, ...overrides };
  const words = [
    uintWord(f.sqrtPriceX96),
    intWord(f.tick),
    uintWord(BigInt(f.observationIndex)),
    uintWord(BigInt(f.observationCardinality)),
    uintWord(BigInt(f.observationCardinalityNext)),
    uintWord(BigInt(f.feeProtocol)),
    boolWord(f.unlocked),
  ].join("");
  return `0x${words}` as Hex;
}

export function liquidityReturn(value: bigint = DEFAULT_LIQUIDITY): Hex {
  return `0x${uintWord(value)}` as Hex;
}

export function feeReturn(value: number = DEFAULT_FEE): Hex {
  return `0x${uintWord(BigInt(value))}` as Hex;
}

export function tickSpacingReturn(value: number = DEFAULT_TICK_SPACING): Hex {
  return `0x${intWord(value)}` as Hex;
}

/** A raw word with a value exceeding a given bit width — for malformed "dirty high bits" tests. Not itself a valid encoding of anything. */
export function oversizedWord(): string {
  return "f".repeat(64);
}

export const DEFAULT_PROTOCOL_FEE = 0;
export const DEFAULT_LP_FEE = 3000;

export interface Slot0V4Fields {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
}

export const DEFAULT_SLOT0_V4: Slot0V4Fields = {
  sqrtPriceX96: DEFAULT_SQRT_PRICE_X96,
  tick: DEFAULT_TICK,
  protocolFee: DEFAULT_PROTOCOL_FEE,
  lpFee: DEFAULT_LP_FEE,
};

/** Builds a valid raw `StateView.getSlot0(poolId)` return (4 ABI words) from field overrides — a plain word-concatenation builder, independent of the production decoder it's used to test. */
export function slot0V4Return(overrides: Partial<Slot0V4Fields> = {}): Hex {
  const f = { ...DEFAULT_SLOT0_V4, ...overrides };
  const words = [uintWord(f.sqrtPriceX96), intWord(f.tick), uintWord(BigInt(f.protocolFee)), uintWord(BigInt(f.lpFee))].join("");
  return `0x${words}` as Hex;
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

/** Builds a `pool` + a `VERIFIED`/`UNISWAP_V3` `PoolIdentityVerification` guaranteed to reference that same pool, plus any explicit overrides for negative-precondition tests. */
export function verifiedV3Identity(
  poolOverrides: Partial<LiquidityPool> = {},
  identityOverrides: Partial<Omit<PoolIdentityVerification, "pool">> = {},
): { pool: LiquidityPool; identity: PoolIdentityVerification } {
  const p = pool(poolOverrides);
  const identity: PoolIdentityVerification = {
    pool: {
      chainId: p.chainId,
      pairAddress: p.pairAddress,
      dexId: p.dexId,
      canonicalAssetAddress: p.canonicalAssetAddress,
      canonicalAssetSymbol: p.canonicalAssetSymbol,
      canonicalAssetSide: p.canonicalAssetSide,
    },
    family: "UNISWAP_V3",
    classificationStatus: "CLASSIFIED",
    status: "VERIFIED",
    blockNumber: IDENTITY_BLOCK,
    evidence: [],
    ...identityOverrides,
  };
  return { pool: p, identity };
}

/** Same as `verifiedV3Identity`, but shaped as a `VERIFIED`/`UNISWAP_V4` identity: 32-byte `pairAddress` (`V4_POOL_ID`) by default. */
export function verifiedV4Identity(
  poolOverrides: Partial<LiquidityPool> = {},
  identityOverrides: Partial<Omit<PoolIdentityVerification, "pool">> = {},
): { pool: LiquidityPool; identity: PoolIdentityVerification } {
  const p = pool({ pairAddress: V4_POOL_ID, labels: ["v4"], ...poolOverrides });
  const identity: PoolIdentityVerification = {
    pool: {
      chainId: p.chainId,
      pairAddress: p.pairAddress,
      dexId: p.dexId,
      canonicalAssetAddress: p.canonicalAssetAddress,
      canonicalAssetSymbol: p.canonicalAssetSymbol,
      canonicalAssetSide: p.canonicalAssetSide,
    },
    family: "UNISWAP_V4",
    classificationStatus: "CLASSIFIED",
    status: "VERIFIED",
    blockNumber: IDENTITY_BLOCK,
    evidence: [],
    ...identityOverrides,
  };
  return { pool: p, identity };
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
  readonly slot0?: RpcStub;
  readonly liquidity?: RpcStub;
  readonly fee?: RpcStub;
  readonly tickSpacing?: RpcStub;
  readonly slot0V4?: RpcStub;
  readonly liquidityV4?: RpcStub;
}

export interface FakeRpcCallLog {
  getBlockNumberCalls: number;
  callCalls: Array<{ to: string; data: string; blockTag: unknown }>;
}

/**
 * A fake `VerifiedRobinhoodRpcClient` that routes `call(...)` by
 * 4-byte selector, using the real `encode*Call` helpers to compute
 * selectors — so a fixture never hand-transcribes a selector that
 * could silently drift from what `abi/selectors.ts` actually produces.
 * Defaults represent a fully valid VERIFIED path; each test overrides
 * only what it needs.
 */
export function buildFakeRpc(stubs: FakeRpcStubs = {}): { rpc: VerifiedRobinhoodRpcClient; calls: FakeRpcCallLog } {
  const calls: FakeRpcCallLog = { getBlockNumberCalls: 0, callCalls: [] };

  const slot0Fn = toFn(stubs.slot0, slot0Return());
  const liquidityFn = toFn(stubs.liquidity, liquidityReturn());
  const feeFn = toFn(stubs.fee, feeReturn());
  const tickSpacingFn = toFn(stubs.tickSpacing, tickSpacingReturn());
  const slot0V4Fn = toFn(stubs.slot0V4, slot0V4Return());
  const liquidityV4Fn = toFn(stubs.liquidityV4, liquidityReturn(DEFAULT_LIQUIDITY));

  const slot0Selector = encodeSlot0Call().slice(0, 10);
  const liquiditySelector = encodeLiquidityCall().slice(0, 10);
  const feeSelector = encodeFeeCall().slice(0, 10);
  const tickSpacingSelector = encodeTickSpacingCall().slice(0, 10);
  const slot0V4Selector = encodeGetSlot0Call(V4_POOL_ID).slice(0, 10);
  const liquidityV4Selector = encodeGetLiquidityCall(V4_POOL_ID).slice(0, 10);

  const rpc: VerifiedRobinhoodRpcClient = {
    chainId: stubs.chainId ?? 4663,
    getBlockNumber: async () => {
      calls.getBlockNumberCalls += 1;
      if (stubs.getBlockNumber && typeof stubs.getBlockNumber !== "function") throw stubs.getBlockNumber.error;
      return stubs.getBlockNumber ? (stubs.getBlockNumber as () => Promise<bigint>)() : STATE_BLOCK;
    },
    // Neither V3 nor V4 current-state reads (Phase 6D.1/6D.2) have any
    // use for eth_getCode — identity's contract-code check already
    // happened in Phase 6C.1, and V4 pools have no per-pool contract at
    // all.
    getCode: async () => {
      throw new Error("unstubbed fake RPC call: getCode (not used by pool-state reads)");
    },
    call: async (request, blockTag) => {
      calls.callCalls.push({ to: request.to, data: request.data, blockTag });
      const selector = request.data.slice(0, 10);
      if (selector === slot0Selector) return slot0Fn();
      if (selector === liquiditySelector) return liquidityFn();
      if (selector === feeSelector) return feeFn();
      if (selector === tickSpacingSelector) return tickSpacingFn();
      if (selector === slot0V4Selector) return slot0V4Fn();
      if (selector === liquidityV4Selector) return liquidityV4Fn();
      throw new Error(`unstubbed fake RPC call: to=${request.to} data=${request.data}`);
    },
    getLogs: async () => {
      throw new Error("unstubbed fake RPC call: getLogs (not used by pool-state reads)");
    },
  };

  return { rpc, calls };
}
