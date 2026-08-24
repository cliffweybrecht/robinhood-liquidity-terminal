import type { Hex } from "viem";
import {
  fetchWithTimeout,
  HttpNetworkError,
  HttpTimeoutError,
} from "@/lib/http/fetchWithTimeout";
import { isValidEvmAddress } from "@/lib/evm/address";
import { hexQuantityToBigInt, isHexBytes, isHexQuantity } from "@/lib/evm/hex";
import { jsonRpcEnvelopeSchema } from "./schema";
import {
  RobinhoodRpcConfigError,
  RobinhoodRpcErrorResponseError,
  RobinhoodRpcHttpError,
  RobinhoodRpcInvalidAddressError,
  RobinhoodRpcInvalidBlockTagError,
  RobinhoodRpcInvalidHexBytesError,
  RobinhoodRpcInvalidJsonError,
  RobinhoodRpcInvalidResultError,
  RobinhoodRpcMalformedResponseError,
  RobinhoodRpcNetworkError,
  RobinhoodRpcTimeoutError,
  RobinhoodRpcWrongChainError,
} from "./errors";

/**
 * Phase 6A — Robinhood Chain RPC foundation.
 *
 * This module is a **generic JSON-RPC provider boundary**, structurally
 * identical in spirit to `src/providers/robinhood`/`dexscreener`/
 * `robinhood-price`: it knows how to talk to one specific network
 * endpoint correctly and fails closed on anything unexpected. It does
 * NOT know about Dexscreener, liquidity pools, PoolIds, Uniswap V2/V3/V4,
 * token decimals, or executable quoting — that protocol-specific layer
 * is explicitly future work (see README "Phase 6" for the planned trust
 * chain). Keeping this boundary generic is deliberate: every later
 * Phase 6 service (protocol census, pool-state reads, executable quotes)
 * should be able to depend on this module without it knowing anything
 * about what it's being used for.
 *
 * ---
 *
 * ## Trust boundary — read this before using this module elsewhere
 *
 * Three distinct claims exist, and this module only proves the first
 * two:
 *
 *  1. **RPC transport success** — the HTTP request succeeded and the
 *     response body is a well-formed JSON-RPC 2.0 message for the exact
 *     request that was sent (matching id, `jsonrpc: "2.0"`, a `result`
 *     or a well-formed `error`). Proved by every state-reading operation
 *     — a `200 OK` HTTP status is never treated as sufficient evidence
 *     of this on its own.
 *  2. **Robinhood Chain verification** — the RPC endpoint reports chain
 *     ID `4663`. Proved *structurally*, not by convention: the only way
 *     to obtain a `VerifiedRobinhoodRpcClient` at all is through
 *     `createVerifiedRobinhoodRpcClient`, and construction fails closed
 *     unless the endpoint reports `4663`. There is no exported function
 *     that performs a state-reading operation (`getBlockNumber`/
 *     `getCode`/`call`) without first going through that factory — the
 *     unverified primitives are private to this module (see "Hardening
 *     pass" below for why this changed from the original Phase 6A
 *     design).
 *  3. **Pool identity verification** — that some on-chain address/PoolId
 *     is genuinely the pool Dexscreener claims it is, for the protocol
 *     Dexscreener claims it uses. **Not proved by anything in this
 *     module or in this phase.** This is deliberately out of scope for
 *     Phase 6A — see the README's Phase 6 trust-chain diagram.
 *
 * ## Hardening pass — verification is now structural, not a caller convention
 *
 * The original Phase 6A design exported `getChainId`/`getBlockNumber`/
 * `getCode`/`call`/`verifyRobinhoodChainConnection` as five independent
 * public functions, documented as "call `verifyRobinhoodChainConnection`
 * once before trusting the others." Independent review correctly
 * identified this as too weak for infrastructure that later on-chain
 * pool identity and executable-quoting work will build on: nothing
 * structurally prevented calling `getBlockNumber`/`getCode`/`call`
 * directly against an unverified endpoint — the API *documented* the
 * right order but did not *enforce* it.
 *
 * The fix: `getChainId`, `getBlockNumber`, `getCode`, and `call` are now
 * module-private. The only way to reach any state-reading operation is
 * through the object returned by `createVerifiedRobinhoodRpcClient`,
 * which resolves configuration, calls `eth_chainId`, and verifies
 * `4663` *before* that object exists. Successful construction of a
 * `VerifiedRobinhoodRpcClient` is now itself the proof that the
 * connection was verified — there is no code path that can produce a
 * usable client without having proven the chain ID first, and no
 * exported function whose name could be mistaken for an already-verified
 * operation when it isn't one.
 *
 * `getBlockNumber`/`getCode`/`call` still never re-verify chain identity
 * internally, and the client's methods don't either — re-checking
 * `eth_chainId` before every individual state-reading call would double
 * the request count for a fact that doesn't change between calls on the
 * same configured endpoint. Verification happens exactly once, at
 * construction, and the resolved `rpcUrl`/`timeoutMs` are captured at
 * that point and reused for every subsequent call on that client — so a
 * client's calls are guaranteed to target the exact endpoint that was
 * verified, even if `process.env.ROBINHOOD_RPC_URL` were somehow
 * mutated afterward.
 */

