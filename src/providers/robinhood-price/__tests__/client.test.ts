import { describe, expect, it } from "vitest";
import validFixture from "@/test/fixtures/robinhood-prices-valid.json";
import { fetchAllRobinhoodPrices, fetchRobinhoodPriceForSymbol } from "../client";
import {
  RobinhoodPriceHttpError,
  RobinhoodPriceInvalidJsonError,
  RobinhoodPriceNetworkError,
  RobinhoodPriceSchemaValidationError,
  RobinhoodPriceTimeoutError,
} from "../errors";

const BASE_URL = "https://example.test";

describe("fetchRobinhoodPriceForSymbol", () => {
  it("returns validated quotes for a successful response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(validFixture), { status: 200 });

    const result = await fetchRobinhoodPriceForSymbol("NVDA", { baseUrl: BASE_URL, fetchImpl });

    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]?.tokenSymbol).toBe("NVDA");
  });

  it("requests the /rhj/prices/{symbol} path", async () => {
    let requestedUrl: string | undefined;
    const fetchImpl: typeof fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify(validFixture), { status: 200 });
    };

    await fetchRobinhoodPriceForSymbol("NVDA", { baseUrl: BASE_URL, fetchImpl });

    expect(requestedUrl).toBe("https://example.test/rhj/prices/NVDA");
  });

  it("throws RobinhoodPriceHttpError for an unknown symbol (404)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 5, message: 'no whitelisted asset with symbol "X"', details: [] }), {
        status: 404,
        statusText: "Not Found",
      });

    await expect(
      fetchRobinhoodPriceForSymbol("X", { baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(RobinhoodPriceHttpError);
  });

  it("throws RobinhoodPriceInvalidJsonError for a non-JSON body", async () => {
    const fetchImpl: typeof fetch = async () => new Response("not json{", { status: 200 });

    await expect(
      fetchRobinhoodPriceForSymbol("NVDA", { baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(RobinhoodPriceInvalidJsonError);
  });

  it("throws RobinhoodPriceSchemaValidationError for a schema-invalid body", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ notQuotes: [] }), { status: 200 });

    await expect(
      fetchRobinhoodPriceForSymbol("NVDA", { baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(RobinhoodPriceSchemaValidationError);
  });

  it("throws RobinhoodPriceNetworkError when the underlying fetch fails", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(
      fetchRobinhoodPriceForSymbol("NVDA", { baseUrl: BASE_URL, fetchImpl }),
    ).rejects.toThrow(RobinhoodPriceNetworkError);
  });

  it("throws RobinhoodPriceTimeoutError when the request exceeds timeoutMs", async () => {
    const neverResolves: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    await expect(
      fetchRobinhoodPriceForSymbol("NVDA", { baseUrl: BASE_URL, timeoutMs: 10, fetchImpl: neverResolves }),
    ).rejects.toThrow(RobinhoodPriceTimeoutError);
  });
});

describe("fetchAllRobinhoodPrices", () => {
  it("requests the bare /rhj/prices path (no symbol suffix)", async () => {
    let requestedUrl: string | undefined;
    const fetchImpl: typeof fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify(validFixture), { status: 200 });
    };

    await fetchAllRobinhoodPrices({ baseUrl: BASE_URL, fetchImpl });

    expect(requestedUrl).toBe("https://example.test/rhj/prices");
  });

  it("returns multiple quotes when the provider returns multiple", async () => {
    const multiQuoteFixture = {
      quotes: [validFixture.quotes[0], { ...validFixture.quotes[0], tokenSymbol: "AAPL" }],
    };
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(multiQuoteFixture), { status: 200 });

    const result = await fetchAllRobinhoodPrices({ baseUrl: BASE_URL, fetchImpl });

    expect(result.quotes.map((q) => q.tokenSymbol)).toEqual(["NVDA", "AAPL"]);
  });
});
