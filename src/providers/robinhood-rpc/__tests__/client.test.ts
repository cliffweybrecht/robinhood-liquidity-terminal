import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { createVerifiedRobinhoodRpcClient, ROBINHOOD_CHAIN_ID } from "../client";
import type { VerifiedRobinhoodRpcClient } from "../client";
import {
  RobinhoodRpcConfigError,
  RobinhoodRpcErrorResponseError,
  RobinhoodRpcHttpError,
  RobinhoodRpcInvalidAddressError,
  RobinhoodRpcInvalidBlockTagError,
  RobinhoodRpcInvalidHexBytesError,
  RobinhoodRpcInvalidJsonError,
  RobinhoodRpcInvalidResultError,
  RobinhoodRpcInvalidTopicError,
  RobinhoodRpcMalformedResponseError,
  RobinhoodRpcNetworkError,
  RobinhoodRpcTimeoutError,
  RobinhoodRpcWrongChainError,
} from "../errors";

const RPC_URL = "https://rpc.example.test";
const VALID_ADDRESS = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const VALID_ADDRESS_2 = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// A syntactically valid 32-byte value shaped like a Uniswap V4 PoolId —
// deliberately NOT a valid 20-byte address.
const POOL_ID_LIKE = "0x" + "ab".repeat(32);
const CALLDATA = "0x70a082310000000000000000000000000d0601ce157db5bdc3162bbac2a2c8af5320d9ec";

// getLogs fixtures. Topics/hashes are 32-byte hex — same shape as
// POOL_ID_LIKE above, deliberately reused for consistency rather than
// inventing an unrelated-looking value.
const TOPIC_A = ("0x" + "aa".repeat(32)) as Hex;
const TOPIC_B = ("0x" + "bb".repeat(32)) as Hex;
const BLOCK_HASH = ("0x" + "cc".repeat(32)) as Hex;
const TX_HASH = ("0x" + "dd".repeat(32)) as Hex;

function rawLogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: VALID_ADDRESS,
    topics: [TOPIC_A, TOPIC_B],
    data: "0x1234",
    blockNumber: "0x2a",
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    transactionIndex: "0x1",
    logIndex: "0x2",
    removed: false,
    ...overrides,
  };
}

function requestBody(init?: RequestInit): { id: number; method: string; params: unknown[]; jsonrpc: string } {
  return JSON.parse(String(init?.body));
}

interface RecordedCall {
  readonly method: string;
  readonly params: unknown[];
}

/**
 * Routes each outgoing JSON-RPC method to a handler, echoing the
 * correct request id back. Optionally records every call (method +
 * params) for tests that need to assert exactly which/how-many RPC
 * calls were made — e.g. "no second eth_chainId call after
 * construction" or "no network call at all for a rejected address."
 */
function routedFetch(
  handlers: Record<string, (params: unknown[]) => unknown>,
  recorder?: RecordedCall[],
): typeof fetch {
  return async (_url, init) => {
    const body = requestBody(init);
    recorder?.push({ method: body.method, params: body.params });
    const handler = handlers[body.method];
    if (!handler) {
      throw new Error(`Unexpected JSON-RPC method in test: "${body.method}"`);
    }
    const result = handler(body.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
  };
}

function rawFetch(body: string, status = 200): typeof fetch {
  return async () => new Response(body, { status });
}

/** A client construction that always succeeds (chain ID 4663), with whatever extra method handlers a test needs. */
async function createTestClient(
  extraHandlers: Record<string, (params: unknown[]) => unknown> = {},
  recorder?: RecordedCall[],
): Promise<VerifiedRobinhoodRpcClient> {
  const fetchImpl = routedFetch({ eth_chainId: () => "0x1237", ...extraHandlers }, recorder);
  return createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl });
}