export const ROBINHOOD_CHAIN_ID = 4663;

const DEFAULT_TIMEOUT_MS = 8000;

export interface RobinhoodRpcOptions {
  /** Overrides `ROBINHOOD_RPC_URL`. No default is used — required configuration, see `resolveRpcUrl`. */
  rpcUrl?: string;
  /** Overrides `ROBINHOOD_RPC_TIMEOUT_MS` / the built-in default (8000ms). */
  timeoutMs?: number;
  /** Injectable fetch implementation, primarily for deterministic tests. */
  fetchImpl?: typeof fetch;
}

/**
 * A block reference for state-reading calls (`eth_getCode`/`eth_call`).
 * Deliberately minimal: `"latest"`, or an explicit block number as a
 * `bigint` (never a floating-point `number` — see `hexQuantityToBigInt`).
 * This is enough for future Phase 6 work to pin multiple related reads
 * to the same block for a consistent snapshot, without committing to
 * every Ethereum block-tag variant (`"earliest"`, `"pending"`,
 * `"safe"`, `"finalized"`) this codebase has no present use for.
 */
export type BlockTag = "latest" | bigint;

export interface EthCallRequest {
  readonly to: string;
  readonly data: string;
}

/**
 * A Robinhood Chain RPC connection whose chain identity has already
 * been verified as `4663` at construction time — see
 * `createVerifiedRobinhoodRpcClient`. `chainId` is included as a
 * lightweight, inspectable proof of what was verified (always `4663`
 * for any successfully-constructed client, but present so callers/tests
 * don't have to hardcode that assumption).
 *
 * These three methods are the *only* way this module exposes
 * `eth_getCode`/`eth_call`/`eth_blockNumber` — there is no standalone
 * exported function for any of them.
 */
export interface VerifiedRobinhoodRpcClient {
  readonly chainId: number;
  getBlockNumber(): Promise<bigint>;
  getCode(address: string, blockTag?: BlockTag): Promise<Hex>;
  call(request: EthCallRequest, blockTag?: BlockTag): Promise<Hex>;
}

/**
 * No default is used for `ROBINHOOD_RPC_URL` — unlike every other
 * provider's `baseUrl` (which has a real public default), there is no
 * value that would be safe to silently fall back to here: guessing
 * wrong means talking to the wrong chain entirely, which is exactly
 * what this module exists to prevent. Absent, empty, or non-http(s)
 * configuration fails immediately and explicitly.
 */
