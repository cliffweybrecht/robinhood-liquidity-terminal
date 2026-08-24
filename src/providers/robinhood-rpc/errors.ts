/**
 * Typed failure modes for the Robinhood Chain JSON-RPC provider boundary.
 * Each represents a distinct, intentional failure category — callers
 * branch on these rather than on message strings, and none of them are
 * ever silently swallowed into a fabricated result. Mirrors the error
 * hierarchy shape used by every other provider in this codebase
 * (`src/providers/robinhood`, `src/providers/dexscreener`,
 * `src/providers/robinhood-price`).
 *
 * Distinct from every other provider's error set: this one also
 * distinguishes *caller-input* validation failures (`INVALID_ADDRESS`,
 * `INVALID_HEX_BYTES`, `INVALID_BLOCK_TAG`) — these happen before any
 * network request is made, not as a response-parsing failure. See
 * `client.ts` for where each check runs.
 */
export type RobinhoodRpcErrorCode =
  | "CONFIG_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "MALFORMED_RESPONSE"
  | "RPC_ERROR_RESPONSE"
  | "INVALID_RESULT"
  | "INVALID_ADDRESS"
  | "INVALID_HEX_BYTES"
  | "INVALID_BLOCK_TAG"
  | "WRONG_CHAIN";

export abstract class RobinhoodRpcError extends Error {
  abstract readonly code: RobinhoodRpcErrorCode;
}

/** Required RPC configuration (`ROBINHOOD_RPC_URL`) is absent, empty, or not a valid http(s) URL. There is no default — see `client.ts`'s `resolveRpcUrl`. */
export class RobinhoodRpcConfigError extends RobinhoodRpcError {
  readonly code = "CONFIG_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "RobinhoodRpcConfigError";
  }
}

export class RobinhoodRpcNetworkError extends RobinhoodRpcError {
  readonly code = "NETWORK_ERROR" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RobinhoodRpcNetworkError";
  }
}

export class RobinhoodRpcTimeoutError extends RobinhoodRpcError {
  readonly code = "TIMEOUT" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RobinhoodRpcTimeoutError";
  }
}

export class RobinhoodRpcHttpError extends RobinhoodRpcError {
  readonly code = "HTTP_ERROR" as const;
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string) {
    super(`Robinhood Chain RPC responded with HTTP ${status} ${statusText}`);
    this.name = "RobinhoodRpcHttpError";
    this.status = status;
    this.statusText = statusText;
  }
}

export class RobinhoodRpcInvalidJsonError extends RobinhoodRpcError {
  readonly code = "INVALID_JSON" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RobinhoodRpcInvalidJsonError";
  }
}

/**
 * The response body was valid JSON but is not shaped like a JSON-RPC
 * 2.0 response for the specific request that was sent — wrong/missing
 * `jsonrpc` version, missing response `id`, a response `id` that
 * doesn't match the request's `id`, or a body with neither `result` nor
 * `error` present. A `200 OK` HTTP status is never treated as evidence
 * that the JSON-RPC operation itself succeeded — this is the check that
 * enforces that distinction.
 */
export class RobinhoodRpcMalformedResponseError extends RobinhoodRpcError {
  readonly code = "MALFORMED_RESPONSE" as const;
  readonly method: string;
  readonly reason: string;

  constructor(method: string, reason: string) {
    super(`Malformed JSON-RPC response to "${method}": ${reason}`);
    this.name = "RobinhoodRpcMalformedResponseError";
    this.method = method;
    this.reason = reason;
  }
}

/** The response was a well-formed JSON-RPC envelope carrying an `error` object — the RPC node itself rejected the request. */
export class RobinhoodRpcErrorResponseError extends RobinhoodRpcError {
  readonly code = "RPC_ERROR_RESPONSE" as const;
  readonly method: string;
  readonly rpcCode: number;
  readonly rpcMessage: string;
  readonly data: unknown;