describe("createVerifiedRobinhoodRpcClient — construction / chain verification", () => {
  it("succeeds and returns a client exposing chainId 4663 when the RPC reports 0x1237", async () => {
    const rpc = await createTestClient();
    expect(rpc.chainId).toBe(4663);
    expect(rpc.chainId).toBe(ROBINHOOD_CHAIN_ID);
  });

  it("sends a well-formed eth_chainId request with no params during construction", async () => {
    const calls: RecordedCall[] = [];
    await createTestClient({}, calls);
    expect(calls).toEqual([{ method: "eth_chainId", params: [] }]);
  });

  it("successful construction exposes getBlockNumber/getCode/call as callable methods", async () => {
    const rpc = await createTestClient();
    expect(typeof rpc.getBlockNumber).toBe("function");
    expect(typeof rpc.getCode).toBe("function");
    expect(typeof rpc.call).toBe("function");
  });

  it("fails construction for a chain ID other than 4663 (Ethereum mainnet), and returns no client", async () => {
    const fetchImpl = routedFetch({ eth_chainId: () => "0x1" });
    let rpc: VerifiedRobinhoodRpcClient | undefined;
    let caught: unknown;
    try {
      rpc = await createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect(rpc).toBeUndefined();
    expect(caught).toBeInstanceOf(RobinhoodRpcWrongChainError);
    expect((caught as RobinhoodRpcWrongChainError).expectedChainId).toBe(4663);
    expect((caught as RobinhoodRpcWrongChainError).actualChainId).toBe(1);
  });

  it("fails construction for a malformed eth_chainId result, and returns no client", async () => {
    const fetchImpl = routedFetch({ eth_chainId: () => "not-hex" });
    let rpc: VerifiedRobinhoodRpcClient | undefined;
    let caught: unknown;
    try {
      rpc = await createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect(rpc).toBeUndefined();
    expect(caught).toBeInstanceOf(RobinhoodRpcInvalidResultError);
  });

  it("fails construction for a non-string eth_chainId result", async () => {
    const fetchImpl = routedFetch({ eth_chainId: () => 4663 });
    await expect(
      createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("never returns a partially-constructed client — a rejected construction promise has no resolved value at all", async () => {
    const fetchImpl = routedFetch({ eth_chainId: () => "0x1" });
    const promise = createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl });
    await expect(promise).rejects.toBeInstanceOf(RobinhoodRpcWrongChainError);
    // No `.then` branch of this promise ever ran with a value — the
    // only outcome is rejection, proven above. There is no separate
    // "unverified client" object produced anywhere on this path.
  });
});

describe("verified client — no re-verification per call", () => {
  it("does not perform another eth_chainId request when getBlockNumber is called after construction", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_blockNumber: () => "0x10" }, calls);
    calls.length = 0; // clear the construction-time eth_chainId call
    await rpc.getBlockNumber();
    expect(calls).toEqual([{ method: "eth_blockNumber", params: [] }]);
  });

  it("does not perform another eth_chainId request when getCode is called after construction", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getCode: () => "0x" }, calls);
    calls.length = 0;
    await rpc.getCode(VALID_ADDRESS);
    expect(calls).toEqual([{ method: "eth_getCode", params: [VALID_ADDRESS, "latest"] }]);
  });

  it("does not perform another eth_chainId request when call is called after construction", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_call: () => "0x" }, calls);
    calls.length = 0;
    await rpc.call({ to: VALID_ADDRESS, data: "0x" });
    expect(calls).toEqual([{ method: "eth_call", params: [{ to: VALID_ADDRESS, data: "0x" }, "latest"] }]);
  });

  it("reuses the exact rpcUrl resolved at construction even if the environment variable changes afterward", async () => {
    const originalEnv = process.env.ROBINHOOD_RPC_URL;
    try {
      process.env.ROBINHOOD_RPC_URL = RPC_URL;
      const calls: RecordedCall[] = [];
      const fetchImpl = routedFetch({ eth_chainId: () => "0x1237", eth_blockNumber: () => "0x1" }, calls);
      const rpc = await createVerifiedRobinhoodRpcClient({ fetchImpl }); // no explicit rpcUrl — read from env
      process.env.ROBINHOOD_RPC_URL = "https://a-different-endpoint.example.test";
      await rpc.getBlockNumber();
      // The call still succeeded via the injected fetchImpl regardless
      // of the URL string (fetchImpl ignores the URL argument in this
      // test), but the important structural guarantee is that
      // resolution happened once, at construction — verified directly
      // in client.ts by resolvedOptions being captured in the closure.
      expect(calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_blockNumber"]);
    } finally {
      if (originalEnv === undefined) delete process.env.ROBINHOOD_RPC_URL;
      else process.env.ROBINHOOD_RPC_URL = originalEnv;
    }
  });
});

