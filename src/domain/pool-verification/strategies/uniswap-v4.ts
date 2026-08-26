import type { Hex } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { ClassifiedPoolIdentity, PoolProtocolClassification } from "@/domain/protocol";
import type { LogEntry, VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { computeV4PoolId, decodeV4InitializeLog, V4_INITIALIZE_TOPIC0, type V4PoolKey } from "../abi/v4-events";
import type { ProtocolDeployment } from "../deployments";
import { describeError } from "../read";
import type {
  HistoricalPoolProvenance,
  PoolIdentityVerification,
  PoolVerificationEvidence,
  PoolVerificationStatus,
  VerifiedV4PoolKey,
} from "../types";

export interface VerifyUniswapV4Args {
  readonly pool: LiquidityPool;
  readonly identity: ClassifiedPoolIdentity;
  readonly classification: PoolProtocolClassification;
  readonly rpc: VerifiedRobinhoodRpcClient;
  /** The block every read in this attempt is pinned to — the *current* chain tip, not the historical Initialize block. */
  readonly blockNumber: bigint;
  /** The pool's classified identifier — for `UNISWAP_V4` this is the bytes32 `PoolId`, never an address. */
  readonly poolId: Hex;
  /** The canonical Robinhood Chain V4 `PoolManager` deployment (`deployments.ts`), including its `deploymentBlock`. */
  readonly poolManager: ProtocolDeployment & { readonly deploymentBlock: bigint };
}

function result(
  args: VerifyUniswapV4Args,
  status: PoolVerificationStatus,
  evidence: readonly PoolVerificationEvidence[],
  historicalProvenance: HistoricalPoolProvenance | null = null,
  poolKey: VerifiedV4PoolKey | null = null,
): PoolIdentityVerification {
  return {
    pool: args.identity,
    family: args.classification.family,
    classificationStatus: args.classification.status,
    status,
    blockNumber: args.blockNumber,
    historicalProvenance,
    // Only a genuinely VERIFIED result exposes the PoolKey as trustworthy
    // — a CONTRADICTED/INDETERMINATE/RPC_ERROR result never does, even if
    // a PoolKey was structurally decoded along the way (see
    // VerifiedV4PoolKey's doc comment in ../types.ts).
    poolKey: status === "VERIFIED" ? poolKey : null,
    evidence,
  };
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Uniswap V4's singleton `PoolManager` architecture means a V4 pool has
 * no per-pool contract to inspect — its `PoolId` (bytes32) is not an
 * address and must never reach `eth_getCode`/`eth_call`. Identity is
 * instead proven from the `PoolManager`'s own historical `Initialize`
 * event log for this exact `PoolId`, which is the only on-chain record
 * that a pool with this identity was ever created and exactly what
 * `PoolKey` it was created with. Required proof for `VERIFIED` (all must
 * hold — see the module-level tests for every negative case):
 *
 *  1. exactly one non-removed `Initialize` event exists for this exact
 *     `PoolId`, searched across the *complete* canonical range (the
 *     `PoolManager`'s `deploymentBlock` through the current pinned
 *     block) — this completeness is what makes "zero matching events"
 *     a decisive `CONTRADICTED`, not merely "none found so far".
 *  2. that event decodes cleanly into a `PoolKey` (`currency0`,
 *     `currency1`, `fee`, `tickSpacing`, `hooks`) via this module's own
 *     strict per-word ABI decoding (see `abi/v4-events.ts`).
 *  3. `keccak256(abi.encode(PoolKey))` (Uniswap's `PoolIdLibrary.toId`)
 *     recomputes to exactly the discovered `PoolId`.
 *  4. the decoded `{currency0, currency1}` pair matches the discovered
 *     Phase 2 `{baseToken.address, quoteToken.address}`, ignoring
 *     orientation.
 *  5. `canonicalAssetAddress` is one of the decoded currencies.
 *
 * More than one matching event is `INDETERMINATE`, not `CONTRADICTED`:
 * `PoolManager` itself reverts `Initialize` for an already-initialized
 * `PoolId`, so two genuine matching events are protocol-impossible —
 * observing more than one means this module's own view of history is
 * unreliable, not that the pool doesn't exist. A `removed` log (a
 * reorg-invalidated result) and any decode/shape failure are
 * `INDETERMINATE` for the same reason: neither proves the pool was
 * never initialized, only that this specific read didn't produce
 * trustworthy evidence either way.
 */
export async function verifyUniswapV4PoolIdentity(args: VerifyUniswapV4Args): Promise<PoolIdentityVerification> {
  const { rpc, blockNumber, poolId, poolManager } = args;

  let logs: readonly LogEntry[];
  try {
    logs = await rpc.getLogs({
      address: poolManager.address,
      topics: [V4_INITIALIZE_TOPIC0, poolId],
      fromBlock: poolManager.deploymentBlock,
      toBlock: blockNumber,
    });
  } catch (error) {
    return result(args, "RPC_ERROR", [
      {
        kind: "V4_INITIALIZE_EVENT_FOUND",
        support: "NEUTRAL",
        source: "eth_getLogs(PoolManager.Initialize)",
        detail: `RPC log search failed: ${describeError(error)}`,
      },
    ]);
  }

  if (logs.length === 0) {
    return result(args, "CONTRADICTED", [
      {
        kind: "V4_INITIALIZE_EVENT_FOUND",
        support: "CONTRADICTS",
        source: "eth_getLogs(PoolManager.Initialize)",
        observed: "0 matching events",
        expected: "exactly 1 matching event",
        detail: `No Initialize event for this PoolId exists across the complete canonical range (block ${poolManager.deploymentBlock} through ${blockNumber}) — this pool was never created.`,
      },
    ]);
  }

  if (logs.length !== 1) {
    return result(args, "INDETERMINATE", [
      {
        kind: "V4_INITIALIZE_EVENT_AMBIGUOUS",
        support: "NEUTRAL",
        source: "eth_getLogs(PoolManager.Initialize)",
        observed: `${logs.length} matching events`,
        expected: "exactly 1 matching event",
        detail:
          "PoolManager.initialize reverts for an already-initialized PoolId, so more than one genuine matching event is protocol-impossible — refusing to select among candidates rather than treat this as proof of anything.",
      },
    ]);
  }

  const log = logs[0];
  if (log === undefined) {
    // Unreachable given the length === 1 check above; narrows the type for noUncheckedIndexedAccess.
    throw new Error("unreachable: logs.length === 1 but logs[0] is undefined");
  }

  const decoded = decodeV4InitializeLog(log, poolId);
  if (decoded.outcome === "removed") {
    return result(args, "INDETERMINATE", [
      {
        kind: "V4_POOL_KEY_RECOVERED",
        support: "NEUTRAL",
        source: "PoolManager.Initialize",
        detail: "The single matching Initialize log is marked removed (reorg-invalidated) — not currently authoritative evidence either way.",
      },
    ]);
  }
  if (decoded.outcome === "malformed") {
    return result(args, "INDETERMINATE", [
      {
        kind: "V4_POOL_KEY_RECOVERED",
        support: "NEUTRAL",
        source: "PoolManager.Initialize",
        detail: `Initialize event could not be decoded safely: ${decoded.reason}`,
      },
    ]);
  }

  const key: V4PoolKey = decoded.key;
  const historicalProvenance: HistoricalPoolProvenance = {
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  };

  const evidence: PoolVerificationEvidence[] = [
    {
      kind: "V4_INITIALIZE_EVENT_FOUND",
      support: "SUPPORTS",
      source: "eth_getLogs(PoolManager.Initialize)",
      observed: `block=${log.blockNumber} tx=${log.transactionHash} logIndex=${log.logIndex}`,
      detail: "Exactly one valid, non-removed Initialize event was found for this PoolId.",
    },
    {
      kind: "V4_POOL_KEY_RECOVERED",
      support: "SUPPORTS",
      source: "PoolManager.Initialize",
      observed: `currency0=${key.currency0} currency1=${key.currency1} fee=${key.fee} tickSpacing=${key.tickSpacing} hooks=${key.hooks}`,
      detail: "PoolKey fully recovered from the event's indexed topics and ABI-encoded data.",
    },
  ];

  const recomputedPoolId = computeV4PoolId(key);
  const idMatches = sameAddress(recomputedPoolId, poolId);
  evidence.push({
    kind: "V4_POOL_ID_RECOMPUTED",
    support: idMatches ? "SUPPORTS" : "CONTRADICTS",
    source: "keccak256(abi.encode(PoolKey)) — PoolIdLibrary.toId",
    observed: recomputedPoolId,
    expected: poolId,
    detail: idMatches
      ? "Recomputing PoolId from the recovered PoolKey reproduces the discovered PoolId exactly."
      : "Recomputing PoolId from the recovered PoolKey does NOT reproduce the discovered PoolId.",
  });

  const discoveredPair = new Set([args.pool.baseToken.address.toLowerCase(), args.pool.quoteToken.address.toLowerCase()]);
  const decodedPair = new Set([key.currency0.toLowerCase(), key.currency1.toLowerCase()]);
  const pairMatches = discoveredPair.size === decodedPair.size && [...discoveredPair].every((a) => decodedPair.has(a));
  evidence.push({
    kind: "V4_CURRENCY_PAIR_MATCH",
    support: pairMatches ? "SUPPORTS" : "CONTRADICTS",
    source: "Initialize {currency0, currency1} vs discovered {baseToken.address, quoteToken.address}",
    observed: `{${key.currency0}, ${key.currency1}}`,
    expected: `{${args.pool.baseToken.address}, ${args.pool.quoteToken.address}}`,
    detail: pairMatches
      ? "Recovered currencies match the discovered pool's tokens (orientation-independent)."
      : "Recovered currencies do NOT match the discovered pool's tokens.",
  });

  const canonicalPresent = decodedPair.has(args.pool.canonicalAssetAddress.toLowerCase());
  evidence.push({
    kind: "CANONICAL_ASSET_MATCH",
    support: canonicalPresent ? "SUPPORTS" : "CONTRADICTS",
    source: "Initialize {currency0, currency1} vs canonicalAssetAddress",
    observed: `{${key.currency0}, ${key.currency1}}`,
    expected: args.pool.canonicalAssetAddress,
    detail: canonicalPresent
      ? "The canonical Robinhood asset address is one of the recovered currencies."
      : "The canonical Robinhood asset address is NOT among the recovered currencies.",
  });

  const status: PoolVerificationStatus = idMatches && pairMatches && canonicalPresent ? "VERIFIED" : "CONTRADICTED";
  return result(args, status, evidence, historicalProvenance, key);
}
