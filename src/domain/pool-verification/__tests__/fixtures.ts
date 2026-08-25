import type { Address, Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolProtocolClassification } from "@/domain/protocol";
import type { EthGetLogsFilter, LogEntry, VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { encodeFactoryCall, encodeFeeCall, encodeGetPoolCall, encodeToken0Call, encodeToken1Call } from "../abi/selectors";
import { computeV4PoolId, V4_INITIALIZE_TOPIC0 } from "../abi/v4-events";

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

// The canonical Robinhood Chain Uniswap V4 PoolManager from deployments.ts,
// duplicated here (not imported) for the same reason CANONICAL_FACTORY is
// above: a test that accidentally breaks the real deployments.ts constant
// should fail loudly, not silently compare against whatever it currently says.
export const V4_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address;
export const V4_DEPLOYMENT_BLOCK = 9070n;
export const V4_CURRENCY0 = NVDA;
export const V4_CURRENCY1 = USDG;
export const V4_FEE = FEE_TIER;
export const V4_TICK_SPACING = 60;
export const V4_HOOKS = "0x0000000000000000000000000000000000000000" as Address;
export const V4_SQRT_PRICE_X96 = 1n << 96n;
export const V4_TICK = 0;

export function addressReturn(address: string): Hex {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as Hex;
}

export function uint24Return(fee: number): Hex {
  return `0x${fee.toString(16).padStart(64, "0")}` as Hex;
}

/** Two's-complement-encodes a signed value into one 32-byte ABI word (e.g. `int24`), matching real ABI sign extension. */
export function intWord(value: number | bigint): string {
  const v = BigInt(value);
  const unsigned = v < 0n ? v + (1n << 256n) : v;
  return unsigned.toString(16).padStart(64, "0");
}

/** Encodes one unsigned value into one 32-byte ABI word (e.g. `uint160`). */
export function uintWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/**
 * Builds the ABI-encoded `Initialize` event `data` blob (fee, tickSpacing,
 * hooks, sqrtPriceX96, tick — the 5 non-indexed fields) using plain word
 * concatenation, deliberately not viem's `encodeAbiParameters` — this
 * constructs raw wire-format test data independently of the production
 * decode path, the same way a real node's `eth_getLogs` response would
 * arrive.
 */
export function v4InitializeData(fields: {
  fee?: number;
  tickSpacing?: number;
  hooks?: Address;
  sqrtPriceX96?: bigint;
  tick?: number;
} = {}): Hex {
  const fee = fields.fee ?? V4_FEE;
  const tickSpacing = fields.tickSpacing ?? V4_TICK_SPACING;
  const hooks = fields.hooks ?? V4_HOOKS;
  const sqrtPriceX96 = fields.sqrtPriceX96 ?? V4_SQRT_PRICE_X96;
  const tick = fields.tick ?? V4_TICK;
  const feeWord = uintWord(BigInt(fee));
  const tickSpacingWord = intWord(tickSpacing);
  const hooksWord = addressReturn(hooks).slice(2);
  const sqrtPriceWord = uintWord(sqrtPriceX96);
  const tickWord = intWord(tick);
  return `0x${feeWord}${tickSpacingWord}${hooksWord}${sqrtPriceWord}${tickWord}` as Hex;
}

/**
 * The PoolId a `V4_CURRENCY0`/`V4_CURRENCY1`/`V4_FEE`/`V4_TICK_SPACING`/
 * `V4_HOOKS` PoolKey recomputes to, via the same trusted-encode-direction
 * helper `strategies/uniswap-v4.ts` itself uses (see `abi/v4-events.ts`'s
 * doc comment for why that direction is safe to build with viem
 * directly). Fixtures constructing self-consistent test data this way is
 * distinct from a test *validating* that computation — the dedicated
 * PoolId-vector test in `uniswap-v4.test.ts` independently cross-checks
 * this value via manual word concatenation + `keccak256`, not by calling
 * this same helper.
 */
export const V4_POOL_ID: Hex = computeV4PoolId({
  currency0: V4_CURRENCY0,
  currency1: V4_CURRENCY1,
  fee: V4_FEE,
  tickSpacing: V4_TICK_SPACING,
  hooks: V4_HOOKS,
});

export const V4_BLOCK_NUMBER = 999888n;
export const V4_HISTORICAL_BLOCK_NUMBER = 12345n;
export const V4_TRANSACTION_HASH = "0xaaaabbbbccccddddeeeeffff00001111222233334444555566667777888899aa" as Hex;
export const V4_BLOCK_HASH = "0x1111222233334444555566667777888899aaaabbbbccccddddeeeeffff0000" as Hex;

/**
 * Builds a fully valid, non-removed `PoolManager.Initialize` `LogEntry`
 * for `V4_POOL_ID` by default — the happy-path VERIFIED log. Individual
 * fields (`topics`, `data`, `removed`, provenance) can be overridden
 * directly to construct every malformed/removed/mismatched test case.
 */
export function v4InitializeLog(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    address: V4_POOL_MANAGER,
    topics: [V4_INITIALIZE_TOPIC0, V4_POOL_ID, addressReturn(V4_CURRENCY0), addressReturn(V4_CURRENCY1)],
    data: v4InitializeData(),
    blockNumber: V4_HISTORICAL_BLOCK_NUMBER,
    blockHash: V4_BLOCK_HASH,
    transactionHash: V4_TRANSACTION_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    ...overrides,
  };
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

/** Same as `classifiedPool`, but shaped as a CLASSIFIED UNISWAP_V4 pool: 32-byte `pairAddress` (`V4_POOL_ID`), `identifierShape: "ID_32_BYTE"`. */
export function classifiedV4Pool(
  poolOverrides: Partial<LiquidityPool> = {},
  classificationOverrides: Partial<Omit<PoolProtocolClassification, "pool">> = {},
): { pool: LiquidityPool; classification: PoolProtocolClassification } {
  return classifiedPool(
    { pairAddress: V4_POOL_ID, labels: ["v4"], ...poolOverrides },
    { identifierShape: "ID_32_BYTE", family: "UNISWAP_V4", version: "v4", status: "CLASSIFIED", ...classificationOverrides },
  );
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

export type GetLogsStub = readonly LogEntry[] | (() => Promise<readonly LogEntry[]>) | { error: unknown };

export interface FakeRpcStubs {
  readonly chainId?: number;
  readonly getBlockNumber?: (() => Promise<bigint>) | { error: unknown };
  readonly code?: RpcStub;
  readonly token0?: RpcStub;
  readonly token1?: RpcStub;
  readonly factory?: RpcStub;
  readonly fee?: RpcStub;
  readonly getPool?: RpcStub;
  readonly getLogs?: GetLogsStub;
}

export interface FakeRpcCallLog {
  getBlockNumberCalls: number;
  getCodeCalls: Array<{ address: string; blockTag: unknown }>;
  callCalls: Array<{ to: string; data: string; blockTag: unknown }>;
  getLogsCalls: EthGetLogsFilter[];
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
  const calls: FakeRpcCallLog = { getBlockNumberCalls: 0, getCodeCalls: [], callCalls: [], getLogsCalls: [] };

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
    // Uniswap V4 identity verification (Phase 6C.2) is the only strategy
    // that calls eth_getLogs — every V4 test must stub `stubs.getLogs`
    // explicitly (no fully-valid default the way code/token0/etc. have
    // one, since a default log would only be valid for one specific
    // PoolId/PoolKey combination). The call is always recorded before
    // resolving/throwing, regardless of which stub shape was given.
    getLogs: async (filter) => {
      calls.getLogsCalls.push(filter);
      const getLogsStub = stubs.getLogs;
      if (getLogsStub === undefined) {
        throw new Error("unstubbed fake RPC call: getLogs — pass stubs.getLogs");
      }
      if (typeof getLogsStub === "function") return getLogsStub();
      if (Array.isArray(getLogsStub)) return getLogsStub;
      if ("error" in getLogsStub) throw getLogsStub.error;
      return getLogsStub;
    },
  };

  return { rpc, calls };
}