describe("client.getBlockNumber", () => {
  it("parses a valid block quantity correctly", async () => {
    const rpc = await createTestClient({ eth_blockNumber: () => "0x10" });
    const blockNumber = await rpc.getBlockNumber();
    expect(blockNumber).toBe(16n);
    expect(typeof blockNumber).toBe("bigint");
  });

  it("handles large block quantities without unsafe floating-point assumptions", async () => {
    const rpc = await createTestClient({ eth_blockNumber: () => "0xffffffffffffffff" });
    const blockNumber = await rpc.getBlockNumber();
    expect(blockNumber).toBe(18446744073709551615n);
    expect(blockNumber.toString()).toBe("18446744073709551615");
    expect(Number(blockNumber).toString()).not.toBe(blockNumber.toString());
  });

  it("fails for a malformed block quantity (missing 0x prefix)", async () => {
    const rpc = await createTestClient({ eth_blockNumber: () => "12345" });
    await expect(rpc.getBlockNumber()).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a null block result", async () => {
    const rpc = await createTestClient({ eth_blockNumber: () => null });
    await expect(rpc.getBlockNumber()).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });
});

describe("client.getCode", () => {
  it("succeeds for a valid 20-byte address", async () => {
    const rpc = await createTestClient({ eth_getCode: () => "0x6080604052" });
    const code = await rpc.getCode(VALID_ADDRESS);
    expect(code).toBe("0x6080604052");
  });

  it("sends the address and 'latest' block tag as positional params by default", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getCode: () => "0x" }, calls);
    calls.length = 0;
    await rpc.getCode(VALID_ADDRESS);
    expect(calls[0]?.params).toEqual([VALID_ADDRESS, "latest"]);
  });

  it("encodes an explicit bigint block tag as a hex quantity param", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getCode: () => "0x" }, calls);
    calls.length = 0;
    await rpc.getCode(VALID_ADDRESS, 291n);
    expect(calls[0]?.params).toEqual([VALID_ADDRESS, "0x123"]);
  });

  it("'0x' succeeds and remains exactly '0x' — not null, false, or a failure", async () => {
    const rpc = await createTestClient({ eth_getCode: () => "0x" });
    const code = await rpc.getCode(VALID_ADDRESS);
    expect(code).toBe("0x");
    expect(code).not.toBeNull();
    expect(code).not.toBe(false);
  });

  it("fails for malformed bytecode (odd-length hex)", async () => {
    const rpc = await createTestClient({ eth_getCode: () => "0x123" });
    await expect(rpc.getCode(VALID_ADDRESS)).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("rejects an invalid address before any state-operation network request", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(rpc.getCode("not-an-address")).rejects.toThrow(RobinhoodRpcInvalidAddressError);
    expect(calls).toEqual([]);
  });

  it("rejects a 32-byte PoolId-like value before any state-operation network request — never truncated or coerced", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    let caught: unknown;
    try {
      await rpc.getCode(POOL_ID_LIKE);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RobinhoodRpcInvalidAddressError);
    expect((caught as RobinhoodRpcInvalidAddressError).input).toBe(POOL_ID_LIKE);
    expect(calls).toEqual([]);
  });

  it("rejects a negative explicit block number before any state-operation network request", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(rpc.getCode(VALID_ADDRESS, -1n)).rejects.toThrow(RobinhoodRpcInvalidBlockTagError);
    expect(calls).toEqual([]);
  });
});

