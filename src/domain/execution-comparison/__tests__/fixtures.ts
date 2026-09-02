import { zeroAddress, type Address, type Hex } from "viem";
import type { CanonicalRobinhoodAsset } from "@/domain/asset";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolIdentityVerification } from "@/domain/pool-verification";
import type { PoolProtocolClassification } from "@/domain/protocol";
import type { VerifiedExecutionSnapshot } from "../types";

export const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;

export const NVDA_ASSET: CanonicalRobinhoodAsset = {
  id: "nvda-1",
  symbol: "NVDA",
  name: "NVIDIA Corporation",
  contractAddress: NVDA,
  chainId: 4663,
  logoUrl: null,
  currentMultiplier: "1.000000000000000000",
  tokenDecimals: 18,
  status: "ACTIVE",
};

export function pool(overrides: Partial<LiquidityPool> = {}): LiquidityPool {
  return {
    provider: "dexscreener",
    chainId: "robinhood",
    dexId: "uniswap",
    pairAddress: "0x1111111111111111111111111111111111111111",
    canonicalAssetAddress: NVDA,
    canonicalAssetSymbol: "NVDA",
    canonicalAssetSide: "base",
    baseToken: { address: NVDA, name: "NVIDIA", symbol: "NVDA" },
    quoteToken: { address: USDG, name: "Global Dollar", symbol: "USDG" },
    priceUsd: null,
    priceNative: null,
    liquidityUsd: null,
    liquidityBase: null,
    liquidityQuote: null,
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

export function classification(overrides: Partial<PoolProtocolClassification> = {}): PoolProtocolClassification {
  return {
    pool: {
      chainId: "robinhood",
      pairAddress: "0x1111111111111111111111111111111111111111",
      dexId: "uniswap",
      canonicalAssetAddress: NVDA,
      canonicalAssetSymbol: "NVDA",
      canonicalAssetSide: "base",
    },
    identifierShape: "ADDRESS_20_BYTE",
    family: "UNISWAP_V3",
    version: "v3",
    status: "CLASSIFIED",
    evidence: [],
    ...overrides,
  };
}

export function verifiedV3Identity(pairAddress: Hex, token0: Address, token1: Address, fee = 500): PoolIdentityVerification {
  return {
    pool: {
      chainId: "robinhood",
      pairAddress,
      dexId: "uniswap",
      canonicalAssetAddress: NVDA,
      canonicalAssetSymbol: "NVDA",
      canonicalAssetSide: "base",
    },
    family: "UNISWAP_V3",
    classificationStatus: "CLASSIFIED",
    status: "VERIFIED",
    blockNumber: 100n,
    v3PoolKey: { token0, token1, fee },
    evidence: [],
  };
}

export function verifiedV4Identity(
  poolId: Hex,
  currency0: Address,
  currency1: Address,
  fee = 8_388_608,
  tickSpacing = 4,
  hooks: Address = zeroAddress,
): PoolIdentityVerification {
  return {
    pool: {
      chainId: "robinhood",
      pairAddress: poolId,
      dexId: "uniswap",
      canonicalAssetAddress: NVDA,
      canonicalAssetSymbol: "NVDA",
      canonicalAssetSide: "base",
    },
    family: "UNISWAP_V4",
    classificationStatus: "CLASSIFIED",
    status: "VERIFIED",
    blockNumber: 100n,
    poolKey: { currency0, currency1, fee, tickSpacing, hooks },
    evidence: [],
  };
}

export function snapshotFixture(overrides: Partial<VerifiedExecutionSnapshot> = {}): VerifiedExecutionSnapshot {
  return {
    asset: NVDA_ASSET,
    generatedAt: Date.now(),
    candidates: [],
    groups: [],
    verificationHealth: "HEALTHY",
    ...overrides,
  };
}

export function nonVerifiedIdentity(status: PoolIdentityVerification["status"], family: PoolIdentityVerification["family"] = "UNISWAP_V3"): PoolIdentityVerification {
  return {
    pool: {
      chainId: "robinhood",
      pairAddress: "0x1111111111111111111111111111111111111111",
      dexId: "uniswap",
      canonicalAssetAddress: NVDA,
      canonicalAssetSymbol: "NVDA",
      canonicalAssetSide: "base",
    },
    family,
    classificationStatus: "CLASSIFIED",
    status,
    blockNumber: status === "UNSUPPORTED" ? null : 100n,
    evidence: [],
  };
}
