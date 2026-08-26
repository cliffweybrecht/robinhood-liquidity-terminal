import { getAddress, type Address } from "viem";
import { UnknownProtocolDeploymentError } from "./errors";

/**
 * A specific known-good on-chain contract deployment this codebase is
 * allowed to trust as a comparison/entry-point target. Deliberately its
 * own trust boundary, separate from Phase 6B's classification and from
 * any pool's own self-reported addresses (e.g. a pool's `factory()`
 * return): a pool's own reads are exactly what this registry's
 * addresses are used to *check*, so they can never be each other's
 * source of truth.
 *
 * Originally built for Phase 6C identity verification (`factory`/
 * `pool_manager`); Phase 6D's state-reading layer (`src/domain/pool-state/`)
 * also depends on this registry (`state_view`) rather than maintaining a
 * second copy — this is a chain-level fact registry (`getProtocolDeployment`
 * is public API, exported from this module's `index.ts`), not
 * identity-verification-private state.
 */
export type ProtocolDeploymentProtocol = "UNISWAP_V3" | "UNISWAP_V4";
export type ProtocolDeploymentRole = "factory" | "pool_manager" | "state_view";

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
  {
    chainId: 4663,
    protocol: "UNISWAP_V4",
    role: "state_view",
    address: getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
    provenance:
      "Official Uniswap v4-periphery StateView deployment for Robinhood Chain (chainId 4663). Independently verified live: eth_getCode at this address is non-empty and its dispatch table contains the getSlot0/getLiquidity/poolManager selectors; calling this contract's own immutable `poolManager()` getter returns exactly the canonical PoolManager address configured above (0x8366a39CC670B4001A1121B8F6A443A643e40951) — StateView's PoolManager reference is set once in its constructor and can never change, so this binding is verified here, once, rather than re-checked on every state read.",
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