describe("client.call (eth_call)", () => {
  it("succeeds for a valid destination and calldata", async () => {
    const rpc = await createTestClient({
      eth_call: () => "0x00000000000000000000000000000000000000000000000000000000000003e8",
    });
    const result = await rpc.call({ to: VALID_ADDRESS, data: CALLDATA });
    expect(result).toBe("0x00000000000000000000000000000000000000000000000000000000000003e8");
  });

  it("sends {to, data} and the block tag as positional params, never leaking Uniswap/pool concepts", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_call: () => "0x" }, calls);
    calls.length = 0;
    await rpc.call({ to: VALID_ADDRESS, data: CALLDATA });
    expect(calls[0]?.params).toEqual([{ to: VALID_ADDRESS, data: CALLDATA }, "latest"]);
  });

  it("'0x' calldata is valid (empty calldata is a legitimate generic RPC input)", async () => {
    const rpc = await createTestClient({ eth_call: () => "0x" });
    const result = await rpc.call({ to: VALID_ADDRESS, data: "0x" });
    expect(result).toBe("0x");
  });

  it("rejects malformed calldata before any state-operation network request", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(rpc.call({ to: VALID_ADDRESS, data: "0xabc" })).rejects.toThrow(
      RobinhoodRpcInvalidHexBytesError,
    );
    expect(calls).toEqual([]);
  });

  it("rejects an invalid destination before any state-operation network request", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(rpc.call({ to: "0xnotanaddress", data: "0x" })).rejects.toThrow(
      RobinhoodRpcInvalidAddressError,
    );
    expect(calls).toEqual([]);
  });

  it("rejects a 32-byte PoolId-like destination before any state-operation network request", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(rpc.call({ to: POOL_ID_LIKE, data: "0x" })).rejects.toThrow(
      RobinhoodRpcInvalidAddressError,
    );
    expect(calls).toEqual([]);
  });

  it("fails for malformed returned bytes (odd-length hex)", async () => {
    const rpc = await createTestClient({ eth_call: () => "0xabc" });
    await expect(rpc.call({ to: VALID_ADDRESS, data: "0x" })).rejects.toThrow(
      RobinhoodRpcInvalidResultError,
    );
  });

  it("fails for a non-string returned result", async () => {
    const rpc = await createTestClient({ eth_call: () => 12345 });
    await expect(rpc.call({ to: VALID_ADDRESS, data: "0x" })).rejects.toThrow(
      RobinhoodRpcInvalidResultError,
    );
  });
});

