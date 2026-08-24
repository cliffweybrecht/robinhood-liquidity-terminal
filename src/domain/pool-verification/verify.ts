import { getAddress, type Hex } from "viem";
import { isHexBytes } from "@/lib/evm/hex";
import { getPairIdentifierShape } from "@/domain/pool";
import type { LiquidityPool } from "@/domain/pool";
import type { ClassifiedPoolIdentity, PoolProtocolClassification } from "@/domain/protocol";
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";
import { getProtocolDeploymentAddress } from "./deployments";
import { PoolClassificationMismatchError, UnexpectedIdentifierShapeError } from "./errors";
import { describeError } from "./read";
import { verifyUniswapV3PoolIdentity } from "./strategies/uniswap-v3";
import type { PoolIdentityVerification, PoolVerificationEvidence } from "./types";

export interface VerifyPoolIdentityInput {
  readonly pool: LiquidityPool;
  readonly classification: PoolProtocolClassification;
  readonly rpc: VerifiedRobinhoodRpcClient;
}

function buildIdentitySnapshot(pool: LiquidityPool): ClassifiedPoolIdentity {
  return {
    chainId: pool.chainId,
    pairAddress: pool.pairAddress,
    dexId: pool.dexId,
    canonicalAssetAddress: pool.canonicalAssetAddress,
    canonicalAssetSymbol: pool.canonicalAssetSymbol,
    canonicalAssetSide: pool.canonicalAssetSide,
  };
}

function unsupportedResult(
  identity: ClassifiedPoolIdentity,
  classification: PoolProtocolClassification,
): PoolIdentityVerification {
  const evidence: PoolVerificationEvidence[] = [
    {
      kind: "CLASSIFICATION_UNSUPPORTED",
      support: "NEUTRAL",
      source: "Phase 6B classification",
      observed: `family=${classification.family} status=${classification.status}`,
      expected: "family=UNISWAP_V3 status=CLASSIFIED",
      detail:
        "Phase 6C.1 only verifies CLASSIFIED UNISWAP_V3 pools — no RPC call was made for this pool, to avoid probing its protocol from scratch.",
    },
  ];
  return {
    pool: identity,
    family: classification.family,
    classificationStatus: classification.status,
    status: "UNSUPPORTED",
    blockNumber: null,
    evidence,
  };
}

/**
 * Given an already-validated Phase 2 `LiquidityPool` and its Phase 6B
 * `PoolProtocolClassification`, determines whether on-chain state
 * proves, contradicts, or cannot establish the claimed pool identity.
 *
 * This is identity verification only — not quoting, not liquidity/depth
 * analysis. Phase 6B guides which strategy (if any) is attempted, but is
 * never itself treated as proof: every `VERIFIED`/`CONTRADICTED` result
 * is earned from `rpc` reads performed here, pinned to a single block.
 *
 * Dispatch is fail-closed: only `classification.status === "CLASSIFIED"`
 * with `classification.family === "UNISWAP_V3"` is attempted. Every
 * other combination resolves to `UNSUPPORTED` with **zero RPC calls** —
 * this module never probes an unsupported pool trying to infer its
 * protocol.
 */
export async function verifyPoolIdentity(input: VerifyPoolIdentityInput): Promise<PoolIdentityVerification> {
  const { pool, classification, rpc } = input;

  if (
    classification.pool.chainId !== pool.chainId ||
    classification.pool.pairAddress.toLowerCase() !== pool.pairAddress.toLowerCase()
  ) {
    throw new PoolClassificationMismatchError(pool.pairAddress, classification.pool.pairAddress);
  }

  const identity = buildIdentitySnapshot(pool);

  if (classification.status !== "CLASSIFIED" || classification.family !== "UNISWAP_V3") {
    return unsupportedResult(identity, classification);
  }

  // Fail closed on missing deployment configuration before spending any
  // RPC round trip — a config/registry problem, not a per-pool epistemic
  // outcome, so it throws rather than becoming part of the result.
  const canonicalFactory = getProtocolDeploymentAddress(rpc.chainId, "UNISWAP_V3", "factory");

  // Defensive re-check: a CLASSIFIED UNISWAP_V3 classification is only
  // ever produced for a 20-byte-address pool (see classify.ts's
  // expectedShapeFor), but this module never trusts that invariant
  // blindly — see UnexpectedIdentifierShapeError's doc comment.
  if (getPairIdentifierShape(pool.pairAddress) !== "ADDRESS_20_BYTE") {
    throw new UnexpectedIdentifierShapeError(pool.pairAddress);
  }
  // Safe to re-checksum as `Address` now that the shape is confirmed.
  const pairAddress = getAddress(pool.pairAddress);

  let blockNumber: bigint;
  try {
    blockNumber = await rpc.getBlockNumber();
  } catch (error) {
    return {
      pool: identity,
      family: classification.family,
      classificationStatus: classification.status,
      status: "RPC_ERROR",
      blockNumber: null,
      evidence: [
        {
          kind: "BLOCK_PIN_FAILURE",
          support: "NEUTRAL",
          source: "eth_blockNumber",
          detail: `Could not pin a block for this verification attempt: ${describeError(error)}`,
        },
      ],
    };
  }

  // Generic 20-byte contract-code evidence — protocol-agnostic, reused
  // by every strategy that verifies an address-identified pool. `"0x"`
  // is decisive (CONTRADICTED) on its own; non-empty code is necessary
  // but never sufficient by itself, so verification continues into the
  // protocol-specific strategy either way.
  let codeRaw: Hex;
  try {
    codeRaw = await rpc.getCode(pairAddress, blockNumber);
  } catch (error) {
    return {
      pool: identity,
      family: classification.family,
      classificationStatus: classification.status,
      status: "RPC_ERROR",
      blockNumber,
      evidence: [
        {
          kind: "CONTRACT_CODE_PRESENT",
          support: "NEUTRAL",
          source: `eth_getCode(${pairAddress})`,
          detail: `RPC read failed: ${describeError(error)}`,
        },
      ],
    };
  }
  if (!isHexBytes(codeRaw)) {
    return {
      pool: identity,
      family: classification.family,
      classificationStatus: classification.status,
      status: "INDETERMINATE",
      blockNumber,
      evidence: [
        {
          kind: "CONTRACT_CODE_PRESENT",
          support: "NEUTRAL",
          source: `eth_getCode(${pairAddress})`,
          detail: "eth_getCode returned a value that is not valid hex bytes — cannot determine code presence.",
        },
      ],
    };
  }
  if (codeRaw === "0x") {
    return {
      pool: identity,
      family: classification.family,
      classificationStatus: classification.status,
      status: "CONTRADICTED",
      blockNumber,
      evidence: [
        {
          kind: "CONTRACT_CODE_ABSENT",
          support: "CONTRADICTS",
          source: `eth_getCode(${pairAddress})`,
          observed: "0x",
          detail: "No contract code exists at the discovered pool address — it cannot be a deployed Uniswap V3 pool.",
        },
      ],
    };
  }

  const codeEvidence: PoolVerificationEvidence = {
    kind: "CONTRACT_CODE_PRESENT",
    support: "SUPPORTS",
    source: `eth_getCode(${pairAddress})`,
    observed: `${(codeRaw.length - 2) / 2} bytes`,
    detail: "Contract code exists at the discovered pool address (necessary but not sufficient for VERIFIED on its own).",
  };

  return verifyUniswapV3PoolIdentity({
    pool,
    identity,
    classification,
    rpc,
    blockNumber,
    pairAddress,
    canonicalFactory,
    codeEvidence,
  });
}
