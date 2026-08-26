import type { Address, Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolIdentityVerification } from "@/domain/pool-verification";
import { RobinhoodRpcErrorResponseError } from "@/providers/robinhood-rpc";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { encodeFeeCall, encodeQuoteExactInputSingleV3Call, encodeQuoteExactInputSingleV4Call } from "../abi/selectors";

// Real address forms reused verbatim from earlier phases' test fixtures
// for consistency, not invented shapes. Deliberately duplicated here
// rather than imported from pool-verification's/pool-state's own test
// fixtures — matches the established module-independence policy.
export const POOL_ADDRESS = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3" as Address;
export const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
export const OTHER_TOKEN = "0x1234567890123456789012345678901234567890" as Address;
export const V4_POOL_ID = "0x401bc4b106c6deac5c66c251743efce2776a7eb0ce49d122d870308a4d209e43" as Hex;
export const V3_QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7" as Address;
export const V4_QUOTER = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94" as Address;
export const HOOK_ADDRESS = "0xf869A735ec31e28f77A6f917157BE63729F60880" as Address;

export const IDENTITY_BLOCK = 11111n;
export const QUOTE_BLOCK = 22222n;

export const DEFAULT_FEE = 500;
export const DEFAULT_TICK_SPACING = 10;
export const DEFAULT_AMOUNT_IN = 1000000000000000n; // 0.001, 18 decimals

function uintWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

export function feeReturn(fee: number = DEFAULT_FEE): Hex {
  return `0x${uintWord(BigInt(fee))}` as Hex;
}

export interface V3QuoteFields {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
}

export const DEFAULT_V3_QUOTE: V3QuoteFields = {
  amountOut: 212875n,
  sqrtPriceX96After: 5428855367745061334802449001776699n,
  initializedTicksCrossed: 1,
  gasEstimate: 101560n,
};

export function v3QuoteReturn(overrides: Partial<V3QuoteFields> = {}): Hex {
  const f = { ...DEFAULT_V3_QUOTE, ...overrides };
  const words = [uintWord(f.amountOut), uintWord(f.sqrtPriceX96After), uintWord(BigInt(f.initializedTicksCrossed)), uintWord(f.gasEstimate)].join(
    "",
  );
  return `0x${words}` as Hex;
}

export interface V4QuoteFields {
  amountOut: bigint;
  gasEstimate: bigint;
}

export const DEFAULT_V4_QUOTE: V4QuoteFields = {
  amountOut: 11449737457906132n,
  gasEstimate: 49580n,
};

export function v4QuoteReturn(overrides: Partial<V4QuoteFields> = {}): Hex {
  const f = { ...DEFAULT_V4_QUOTE, ...overrides };
  const words = [uintWord(f.amountOut), uintWord(f.gasEstimate)].join("");
  return `0x${words}` as Hex;
}

/** A raw word with a value exceeding a given bit width — for malformed "dirty high bits" tests. */
export function oversizedWord(): string {
  return "f".repeat(64);
}

/** Builds a well-formed `Error(string)` revert payload for an arbitrary UTF-8 reason string. */
export function errorStringRevert(reason: string): Hex {
  const reasonBytes = Buffer.from(reason, "utf8");
  const lengthWord = uintWord(BigInt(reasonBytes.length));
  const contentHex = reasonBytes.toString("hex").padEnd(Math.ceil(reasonBytes.length / 32) * 64, "0");
  return `0x08c379a0${uintWord(32n)}${lengthWord}${contentHex}` as Hex;
}