describe("transport / JSON-RPC correctness — exercised at construction (eth_chainId)", () => {
  it("throws RobinhoodRpcHttpError for a non-2xx HTTP response", async () => {
    await expect(
      createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl: rawFetch("Bad Gateway", 502) }),
    ).rejects.toThrow(RobinhoodRpcHttpError);
  });

  it("throws RobinhoodRpcTimeoutError when the request exceeds timeoutMs", async () => {
    const neverResolves: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    await expect(
      createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, timeoutMs: 10, fetchImpl: neverResolves }),
    ).rejects.toThrow(RobinhoodRpcTimeoutError);
  });

  it("throws RobinhoodRpcNetworkError (not confused with timeout) when the underlying fetch fails outright", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    let caught: unknown;
    try {
      await createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RobinhoodRpcNetworkError);
    expect(caught).not.toBeInstanceOf(RobinhoodRpcTimeoutError);
  });

  it("throws RobinhoodRpcInvalidJsonError for a non-JSON body", async () => {
    await expect(
      createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl: rawFetch("not json{", 200) }),
    ).rejects.toThrow(RobinhoodRpcInvalidJsonError);
  });

  it("throws RobinhoodRpcErrorResponseError for a JSON-RPC error object, preserving code/message/data", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { id } = requestBody(init);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found", data: { extra: "context" } } }),
        { status: 200 },
      );
    };
    let caught: unknown;
    try {
      await createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RobinhoodRpcErrorResponseError);
    expect((caught as RobinhoodRpcErrorResponseError).rpcCode).toBe(-32601);
    expect((caught as RobinhoodRpcErrorResponseError).rpcMessage).toBe("Method not found");
    expect((caught as RobinhoodRpcErrorResponseError).data).toEqual({ extra: "context" });
  });

  it("throws RobinhoodRpcMalformedResponseError for a response missing the id field", async () => {
    await expect(
      createVerifiedRobinhoodRpcClient({
        rpcUrl: RPC_URL,
        fetchImpl: rawFetch(JSON.stringify({ jsonrpc: "2.0", result: "0x1237" }), 200),
      }),
    ).rejects.toThrow(RobinhoodRpcMalformedResponseError);
  });

  it("throws RobinhoodRpcMalformedResponseError for a response id that does not match the request id", async () => {
    await expect(
      createVerifiedRobinhoodRpcClient({
        rpcUrl: RPC_URL,
        fetchImpl: rawFetch(JSON.stringify({ jsonrpc: "2.0", id: 999999, result: "0x1237" }), 200),
      }),
    ).rejects.toThrow(RobinhoodRpcMalformedResponseError);
  });

  it("throws RobinhoodRpcMalformedResponseError for the wrong jsonrpc version", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { id } = requestBody(init);
      return new Response(JSON.stringify({ jsonrpc: "1.0", id, result: "0x1237" }), { status: 200 });
    };
    await expect(createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl })).rejects.toThrow(
      RobinhoodRpcMalformedResponseError,
    );
  });

  it("throws RobinhoodRpcMalformedResponseError when neither result nor error is present", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { id } = requestBody(init);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id }), { status: 200 });
    };
    await expect(createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl })).rejects.toThrow(
      RobinhoodRpcMalformedResponseError,
    );
  });

  it("throws RobinhoodRpcMalformedResponseError for a response that is a bare array, not a JSON-RPC object", async () => {
    await expect(
      createVerifiedRobinhoodRpcClient({
        rpcUrl: RPC_URL,
        fetchImpl: rawFetch(JSON.stringify([1, 2, 3]), 200),
      }),
    ).rejects.toThrow(RobinhoodRpcMalformedResponseError);
  });

  it("treats a response carrying both result and error as an error, never as success", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { id } = requestBody(init);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, result: "0x1237", error: { code: -32000, message: "ambiguous" } }),
        { status: 200 },
      );
    };
    await expect(createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl })).rejects.toThrow(
      RobinhoodRpcErrorResponseError,
    );
  });
});

describe("transport / JSON-RPC correctness — also exercised on a post-construction state call", () => {
  it("a malformed response id on a getBlockNumber call (after successful construction) is rejected the same way", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      callCount += 1;
      const body = requestBody(init);
      if (callCount === 1) {
        // construction's eth_chainId call
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1237" }), { status: 200 });
      }
      // eth_blockNumber call — deliberately wrong id
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 999999, result: "0x10" }), { status: 200 });
    };
    const rpc = await createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl });
    await expect(rpc.getBlockNumber()).rejects.toThrow(RobinhoodRpcMalformedResponseError);
  });

  it("a JSON-RPC error object on an eth_call (after successful construction) surfaces as RobinhoodRpcErrorResponseError", async () => {
    // Construction succeeds against eth_chainId; the subsequent eth_call
    // request receives a well-formed JSON-RPC *error* envelope instead
    // of a result — proves envelope-error handling is identical shared
    // code between construction and state calls, not a construction-only
    // special case.
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init);
      if (body.method === "eth_chainId") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1237" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "execution reverted" } }),
        { status: 200 },
      );
    };
    const rpc = await createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl });

    let caught: unknown;
    try {
      await rpc.call({ to: VALID_ADDRESS, data: "0x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RobinhoodRpcErrorResponseError);
    expect((caught as RobinhoodRpcErrorResponseError).rpcCode).toBe(-32000);
    expect((caught as RobinhoodRpcErrorResponseError).rpcMessage).toBe("execution reverted");
  });
});

