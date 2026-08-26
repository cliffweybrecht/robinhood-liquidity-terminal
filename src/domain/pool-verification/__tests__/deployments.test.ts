import { describe, expect, it } from "vitest";
import { getProtocolDeployment, getProtocolDeploymentAddress } from "../deployments";
import { UnknownProtocolDeploymentError } from "../errors";

describe("getProtocolDeploymentAddress", () => {
  it("resolves the canonical Robinhood Chain (4663) Uniswap V3 factory", () => {
    const address = getProtocolDeploymentAddress(4663, "UNISWAP_V3", "factory");
    expect(address).toBe("0x1f7d7550B1b028f7571E69A784071F0205FD2EfA");
  });

  it("resolves the canonical Robinhood Chain (4663) Uniswap V4 StateView", () => {
    const address = getProtocolDeploymentAddress(4663, "UNISWAP_V4", "state_view");
    expect(address).toBe("0xF3334192D15450CdD385c8B70e03f9A6bD9E673b");
  });

  it("exposes StateView provenance describing the independent poolManager() binding check", () => {
    const deployment = getProtocolDeployment(4663, "UNISWAP_V4", "state_view");
    expect(deployment.provenance).toMatch(/poolManager/);
    expect(deployment.provenance).toMatch(/0x8366a39CC670B4001A1121B8F6A443A643e40951/);
  });

  it("resolves the canonical Robinhood Chain (4663) Uniswap V3 QuoterV2", () => {
    const address = getProtocolDeploymentAddress(4663, "UNISWAP_V3", "quoter");
    expect(address).toBe("0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7");
  });

  it("resolves the canonical Robinhood Chain (4663) Uniswap V4Quoter", () => {
    const address = getProtocolDeploymentAddress(4663, "UNISWAP_V4", "quoter");
    expect(address).toBe("0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94");
  });

  it("exposes V3 QuoterV2 provenance describing the independent factory() binding check", () => {
    const deployment = getProtocolDeployment(4663, "UNISWAP_V3", "quoter");
    expect(deployment.provenance).toMatch(/factory/);
    expect(deployment.provenance).toMatch(/0x1f7d7550b1b028f7571e69a784071f0205fd2efa/);
  });

  it("exposes V4Quoter provenance describing the independent poolManager() binding check", () => {
    const deployment = getProtocolDeployment(4663, "UNISWAP_V4", "quoter");
    expect(deployment.provenance).toMatch(/poolManager/);
    expect(deployment.provenance).toMatch(/0x8366a39CC670B4001A1121B8F6A443A643e40951/);
  });

  it("throws UnknownProtocolDeploymentError for an unconfigured chainId", () => {
    expect(() => getProtocolDeploymentAddress(1, "UNISWAP_V3", "factory")).toThrow(UnknownProtocolDeploymentError);
  });

  it("fails closed rather than falling back to another chain's deployment, carrying the requested chain/protocol/role", () => {
    let caught: unknown;
    try {
      getProtocolDeploymentAddress(999999, "UNISWAP_V3", "factory");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownProtocolDeploymentError);
    const err = caught as UnknownProtocolDeploymentError;
    expect(err.chainId).toBe(999999);
    expect(err.protocol).toBe("UNISWAP_V3");
    expect(err.role).toBe("factory");
    expect(err.code).toBe("UNKNOWN_PROTOCOL_DEPLOYMENT");
  });
});
