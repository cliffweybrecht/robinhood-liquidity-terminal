import { describe, expect, it } from "vitest";
import { getPairIdentifierShape, isValidPairIdentifier } from "../address";

const ADDRESS_20 = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3";
const ADDRESS_20_LOWERCASE = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3";
const ID_32 = "0x401bc4b106c6deac5c66c251743efce2776a7eb0ce49d122d870308a4d209e43";

describe("getPairIdentifierShape", () => {
  it("returns ADDRESS_20_BYTE for a valid 20-byte address", () => {
    expect(getPairIdentifierShape(ADDRESS_20)).toBe("ADDRESS_20_BYTE");
  });

  it("returns ADDRESS_20_BYTE for a lowercase (unchecksummed) 20-byte address", () => {
    expect(getPairIdentifierShape(ADDRESS_20_LOWERCASE)).toBe("ADDRESS_20_BYTE");
  });

  it("returns ID_32_BYTE for a valid 32-byte PoolId", () => {
    expect(getPairIdentifierShape(ID_32)).toBe("ID_32_BYTE");
  });

  it("returns null for a value matching neither shape", () => {
    expect(getPairIdentifierShape("0xnotarealidentifier")).toBeNull();
    expect(getPairIdentifierShape("")).toBeNull();
    expect(getPairIdentifierShape("not hex at all")).toBeNull();
  });

  it("is the single source of truth isValidPairIdentifier is built on", () => {
    for (const value of [ADDRESS_20, ID_32, "0xnotarealidentifier", ""]) {
      expect(isValidPairIdentifier(value)).toBe(getPairIdentifierShape(value) !== null);
    }
  });
});

describe("isValidPairIdentifier (Phase 2 behavior, unchanged by the address.ts refactor)", () => {
  it("accepts a 20-byte address", () => {
    expect(isValidPairIdentifier(ADDRESS_20)).toBe(true);
  });

  it("accepts a lowercase 20-byte address", () => {
    expect(isValidPairIdentifier(ADDRESS_20_LOWERCASE)).toBe(true);
  });

  it("accepts a 32-byte PoolId", () => {
    expect(isValidPairIdentifier(ID_32)).toBe(true);
  });

  it("rejects a malformed value", () => {
    expect(isValidPairIdentifier("0xnotarealidentifier")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidPairIdentifier("")).toBe(false);
  });

  it("rejects a value one hex character short of a valid 32-byte PoolId", () => {
    expect(isValidPairIdentifier(ID_32.slice(0, -1))).toBe(false);
  });
});