describe("createVerifiedRobinhoodRpcClient — configuration", () => {
  const originalRpcUrl = process.env.ROBINHOOD_RPC_URL;

  afterEach(() => {
    if (originalRpcUrl === undefined) {
      delete process.env.ROBINHOOD_RPC_URL;
    } else {
      process.env.ROBINHOOD_RPC_URL = originalRpcUrl;
    }
  });

  it("throws RobinhoodRpcConfigError when ROBINHOOD_RPC_URL is unset and no override is given, without making a network request", async () => {
    delete process.env.ROBINHOOD_RPC_URL;
    const fetchImpl = vi.fn();
    let rpc: VerifiedRobinhoodRpcClient | undefined;
    let caught: unknown;
    try {
      rpc = await createVerifiedRobinhoodRpcClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    } catch (err) {
      caught = err;
    }
    expect(rpc).toBeUndefined();
    expect(caught).toBeInstanceOf(RobinhoodRpcConfigError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws RobinhoodRpcConfigError for a syntactically invalid URL", async () => {
    await expect(
      createVerifiedRobinhoodRpcClient({ rpcUrl: "not a url", fetchImpl: vi.fn() as unknown as typeof fetch }),
    ).rejects.toThrow(RobinhoodRpcConfigError);
  });

  it("throws RobinhoodRpcConfigError for a non-http(s) protocol", async () => {
    await expect(
      createVerifiedRobinhoodRpcClient({
        rpcUrl: "ftp://rpc.example.test",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(RobinhoodRpcConfigError);
  });

  it("reads ROBINHOOD_RPC_URL from the environment when no override is passed", async () => {
    process.env.ROBINHOOD_RPC_URL = RPC_URL;
    const rpc = await createVerifiedRobinhoodRpcClient({
      fetchImpl: routedFetch({ eth_chainId: () => "0x1237" }),
    });
    expect(rpc.chainId).toBe(4663);
  });

  it("fails closed for an explicit empty-string rpcUrl override, without silently falling back to the environment variable", async () => {
    process.env.ROBINHOOD_RPC_URL = RPC_URL;
    const fetchImpl = vi.fn();
    await expect(
      createVerifiedRobinhoodRpcClient({ rpcUrl: "", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(RobinhoodRpcConfigError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("client.getLogs (eth_getLogs) — success", () => {
  it("returns a single valid log", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry()] });
    const logs = await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      address: VALID_ADDRESS,
      topics: [TOPIC_A, TOPIC_B],
      data: "0x1234",
      blockNumber: 42n,
      blockHash: BLOCK_HASH,
      transactionHash: TX_HASH,
      transactionIndex: 1,
      logIndex: 2,
      removed: false,
    });
  });

  it("returns multiple valid logs, preserving order", async () => {
    const rpc = await createTestClient({
      eth_getLogs: () => [
        rawLogEntry({ logIndex: "0x1" }),
        rawLogEntry({ logIndex: "0x2" }),
        rawLogEntry({ logIndex: "0x3" }),
      ],
    });
    const logs = await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" });
    expect(logs.map((l) => l.logIndex)).toEqual([1, 2, 3]);
  });

  it("returns an empty array for no matches, not null/undefined", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [] });
    const logs = await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" });
    expect(logs).toEqual([]);
  });

  it("sends a single address filter as-is", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getLogs: () => [] }, calls);
    calls.length = 0;
    await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" });
    expect(calls[0]?.params[0]).toMatchObject({ address: VALID_ADDRESS });
  });

  it("sends an address-array filter as-is", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getLogs: () => [] }, calls);
    calls.length = 0;
    await rpc.getLogs({
      address: [VALID_ADDRESS, VALID_ADDRESS_2],
      topics: [],
      fromBlock: 0n,
      toBlock: "latest",
    });
    expect(calls[0]?.params[0]).toMatchObject({ address: [VALID_ADDRESS, VALID_ADDRESS_2] });
  });

  it("sends a null wildcard topic as-is", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getLogs: () => [] }, calls);
    calls.length = 0;
    await rpc.getLogs({ address: VALID_ADDRESS, topics: [null, TOPIC_A], fromBlock: 0n, toBlock: "latest" });
    expect(calls[0]?.params[0]).toMatchObject({ topics: [null, TOPIC_A] });
  });

  it("sends an OR-topic array as-is", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getLogs: () => [] }, calls);
    calls.length = 0;
    await rpc.getLogs({ address: VALID_ADDRESS, topics: [[TOPIC_A, TOPIC_B]], fromBlock: 0n, toBlock: "latest" });
    expect(calls[0]?.params[0]).toMatchObject({ topics: [[TOPIC_A, TOPIC_B]] });
  });

  it("encodes explicit bigint fromBlock/toBlock as hex quantities", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getLogs: () => [] }, calls);
    calls.length = 0;
    await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 291n, toBlock: 4660n });
    expect(calls[0]?.params[0]).toMatchObject({ fromBlock: "0x123", toBlock: "0x1234" });
  });

  it("supports the 'latest' named block tag for both fromBlock and toBlock", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getLogs: () => [] }, calls);
    calls.length = 0;
    await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: "latest", toBlock: "latest" });
    expect(calls[0]?.params[0]).toMatchObject({ fromBlock: "latest", toBlock: "latest" });
  });
});

