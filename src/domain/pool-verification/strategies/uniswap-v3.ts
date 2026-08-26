import { zeroAddress, type Address } from "viem";
import type { LiquidityPool } from "@/domain/pool";
import type { ClassifiedPoolIdentity, PoolProtocolClassification } from "@/domain/protocol";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { encodeFactoryCall, encodeFeeCall, encodeGetPoolCall, encodeToken0Call, encodeToken1Call } from "../abi/selectors";
import { describeError, readAddress, readUint24, type ReadResult } from "../read";
import type { PoolIdentityVerification, PoolVerificationEvidence, PoolVerificationStatus, VerifiedV3PoolKey } from "../types";

export interface VerifyUniswapV3Args {
  readonly pool: LiquidityPool;
  readonly identity: ClassifiedPoolIdentity;
  readonly classification: PoolProtocolClassification;
  readonly rpc: VerifiedRobinhoodRpcClient;
  readonly blockNumber: bigint;
  readonly pairAddress: Address;
  readonly canonicalFactory: Address;
  /** The generic contract-code-presence evidence `verify.ts` already established — prepended to this strategy's own evidence, never recomputed. */
  readonly codeEvidence: PoolVerificationEvidence;
}

function failureEvidence(
  kind: PoolVerificationEvidence["kind"],
  source: string,
  result: ReadResult<unknown> & { outcome: "rpc_error" | "decode_error" },
): PoolVerificationEvidence {
  if (result.outcome === "rpc_error") {
    return { kind, support: "NEUTRAL", source, detail: `RPC read failed: ${describeError(result.error)}` };
  }
  return {
    kind,
    support: "NEUTRAL",
    source,
    detail: `Return data could not be decoded into a valid value (raw: ${result.raw}).`,
  };
}

/**
 * Phase 6C.1's only fully-supported protocol. Required proof for
 * `VERIFIED` (all must hold — see module-level tests for every negative
 * case):
 *
 *  1. (established by `verify.ts` before this is called) the discovered
 *     pool address has non-empty contract code.
 *  2. `token0()`/`token1()` both decode to valid addresses.
 *  3. the on-chain `{token0, token1}` pair matches the discovered Phase 2
 *     `{baseToken.address, quoteToken.address}`, ignoring orientation.
 *  4. `canonicalAssetAddress` is one of `token0`/`token1`.
 *  5. `factory()` equals the canonical Robinhood Chain Uniswap V3
 *     factory (`deployments.ts`).
 *  6. `fee()` decodes to a valid `uint24`.
 *  7. the canonical factory's `getPool(token0, token1, fee)` returns
 *     exactly the discovered pool address.
 *
 * Any valid on-chain mismatch on 3/4/5/7 produces `CONTRADICTED`, never
 * `RPC_ERROR`/`INDETERMINATE`. A transport failure on any required read
 * produces `RPC_ERROR` unless a contradiction was already found
 * elsewhere (contradiction always wins — see `types.ts`). A decode
 * failure on any required read produces `INDETERMINATE` under the same
 * priority rule. `tickSpacing()` is deliberately not read: the task's
 * own required-proof list treats it as optional, and no invariant in
 * this phase's scope needs it beyond what `fee()` already establishes.
 */
