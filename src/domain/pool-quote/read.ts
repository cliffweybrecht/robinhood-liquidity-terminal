import type { Address, Hex } from "viem";
import { RobinhoodRpcErrorResponseError } from "@/providers/robinhood-rpc";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { classifyV3Revert, classifyV4Revert, type RevertClassification } from "./abi/revert";

/** Same message-extraction convention used elsewhere in this codebase (`pool-verification/read.ts`, `pool-state/read.ts`, `src/domain/market/classify.ts`). */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * The outcome of one quoter `eth_call`, already classified into the
 * four-way vocabulary this module's status model needs. Distinguishes,
 * per the frozen architecture:
 *  - `ok`: the call returned normally (a success return, not a revert).
 *  - `rpc_error`: a transport/infrastructure failure, OR a JSON-RPC
 *    error response whose code is anything other than `3` (i.e. NOT a
 *    genuine EVM execution revert — see `RobinhoodRpcErrorResponseError.rpcCode`).
 *  - `revert`: a genuine EVM execution revert (`rpcCode === 3`) — the
 *    raw `error.data` is preserved for `classifyV3Revert`/`classifyV4Revert`
 *    to classify as `unquotable` or `indeterminate`.
 */
export type QuoterCallOutcome =
  | { readonly kind: "ok"; readonly raw: Hex }
  | { readonly kind: "rpc_error"; readonly detail: string }
  | { readonly kind: "revert"; readonly data: unknown };

export async function callQuoter(
  rpc: VerifiedRobinhoodRpcClient,
  to: Address,
  data: Hex,
  blockNumber: bigint,
): Promise<QuoterCallOutcome> {
  try {
    const raw = await rpc.call({ to, data }, blockNumber);
    return { kind: "ok", raw };
  } catch (error) {
    if (error instanceof RobinhoodRpcErrorResponseError && error.rpcCode === 3) {
      return { kind: "revert", data: error.data };
    }
    return { kind: "rpc_error", detail: describeError(error) };
  }
}

export function classifyRevert(family: "UNISWAP_V3" | "UNISWAP_V4", data: unknown): RevertClassification {
  return family === "UNISWAP_V3" ? classifyV3Revert(data) : classifyV4Revert(data);
}