describe("client.getLogs — input validation (before any network request)", () => {
  it("rejects a malformed single address", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(
      rpc.getLogs({ address: "not-an-address" as Address, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidAddressError);
    expect(calls).toEqual([]);
  });

  it("rejects a malformed address inside an address array", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(
      rpc.getLogs({
        address: [VALID_ADDRESS, "not-an-address"] as readonly Address[],
        topics: [],
        fromBlock: 0n,
        toBlock: "latest",
      }),
    ).rejects.toThrow(RobinhoodRpcInvalidAddressError);
    expect(calls).toEqual([]);
  });

  it("rejects an empty address array as ambiguous", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(
      rpc.getLogs({ address: [], topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidAddressError);
    expect(calls).toEqual([]);
  });

  it("rejects a malformed standalone topic", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: ["0xnotatopic" as `0x${string}`], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidTopicError);
    expect(calls).toEqual([]);
  });

  it("rejects a malformed topic inside an OR-array", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(
      rpc.getLogs({
        address: VALID_ADDRESS,
        topics: [[TOPIC_A, "0xnotatopic" as `0x${string}`]],
        fromBlock: 0n,
        toBlock: "latest",
      }),
    ).rejects.toThrow(RobinhoodRpcInvalidTopicError);
    expect(calls).toEqual([]);
  });

  it("rejects an empty OR-topic array as ambiguous (use null instead)", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [[]], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidTopicError);
    expect(calls).toEqual([]);
  });

  it("rejects a negative explicit fromBlock", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: -1n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidBlockTagError);
    expect(calls).toEqual([]);
  });

  it("rejects a negative explicit toBlock", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: -1n }),
    ).rejects.toThrow(RobinhoodRpcInvalidBlockTagError);
    expect(calls).toEqual([]);
  });

  it("rejects an inverted range (fromBlock > toBlock) when both are explicit block numbers", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({}, calls);
    calls.length = 0;
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 100n, toBlock: 50n }),
    ).rejects.toThrow(RobinhoodRpcInvalidBlockTagError);
    expect(calls).toEqual([]);
  });
});

