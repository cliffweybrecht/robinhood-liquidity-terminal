import { describe, expect, it } from "vitest";
import { isValidEvmAddress, toChecksummedAddress } from "../address";

describe("isValidEvmAddress", () => {
  it("accepts a checksummed address", () => {
    expect(isValidEvmAddress("0xd95B44124e475743a7589e68F3D74008A5536D44")).toBe(true);
  });

  it("accepts an all-lowercase address", () => {
    expect(isValidEvmAddress("0xd95b44124e475743a7589e68f3d74008a5536d44")).toBe(true);
  });

  it("rejects an address missing the 0x prefix", () => {
    expect(isValidEvmAddress("d95B44124e475743a7589e68F3D74008A5536D44")).toBe(false);
  });

  it("rejects an address that is too short", () => {
    expect(isValidEvmAddress("0xDEADBEEF")).toBe(false);
  });

  it("rejects an address with non-hex characters", () => {
    expect(isValidEvmAddress("0xZZZZ44124e475743a7589e68F3D74008A5536D44")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidEvmAddress("")).toBe(false);
  });
});

describe("toChecksummedAddress", () => {
  it("normalizes differently-cased input to the same checksum", () => {
    const lower = toChecksummedAddress("0xd95b44124e475743a7589e68f3d74008a5536d44");
    const upper = toChecksummedAddress("0xD95B44124E475743A7589E68F3D74008A5536D44");

    expect(lower).toBe(upper);
    expect(lower).toBe("0xd95B44124e475743a7589e68F3D74008A5536D44");
  });
});
