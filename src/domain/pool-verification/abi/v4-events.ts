import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { LogEntry } from "@/providers/robinhood-rpc";
import { decodeAddressReturn, decodeInt24Return, decodeUint24Return } from "./decode";

/**
 * `keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")`
 * — the Uniswap V4 `PoolManager.Initialize` event topic0. Verified
 * against real Robinhood Chain PoolManager logs during Phase 6C.2
 * research; not derived at runtime from a string signature, so a typo
 * here can't silently produce a different (wrong) topic.
 */
export const V4_INITIALIZE_TOPIC0 =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" as Hex;

const WORD_HEX_LENGTH = 64; // 32 bytes * 2 hex chars per byte
const INITIALIZE_DATA_WORD_COUNT = 5; // fee, tickSpacing, hooks, sqrtPriceX96, tick
const INITIALIZE_DATA_HEX_LENGTH = 2 + WORD_HEX_LENGTH * INITIALIZE_DATA_WORD_COUNT;
const LP_FEE_MAX = 1_000_000; // LPFeeLibrary.MAX_LP_FEE
const DYNAMIC_FEE_FLAG = 0x800000; // LPFeeLibrary.DYNAMIC_FEE_FLAG

/** The Uniswap V4 `PoolKey` fields recoverable from an `Initialize` event — everything `PoolId = keccak256(abi.encode(PoolKey))` is computed from. */
export interface V4PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

/**
 * The outcome of decoding one candidate `Initialize` log, kept as a
 * discriminated union (never throws) for the same reason `ReadResult` in
 * `../read.ts` doesn't throw: calling code needs to distinguish *why* a
 * log didn't yield a trustworthy `PoolKey` in order to choose the right
 * verification status (`removed` and `malformed` both currently map to
 * `INDETERMINATE` in `strategies/uniswap-v4.ts` — see that module for
 * why neither is treated as a contradiction).
 */
export type V4InitializeDecodeResult =
  | { readonly outcome: "ok"; readonly key: V4PoolKey }
  | { readonly outcome: "removed" }
  | { readonly outcome: "malformed"; readonly reason: string };

function dataWord(data: Hex, index: number): Hex {
  const body = data.slice(2);
  const start = index * WORD_HEX_LENGTH;
  return `0x${body.slice(start, start + WORD_HEX_LENGTH)}` as Hex;
}

function isValidV4Fee(fee: number): boolean {
  return fee <= LP_FEE_MAX || fee === DYNAMIC_FEE_FLAG;
}

/**
 * Decodes and validates one candidate `PoolManager.Initialize` log
 * against an `expectedPoolId`, entirely via this module's own strict,
 * per-word decoders (`../decode.ts`) — never viem's `decodeAbiParameters`
 * directly. That distinction matters: viem's tuple decoder does not
 * verify an `address` word's 12-byte zero padding, so decoding `hooks`
 * (or the indexed `currency0`/`currency1` topics) through it would
 * silently accept a garbage-padded word instead of failing closed.
 *
 * Every required shape/content check is performed before any field is
 * trusted:
 *  - the log must not be `removed` (a reorg-invalidated log is not
 *    authoritative evidence either way — see the caller for why this is
 *    `INDETERMINATE`, not `CONTRADICTED`),
 *  - exactly 4 topics, with topic0/topic1 matching the expected
 *    `Initialize` signature and PoolId exactly,
 *  - `currency0`/`currency1` are validly zero-padded addresses,
 *  - `data` is exactly 5 ABI words (fee, tickSpacing, hooks,
 *    sqrtPriceX96, tick — the last two are structurally present but not
 *    part of `PoolKey` and are not further decoded here),
 *  - `fee`/`tickSpacing`/`hooks` each decode as their exact ABI type,
 *  - `fee` satisfies Uniswap V4's own invariant: at most
 *    `LPFeeLibrary.MAX_LP_FEE` (1_000_000) or exactly the dynamic-fee
 *    flag (`0x800000`).
 */
export function decodeV4InitializeLog(log: LogEntry, expectedPoolId: Hex): V4InitializeDecodeResult {
  if (log.removed) return { outcome: "removed" };

  const [topic0, topic1, topic2, topic3, ...extraTopics] = log.topics;
  if (
    log.topics.length !== 4 ||
    topic0 === undefined ||
    topic1 === undefined ||
    topic2 === undefined ||
    topic3 === undefined ||
    extraTopics.length > 0
  ) {
    return { outcome: "malformed", reason: `expected exactly 4 topics, got ${log.topics.length}` };
  }
  if (topic0.toLowerCase() !== V4_INITIALIZE_TOPIC0.toLowerCase()) {
    return { outcome: "malformed", reason: `topic0 "${topic0}" does not match the Initialize event signature` };
  }
  if (topic1.toLowerCase() !== expectedPoolId.toLowerCase()) {
    return { outcome: "malformed", reason: `topic1 (id) "${topic1}" does not match the expected PoolId` };
  }

  const currency0 = decodeAddressReturn(topic2);
  if (currency0 === null) return { outcome: "malformed", reason: `topic2 (currency0) "${topic2}" is not a validly padded address` };
  const currency1 = decodeAddressReturn(topic3);
  if (currency1 === null) return { outcome: "malformed", reason: `topic3 (currency1) "${topic3}" is not a validly padded address` };

  if (log.data.length !== INITIALIZE_DATA_HEX_LENGTH) {
    return {
      outcome: "malformed",
      reason: `data must contain exactly ${INITIALIZE_DATA_WORD_COUNT} ABI words (${INITIALIZE_DATA_HEX_LENGTH} hex chars including "0x"), got ${log.data.length}`,
    };
  }

  const fee = decodeUint24Return(dataWord(log.data, 0));
  if (fee === null) return { outcome: "malformed", reason: "data word 0 (fee) is not a valid uint24" };
  const tickSpacing = decodeInt24Return(dataWord(log.data, 1));
  if (tickSpacing === null) return { outcome: "malformed", reason: "data word 1 (tickSpacing) is not a valid int24" };
  const hooks = decodeAddressReturn(dataWord(log.data, 2));
  if (hooks === null) return { outcome: "malformed", reason: "data word 2 (hooks) is not a validly padded address" };
  // Words 3 (sqrtPriceX96) and 4 (tick) are structurally present (the
  // fixed-length check above already guarantees this) but are not part
  // of PoolKey and are not needed for identity verification — Phase
  // 6C.2 is identity provenance only, never price/quote logic.

  if (!isValidV4Fee(fee)) {
    return { outcome: "malformed", reason: `fee ${fee} is neither <= ${LP_FEE_MAX} nor the dynamic-fee flag ${DYNAMIC_FEE_FLAG}` };
  }

  return { outcome: "ok", key: { currency0, currency1, fee, tickSpacing, hooks } };
}

/**
 * Recomputes `PoolId = keccak256(abi.encode(currency0, currency1, fee,
 * tickSpacing, hooks))` — Uniswap V4's `PoolIdLibrary.toId`. Unlike
 * `decodeV4InitializeLog` above, this direction is safe to build with
 * viem's `encodeAbiParameters` directly: every input here has already
 * been strictly decoded/validated, so this module is only *encoding*
 * known-good values, not trusting a generic decoder with untrusted wire
 * data (the same trusted-encode/strict-decode split `abi/selectors.ts`
 * documents for Phase 6C.1).
 */
export function computeV4PoolId(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}
