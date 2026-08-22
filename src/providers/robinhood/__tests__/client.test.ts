import { describe, expect, it } from "vitest";
import validFixture from "@/test/fixtures/robinhood-assets-valid.json";
import { fetchRobinhoodAssets } from "../client";
import {
  RobinhoodHttpError,
  RobinhoodInvalidJsonError,
  RobinhoodNetworkError,
  RobinhoodSchemaValidationError,
  RobinhoodTimeoutError,
} from "../errors";

const BASE_URL = "https://example.test";

describe("fetchRobinhoodAssets", () => {
  it("returns validated data for a successful 200 response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(validFixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const result = await fetchRobinhoodAssets({ baseUrl: BASE_URL, fetchImpl });

    expect(result.assets).toHaveLength(3);
    expect(result.assets[0]?.tokenSymbol).toBe("CRM");
  });

  it("requests the /rhj/assets path against the configured base URL", async () => {
    let requestedUrl: string | undefined;
    const fetchImpl: typeof fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify(validFixture), { status: 200 });
    };

    await fetchRobinhoodAssets({ baseUrl: BASE_URL, fetchImpl });

    expect(requestedUrl).toBe("https://example.test/rhj/assets");
  });

  it("throws RobinhoodHttpError for a non-2xx response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("Internal error", { status: 500, statusText: "Internal Server Error" });

    await expect(
      fetchRobinhoodAssets({ baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(RobinhoodHttpError);
  });

  it("throws RobinhoodInvalidJsonError for a non-JSON body", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("not json{", { status: 200 });

    await expect(
      fetchRobinhoodAssets({ baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(RobinhoodInvalidJsonError);
  });

  it("throws RobinhoodSchemaValidationError for a schema-invalid body", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ assets: [{ nonsense: true }] }), {
        status: 200,
      });

    await expect(
      fetchRobinhoodAssets({ baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(RobinhoodSchemaValidationError);
  });

  it("throws RobinhoodNetworkError when the underlying fetch fails", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(
      fetchRobinhoodAssets({ baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(RobinhoodNetworkError);
  });

  it("throws RobinhoodTimeoutError when the request exceeds timeoutMs", async () => {
    const neverResolves: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    await expect(
      fetchRobinhoodAssets({ baseUrl: BASE_URL, timeoutMs: 10, fetchImpl: neverResolves }),
    ).rejects.toThrow(RobinhoodTimeoutError);
  });
});
