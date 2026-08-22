import { describe, expect, it } from "vitest";
import validFixture from "@/test/fixtures/robinhood-assets-valid.json";
import { robinhoodAssetsResponseSchema } from "../schema";

describe("robinhoodAssetsResponseSchema", () => {
  it("accepts a valid response and preserves provider field values", () => {
    const parsed = robinhoodAssetsResponseSchema.parse(validFixture);

    expect(parsed.assets).toHaveLength(3);
    expect(parsed.assets[0]).toMatchObject({
      tokenSymbol: "CRM",
      currentMultiplier: "1.000000000000000000",
      status: "ASSET_STATUS_ACTIVE",
    });
  });

  it("ignores unrecognized upstream fields (isin, tradingCapabilities, networkName)", () => {
    const parsed = robinhoodAssetsResponseSchema.parse(validFixture);
    const asset = parsed.assets[0] as unknown as Record<string, unknown>;

    expect(asset.isin).toBeUndefined();
    expect(asset.tradingCapabilities).toBeUndefined();
  });

  it("rejects a response missing the top-level assets array", () => {
    const result = robinhoodAssetsResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an asset missing a required field", () => {
    const result = robinhoodAssetsResponseSchema.safeParse({
      assets: [
        {
          id: "0x1",
          // tokenSymbol missing
          tokenName: "Foo",
          deployments: [],
          currentMultiplier: "1",
          status: "ASSET_STATUS_ACTIVE",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed contract address (wrong length)", () => {
    const result = robinhoodAssetsResponseSchema.safeParse({
      assets: [
        {
          id: "0x1",
          tokenSymbol: "FOO",
          tokenName: "Foo",
          deployments: [{ contractAddress: "0xDEADBEEF", chainId: 4663 }],
          currentMultiplier: "1",
          status: "ASSET_STATUS_ACTIVE",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed contract address (missing 0x prefix)", () => {
    const result = robinhoodAssetsResponseSchema.safeParse({
      assets: [
        {
          id: "0x1",
          tokenSymbol: "FOO",
          tokenName: "Foo",
          deployments: [
            {
              contractAddress: "d95B44124e475743a7589e68F3D74008A5536D44",
              chainId: 4663,
            },
          ],
          currentMultiplier: "1",
          status: "ASSET_STATUS_ACTIVE",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized status enum value", () => {
    const result = robinhoodAssetsResponseSchema.safeParse({
      assets: [
        {
          id: "0x1",
          tokenSymbol: "FOO",
          tokenName: "Foo",
          deployments: [
            {
              contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44",
              chainId: 4663,
            },
          ],
          currentMultiplier: "1",
          status: "ASSET_STATUS_DELISTED",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects deployments that are not an array", () => {
    const result = robinhoodAssetsResponseSchema.safeParse({
      assets: [
        {
          id: "0x1",
          tokenSymbol: "FOO",
          tokenName: "Foo",
          deployments: "not-an-array",
          currentMultiplier: "1",
          status: "ASSET_STATUS_ACTIVE",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
