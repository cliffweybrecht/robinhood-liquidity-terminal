import { describe, expect, it, vi } from "vitest";
import validFixture from "@/test/fixtures/robinhood-assets-valid.json";
import noChain4663Fixture from "@/test/fixtures/robinhood-assets-no-4663.json";
import duplicateAddressFixture from "@/test/fixtures/robinhood-assets-duplicate-address.json";
import { RobinhoodHttpError, RobinhoodTimeoutError } from "@/providers/robinhood/errors";
import {
  AmbiguousSymbolError,
  AssetNotFoundError,
  InvalidAddressInputError,
} from "../errors";
import { NoChainDeploymentError, DuplicateContractAddressError } from "../errors";
import {
  getRobinhoodAssetByAddress,
  getRobinhoodAssetBySymbol,
  getRobinhoodAssets,
} from "../service";

const BASE_URL = "https://example.test";

function fetchImplFor(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("getRobinhoodAssets", () => {
  it("returns a normalized registry for a valid upstream response", async () => {
    const registry = await getRobinhoodAssets({
      baseUrl: BASE_URL,
      fetchImpl: fetchImplFor(validFixture),
    });

    expect(registry.assets).toHaveLength(3);
  });

  it("propagates NoChainDeploymentError when no asset targets chain 4663", async () => {
    await expect(
      getRobinhoodAssets({ baseUrl: BASE_URL, fetchImpl: fetchImplFor(noChain4663Fixture) }),
    ).rejects.toThrow(NoChainDeploymentError);
  });

  it("propagates DuplicateContractAddressError for colliding canonical addresses", async () => {
    await expect(
      getRobinhoodAssets({ baseUrl: BASE_URL, fetchImpl: fetchImplFor(duplicateAddressFixture) }),
    ).rejects.toThrow(DuplicateContractAddressError);
  });

  it("propagates upstream HTTP failures", async () => {
    await expect(
      getRobinhoodAssets({ baseUrl: BASE_URL, fetchImpl: fetchImplFor({}, 503) }),
    ).rejects.toThrow(RobinhoodHttpError);
  });

  it("propagates timeouts", async () => {
    const neverResolves: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    await expect(
      getRobinhoodAssets({ baseUrl: BASE_URL, timeoutMs: 10, fetchImpl: neverResolves }),
    ).rejects.toThrow(RobinhoodTimeoutError);
  });
});

describe("getRobinhoodAssetBySymbol", () => {
  it("matches case-insensitively", async () => {
    const asset = await getRobinhoodAssetBySymbol("crm", {
      baseUrl: BASE_URL,
      fetchImpl: fetchImplFor(validFixture),
    });

    expect(asset.symbol).toBe("CRM");
  });

  it("throws AssetNotFoundError for an unknown symbol", async () => {
    await expect(
      getRobinhoodAssetBySymbol("NOPE", { baseUrl: BASE_URL, fetchImpl: fetchImplFor(validFixture) }),
    ).rejects.toThrow(AssetNotFoundError);
  });

  it("throws AmbiguousSymbolError when the symbol resolves to more than one asset", async () => {
    const ambiguousFixture = {
      assets: [
        {
          id: "0x1",
          tokenSymbol: "aapl",
          tokenName: "Asset A",
          deployments: [{ contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44", chainId: 4663 }],
          currentMultiplier: "1",
          status: "ASSET_STATUS_ACTIVE",
        },
        {
          id: "0x2",
          tokenSymbol: "AAPL",
          tokenName: "Asset B",
          deployments: [{ contractAddress: "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D", chainId: 4663 }],
          currentMultiplier: "1",
          status: "ASSET_STATUS_ACTIVE",
        },
      ],
    };

    await expect(
      getRobinhoodAssetBySymbol("AAPL", { baseUrl: BASE_URL, fetchImpl: fetchImplFor(ambiguousFixture) }),
    ).rejects.toThrow(AmbiguousSymbolError);
  });
});

describe("getRobinhoodAssetByAddress", () => {
  it("matches case-insensitively", async () => {
    const asset = await getRobinhoodAssetByAddress(
      "0xd95b44124e475743a7589e68f3d74008a5536d44",
      { baseUrl: BASE_URL, fetchImpl: fetchImplFor(validFixture) },
    );

    expect(asset.symbol).toBe("CRM");
  });

  it("throws InvalidAddressInputError for malformed input without making a network call", async () => {
    const fetchImpl = vi.fn();

    await expect(
      getRobinhoodAssetByAddress("not-an-address", {
        baseUrl: BASE_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(InvalidAddressInputError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws AssetNotFoundError for a well-formed but unknown address", async () => {
    await expect(
      getRobinhoodAssetByAddress("0x00000000000000000000000000000000000000ad", {
        baseUrl: BASE_URL,
        fetchImpl: fetchImplFor(validFixture),
      }),
    ).rejects.toThrow(AssetNotFoundError);
  });
});
