import type { Address } from "viem";
import type { CanonicalRobinhoodAsset } from "@/domain/asset";
import type { LiquidityPool } from "@/domain/pool";
import type { PoolIdentityVerification } from "@/domain/pool-verification";

/**
 * The sentinel this module uses, end-to-end, for the V4 native-currency
 * zero-address — the SAME literal `compareVerifiedPoolsExactInput`'s own
 * live smokes and this project's architecture research have used
 * throughout. Never a bare `"0x0000...0000"` string compared ad hoc —
 * always this one named constant, so every equality check in this
 * module is structurally guaranteed to compare against the same value.
 */
export const NATIVE_ETH = "NATIVE_ETH" as const;

/** A verified pool's output-side token — either a real ERC20 address, or the `NATIVE_ETH` sentinel for a V4 pool whose `PoolKey` currency on this side is the protocol-defined zero address. Never a raw `Address` that happens to equal the zero address without having gone through the verified-identity derivation in `snapshot.ts`. */
export type TokenOutIdentifier = Address | typeof NATIVE_ETH;

/**
 * One candidate that has ALREADY passed `verifyPoolIdentity` (`identity.
 * status === "VERIFIED"` is a structural invariant of every value of
 * this type — see `snapshot.ts`, the only place that constructs one).
 * `tokenOut` is derived EXCLUSIVELY from `identity.v3PoolKey`/`poolKey`
 * — never from `pool.baseToken`/`quoteToken`.
 */
export interface VerifiedExecutionCandidate {
  readonly pool: LiquidityPool;
  readonly identity: PoolIdentityVerification;
  readonly tokenOut: TokenOutIdentifier;
}

/** A group of verified candidates sharing the exact same verified `tokenOut`. Counts only — the actual candidates live in `VerifiedExecutionSnapshot.candidates`, filtered by `tokenOut` when needed; this type is deliberately just the summary a group-selector UI needs. */
export interface ComparableExecutionGroup {
  readonly tokenOut: TokenOutIdentifier;
  /** Best-effort, DISPLAY-ONLY label for `tokenOut`, sourced from a matching candidate's own (unverified, provider-reported) pool metadata — exactly the same "representative label, never identity truth" discipline `src/domain/liquidity/aggregate.ts`'s `QuoteAssetComposition.symbol` already established. `undefined` for the `NATIVE_ETH` group (labeled by the UI directly) or if no candidate happened to carry a usable symbol. */
  readonly tokenOutSymbol?: string;
  readonly candidateCount: number;
  readonly v3Count: number;
  readonly v4Count: number;
}

/**
 * The result of discovering, classifying, and identity-VERIFYING one
 * canonical asset's execution candidates — cached (see `snapshot.ts`)
 * because this is, by a wide margin, the most expensive step in the
 * whole pipeline. Deliberately contains NOTHING about any individual
 * comparison's outcome: no `amountOut`, no candidate `status`, no
 * `executionPrice`, no ranking, no comparison block number. Every one
 * of those is computed FRESH, on every request, by
 * `compareVerifiedPoolsExactInput` — caching THIS type can never make
 * execution truth stale, because it doesn't contain any.
 */
export interface VerifiedExecutionSnapshot {
  readonly asset: CanonicalRobinhoodAsset;
  /** Epoch ms when this snapshot was built — informational only; the cache layer (not this type) owns actual freshness/TTL decisions. */
  readonly generatedAt: number;
  /** Only `status === "VERIFIED"` candidates — a transient verification failure (RPC_ERROR) is retried internally (see `snapshot.ts`) and, if still unresolved after retries, is OMITTED here. See `verificationHealth` for why an omission like that must never be treated as a 60-second cached fact. */
  readonly candidates: readonly VerifiedExecutionCandidate[];
  /** Derived from `candidates`, deterministically ordered: `candidateCount` descending, tie-broken by `tokenOut` string ascending — never dependent on `Map`/object iteration order. `groups[0]` is the default output group when a caller does not specify one. */
  readonly groups: readonly ComparableExecutionGroup[];
  /**
   * `"DEGRADED"` when this build's fan-out had at least one candidate
   * whose identity verification was still `RPC_ERROR` after exhausting
   * all retries — i.e. a candidate's absence from `candidates` might be
   * a genuinely transient RPC condition rather than a settled fact.
   * `"HEALTHY"` means every classified candidate reached a FINAL,
   * non-transient outcome (`VERIFIED`, or a deterministic
   * `CONTRADICTED`/`INDETERMINATE`/`UNSUPPORTED`) — an omission in a
   * HEALTHY snapshot is a settled fact, safe to rely on for the full
   * cache TTL. This field exists specifically so the caching layer
   * (`getVerifiedExecutionSnapshot`) can refuse to let a DEGRADED
   * snapshot survive in the 60-second cache — see that function's own
   * doc comment. A DEGRADED snapshot is still returned to the CURRENT
   * caller (candidates are omitted exactly as before, never fabricated)
   * — only its cache durability changes, never its truth content.
   */
  readonly verificationHealth: "HEALTHY" | "DEGRADED";
}
