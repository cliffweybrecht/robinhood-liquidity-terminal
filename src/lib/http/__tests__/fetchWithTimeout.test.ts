import { describe, expect, it } from "vitest";
import {
  fetchWithTimeout,
  HttpNetworkError,
  HttpTimeoutError,
} from "../fetchWithTimeout";

describe("fetchWithTimeout", () => {
  it("resolves normally when the underlying fetch resolves before the timeout", async () => {
    const fetchImpl = async () => new Response("ok", { status: 200 });

    const response = await fetchWithTimeout("https://example.test/x", {
      timeoutMs: 1000,
      fetchImpl,
    });

    expect(response.status).toBe(200);
  });

  it("throws HttpTimeoutError when the request does not settle within timeoutMs", async () => {
    const neverResolves: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    await expect(
      fetchWithTimeout("https://example.test/hangs", {
        timeoutMs: 10,
        fetchImpl: neverResolves,
      }),
    ).rejects.toBeInstanceOf(HttpTimeoutError);
  });

  it("throws HttpNetworkError for a non-abort failure", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(
      fetchWithTimeout("https://example.test/down", {
        timeoutMs: 1000,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(HttpNetworkError);
  });
});
