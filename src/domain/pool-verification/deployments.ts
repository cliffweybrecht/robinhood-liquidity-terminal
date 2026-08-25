import { getAddress, type Address } from "viem";
import { UnknownProtocolDeploymentError } from "./errors";

/**
 * A specific known-good on-chain contract deployment that Phase 6C
 * verification code is allowed to trust as a comparison target.
 * Deliberately its own trust boundary, separate from Phase 6B's
 * classification and from any pool's own self-reported addresses (e.g.
 * a pool's `factory()` return): a pool's own reads are exactly what
 * this registry's addresses are used to *check*, so they can never be
 * each other's source of truth.
 */
export type ProtocolDeploymentProtocol = "UNISWAP_V3" | "UNISWAP_V4";
export type ProtocolDeploymentRole = "factory" | "pool_manager";

export interface ProtocolDeployment {
  readonly chainId: number;
  readonly protocol: ProtocolDeploymentProtocol;
  readonly role: ProtocolDeploymentRole;
  readonly address: Address;
  readonly deploymentBlock?: bigint;
  /** Human-readable justification for why this address is trusted — never left as a bare unexplained constant. */
  readonly provenance: string;
}

/**
 * Canonical, hand-curated deployment facts. Intentionally a flat list,
 * not a lookup table keyed by convention — this registry only ever has
 * a handful of entries, and a flat list makes every entry's full
 * provenance visible at a glance rather than scattered across map keys.
 *
 * ## Robinhood Chain (4663) Uniswap V3 factory
 *
 * Address: `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`
 *
 * Provenance: identified via authoritative deployment research for
 * Robinhood Chain (chain ID 4663) as the canonical Uniswap V3
 * `UniswapV3Factory` contract — the same factory Phase 6C.1's
 * `getPool(token0, token1, fee)` cross-check calls to confirm a
 * discovered pool is genuinely registered under this deployment, not
 * merely a contract that happens to expose a V3-shaped ABI. This is the
 * single comparison target for classify.ts step 5 (`pool.factory()`
 * must equal this) and step 7 (this factory's `getPool(...)` must
 * return the discovered pool address) — see `strategies/uniswap-v3.ts`.
 *
 * This address is deliberately NOT the same as any Dexscreener-reported
 * `dexId`/`labels` value, and is never derived from Phase 2/6B data —
 * it is configured here, once, as an independent fact this codebase
 * asserts about Robinhood Chain itself.
 */
const DEPLOYMENTS: readonly ProtocolDeployment[] = [
  {
    chainId: 4663,
    protocol: "UNISWAP_V3",
    role: "factory",
    address: getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa"),
    provenance:
      "Authoritative deployment research for Robinhood Chain (chainId 4663) — canonical Uniswap V3 UniswapV3Factory contract. See module doc comment above for how this address is used.",
  },
  {
    chainId: 4663,
    protocol: "UNISWAP_V4",
    role: "pool_manager",
    address: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
    deploymentBlock: 9070n,
    provenance:
      "Official Uniswap deployment metadata identifies the Robinhood Chain PoolManager; Robinhood Blockscout identifies its creation transaction/block 9070; direct Robinhood RPC block-header research cross-checked that deployment boundary.",
  },
];

/**
 * Resolves the configured deployment address for `chainId`/`protocol`/
 * `role`. Fails closed: throws `UnknownProtocolDeploymentError` rather
 * than returning `null`/`undefined` or silently falling back to some
 * other chain's deployment — a caller with a missing deployment has no
 * safe address to compare against, and must not proceed as if it does.
 */
export function getProtocolDeploymentAddress(
  chainId: number,
  protocol: ProtocolDeploymentProtocol,
  role: ProtocolDeploymentRole,
): Address {
  const found = DEPLOYMENTS.find(
    (d) => d.chainId === chainId && d.protocol === protocol && d.role === role,
  );
  if (!found) {
    throw new UnknownProtocolDeploymentError(chainId, protocol, role);
  }
  return found.address;
}

export function getProtocolDeployment(
  chainId: number, protocol: ProtocolDeploymentProtocol, role: ProtocolDeploymentRole,
): ProtocolDeployment {
  const found = DEPLOYMENTS.find((d) => d.chainId === chainId && d.protocol === protocol && d.role === role);
  if (!found) throw new UnknownProtocolDeploymentError(chainId, protocol, role);
  return found;
}