/** Builds a well-formed `UnexpectedRevertBytes(bytes)` revert payload wrapping an arbitrary inner byte sequence (e.g. a 4-byte selector). */
export function unexpectedRevertBytes(innerHex: Hex): Hex {
  const inner = innerHex.slice(2);
  const innerBytesLength = inner.length / 2;
  const lengthWord = uintWord(BigInt(innerBytesLength));
  const contentHex = inner.padEnd(Math.ceil(innerBytesLength / 32) * 64, "0");
  return `0x6190b2b0${uintWord(32n)}${lengthWord}${contentHex}` as Hex;
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

export interface V4PoolKeyFields {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export const DEFAULT_V4_POOL_KEY: V4PoolKeyFields = {
  currency0: WETH,
  currency1: NVDA,
  fee: 8388608,
  tickSpacing: 4,
  hooks: "0x0000000000000000000000000000000000000000" as Address,
};

export function verifiedV4Identity(
  poolOverrides: Partial<LiquidityPool> = {},
  identityOverrides: Partial<Omit<PoolIdentityVerification, "pool">> = {},
  poolKeyOverrides: Partial<V4PoolKeyFields> = {},
): { pool: LiquidityPool; identity: PoolIdentityVerification } {
  const poolKey = { ...DEFAULT_V4_POOL_KEY, ...poolKeyOverrides };
  const p = pool({
    pairAddress: V4_POOL_ID,
    labels: ["v4"],
    baseToken: { address: poolKey.currency1, name: "NVDA", symbol: "NVDA" },
    quoteToken: { address: poolKey.currency0, name: "WETH", symbol: "WETH" },
    canonicalAssetAddress: poolKey.currency1,
    ...poolOverrides,
  });
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
    poolKey,
    evidence: [],
    ...identityOverrides,
  };
  return { pool: p, identity };
}

export type RpcStub = Hex | (() => Promise<Hex>) | { error: unknown } | { revert: Hex };

function toFn(stub: RpcStub | undefined, fallback: Hex): () => Promise<Hex> {
  if (stub === undefined) return async () => fallback;
  if (typeof stub === "function") return stub;
  if (typeof stub === "object" && "error" in stub) {
    return async () => {
      throw stub.error;
    };
  }
  if (typeof stub === "object" && "revert" in stub) {
    return async () => {
      throw new RobinhoodRpcErrorResponseError("eth_call", 3, "execution reverted", stub.revert);
    };
  }
  return async () => stub;
}

export interface FakeRpcStubs {
  readonly chainId?: number;
  readonly getBlockNumber?: (() => Promise<bigint>) | { error: unknown };
  readonly fee?: RpcStub;
  readonly v3Quote?: RpcStub;
  readonly v4Quote?: RpcStub;
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
 */
export function buildFakeRpc(stubs: FakeRpcStubs = {}): { rpc: VerifiedRobinhoodRpcClient; calls: FakeRpcCallLog } {
  const calls: FakeRpcCallLog = { getBlockNumberCalls: 0, callCalls: [] };

  const feeFn = toFn(stubs.fee, feeReturn());
  const v3QuoteFn = toFn(stubs.v3Quote, v3QuoteReturn());
  const v4QuoteFn = toFn(stubs.v4Quote, v4QuoteReturn());

  const feeSelector = encodeFeeCall().slice(0, 10);
  const v3QuoteSelector = encodeQuoteExactInputSingleV3Call(NVDA, USDG, DEFAULT_AMOUNT_IN, DEFAULT_FEE).slice(0, 10);
  const v4QuoteSelector = encodeQuoteExactInputSingleV4Call(DEFAULT_V4_POOL_KEY, true, DEFAULT_AMOUNT_IN, "0x").slice(0, 10);

  const rpc: VerifiedRobinhoodRpcClient = {
    chainId: stubs.chainId ?? 4663,
    getBlockNumber: async () => {
      calls.getBlockNumberCalls += 1;
      if (stubs.getBlockNumber && typeof stubs.getBlockNumber !== "function") throw stubs.getBlockNumber.error;
      return stubs.getBlockNumber ? (stubs.getBlockNumber as () => Promise<bigint>)() : QUOTE_BLOCK;
    },
    getCode: async () => {
      throw new Error("unstubbed fake RPC call: getCode (not used by Phase 6E.1 quote reads)");
    },
    call: async (request, blockTag) => {
      calls.callCalls.push({ to: request.to, data: request.data, blockTag });
      const selector = request.data.slice(0, 10);
      if (selector === feeSelector) return feeFn();
      if (selector === v3QuoteSelector) return v3QuoteFn();
      if (selector === v4QuoteSelector) return v4QuoteFn();
      throw new Error(`unstubbed fake RPC call: to=${request.to} data=${request.data}`);
    },
    getLogs: async () => {
      throw new Error("unstubbed fake RPC call: getLogs (not used by Phase 6E.1 quote reads)");
    },
  };

  return { rpc, calls };
}