function resolveRpcUrl(options: RobinhoodRpcOptions): string {
  const raw = options.rpcUrl ?? process.env.ROBINHOOD_RPC_URL;
  if (raw === undefined || raw.trim() === "") {
    throw new RobinhoodRpcConfigError(
      "ROBINHOOD_RPC_URL must be set — there is no default Robinhood Chain RPC endpoint. Set it in the environment or pass { rpcUrl } explicitly.",
    );
  }

  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RobinhoodRpcConfigError(`ROBINHOOD_RPC_URL is not a valid URL: "${trimmed}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RobinhoodRpcConfigError(`ROBINHOOD_RPC_URL must use http or https: "${trimmed}"`);
  }

  return trimmed;
}

function resolveTimeoutMs(options: RobinhoodRpcOptions): number {
  if (options.timeoutMs !== undefined) return options.timeoutMs;
  const fromEnv = Number(process.env.ROBINHOOD_RPC_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

/**
 * Monotonic per-process JSON-RPC request id. Deliberately left as a
 * plain incrementing counter with no rollover handling: reaching
 * `Number.MAX_SAFE_INTEGER` (~9.007 * 10^15) would require that many
 * RPC calls within one process lifetime, which is not a realistic
 * scenario for this application (or, practically, any application) —
 * and a rollover branch here could not be meaningfully exercised by a
 * test without either mutating private module state from outside (which
 * would defeat the point of it being private) or actually looping
 * billions of times, so adding one would introduce untested code for a
 * threat that isn't real at this scale. See README "Phase 6A" for the
 * same note in the public-facing docs.
 */
let requestIdCounter = 0;
function nextRequestId(): number {
  requestIdCounter += 1;
  return requestIdCounter;
}

/**
 * The generic JSON-RPC transport: sends one `{jsonrpc, id, method,
 * params}` request and returns the validated `result` payload, or
 * throws a typed error for every way this can fail. This is the single
 * place that enforces "HTTP 200 is not sufficient evidence of RPC
 * success" — every operation in this module goes through it.
 *
 * Validation order, each step fatal on its own typed error:
 *  1. transport (timeout / network failure / non-2xx HTTP)
 *  2. response body is valid JSON
 *  3. response body is shaped like a JSON-RPC envelope (via `zod`)
 *  4. `jsonrpc` is exactly `"2.0"`
 *  5. response has an `id`, and it matches the request's `id`
 *  6. exactly one of `error`/`result` is meaningfully present — `error`
 *     wins if (implausibly) both are, since a server-reported error
 *     should never be treated as a successful call
 */
async function callRpc(
  method: string,
  params: unknown[],
  options: RobinhoodRpcOptions,
): Promise<unknown> {
  const rpcUrl = resolveRpcUrl(options);
  const timeoutMs = resolveTimeoutMs(options);
  const id = nextRequestId();

  let response: Response;
  try {
    response = await fetchWithTimeout(rpcUrl, {
      timeoutMs,
      fetchImpl: options.fetchImpl,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
  } catch (err) {
    if (err instanceof HttpTimeoutError) {
      throw new RobinhoodRpcTimeoutError(
        `Timed out calling "${method}" after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    if (err instanceof HttpNetworkError) {
      throw new RobinhoodRpcNetworkError(`Network error calling "${method}"`, { cause: err });
    }
    throw err;
  }

  if (!response.ok) {
    throw new RobinhoodRpcHttpError(response.status, response.statusText);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new RobinhoodRpcInvalidJsonError(
      `Response to "${method}" was not valid JSON`,
      { cause: err },
    );
  }

  const parsed = jsonRpcEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new RobinhoodRpcMalformedResponseError(
      method,
      "response body is not shaped like a JSON-RPC 2.0 message",
    );
  }
  const envelope = parsed.data;

  if (envelope.jsonrpc !== "2.0") {
    throw new RobinhoodRpcMalformedResponseError(
      method,
      `unexpected "jsonrpc" version ${JSON.stringify(envelope.jsonrpc)}`,
    );
  }
  if (envelope.id === undefined || envelope.id === null) {
    throw new RobinhoodRpcMalformedResponseError(method, "response is missing an \"id\"");
  }
  if (envelope.id !== id) {
    throw new RobinhoodRpcMalformedResponseError(
      method,
      `response id ${JSON.stringify(envelope.id)} does not match request id ${id}`,
    );
  }

  if (envelope.error !== undefined) {
    throw new RobinhoodRpcErrorResponseError(
      method,
      envelope.error.code,
      envelope.error.message,
      envelope.error.data,
    );
  }
  if (envelope.result === undefined) {
    throw new RobinhoodRpcMalformedResponseError(
      method,
      "response has neither a \"result\" nor an \"error\"",
    );
  }

  return envelope.result;
}

function encodeBlockTagParam(blockTag: BlockTag): string {
  if (blockTag === "latest") return "latest";
  if (typeof blockTag === "bigint") {
    if (blockTag < 0n) {
      throw new RobinhoodRpcInvalidBlockTagError(blockTag.toString());
    }
    return `0x${blockTag.toString(16)}`;
  }
  throw new RobinhoodRpcInvalidBlockTagError(String(blockTag));
}

/**
 * `eth_chainId`. Module-private — see the "Hardening pass" doc comment
 * above. Its only caller is `createVerifiedRobinhoodRpcClient`. Returns
 * a validated `number` — chain IDs are always small, well within
 * `Number.MAX_SAFE_INTEGER`, so a `bigint` return type would add
 * friction with no precision benefit here (unlike block numbers, where
 * a `bigint` return type is load-bearing).
 */
async function getChainId(options: RobinhoodRpcOptions): Promise<number> {
  const result = await callRpc("eth_chainId", [], options);
  if (typeof result !== "string" || !isHexQuantity(result)) {
    throw new RobinhoodRpcInvalidResultError(
      "eth_chainId",
      result,
      "expected a 0x-prefixed hex quantity string",
    );
  }
  const value = hexQuantityToBigInt(result);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RobinhoodRpcInvalidResultError(
      "eth_chainId",
      result,
      "chain ID is outside the safe integer range",
    );
  }
  return Number(value);
}

/**
 * `eth_blockNumber`. Module-private — reachable only via
 * `VerifiedRobinhoodRpcClient.getBlockNumber`. Returns `bigint`, never
 * `number` — block numbers are chain quantities and must never be run
 * through floating-point arithmetic or comparison.
 */