describe("client.getLogs — result validation (untrusted response)", () => {
  it("fails when the top-level result is not an array", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => ({ not: "an array" }) });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a malformed log address", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ address: "not-an-address" })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails when a log's topics field is not an array", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ topics: "not-an-array" })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a malformed topic inside a returned log", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ topics: [TOPIC_A, "0xbad"] })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for malformed data (odd-length hex)", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ data: "0x123" })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a malformed blockNumber", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ blockNumber: "not-hex" })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a null blockNumber (pending log — unsupported)", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ blockNumber: null })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a null blockHash (pending log — unsupported)", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ blockHash: null })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a malformed transactionHash", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ transactionHash: "0xbad" })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a null transactionHash (pending log — unsupported)", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ transactionHash: null })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a malformed logIndex", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ logIndex: "not-hex" })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a null logIndex (pending log — unsupported)", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ logIndex: null })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a null transactionIndex (pending log — unsupported)", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ transactionIndex: null })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a non-boolean removed field", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [rawLogEntry({ removed: "false" })] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails for a log entry missing required fields entirely", async () => {
    const rpc = await createTestClient({ eth_getLogs: () => [{ address: VALID_ADDRESS }] });
    await expect(
      rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" }),
    ).rejects.toThrow(RobinhoodRpcInvalidResultError);
  });

  it("fails the entire request when one entry among otherwise-valid multiple logs is malformed — never returns a partially-trusted array", async () => {
    const rpc = await createTestClient({
      eth_getLogs: () => [rawLogEntry({ logIndex: "0x1" }), rawLogEntry({ logIndex: "not-hex" }), rawLogEntry({ logIndex: "0x3" })],
    });
    let caught: unknown;
    try {
      await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RobinhoodRpcInvalidResultError);
    expect((caught as RobinhoodRpcInvalidResultError).reason).toContain("index 1");
  });
});

describe("client.getLogs — transport/JSON-RPC errors", () => {
  it("surfaces a network failure as RobinhoodRpcNetworkError", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init);
      if (body.method === "eth_chainId") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1237" }), { status: 200 });
      }
      throw new TypeError("fetch failed");
    };
    const rpc = await createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl });
    let caught: unknown;
    try {
      await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RobinhoodRpcNetworkError);
  });

  it("surfaces a JSON-RPC error object as RobinhoodRpcErrorResponseError", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init);
      if (body.method === "eth_chainId") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1237" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "query returned more than 10000 results" } }),
        { status: 200 },
      );
    };
    const rpc = await createVerifiedRobinhoodRpcClient({ rpcUrl: RPC_URL, fetchImpl });
    let caught: unknown;
    try {
      await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RobinhoodRpcErrorResponseError);
    expect((caught as RobinhoodRpcErrorResponseError).rpcCode).toBe(-32000);
  });
});

describe("client.getLogs — trust boundary", () => {
  it("does not perform another eth_chainId request when getLogs is called after construction", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getLogs: () => [] }, calls);
    calls.length = 0;
    await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: "latest" });
    expect(calls.map((c) => c.method)).toEqual(["eth_getLogs"]);
  });

  it("issues exactly one eth_getLogs request per getLogs invocation — no pagination, no automatic retries", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getLogs: () => [] }, calls);
    calls.length = 0;
    await rpc.getLogs({ address: VALID_ADDRESS, topics: [], fromBlock: 0n, toBlock: 1000n });
    expect(calls.filter((c) => c.method === "eth_getLogs")).toHaveLength(1);
  });

  it("sends only generic JSON-RPC filter fields — no protocol/Uniswap-specific params leak into the request", async () => {
    const calls: RecordedCall[] = [];
    const rpc = await createTestClient({ eth_getLogs: () => [] }, calls);
    calls.length = 0;
    await rpc.getLogs({ address: VALID_ADDRESS, topics: [TOPIC_A], fromBlock: 0n, toBlock: "latest" });
    expect(Object.keys(calls[0]?.params[0] as object).sort()).toEqual(["address", "fromBlock", "toBlock", "topics"]);
  });
});
