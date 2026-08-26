import type { Address, Hex } from "viem";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import {
  decodeInt24Return,
  decodeSlot0Return,
  decodeSlot0V4Return,
  decodeUint128Return,
  decodeUint24Return,
  type Slot0Tuple,
  type Slot0V4Tuple,
} from "./abi/decode";

/**
 * The outcome of one `rpc.call(...)` plus its ABI decode — the same
 * discriminated-union shape `pool-verification/read.ts` uses, for the
 * same reason (distinguishing transport failure from decode failure).
 * Duplicated locally rather than imported — see `abi/decode.ts`'s doc
 * comment for why this module does not reach into `pool-verification`'s
 * internals.
 */
export type ReadResult<T> =
  | { readonly outcome: "ok"; readonly value: T; readonly raw: Hex }
  | { readonly outcome: "rpc_error"; readonly error: unknown }
  | { readonly outcome: "decode_error"; readonly raw: Hex };

/** Same message-extraction convention used elsewhere in this codebase (e.g. `pool-verification/read.ts`, `src/domain/market/classify.ts`). */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function readCall<T>(
  rpc: VerifiedRobinhoodRpcClient,
  to: Address,
  data: Hex,
  blockNumber: bigint,
  decode: (raw: Hex) => T | null,
): Promise<ReadResult<T>> {
  let raw: Hex;
  try {
    raw = await rpc.call({ to, data }, blockNumber);
  } catch (error) {
    return { outcome: "rpc_error", error };
  }
  const value = decode(raw);
  if (value === null) return { outcome: "decode_error", raw };
  return { outcome: "ok", value, raw };
}

export function readSlot0(rpc: VerifiedRobinhoodRpcClient, to: Address, data: Hex, blockNumber: bigint): Promise<ReadResult<Slot0Tuple>> {
  return readCall(rpc, to, data, blockNumber, decodeSlot0Return);
}

export function readLiquidity(rpc: VerifiedRobinhoodRpcClient, to: Address, data: Hex, blockNumber: bigint): Promise<ReadResult<bigint>> {
  return readCall(rpc, to, data, blockNumber, decodeUint128Return);
}

export function readFee(rpc: VerifiedRobinhoodRpcClient, to: Address, data: Hex, blockNumber: bigint): Promise<ReadResult<number>> {
  return readCall(rpc, to, data, blockNumber, decodeUint24Return);
}

export function readTickSpacing(rpc: VerifiedRobinhoodRpcClient, to: Address, data: Hex, blockNumber: bigint): Promise<ReadResult<number>> {
  return readCall(rpc, to, data, blockNumber, decodeInt24Return);
}

/** `readLiquidity` above is reused as-is for `StateView.getLiquidity` — same `uint128` decode, generic over `to`/`data`. */
export function readSlot0V4(rpc: VerifiedRobinhoodRpcClient, to: Address, data: Hex, blockNumber: bigint): Promise<ReadResult<Slot0V4Tuple>> {
  return readCall(rpc, to, data, blockNumber, decodeSlot0V4Return);
}
