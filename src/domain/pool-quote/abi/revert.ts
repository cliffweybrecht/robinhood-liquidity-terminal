import type { Hex } from "viem";

/**
 * Strict, hand-rolled parsing of canonical Uniswap quoter revert data —
 * researched and empirically verified live against Robinhood Chain
 * (see `~/phase-6e-revert-research.txt`). Deliberately conservative:
 * classifies a revert as `"unquotable"` ONLY when its bytes strictly
 * match one of a small, explicitly hand-verified allowlist of known
 * canonical Uniswap error signatures. Everything else — empty revert
 * data, an unrecognized selector, a malformed/truncated payload, a hook
 * revert not on the allowlist — resolves to `"indeterminate"`. This
 * module never infers "insufficient liquidity," "no pool," or any other
 * meaning from a bare or unrecognized revert; guessing would violate
 * the fail-closed policy this whole codebase already applies everywhere
 * else.
 *
 * Both V3's standard `Error(string)` and V4's `UnexpectedRevertBytes(bytes)`
 * are, at the ABI level, the identical shape: a 4-byte selector followed
 * by one dynamic `bytes`/`string` parameter (offset word, length word,
 * then the content right-padded to a 32-byte boundary). `decodeDynamicBytesPayload`
 * strictly validates this exact structure — exact offset (`0x20`, since
 * there are no preceding static parameters), exact content length with
 * no trailing bytes, and all padding bytes zero — never a lenient/
 * generic ABI decoder, matching the same untrusted-wire-data policy
 * `pool-verification`/`pool-state` already established for their own
 * decoders.
 */
const WORD_HEX_LENGTH = 64;
const MAX_REASONABLE_PAYLOAD_BYTES = 4096; // sanity cap against a pathological length word

function decodeDynamicBytesPayload(data: Hex, expectedSelector: Hex): Hex | null {
  const body = data.slice(2);
  if (body.length < 8) return null;
  const selector = `0x${body.slice(0, 8)}`.toLowerCase();
  if (selector !== expectedSelector.toLowerCase()) return null;

  const afterSelector = body.slice(8);
  if (afterSelector.length < WORD_HEX_LENGTH * 2) return null;

  const offsetWordHex = afterSelector.slice(0, WORD_HEX_LENGTH);
  if (!/^[0-9a-fA-F]{64}$/.test(offsetWordHex)) return null;
  if (BigInt(`0x${offsetWordHex}`) !== 32n) return null; // must be exactly 0x20 — one dynamic param, no preceding static params

  const lengthWordHex = afterSelector.slice(WORD_HEX_LENGTH, WORD_HEX_LENGTH * 2);
  if (!/^[0-9a-fA-F]{64}$/.test(lengthWordHex)) return null;
  const length = BigInt(`0x${lengthWordHex}`);
  if (length < 0n || length > BigInt(MAX_REASONABLE_PAYLOAD_BYTES)) return null;
  const lengthNum = Number(length);

  const paddedContentHexChars = Math.ceil(lengthNum / 32) * 32 * 2;
  const contentHex = afterSelector.slice(WORD_HEX_LENGTH * 2);
  if (contentHex.length !== paddedContentHexChars) return null; // exact length, no trailing bytes

  const rawHex = contentHex.slice(0, lengthNum * 2);
  const paddingHex = contentHex.slice(lengthNum * 2);
  if (!/^0*$/.test(paddingHex)) return null; // padding must be all-zero

  return `0x${rawHex}` as Hex;
}

export type RevertClassification =
  | { readonly outcome: "unquotable"; readonly reason: string }
  | { readonly outcome: "indeterminate"; readonly reason: string };

const ERROR_STRING_SELECTOR = "0x08c379a0" as Hex;
const UNEXPECTED_REVERT_BYTES_SELECTOR = "0x6190b2b0" as Hex;