  constructor(method: string, rpcCode: number, rpcMessage: string, data?: unknown) {
    super(`Robinhood Chain RPC returned an error for "${method}": [${rpcCode}] ${rpcMessage}`);
    this.name = "RobinhoodRpcErrorResponseError";
    this.method = method;
    this.rpcCode = rpcCode;
    this.rpcMessage = rpcMessage;
    this.data = data;
  }
}

/** The envelope was well-formed and carried a `result`, but that result's shape doesn't match what the calling operation expects (e.g. not valid hex quantity/bytes). */
export class RobinhoodRpcInvalidResultError extends RobinhoodRpcError {
  readonly code = "INVALID_RESULT" as const;
  readonly method: string;
  readonly rawResult: unknown;
  readonly reason: string;

  constructor(method: string, rawResult: unknown, reason: string) {
    super(`Invalid result for "${method}": ${reason}`);
    this.name = "RobinhoodRpcInvalidResultError";
    this.method = method;
    this.rawResult = rawResult;
    this.reason = reason;
  }
}

/**
 * Caller-supplied address input is not a valid 20-byte EVM address.
 * Checked before any network request. Critically, this is also what
 * rejects a 32-byte Uniswap V4 PoolId passed where an address is
 * required — a PoolId is not truncated, coerced, or reinterpreted; it
 * simply fails this check like any other malformed address.
 */
export class RobinhoodRpcInvalidAddressError extends RobinhoodRpcError {
  readonly code = "INVALID_ADDRESS" as const;
  readonly input: string;

  constructor(input: string) {
    super(`"${input}" is not a valid 20-byte EVM address`);
    this.name = "RobinhoodRpcInvalidAddressError";
    this.input = input;
  }
}

/** Caller-supplied calldata/bytecode is not valid 0x-prefixed, even-length hex. Checked before any network request. */
export class RobinhoodRpcInvalidHexBytesError extends RobinhoodRpcError {
  readonly code = "INVALID_HEX_BYTES" as const;
  readonly input: string;

  constructor(input: string) {
    super(`"${input}" is not valid 0x-prefixed hex bytes`);
    this.name = "RobinhoodRpcInvalidHexBytesError";
    this.input = input;
  }
}

/** Caller-supplied block tag is neither `"latest"` nor a non-negative bigint block number. Checked before any network request. */
export class RobinhoodRpcInvalidBlockTagError extends RobinhoodRpcError {
  readonly code = "INVALID_BLOCK_TAG" as const;
  readonly input: string;

  constructor(input: string) {
    super(`"${input}" is not a valid block tag ("latest" or a non-negative bigint block number)`);
    this.name = "RobinhoodRpcInvalidBlockTagError";
    this.input = input;
  }
}

/**
 * `createVerifiedRobinhoodRpcClient` confirmed the RPC transport works
 * (valid JSON-RPC responses) but the reported `eth_chainId` is not
 * Robinhood Chain's `4663`. The configured `ROBINHOOD_RPC_URL` is
 * reachable and speaking JSON-RPC correctly, but it is not Robinhood
 * Chain — e.g. it could be Ethereum mainnet, a different L2, or a
 * misconfigured endpoint. Fails closed: construction throws rather than
 * returning a client, so the chain is never silently treated as
 * verified.
 */
export class RobinhoodRpcWrongChainError extends RobinhoodRpcError {
  readonly code = "WRONG_CHAIN" as const;
  readonly expectedChainId: number;
  readonly actualChainId: number;

  constructor(expectedChainId: number, actualChainId: number) {
    super(
      `Robinhood Chain RPC connection verification failed: expected chain ID ${expectedChainId}, got ${actualChainId}. The configured ROBINHOOD_RPC_URL does not point at Robinhood Chain.`,
    );
    this.name = "RobinhoodRpcWrongChainError";
    this.expectedChainId = expectedChainId;
    this.actualChainId = actualChainId;
  }
}