export async function verifyUniswapV3PoolIdentity(args: VerifyUniswapV3Args): Promise<PoolIdentityVerification> {
  const { pool, identity, classification, rpc, blockNumber, pairAddress, canonicalFactory, codeEvidence } = args;
  const evidence: PoolVerificationEvidence[] = [codeEvidence];

  let hadRpcError = false;
  let hadDecodeError = false;
  let hadContradiction = false;

  const [token0Result, token1Result, factoryResult, feeResult] = await Promise.all([
    readAddress(rpc, pairAddress, encodeToken0Call(), blockNumber),
    readAddress(rpc, pairAddress, encodeToken1Call(), blockNumber),
    readAddress(rpc, pairAddress, encodeFactoryCall(), blockNumber),
    readUint24(rpc, pairAddress, encodeFeeCall(), blockNumber),
  ]);

  // --- token0()/token1() raw reads ---
  if (token0Result.outcome === "ok") {
    evidence.push({
      kind: "TOKEN0_READ",
      support: "NEUTRAL",
      source: "pool.token0()",
      observed: token0Result.value,
      detail: "token0() decoded to a valid address.",
    });
  } else {
    evidence.push(failureEvidence("TOKEN0_READ", "pool.token0()", token0Result));
    hadRpcError ||= token0Result.outcome === "rpc_error";
    hadDecodeError ||= token0Result.outcome === "decode_error";
  }

  if (token1Result.outcome === "ok") {
    evidence.push({
      kind: "TOKEN1_READ",
      support: "NEUTRAL",
      source: "pool.token1()",
      observed: token1Result.value,
      detail: "token1() decoded to a valid address.",
    });
  } else {
    evidence.push(failureEvidence("TOKEN1_READ", "pool.token1()", token1Result));
    hadRpcError ||= token1Result.outcome === "rpc_error";
    hadDecodeError ||= token1Result.outcome === "decode_error";
  }

  // --- token pair / canonical asset comparisons (require both token0 and token1) ---
  if (token0Result.outcome === "ok" && token1Result.outcome === "ok") {
    const onChainPair = new Set([token0Result.value.toLowerCase(), token1Result.value.toLowerCase()]);
    const discoveredPair = new Set([pool.baseToken.address.toLowerCase(), pool.quoteToken.address.toLowerCase()]);
    const pairMatches = onChainPair.size === discoveredPair.size && [...onChainPair].every((a) => discoveredPair.has(a));

    evidence.push({
      kind: "TOKEN_PAIR_MATCH",
      support: pairMatches ? "SUPPORTS" : "CONTRADICTS",
      source: "{token0(), token1()} vs discovered {baseToken.address, quoteToken.address}",
      observed: `{${token0Result.value}, ${token1Result.value}}`,
      expected: `{${pool.baseToken.address}, ${pool.quoteToken.address}}`,
      detail: pairMatches
        ? "On-chain token pair matches the discovered pool's tokens (orientation-independent)."
        : "On-chain token pair does NOT match the discovered pool's tokens.",
    });
    if (!pairMatches) hadContradiction = true;

    const canonicalPresent = onChainPair.has(pool.canonicalAssetAddress.toLowerCase());
    evidence.push({
      kind: "CANONICAL_ASSET_MATCH",
      support: canonicalPresent ? "SUPPORTS" : "CONTRADICTS",
      source: "{token0(), token1()} vs canonicalAssetAddress",
      observed: `{${token0Result.value}, ${token1Result.value}}`,
      expected: pool.canonicalAssetAddress,
      detail: canonicalPresent
        ? "The canonical Robinhood asset address is one of the on-chain pool's tokens."
        : "The canonical Robinhood asset address is NOT among the on-chain pool's tokens.",
    });
    if (!canonicalPresent) hadContradiction = true;
  } else {
    evidence.push({
      kind: "TOKEN_PAIR_MATCH",
      support: "NEUTRAL",
      source: "{token0(), token1()} vs discovered {baseToken.address, quoteToken.address}",
      detail: "Not evaluated — token0()/token1() did not both succeed.",
    });
    evidence.push({
      kind: "CANONICAL_ASSET_MATCH",
      support: "NEUTRAL",
      source: "{token0(), token1()} vs canonicalAssetAddress",
      detail: "Not evaluated — token0()/token1() did not both succeed.",
    });
  }

  // --- factory() vs canonical deployment ---
  if (factoryResult.outcome === "ok") {
    const factoryMatches = factoryResult.value.toLowerCase() === canonicalFactory.toLowerCase();
    evidence.push({
      kind: "FACTORY_READ",
      support: factoryMatches ? "SUPPORTS" : "CONTRADICTS",
      source: "pool.factory()",
      observed: factoryResult.value,
      expected: canonicalFactory,
      detail: factoryMatches
        ? "pool.factory() matches the canonical Robinhood Chain Uniswap V3 factory."
        : "pool.factory() does NOT match the canonical Robinhood Chain Uniswap V3 factory.",
    });
    if (!factoryMatches) hadContradiction = true;
  } else {
    evidence.push(failureEvidence("FACTORY_READ", "pool.factory()", factoryResult));
    hadRpcError ||= factoryResult.outcome === "rpc_error";
    hadDecodeError ||= factoryResult.outcome === "decode_error";
  }

  // --- fee() (structural fact only; feeds the factory lookup below) ---
  if (feeResult.outcome === "ok") {
    evidence.push({
      kind: "FEE_READ",
      support: "NEUTRAL",
      source: "pool.fee()",
      observed: String(feeResult.value),
      detail: "fee() decoded to a structurally valid uint24 fee tier; used as an input to the canonical factory pool lookup below.",
    });
  } else {
    evidence.push(failureEvidence("FEE_READ", "pool.fee()", feeResult));
    hadRpcError ||= feeResult.outcome === "rpc_error";
    hadDecodeError ||= feeResult.outcome === "decode_error";
  }

  // --- canonical factory.getPool(token0, token1, fee) ---
  if (token0Result.outcome === "ok" && token1Result.outcome === "ok" && feeResult.outcome === "ok") {
    const lookupResult = await readAddress(
      rpc,
      canonicalFactory,
      encodeGetPoolCall(token0Result.value, token1Result.value, feeResult.value),
      blockNumber,
    );
    if (lookupResult.outcome === "ok") {
      const isZero = lookupResult.value.toLowerCase() === zeroAddress;
      const matchesPool = lookupResult.value.toLowerCase() === pairAddress.toLowerCase();
      evidence.push({
        kind: "FACTORY_POOL_LOOKUP",
        support: matchesPool ? "SUPPORTS" : "CONTRADICTS",
        source: "canonical factory.getPool(token0, token1, fee)",
        observed: lookupResult.value,
        expected: pairAddress,
        detail: isZero
          ? "The canonical factory reports no pool exists for this (token0, token1, fee) combination."
          : matchesPool
            ? "The canonical factory's getPool result matches the discovered pool address."
            : "The canonical factory's getPool result does NOT match the discovered pool address.",
      });
      if (!matchesPool) hadContradiction = true;
    } else {
      evidence.push(failureEvidence("FACTORY_POOL_LOOKUP", "canonical factory.getPool(token0, token1, fee)", lookupResult));
      hadRpcError ||= lookupResult.outcome === "rpc_error";
      hadDecodeError ||= lookupResult.outcome === "decode_error";
    }
  } else {
    evidence.push({
      kind: "FACTORY_POOL_LOOKUP",
      support: "NEUTRAL",
      source: "canonical factory.getPool(token0, token1, fee)",
      detail: "Not attempted — token0()/token1()/fee() did not all succeed.",
    });
  }

  const status: PoolVerificationStatus = hadContradiction
    ? "CONTRADICTED"
    : hadRpcError
      ? "RPC_ERROR"
      : hadDecodeError
        ? "INDETERMINATE"
        : "VERIFIED";

  // Only a genuinely VERIFIED result exposes token0/token1/fee as
  // trusted — the SAME values already independently read above and
  // cryptographically confirmed via the canonical factory lookup, never
  // re-derived, never taken from the caller-supplied LiquidityPool.
  const v3PoolKey: VerifiedV3PoolKey | null =
    status === "VERIFIED" && token0Result.outcome === "ok" && token1Result.outcome === "ok" && feeResult.outcome === "ok"
      ? { token0: token0Result.value, token1: token1Result.value, fee: feeResult.value }
      : null;

  return {
    pool: identity,
    family: classification.family,
    classificationStatus: classification.status,
    status,
    blockNumber,
    v3PoolKey,
    evidence,
  };
}
