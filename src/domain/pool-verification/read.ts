import type { Address, Hex } from "viem";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { decodeAddressReturn, decodeUint24Return } from "./abi/decode";

/**
 * The outcome of one `rpc.call(...)` plus its ABI decode, kept as a
 * discriminated union so calling code can distinguish "the transport
 * failed" from "the transport succeeded but returned data that could
 * not be decoded" — see `src/domain/pool-verification/types.ts` for why
 * that distinction matters (`RPC_ERROR` vs. `INDETERMINATE`). Internal
 * to this module — not part of the public API.
 */
export type ReadResult<T> =
  | { readonly outcome: "ok"; readonly value: T; readonly raw: Hex }
  | { readonly outcome: "rpc_error"; readonly error: unknown }
  | { readonly outcome: "decode_error"; readonly raw: Hex };

/** Same message-extraction convention used elsewhere in this codebase (e.g. `src/domain/market/classify.ts`). */
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

export function readAddress(
  rpc: VerifiedRobinhoodRpcClient,
  to: Address,
  data: Hex,
  blockNumber: bigint,
): Promise<ReadResult<Address>> {
  return readCall(rpc, to, data, blockNumber, decodeAddressReturn);
}

export function readUint24(
  rpc: VerifiedRobinhoodRpcClient,
  to: Address,
  data: Hex,
  blockNumber: bigint,
): Promise<ReadResult<number>> {
  return readCall(rpc, to, data, blockNumber, decodeUint24Return);
}
