import { describe, expect, it } from "vitest";
import { DuplicatePoolConflictError } from "@/domain/pool";
import {
  DexScreenerHttpError,
  DexScreenerInvalidJsonError,
  DexScreenerNetworkError,
  DexScreenerSchemaValidationError,
  DexScreenerTimeoutError,
} from "@/providers/dexscreener";
import { classifyFailure } from "../classify";

describe("classifyFailure", () => {
  it("classifies a Dexscreener timeout", () => {
    expect(classifyFailure(new DexScreenerTimeoutError("timed out")).category).toBe("DEXSCREENER_TIMEOUT");
  });

  it("classifies a Dexscreener network failure", () => {
    expect(classifyFailure(new DexScreenerNetworkError("network down")).category).toBe("DEXSCREENER_NETWORK");
  });

  it("classifies a Dexscreener non-2xx HTTP response", () => {
    expect(classifyFailure(new DexScreenerHttpError(503, "Service Unavailable")).category).toBe(
      "DEXSCREENER_HTTP",
    );
  });

  it("classifies an invalid-JSON response distinctly from a schema-invalid one", () => {
    expect(classifyFailure(new DexScreenerInvalidJsonError("bad json")).category).toBe(
      "DEXSCREENER_INVALID_RESPONSE",
    );
    expect(classifyFailure(new DexScreenerSchemaValidationError("bad shape", [])).category).toBe(
      "DEXSCREENER_SCHEMA_INVALID",
    );
  });

  it("classifies a pool integrity conflict", () => {
    expect(classifyFailure(new DuplicatePoolConflictError("robinhood", "0xabc")).category).toBe(
      "POOL_INTEGRITY_CONFLICT",
    );
  });

  it("falls back to UNEXPECTED for an unrecognized error, preserving its message", () => {
    const result = classifyFailure(new TypeError("something else broke"));
    expect(result.category).toBe("UNEXPECTED");
    expect(result.message).toBe("something else broke");
  });

  it("falls back to UNEXPECTED for a non-Error throw", () => {
    const result = classifyFailure("a plain string throw");
    expect(result.category).toBe("UNEXPECTED");
    expect(result.message).toBe("Unknown error");
  });
});
