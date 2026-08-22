import { describe, expect, it } from "vitest";
import type { RobinhoodAsset } from "@/providers/robinhood/schema";
import {
  DuplicateContractAddressError,
  InvalidContractAddressError,
  NoChainDeploymentError,
} from "../errors";
import { buildAssetRegistry, ROBINHOOD_CHAIN_ID } from "../registry";

function asset(overrides: Partial<RobinhoodAsset>): RobinhoodAsset {
  return {
    id: "0x1",
    tokenSymbol: "AAA",
    tokenName: "Asset A",
    deployments: [
      { contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44", chainId: ROBINHOOD_CHAIN_ID },
    ],
    currentMultiplier: "1.000000000000000000",
    status: "ASSET_STATUS_ACTIVE",
    tokenDecimals: 18,
    ...overrides,
  };
}

describe("buildAssetRegistry", () => {
  it("filters to only assets with a deployment on the target chain ID", () => {
    const onChain = asset({ id: "0x1", tokenSymbol: "AAA" });
    const offChain = asset({
      id: "0x2",
      tokenSymbol: "BBB",
      deployments: [
        { contractAddress: "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D", chainId: 1 },
      ],
    });

    const registry = buildAssetRegistry([onChain, offChain]);

    expect(registry.assets).toHaveLength(1);
    expect(registry.assets[0]?.symbol).toBe("AAA");
  });

  it("normalizes fields into the canonical domain shape", () => {
    const registry = buildAssetRegistry([
      asset({
        id: "0x1",
        tokenSymbol: "AAA",
        tokenName: "Asset A Inc.",
        status: "ASSET_STATUS_INACTIVE",
        logoUrl: "https://cdn.example/a.png",
        tokenDecimals: 6,
      }),
    ]);

    expect(registry.assets[0]).toMatchObject({
      id: "0x1",
      symbol: "AAA",
      name: "Asset A Inc.",
      contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44",
      chainId: ROBINHOOD_CHAIN_ID,
      logoUrl: "https://cdn.example/a.png",
      tokenDecimals: 6,
      status: "INACTIVE",
    });
  });

  it("defaults logoUrl and tokenDecimals to null when absent", () => {
    const registry = buildAssetRegistry([
      asset({ id: "0x1", logoUrl: undefined, tokenDecimals: undefined }),
    ]);

    expect(registry.assets[0]?.logoUrl).toBeNull();
    expect(registry.assets[0]?.tokenDecimals).toBeNull();
  });

  it("indexes unambiguous symbols by their uppercased form", () => {
    const registry = buildAssetRegistry([asset({ id: "0x1", tokenSymbol: "aaa" })]);

    expect(registry.bySymbol.get("AAA")?.id).toBe("0x1");
    expect(registry.ambiguousSymbols.size).toBe(0);
  });

  it("marks a symbol shared by multiple assets as ambiguous and excludes it from bySymbol", () => {
    const registry = buildAssetRegistry([
      asset({
        id: "0x1",
        tokenSymbol: "aapl",
        deployments: [
          { contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44", chainId: ROBINHOOD_CHAIN_ID },
        ],
      }),
      asset({
        id: "0x2",
        tokenSymbol: "AAPL",
        deployments: [
          { contractAddress: "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D", chainId: ROBINHOOD_CHAIN_ID },
        ],
      }),
    ]);

    expect(registry.ambiguousSymbols.has("AAPL")).toBe(true);
    expect(registry.bySymbol.has("AAPL")).toBe(false);
  });

  it("indexes contract addresses by their lowercased form regardless of input casing", () => {
    const registry = buildAssetRegistry([
      asset({
        id: "0x1",
        deployments: [
          { contractAddress: "0xd95b44124e475743a7589e68f3d74008a5536d44", chainId: ROBINHOOD_CHAIN_ID },
        ],
      }),
    ]);

    expect(registry.byAddress.get("0xd95b44124e475743a7589e68f3d74008a5536d44")?.id).toBe("0x1");
  });

  it("throws DuplicateContractAddressError when two assets share a canonical address", () => {
    expect(() =>
      buildAssetRegistry([
        asset({
          id: "0x1",
          tokenSymbol: "AAA",
          deployments: [
            { contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44", chainId: ROBINHOOD_CHAIN_ID },
          ],
        }),
        asset({
          id: "0x2",
          tokenSymbol: "BBB",
          // Same address, different (still validly-formed) casing — must still be detected as a duplicate.
          deployments: [
            { contractAddress: "0xd95b44124e475743a7589e68f3d74008a5536d44", chainId: ROBINHOOD_CHAIN_ID },
          ],
        }),
      ]),
    ).toThrow(DuplicateContractAddressError);
  });

  it("throws InvalidContractAddressError for a malformed address, independent of Zod validation", () => {
    expect(() =>
      buildAssetRegistry([
        asset({
          id: "0x1",
          deployments: [{ contractAddress: "0xNOT-AN-ADDRESS", chainId: ROBINHOOD_CHAIN_ID }],
        }),
      ]),
    ).toThrow(InvalidContractAddressError);
  });

  it("throws NoChainDeploymentError when no asset has a deployment on the target chain", () => {
    expect(() =>
      buildAssetRegistry([
        asset({
          id: "0x1",
          deployments: [{ contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44", chainId: 1 }],
        }),
      ]),
    ).toThrow(NoChainDeploymentError);
  });
});
