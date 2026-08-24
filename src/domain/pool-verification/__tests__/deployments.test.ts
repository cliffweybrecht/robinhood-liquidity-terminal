import { describe, expect, it } from "vitest";
import { getProtocolDeploymentAddress } from "../deployments";
import { UnknownProtocolDeploymentError } from "../errors";

describe("getProtocolDeploymentAddress", () => {
  it("resolves the canonical Robinhood Chain (4663) Uniswap V3 factory", () => {
    const address = getProtocolDeploymentAddress(4663, "UNISWAP_V3", "factory");
    expect(address).toBe("0x1f7d7550B1b028f7571E69A784071F0205FD2EfA");
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