/**
 * Intentionally empty. "AS" — Uniswap V3's `require(amountSpecified != 0, 'AS')`
 * check in `UniswapV3Pool.swap()` — was the only candidate ever considered
 * for this allowlist, and it is NOT included: `amountSpecified` for an
 * exact-input swap is exactly this reader's own `amountIn` argument, and
 * `quoteVerifiedUniswapV3ExactInput`'s own precondition already rejects
 * `amountIn <= 0` (`InvalidAmountInError`) before any RPC call. That makes
 * "AS" provably unreachable through this reader for any request that
 * passes its own preconditions — allowlisting it would assign UNQUOTABLE
 * semantics to a revert this reader can never actually receive from a
 * valid caller, which is stronger than the evidence supports. A prior
 * revision allowlisted "AS" based on it being reproducible via a raw,
 * out-of-band `amountIn = 0` probe (see the Phase 6E revert-research
 * report) — that probe is valid on its own terms, but it exercises a
 * request shape this production reader itself already rejects earlier
 * and by a different mechanism (a typed precondition error, not a quote
 * result), so it does not establish "AS" as a live-reachable UNQUOTABLE
 * condition for this reader specifically. No other V3 revert reason has
 * been positively, independently characterized as canonical and
 * production-reachable, so this allowlist currently has zero entries.
 * That is an accurate reflection of current evidence, not a bug: every
 * V3 revert this reader can currently receive resolves to
 * `"indeterminate"` in `classifyV3Revert` below (see its allowlist
 * lookup — an empty map never matches, so every decoded `Error(string)`
 * falls through to the same `"indeterminate"` path as an unknown reason).
 * Do not add an entry here without either (a) authoritative protocol
 * reasoning establishing it as reachable through this reader's own valid
 * precondition domain, or (b) a reproduced case that respects those same
 * preconditions.
 */
const V3_ALLOWLISTED_REASON_BYTES: ReadonlyMap<string, string> = new Map();

/** Confirmed live and independently cross-checked via keccak256 selector computation against the real Uniswap V4 core error names. */
const V4_ALLOWLISTED_INNER_SELECTORS: ReadonlyMap<string, string> = new Map([
  ["0xbe8b8507", "SwapAmountCannotBeZero()"],
  ["0x486aa307", "PoolNotInitialized()"],
]);

function isHexString(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0;
}

/**
 * Classifies a V3 `QuoterV2` revert. `rawData` is `RobinhoodRpcErrorResponseError.data`
 * (`unknown` — the raw, unprocessed `error.data` field from the JSON-RPC
 * response) for a call that already independently satisfied `rpcCode === 3`
 * (a genuine EVM execution revert, not a transport/JSON-RPC-level error —
 * see `read-uniswap-v3-quote.ts`).
 */
export function classifyV3Revert(rawData: unknown): RevertClassification {
  if (!isHexString(rawData)) {
    return { outcome: "indeterminate", reason: `Revert data is missing or not valid hex bytes (raw: ${JSON.stringify(rawData)}).` };
  }
  const inner = decodeDynamicBytesPayload(rawData, ERROR_STRING_SELECTOR);
  if (inner === null) {
    return { outcome: "indeterminate", reason: `Revert data does not match the standard Error(string) shape (raw: ${rawData}).` };
  }
  const known = V3_ALLOWLISTED_REASON_BYTES.get(inner.toLowerCase());
  if (known !== undefined) {
    return { outcome: "unquotable", reason: `Reverted with the known Uniswap V3 reason: ${known}.` };
  }
  return { outcome: "indeterminate", reason: `Reverted with an Error(string) reason not on the allowlist (raw reason bytes: ${inner}).` };
}

/**
 * Classifies a V4 `V4Quoter` revert. `rawData` is `RobinhoodRpcErrorResponseError.data`
 * for a call that already independently satisfied `rpcCode === 3`.
 */
export function classifyV4Revert(rawData: unknown): RevertClassification {
  if (!isHexString(rawData)) {
    return { outcome: "indeterminate", reason: `Revert data is missing or not valid hex bytes (raw: ${JSON.stringify(rawData)}).` };
  }
  const inner = decodeDynamicBytesPayload(rawData, UNEXPECTED_REVERT_BYTES_SELECTOR);
  if (inner === null) {
    return {
      outcome: "indeterminate",
      reason: `Revert data does not match V4Quoter's UnexpectedRevertBytes(bytes) shape (raw: ${rawData}).`,
    };
  }
  if (inner.length !== 10) {
    // "0x" + 8 hex chars = exactly 4 bytes, a well-formed selector shape.
    return { outcome: "indeterminate", reason: `UnexpectedRevertBytes inner payload is not a 4-byte selector (raw: ${inner}).` };
  }
  const known = V4_ALLOWLISTED_INNER_SELECTORS.get(inner.toLowerCase());
  if (known !== undefined) {
    return { outcome: "unquotable", reason: `Reverted with the known Uniswap V4 core error: ${known}.` };
  }
  return { outcome: "indeterminate", reason: `Reverted with an inner selector not on the allowlist (${inner}).` };
}