async function getBlockNumber(options: RobinhoodRpcOptions): Promise<bigint> {
  const result = await callRpc("eth_blockNumber", [], options);
  if (typeof result !== "string" || !isHexQuantity(result)) {
    throw new RobinhoodRpcInvalidResultError(
      "eth_blockNumber",
      result,
      "expected a 0x-prefixed hex quantity string",
    );
  }
  return hexQuantityToBigInt(result);
}

/**
 * `eth_getCode(address, blockTag)`. Module-private — reachable only via
 * `VerifiedRobinhoodRpcClient.getCode`. `address` is validated as a
 * 20-byte EVM address *before* any network request — a 32-byte value
 * (e.g. a Uniswap V4 PoolId) is rejected here, never truncated or
 * reinterpreted. `"0x"` is a valid, successful result meaning "no code
 * at this address" and is returned exactly as `"0x"` — never coerced to
 * `null`, `false`, or treated as a provider failure.
 */
async function getCode(
  address: string,
  blockTag: BlockTag,
  options: RobinhoodRpcOptions,
): Promise<Hex> {
  if (!isValidEvmAddress(address)) {
    throw new RobinhoodRpcInvalidAddressError(address);
  }
  const blockParam = encodeBlockTagParam(blockTag);

  const result = await callRpc("eth_getCode", [address, blockParam], options);
  if (typeof result !== "string" || !isHexBytes(result)) {
    throw new RobinhoodRpcInvalidResultError(
      "eth_getCode",
      result,
      "expected 0x-prefixed hex bytes",
    );
  }
  return result;
}

/**
 * `eth_call({to, data}, blockTag)`. Module-private — reachable only via
 * `VerifiedRobinhoodRpcClient.call`. Both `to` and `data` are validated
 * *before* any network request — `to` as a 20-byte address (a PoolId is
 * rejected, same as `getCode`), `data` as hex bytes (`"0x"` is valid
 * empty calldata). Returns the raw validated hex bytes result —
 * deliberately no ABI decoding, no knowledge of what the call means.
 * That belongs in a protocol-specific layer above this one, not here.
 */
async function call(
  request: EthCallRequest,
  blockTag: BlockTag,
  options: RobinhoodRpcOptions,
): Promise<Hex> {
  if (!isValidEvmAddress(request.to)) {
    throw new RobinhoodRpcInvalidAddressError(request.to);
  }
  if (!isHexBytes(request.data)) {
    throw new RobinhoodRpcInvalidHexBytesError(request.data);
  }
  const blockParam = encodeBlockTagParam(blockTag);

  const result = await callRpc(
    "eth_call",
    [{ to: request.to, data: request.data }, blockParam],
    options,
  );
  if (typeof result !== "string" || !isHexBytes(result)) {
    throw new RobinhoodRpcInvalidResultError("eth_call", result, "expected 0x-prefixed hex bytes");
  }
  return result;
}

/**
 * The one exported entry point into this module's state-reading
 * operations. Resolves configuration exactly once (so every subsequent
 * call on the returned client targets the exact endpoint that was
 * verified — not whatever `process.env.ROBINHOOD_RPC_URL` happens to
 * hold at call time), calls `eth_chainId`, and throws
 * `RobinhoodRpcWrongChainError` — never returning a client — if the
 * reported chain ID is anything other than `ROBINHOOD_CHAIN_ID` (4663).
 * Any config/transport/JSON-RPC failure during this check propagates as
 * the same typed errors `callRpc` always throws (`RobinhoodRpcConfigError`,
 * `RobinhoodRpcTimeoutError`, `RobinhoodRpcInvalidResultError`, etc.) —
 * construction fails closed on all of them, not just a chain mismatch.
 *
 * Successful resolution of the returned promise is the *only* evidence
 * this module ever produces that a Robinhood Chain connection is
 * verified — there is no other exported way to obtain one.
 */
export async function createVerifiedRobinhoodRpcClient(
  options: RobinhoodRpcOptions = {},
): Promise<VerifiedRobinhoodRpcClient> {
  const resolvedOptions: RobinhoodRpcOptions = {
    rpcUrl: resolveRpcUrl(options),
    timeoutMs: resolveTimeoutMs(options),
    fetchImpl: options.fetchImpl,
  };

  const chainId = await getChainId(resolvedOptions);
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new RobinhoodRpcWrongChainError(ROBINHOOD_CHAIN_ID, chainId);
  }

  return {
    chainId,
    getBlockNumber: () => getBlockNumber(resolvedOptions),
    getCode: (address, blockTag = "latest") => getCode(address, blockTag, resolvedOptions),
    call: (request, blockTag = "latest") => call(request, blockTag, resolvedOptions),
  };
}
