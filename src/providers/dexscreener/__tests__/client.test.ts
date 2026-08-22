import { describe, expect, it } from "vitest";
import validFixture from "@/test/fixtures/dexscreener-nvda-valid.json";
import emptyFixture from "@/test/fixtures/dexscreener-empty.json";
import { fetchDexScreenerPairs } from "../client";
import {
  DexScreenerHttpError,
  DexScreenerInvalidJsonError,
  DexScreenerNetworkError,
  DexScreenerSchemaValidationError,
  DexScreenerTimeoutError,
} from "../errors";

const BASE_URL = "https://example.test";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

describe("fetchDexScreenerPairs", () => {
  it("returns validated pairs for a successful 200 response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(validFixture), { status: 200 });

    const result = await fetchDexScreenerPairs("robinhood", NVDA, { baseUrl: BASE_URL, fetchImpl });

    expect(result).toHaveLength(2);
  });

  it("returns an empty array for a legitimate zero-pool response (not an error)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(emptyFixture), { status: 200 });

    const result = await fetchDexScreenerPairs("robinhood", NVDA, { baseUrl: BASE_URL, fetchImpl });

    expect(result).toEqual([]);
  });

  it("requests the /token-pairs/v1/{chainId}/{tokenAddress} path", async () => {
    let requestedUrl: string | undefined;
    const fetchImpl: typeof fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify(emptyFixture), { status: 200 });
    };

    await fetchDexScreenerPairs("robinhood", NVDA, { baseUrl: BASE_URL, fetchImpl });

    expect(requestedUrl).toBe(`https://example.test/token-pairs/v1/robinhood/${NVDA}`);
  });

  it("throws DexScreenerHttpError for a non-2xx response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("Internal error", { status: 500, statusText: "Internal Server Error" });

    await expect(
      fetchDexScreenerPairs("robinhood", NVDA, { baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(DexScreenerHttpError);
  });

  it("throws DexScreenerInvalidJsonError for a non-JSON body", async () => {
    const fetchImpl: typeof fetch = async () => new Response("not json{", { status: 200 });

    await expect(
      fetchDexScreenerPairs("robinhood", NVDA, { baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(DexScreenerInvalidJsonError);
  });

  it("throws DexScreenerSchemaValidationError for a schema-invalid body", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ pairs: [] }), { status: 200 });

    await expect(
      fetchDexScreenerPairs("robinhood", NVDA, { baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(DexScreenerSchemaValidationError);
  });

  it("throws DexScreenerNetworkError when the underlying fetch fails", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(
      fetchDexScreenerPairs("robinhood", NVDA, { baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(DexScreenerNetworkError);
  });

  it("throws DexScreenerTimeoutError when the request exceeds timeoutMs", async () => {
    const neverResolves: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    await expect(
      fetchDexScreenerPairs("robinhood", NVDA, { baseUrl: BASE_URL, timeoutMs: 10, fetchImpl: neverResolves }),
    ).rejects.toThrow(DexScreenerTimeoutError);
  });
});
