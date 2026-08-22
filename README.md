# Robinhood Chain Liquidity Terminal

A liquidity intelligence terminal for canonical Robinhood Stock Tokens on
Robinhood Chain. The long-term goal is to distinguish **displayed DEX
liquidity** (what market-data providers report) from **executable
liquidity** (what can actually be swapped before unacceptable price
impact) — see [Project scope](#project-scope) for what exists today.

## Phase 1: Canonical Robinhood Asset Registry

Phase 1 implements exactly one thing: an authoritative, tested mechanism
for answering **"what are the canonical Robinhood Stock Tokens on
Robinhood Chain, and what are their canonical contract addresses?"**
Every later phase (DEX pool discovery, liquidity aggregation, executable
liquidity, order simulation) depends on this foundation being correct.

### What the registry does

- Fetches `GET https://api.robinhood.com/rhj/assets` (Robinhood's
  canonical stock token asset list).
- Validates the response against a Zod schema built from the *actual
  observed* upstream shape (not assumed from docs alone — see
  [Discovered Robinhood API shape](#discovered-robinhood-api-shape)).
- Filters to assets that have a deployment on **chain ID 4663**
  (Robinhood Chain).
- Normalizes each into an internal `CanonicalRobinhoodAsset` domain
  model, independent of Robinhood's field names/casing.
- Builds symbol and address lookup indices with explicit, tested
  collision handling.

### Why Robinhood's asset API is the authoritative source

Robinhood's `/rhj/assets` endpoint is the source that actually deploys
and registers Stock Token contracts on Robinhood Chain. It is the only
source in this system with a legitimate claim to say "this contract
address is the real NVDA Stock Token." Every other source this project
will eventually touch (Dexscreener, on-chain pools) is *market data
about* tokens, not a statement of *which tokens are canonical*.

### Why ticker matching is insufficient

A pool or token named "NVDA" on a DEX is not evidence that it is
Robinhood's NVDA Stock Token. Anyone can deploy an ERC-20 called `NVDA`
with any symbol/name they like — a scam or unrelated project could reuse
a familiar ticker to imitate a real Stock Token. This is why every
lookup function in this codebase (`getRobinhoodAssetBySymbol`,
`getRobinhoodAssetByAddress`) is built on top of a registry keyed
primarily by **contract address**, and why symbol lookups explicitly
refuse to guess when a symbol is ambiguous (see
[Duplicate symbols](#duplicate-symbols) below) rather than silently
picking one candidate.

### Why contract-address validation matters

Because address identity is the security boundary, a malformed or
unvalidated address is worse than a missing one — it can silently
misrepresent which contract an asset refers to. This is why address
validation happens at two independent layers (see
[Validation](#validation)) and why the system fails closed rather than
guessing when an address can't be trusted.

### Provider models vs. domain models

`src/providers/robinhood/schema.ts` defines Zod schemas that mirror
Robinhood's *actual* wire format — including its field names
(`tokenSymbol`, `tokenName`, `deployments[]`), its status enum strings
(`ASSET_STATUS_ACTIVE`), and only the fields this application uses.
`src/domain/asset/types.ts` defines a separate, stable
`CanonicalRobinhoodAsset` shape that the rest of the app (API route, UI,
and future phases) depends on instead.

This separation means:

- A future upstream rename (`tokenSymbol` → `symbol`, say) is a one-line
  change in the provider schema, not a ripple through the whole app.
- The public API (`GET /api/assets`) has a shape *this application*
  controls and intends, not whatever Robinhood happens to return.
- Fields Robinhood returns but this app doesn't use
  (`tradingCapabilities`, `isin`, `pendingMultiplier`, `networkName`)
  never leak into the domain model or the public API.

## Discovered Robinhood API shape

The response shape below was confirmed against the **live** endpoint
during development, not assumed from documentation. It differs from the
conceptual model in the product brief in several concrete ways: field
names are `tokenSymbol`/`tokenName` (not `symbol`/`name`), chain
deployment data lives in a `deployments[]` array (an asset could in
principle have zero, one, or several), and `status` is a prefixed enum
string.

```json
{
  "assets": [
    {
      "id": "0x0000...<66-char onchain uid>",
      "tokenSymbol": "CRM",
      "tokenName": "Salesforce • Robinhood Token",
      "deployments": [
        { "contractAddress": "0xd95B...checksummed", "chainId": 4663, "networkName": "Robinhood Chain" }
      ],
      "currentMultiplier": "1.000000000000000000",
      "pendingMultiplier": "",
      "status": "ASSET_STATUS_ACTIVE",
      "logoUrl": "https://cdn.robinhood.com/...",
      "tradingCapabilities": { "market": { "...": "..." } },
      "tokenDecimals": 18,
      "isin": "US79466L3024"
    }
  ]
}
```

At the time of writing, the live endpoint returns 194 assets, all with
exactly one deployment on chain 4663, all `ASSET_STATUS_ACTIVE`, with no
duplicate symbols or addresses. The registry is built to handle
violations of any of those properties explicitly rather than assume they
hold forever.

## Validation

Zod validates every provider response at the HTTP boundary
(`src/providers/robinhood/schema.ts`). Contract addresses are checked
for correct shape (`0x` + 40 hex characters) at this layer; an
unrecognized `status` value or a missing required field fails the
**entire** response (see [Error/failure behavior](#errorfailure-behavior)
for why).

A second, independent check happens in the domain layer
(`src/domain/asset/registry.ts`, via `src/domain/asset/address.ts`),
which uses `viem`'s `isAddress`/`getAddress` to confirm each address is
not just correctly shaped but a real, checksummable EVM address, and to
normalize it to its canonical EIP-55 checksummed form for storage and
display. This is deliberate defense in depth: `buildAssetRegistry` is a
pure function that does not trust its caller already ran the Zod schema
(this also makes it directly unit-testable with hand-written fixtures
that bypass the HTTP layer entirely).

**Note on checksums:** `viem`'s address validation is strict — a mixed
or upper-cased address that doesn't match its correct EIP-55 checksum is
rejected as invalid, even though it's syntactically well-formed hex.
Given Robinhood's live API returns properly checksummed addresses, this
doesn't affect real data, but it does mean this app is intentionally
stricter than "is this valid hex" — an incorrectly-checksummed address
is treated as untrustworthy, matching the "fail closed when identity
can't be verified" principle.

### Duplicate symbols

Two assets that normalize to the same ticker symbol are **not** a fatal
error — the registry still builds — but that symbol is marked ambiguous
and `getRobinhoodAssetBySymbol` throws `AmbiguousSymbolError` rather than
silently returning one of the candidates. Symbols are a convenience
index; only contract addresses are treated as identity.

### Duplicate contract addresses

Two assets claiming the same canonical contract address **is** a fatal,
whole-registry-build error (`DuplicateContractAddressError`). Address
uniqueness is the invariant the entire identity model rests on — if it
doesn't hold, no address lookup in the system can be trusted.

## Error/failure behavior

Every external-boundary failure mode is a distinct, typed error — none
of them are collapsed into an empty asset array:

| Failure | Error type | `GET /api/assets` status |
|---|---|---|
| DNS/connection failure | `RobinhoodNetworkError` | 502 |
| Request exceeds timeout | `RobinhoodTimeoutError` | 504 |
| Non-2xx HTTP response | `RobinhoodHttpError` | 502 |
| Response body isn't valid JSON | `RobinhoodInvalidJsonError` | 502 |
| Response fails schema validation | `RobinhoodSchemaValidationError` | 502 |
| No asset has a chain-4663 deployment | `NoChainDeploymentError` | 502 |
| An asset's address fails validation | `InvalidContractAddressError` | 502 |
| Two assets share a canonical address | `DuplicateContractAddressError` | 500 |
| Symbol lookup matches >1 asset | `AmbiguousSymbolError` | (thrown to caller) |
| Symbol/address lookup matches 0 assets | `AssetNotFoundError` | (thrown to caller) |
| Caller passes a malformed address to look up | `InvalidAddressInputError` | (thrown to caller) |

**Design choice — whole-response schema failure:** if *any* asset in the
`assets[]` array fails Zod validation, the entire fetch fails rather than
silently dropping just that entry. A response that deviates from the
documented contract at all means we can't be confident the rest of the
payload is trustworthy either — this fails closed rather than serving a
partial, unverified list. A future phase could relax this to
per-asset tolerance if upstream data quality warrants it; that is a
deliberate tradeoff, not an oversight.

Outbound requests are bounded by a timeout (default 8000ms, configurable
via `ROBINHOOD_API_TIMEOUT_MS`) implemented with `AbortController` in
`src/lib/http/fetchWithTimeout.ts` — a reusable, provider-agnostic
utility, independent of anything Robinhood-specific.

## API

### `GET /api/assets`

```json
{
  "data": {
    "chainId": 4663,
    "assetCount": 194,
    "assets": [
      {
        "id": "0x0000...",
        "symbol": "CRM",
        "name": "Salesforce • Robinhood Token",
        "contractAddress": "0xd95B44124e475743a7589e68F3D74008A5536D44",
        "chainId": 4663,
        "logoUrl": "https://cdn.robinhood.com/...",
        "currentMultiplier": "1.000000000000000000",
        "tokenDecimals": 18,
        "status": "ACTIVE"
      }
    ]
  }
}
```

On failure: `{ "error": { "code": "...", "message": "..." } }` with the
HTTP status from the table above.

### Programmatic API (`src/domain/asset`)

```ts
import {
  getRobinhoodAssets,
  getRobinhoodAssetBySymbol,
  getRobinhoodAssetByAddress,
} from "@/domain/asset";

const registry = await getRobinhoodAssets();
const nvda = await getRobinhoodAssetBySymbol("nvda"); // case-insensitive
const asset = await getRobinhoodAssetByAddress("0xd95b...44"); // case-insensitive
```

Each call performs a fresh upstream fetch — see
[Known limitations](#known-limitations).

## Phase 2: Dexscreener Pool Discovery and Normalization

Phase 2 answers a second, narrower question, always starting from a
Phase 1 canonical address: **"what Dexscreener liquidity pools currently
exist for this exact canonical Robinhood Stock Token contract?"** It does
**not** aggregate liquidity across pools (that's
[Phase 3](#phase-3-displayed-liquidity-aggregation-and-fragmentation-analysis)),
compare against Robinhood's reference price, or attempt executable
liquidity — those remain later phases.

### How pool discovery works

1. Start from a canonical `CanonicalRobinhoodAsset` (symbol/address
   resolved through Phase 1 — see below, this step is never skipped).
2. Fetch `GET https://api.dexscreener.com/token-pairs/v1/robinhood/{contractAddress}`
   (`src/providers/dexscreener/client.ts`), Zod-validated
   (`src/providers/dexscreener/schema.ts`).
3. Validate **every** returned pair independently
   (`src/domain/pool/normalize.ts`): does it actually contain the exact
   canonical address (case-insensitively) as `baseToken` or `quoteToken`?
   Is `chainId` really `"robinhood"`? Are the pair/token addresses
   well-formed? A pool failing any check is excluded from the result, not
   treated as a whole-batch failure (see
   [Zero pools vs. provider failure](#zero-pools-vs-provider-failure)).
4. Normalize accepted pools into `LiquidityPool` and deduplicate (see
   [Deduplication strategy](#deduplication-strategy)).

### Why canonical contract participation is revalidated

Phase 1 establishes that an address *is* a canonical Robinhood Stock
Token. Phase 2 additionally must confirm, **per pool**, that Dexscreener's
`baseToken.address`/`quoteToken.address` actually match that exact
address — not merely that we asked Dexscreener about the right token.
Dexscreener aggregates data from many independent, permissionless DEXes;
nothing stops a scam pool from being indexed under a similar-looking
address, and nothing guarantees Dexscreener's own indexing never mixes up
which token is on which side. Re-validating identity at the pool level,
rather than trusting "we queried for NVDA so every result must be NVDA,"
is the same fail-closed posture Phase 1 applies to Robinhood's own data.

### Why ticker matching is never used for identity

Exactly as in Phase 1: `baseToken.symbol`/`quoteToken.symbol`/`name`
strings from Dexscreener are preserved on each `LiquidityPool` for
display and provenance, but **never** used to decide whether a pool
belongs to the canonical asset. Only `baseToken.address`/
`quoteToken.address`, compared case-insensitively against the Phase 1
canonical address, decide that. `LiquidityPool.canonicalAssetSymbol` is
always the *Phase 1* symbol, never copied from Dexscreener's labels.

### Zero pools vs. provider failure

Empirically, `GET /token-pairs/v1/{chainId}/{tokenAddress}` returns
**HTTP 200 with `[]`** for a token with no pools, an unrecognized chain
ID, or even a malformed token address — Dexscreener never 404s or errors
on bad input. This means:

- A successful `getDexScreenerPoolsBySymbol("XYZ")` call that resolves
  `XYZ` through Phase 1 but finds `pools: []` is a **legitimate result**
  — that Stock Token genuinely has no indexed DEX liquidity yet.
- This is entirely distinct from a `DexScreenerNetworkError`,
  `DexScreenerTimeoutError`, `DexScreenerHttpError`,
  `DexScreenerInvalidJsonError`, or `DexScreenerSchemaValidationError` —
  each a thrown, typed failure, never silently coerced into `[]`.
- Because Dexscreener won't reject a bad chain ID or address for us, the
  per-pool `chainId`/address re-validation described above is doing real
  work defensively even though, in practice, the live endpoint's own
  chain-scoping means those specific checks are unlikely to ever
  trigger — they exist because we cannot prove they won't.

### Deduplication strategy

Pools are deduplicated on **`chainId` + `pairAddress`** (case-insensitive
on the address). If Dexscreener returns the same pool more than once:

- **Materially identical** duplicate records (agree on every normalized
  field, ignoring `pairAddress` casing) are silently collapsed to one.
- **Conflicting** duplicates (same pool identity, disagreeing field
  values) throw `DuplicatePoolConflictError` rather than silently
  picking one — an integrity problem, not a display decision, mirroring
  Phase 1's treatment of duplicate canonical addresses.

### `pairAddress` is not always a contract address

`pairAddress` is typed as viem's `Hex`, not `Address`. Live data showed
Uniswap v4 pools (managed by a singleton `PoolManager` rather than a
per-pool deployed contract) reporting a 32-byte PoolId instead of a
20-byte address — confirmed on 19 of 30 live NVDA pools. Critically,
`labels` is **not** a reliable discriminator for this: one live pool
carried the label `"v4"` but used an ordinary 20-byte address. Both
`src/providers/dexscreener/schema.ts` and the independent domain-layer
check in `src/domain/pool/address.ts` key off the actual hex length (40
vs. 64 characters), not the label.

### Provider/domain separation (Phase 2)

Same split as Phase 1: `src/providers/dexscreener/schema.ts` mirrors
Dexscreener's actual wire format (bare array response, numeric-string
prices, dual-length `pairAddress`) and is validated independently of
anything Robinhood-specific. `src/domain/pool/types.ts` defines the
stable `LiquidityPool` shape the rest of the app depends on — Dexscreener
response types never reach `src/app/**` directly.

### API

#### `GET /api/assets/{symbol}/pools`

```json
{
  "data": {
    "asset": { "symbol": "NVDA", "name": "NVIDIA • Robinhood Token", "contractAddress": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
    "poolCount": 30,
    "pools": [ { "provider": "dexscreener", "dexId": "uniswap", "pairAddress": "0xd4EB...", "canonicalAssetSide": "base", "liquidityUsd": 2762395.14, "volume24h": 13386716.29, "buys24h": 10166, "sells24h": 9316, "dexScreenerUrl": "https://dexscreener.com/robinhood/...", "labels": ["v3"] } ]
  }
}
```

`poolCount` is the count of **accepted, unique, validated** pools — not
raw provider records. Errors: `404` unknown symbol, `409` ambiguous
symbol (inherited from Phase 1), `502`/`504` Dexscreener provider
failures, `500` integrity conflicts (`DuplicatePoolConflictError`) or
unexpected errors.

#### Programmatic API (`src/domain/pool`)

```ts
import {
  getDexScreenerPoolsForAsset,
  getDexScreenerPoolsBySymbol,
  getDexScreenerPoolsByAddress,
} from "@/domain/pool";

const { asset, pools } = await getDexScreenerPoolsBySymbol("nvda");
const byAddr = await getDexScreenerPoolsByAddress("0xd0601c...eec");
```

`getDexScreenerPoolsBySymbol`/`getDexScreenerPoolsByAddress` **always**
resolve through Phase 1 first (`getRobinhoodAssetBySymbol`/
`getRobinhoodAssetByAddress`) — an unresolvable, ambiguous, or malformed
symbol/address never reaches Dexscreener. The lower-level
`fetchDexScreenerPairs(chainId, tokenAddress, options)` in
`src/providers/dexscreener` does accept arbitrary addresses (for
reuse/testability) — it is intentionally *not* exported from the public
domain API surface as a way to look up pools; only the canonical-gated
functions above are.

## Phase 3: Displayed Liquidity Aggregation and Fragmentation Analysis

Phase 3 answers a third question, built entirely on Phase 2's already
canonical-validated, deduplicated pools: **"what does the displayed DEX
liquidity structure of this exact canonical Robinhood Stock Token look
like across all its accepted pools?"** — total displayed liquidity, USDG
liquidity, concentration, and quote-asset/DEX composition.

### Displayed liquidity vs. executable liquidity

**This is provider-reported market data, not a statement of what can
actually be bought.** A Dexscreener pool reporting `liquidity.usd =
1,000,000` does not mean a user can buy $500,000 of the stock token at
acceptable price impact — concentrated-liquidity AMMs can have that
liquidity positioned outside the immediately tradeable price range.
Determining actual swap capacity requires on-chain quoting/simulation,
which is explicitly **not** implemented yet (see
[Phase 5 direction](#phase-5-direction-not-implemented)).

To keep this distinction impossible to miss, the codebase and UI never
use terms like "buy capacity," "executable depth," "available to buy,"
"maximum purchasable," or "order capacity" for Phase 3 metrics — only
"displayed liquidity." The UI additionally carries a standing note:
*"Displayed liquidity is provider-reported pool liquidity and does not
represent executable buy capacity."*

### Null vs. zero handling

The single rule underlying every aggregate in this phase: **a metric is
`null` when zero pools report a non-null value for it, and is the sum of
whatever pools *did* report otherwise — including when that sum is
itself `0`.** A pool reporting `liquidityUsd: 0` contributes a real `0`;
a pool reporting `liquidityUsd: null` contributes nothing and is counted
as missing, never treated as `0`. This one function
(`sumNullable` in `src/domain/liquidity/aggregate.ts`) implements the
rule once and is reused for every liquidity, volume, and buy/sell
aggregate — displayed liquidity, USDG liquidity, each quote-asset/DEX
group's liquidity, and all eight activity metrics.

### Coverage/completeness semantics

`coverage.liquidity` and `coverage.activity.*` report, per metric,
`{ poolsReporting, poolsMissing, complete }` — `complete` is
`poolsMissing === 0`, vacuously `true` for a zero-pool asset (nothing is
missing from nothing). This is what makes the four states the aggregation
rules call for distinguishable from the response alone: zero accepted
pools (`poolCount: 0`, coverage `{0, 0, true}`), accepted pools but no
data (coverage `{0, N, false}`, aggregate `null`), partial data (coverage
`{n, m, false}`, aggregate is the partial sum), and full data (coverage
`{N, 0, true}`).

### USDG identification by exact contract address

Robinhood Chain's canonical USDG (`CANONICAL_USDG_ADDRESS` in
`src/domain/liquidity/aggregate.ts`,
`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`) is matched
case-insensitively against a pool's **non-canonical-asset side** — i.e.
`quoteToken` when `canonicalAssetSide === "base"`, `baseToken` otherwise,
using that field rather than re-deriving which side is which (see
Phase 2's identity rules — same discipline applies here). A token merely
*labeled* `"USDG"` on a different contract address never counts, exactly
as a token labeled with the canonical stock ticker on the wrong contract
never counts in Phase 1/2.

### Quote-asset composition

Each pool's non-canonical-asset side (via `canonicalAssetSide`, never
inferred by ticker) is grouped by **exact contract address**
(case-insensitive). Live NVDA data actually includes three distinct
quote assets by address: canonical USDG, canonical WETH, and the
zero address (`0x000...000`, the conventional placeholder Dexscreener
uses for native ETH — a genuinely different identity from WETH's ERC-20
contract, which is exactly why address-based grouping matters here and
not just for USDG).

If pools sharing an address disagree on the token's symbol beyond
case/whitespace, that is surfaced via `symbolConflict: true` rather than
silently resolved — the group's `symbol` field is a deterministic
representative (the lexicographically smallest distinct raw symbol
observed, independent of pool array order), not a guess.

### DEX composition

Aggregated by exact `dexId` string. Live data across NVDA's 30 pools
(8 distinct DEXes: `uniswap`, `ramses`, `alandale`, `up`, `giga`,
`sheriff`, `pancakeswap`, `robinswap`) showed **no casing variance** —
`dexId` is consistently lowercase — so no normalization is applied;
`dexId` is grouped and displayed exactly as Dexscreener reports it.

### Concentration formulas

Pools with non-null `liquidityUsd`, sorted descending (ties broken by
`pairAddress` ascending for determinism), give:

```
topNPct = sum(top N pools' liquidityUsd) / total(non-null liquidityUsd) * 100
```

`N` exceeding the number of ranked pools sums whatever exists (e.g. 2
pools → `top3Pct` and `top5Pct` both equal `top2Pct`, effectively 100%).
When total displayed liquidity is not strictly positive — no pool
reports liquidity, or the reporting pools sum to exactly `0` — every
`topNPct` (and `largestPool.shareOfDisplayedLiquidityPct`, and every
composition row's `shareOfDisplayedLiquidityPct`) is `null`. This
formula never produces `NaN` or `Infinity`. `largestPool` itself is
`null` only when *no* pool reports `liquidityUsd` — a pool reporting
exactly `0` can still be "largest" (with a `null` share, since the
total is `0`).

### Activity aggregation: an explicit assumption

Dexscreener's docs don't state whether a pair record's `volume`/`txns`
are pool-specific or already aggregated across venues. Live inspection
of NVDA's 30 pools found no duplicate `volume.h24` values and plausible,
widely-varying per-pool magnitudes correlating with each pool's own
liquidity size — consistent with each record being that **specific
pool's own** trading activity, not a shared/duplicated figure. Because
Phase 2 already deduplicates by unique pool identity
(`chainId` + `pairAddress`), Phase 3 sums activity across the accepted,
deduplicated pool set. **This is documented as observed cross-pool
activity, not an exchange-grade consolidated tape** — if a future
Dexscreener response ever demonstrates duplicated activity reporting
across records for the same economic pool, this assumption will need
revisiting.

### Numeric precision

All Phase 3 arithmetic uses plain JavaScript `number`. Live NVDA totals
(~$4.5M displayed liquidity, ~$7.8M 24h volume) are many orders of
magnitude below `Number.MAX_SAFE_INTEGER`, and this is provider-reported
approximate market data, not settlement accounting — a big-decimal
library would add complexity with no evidence it's needed. (This does
not apply to future on-chain token-accounting phases, which must not use
floating-point.)

### Deterministic sorting

`quoteAssets` and `dexes` both sort by `displayedLiquidityUsd`
descending, entries with `null` sorting after every non-null entry, tied
entries broken ascending by `address`/`dexId` respectively. `pools`
preserves Phase 2's existing order. `largestPool` ties break by
`pairAddress` ascending. None of this relies on provider response
ordering for anything meaningful.

### API

#### `GET /api/assets/{symbol}/liquidity`

Returns `{ data: AssetLiquidityProfile }` — see
`src/domain/liquidity/types.ts` for the full shape (asset identity,
`displayedLiquidityUsd`, `usdGLiquidityUsd`, `poolCount`, `dexCount`,
`largestPool`, `concentration`, `quoteAssets`, `dexes`, `activity`,
`coverage`, and the full `pools` array — pool-level detail is always
preserved alongside the aggregates, never replaced by them). Errors:
`404` unknown symbol, `409` ambiguous symbol, `502`/`504` Dexscreener
provider failures, `500` integrity conflicts
(`DuplicatePoolConflictError`) or unexpected errors — identical mapping
to `/pools`, since this route's failure modes are a superset of that
one's.

#### Programmatic API (`src/domain/liquidity`)

```ts
import {
  buildAssetLiquidityProfile,
  getAssetLiquidityProfileBySymbol,
  getAssetLiquidityProfileByAddress,
} from "@/domain/liquidity";

const profile = await getAssetLiquidityProfileBySymbol("nvda");
```

`buildAssetLiquidityProfile(asset, pools)` is a pure, synchronous
function — no provider calls — consuming Phase 2's `readonly
LiquidityPool[]` directly, which is what makes the aggregation logic
exhaustively unit-testable without any network mocking. The
symbol/address service functions preserve the full trust chain
(`symbol/address → canonical asset → validated pools → aggregation`,
mirroring Phase 2's guarantee) — there is intentionally no public
function that aggregates an arbitrary, unverified token address as if it
were a canonical Robinhood asset.

### UI

`/assets/{symbol}` now shows summary stat cards (displayed liquidity,
USDG displayed liquidity, observed 24h volume, pool/DEX count, largest
pool + share, top-3/top-5 concentration, 24h buys/sells) above
quote-asset and DEX composition tables, above the existing pool table —
all using the "displayed liquidity" terminology above, with the
executable-liquidity disclaimer always visible. No home-page leaderboard
yet (see [Project scope](#project-scope) below) — this remains
one-asset-at-a-time.

## Phase 4: Bulk Market Snapshot and Liquidity Leaderboard

Phase 4 answers a market-wide question for the first time: **"what does
displayed liquidity look like across the entire canonical Robinhood
Stock Token universe right now?"** It reuses Phase 3's per-asset math
unchanged — this phase is orchestration, rate limiting, caching, and
presentation, not new liquidity arithmetic.

### Current provider rate limit (re-verified for Phase 4, not assumed from Phase 2/3)

`GET /token-pairs/v1/{chainId}/{tokenAddress}` has **no rate limit
published anywhere in Dexscreener's current docs** — only adjacent
endpoint categories (`token-profiles`, `ads`, `metas`) explicitly state
"60 requests per minute." Live response headers (re-checked for this
phase) show `cache-control: public, max-age=30` via Cloudflare, no
`X-RateLimit-*` headers, unchanged from Phase 2/3. Robinhood's
`/rhj/assets` live response carries no `Cache-Control` header at all —
its "~15s" cache claim is doc-text only, not independently verifiable
from headers.

Since no endpoint-specific number exists, the bulk fetch strategy below
treats the **one number Dexscreener does publish anywhere on this API**
(60 req/min) as the ceiling to design under, rather than assuming a more
generous unconfirmed figure. This is a conservative choice, not a
confirmed guarantee — see "Known limitations."

### Bounded concurrency + rate limiting

`src/lib/concurrency/limiter.ts` is a generic, provider-agnostic
scheduler (not specific to Dexscreener) enforcing two independent
constraints simultaneously:

- **`DEXSCREENER_BULK_CONCURRENCY`** (default `2`) — max requests
  in flight at once.
- **`DEXSCREENER_REQUEST_INTERVAL_MS`** (default `1000`) — minimum
  spacing between successive request *starts*, enforced globally.

The interval, not the concurrency, is what actually caps throughput at
≤60/min: raising concurrency alone doesn't let more requests through per
minute, it only lets slow requests overlap instead of queueing behind
each other's latency. `Promise.all(assets.map(...))` with unconstrained
parallelism is never used.

### Snapshot build time — measured, not guessed

For 194 assets at the default settings, the interval schedule alone
imposes a floor of `(194 − 1) × 1000ms ≈ 193s`. The live smoke test
(below) measured an actual full-snapshot build of **196.8 seconds
(~3.3 minutes)** at an effective rate of **~59.1 requests/minute** — this
is reported directly in every snapshot's `refreshDurationMs`, and the UI
never implies the leaderboard was refreshed at the instant the page
loaded (see "Freshness metadata" below).

### Cache strategy and TTL

`src/lib/cache/ttlCache.ts` is a generic single-value, single-flight,
TTL-based async cache (not specific to market snapshots).
`src/domain/market/cache.ts` wires it to `buildMarketLiquiditySnapshot`:

- **Fresh** (age ≤ TTL): returns the cached snapshot immediately, no
  provider calls.
- **Stale or missing**: calls `produce()` and awaits the result.
- **Single-flight**: if 20 requests arrive while the cache is
  stale/missing, `produce()` still runs exactly once — every caller
  joins the same in-flight promise rather than triggering its own
  194-asset refresh. (Tested directly in `ttlCache.test.ts`.)

**A real bug found and fixed during Phase 4's live verification, worth
documenting because it's non-obvious:** a plain module-level `const
snapshotCache = createTtlCache(...)` is *not* reliably a true singleton
across this app's two entry points. `src/app/page.tsx` and
`src/app/api/market/liquidity/route.ts` are separate Next.js bundler
entries; a live two-request test (cold `/api/market/liquidity`, ~197s,
then `/`) showed the home page triggering an entirely separate ~197s
rebuild instead of reusing the just-built cache — each entry point had
independently evaluated its own copy of the module, defeating
single-flight *between* them (each still correctly single-flighted
*within* itself). The fix: back the singleton with `globalThis`
(`src/domain/market/cache.ts`), which is genuinely process-wide
regardless of which bundle first imports the module — a well-known
pattern for exactly this class of Next.js gotcha (the same one commonly
used for shared DB connections). Re-verified live after the fix: cold
`/api/market/liquidity` (197s) → `/` (0.07s) → `/api/market/liquidity`
again (0.003s), all three sharing one snapshot.

**`MARKET_SNAPSHOT_TTL_MS`** defaults to **5 minutes (300000ms)**. This
is a deliberate departure from a generic "tens of seconds" suggestion:
since building a snapshot itself takes ~3.3 minutes under the
rate-limit-respecting config above, a shorter TTL would mean the
snapshot is already "stale" again almost as soon as it finishes,
degenerating into near-continuous refreshing. 5 minutes gives roughly
1.5× headroom over the measured build time while still refreshing
roughly 10+ times an hour.

Stale-while-revalidate (serving a stale snapshot immediately while
refreshing in the background) was considered and rejected for this
phase: it would add a second code path and a "how stale is too stale to
show" policy decision for a use case a simple block-and-await already
serves correctly, given the TTL is already sized well above the build
time — there's no evidence it's needed yet.

### Partial failure semantics

One broken asset never fails the whole snapshot.
`buildMarketLiquiditySnapshot` uses `Promise.allSettled`, not
`Promise.all`, over the limiter-scheduled per-asset work — every asset's
outcome (success or failure) is collected independently. A failed
asset's contract address and symbol are recorded in `failures[]` with a
stable category (`DEXSCREENER_TIMEOUT`, `DEXSCREENER_NETWORK`,
`DEXSCREENER_HTTP`, `DEXSCREENER_INVALID_RESPONSE`,
`DEXSCREENER_SCHEMA_INVALID`, `POOL_INTEGRITY_CONFLICT`, `UNEXPECTED`)
and a human-readable message — never a raw stack trace, and **never**
converted into `displayedLiquidityUsd: 0`. A zero-pool asset (Dexscreener
genuinely returns `[]`) is a **success** with `poolCount: 0` and
`displayedLiquidityUsd: null` — the live snapshot below found 106 such
assets, correctly present in `rows`, not in `failures`.

### Efficient registry reuse

`buildMarketLiquiditySnapshot` calls `getRobinhoodAssets()` **exactly
once** per snapshot, then calls `getDexScreenerPoolsForAsset(asset)`
directly per already-resolved canonical asset — deliberately *not*
`getDexScreenerPoolsBySymbol`/`getRobinhoodAssetBySymbol`, which would
each re-resolve the canonical registry and turn one snapshot into ~194
additional Robinhood requests. (Verified with a dedicated test asserting
the registry fetch is called exactly once regardless of asset count.)

### Market snapshot domain model

`src/domain/market/types.ts` defines `MarketLiquiditySnapshot` and
`MarketLiquidityRow` — deliberately *not* `profiles`, since a row is a
projection (`projectLiquidityProfileToMarketRow`, pure field selection,
zero arithmetic) of Phase 3's `AssetLiquidityProfile`, not a second
independent liquidity implementation. `refreshStartedAt` +
`generatedAt` + `refreshDurationMs` are all carried on every snapshot,
so "how fresh is this" is always answerable from the data itself, not
implied by when the HTTP response arrived.

### API

#### `GET /api/market/liquidity`

```json
{
  "data": {
    "generatedAt": "2026-08-22T17:19:56.904Z",
    "refreshStartedAt": "2026-08-22T17:16:40.072Z",
    "refreshDurationMs": 196832,
    "assetsRequested": 194,
    "assetsSucceeded": 194,
    "assetsFailed": 0,
    "completeness": { "complete": true, "successPct": 100 },
    "rows": [ { "asset": { "symbol": "NVDA", "...": "..." }, "displayedLiquidityUsd": 4508145.59, "...": "..." } ],
    "failures": []
  },
  "cache": { "status": "fresh", "ageMs": 0, "ttlMs": 300000 }
}
```

`cache` is a sibling of `data`, not nested inside it — it describes
*this response's* freshness, not the market data itself. Errors here can
only come from the Phase 1 registry fetch failing entirely (502/504) —
every per-asset Dexscreener/pool failure is already inside
`data.failures`, never thrown.

### Leaderboard UI

The home page (`src/app/page.tsx`) is now the real leaderboard: a
freshness bar (generated-at, build duration, cache status, N/M
successful), an expandable failures list (native `<details>`, shown only
when incomplete — no dedicated incident UI), and
`MarketLeaderboard` (`src/app/_components/MarketLeaderboard.tsx`, a
client component) rendering Stock / Displayed Liquidity / USDG Liquidity
/ Observed 24h Volume / Pools / DEXes / Top-3 Concentration, sticky
header, horizontal scroll for narrow viewports. The executable-liquidity
disclaimer from Phase 3 is repeated here — a market-wide leaderboard is
exactly where it's most tempting to over-read "liquidity" as "buy
capacity."

`src/app/loading.tsx` provides a visible loading state for the (rare, at
most once per TTL window) case where a visitor's request is the one that
triggers a cold-cache build — this can legitimately take several
minutes, and the loading screen says so rather than showing a blank
page.

### Search / sort behavior

`src/app/_lib/marketTable.ts` — pure, dependency-free functions,
directly unit-tested, with zero network calls:

- **`filterMarketRows(rows, query)`**: case-insensitive substring match
  against symbol or name. Typing in the search box never triggers a
  request — it filters the rows the server already fetched.
- **`sortMarketRowsByColumn(rows, column, direction)`**: numeric sort
  (never lexicographic) over Displayed Liquidity, USDG Liquidity,
  Observed 24h Volume, Pool Count, DEX Count, or Top-3 Concentration.
  Rows with `null` in the sorted column always sort **last**, regardless
  of direction — a documented, deliberate choice (missing data
  deprioritized both ways) rather than nulls flipping to the top on
  ascending sort.

The API's own default row order (`sortMarketRows` in
`src/domain/market/project.ts`: displayed liquidity descending, nulls
last, symbol ascending tie-break) is just the initial client state —
the UI re-sorts client-side from there.

## Running the application

```bash
npm install
cp .env.example .env.local   # optional — sensible defaults apply without it
npm run dev                  # http://localhost:3000
```

```bash
npm test          # vitest — deterministic, no live network required
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # next build (production build)
```

No API keys or secrets are required for any phase — both `/rhj/assets`
and Dexscreener's `/token-pairs/v1` are public, unauthenticated
endpoints. Phase 2/3's single-asset lookups make exactly one Dexscreener
request each, well under any plausible limit. Phase 4's bulk snapshot is
the one place volume matters — see
[Phase 4](#phase-4-bulk-market-snapshot-and-liquidity-leaderboard) above
for the rate-limit evidence and the concurrency/interval strategy built
around it.

Phase 4 configuration (all optional, evidence-based defaults apply if
unset — see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `DEXSCREENER_BULK_CONCURRENCY` | `2` | Max simultaneous Dexscreener requests during a snapshot build. |
| `DEXSCREENER_REQUEST_INTERVAL_MS` | `1000` | Minimum spacing between request starts — the actual rate-limit enforcement. |
| `MARKET_SNAPSHOT_TTL_MS` | `300000` (5 min) | How long a snapshot stays fresh before the next request triggers a rebuild. |

All three validate strictly: unset uses the default, but a *present* value that isn't a positive integer throws immediately rather than silently falling back.

## Project scope

**Implemented (Phase 1):**
- Canonical Robinhood asset registry (fetch, validate, normalize, index).
- `GET /api/assets`.
- A minimal page rendering the registry.

**Implemented (Phase 2):**
- Dexscreener pool discovery for one canonical asset at a time, with
  per-pool canonical-address and chain-ID revalidation.
- `GET /api/assets/{symbol}/pools`.
- `getDexScreenerPoolsForAsset/BySymbol/ByAddress` domain API, gated on
  Phase 1 canonical resolution.

**Implemented (Phase 3):**
- Displayed-liquidity aggregation for one canonical asset at a time:
  total and USDG-specific displayed liquidity, pool/DEX counts,
  concentration (top-1/3/5), largest pool, quote-asset/DEX composition,
  observed cross-pool activity — all with explicit null-vs-zero and
  coverage/completeness semantics.
- `GET /api/assets/{symbol}/liquidity`.
- `buildAssetLiquidityProfile`/`getAssetLiquidityProfileBySymbol/ByAddress`
  domain API, gated on the same Phase 1 → Phase 2 trust chain.
- `/assets/{symbol}` page now shows summary stat cards, quote-asset
  composition, and DEX composition above the existing pool table, with
  the executable-liquidity disclaimer always visible.

**Implemented (Phase 4):**
- Market-wide displayed-liquidity snapshot across all canonical assets,
  built with bounded concurrency + rate-limited spacing (never
  unconstrained `Promise.all`), reusing `buildAssetLiquidityProfile`
  unchanged per asset.
- Single-flight, TTL-based in-memory caching (`src/lib/cache/ttlCache.ts`)
  — concurrent requests during a stale/missing cache share one refresh.
- Explicit partial-failure handling: one broken asset never fails the
  snapshot, is never reported as zero liquidity, and zero-pool assets
  count as successes.
- `GET /api/market/liquidity`.
- The home page is now a real, searchable, sortable market leaderboard
  with freshness metadata and a failures panel — no longer a
  proof-of-consumption table.

**Explicitly NOT implemented yet:**
- Historical snapshots, scheduled/background refresh, a persistent job
  queue.
- Robinhood reference-price comparison, premium/discount, liquidity
  score, price-discrepancy alerts.
- Executable liquidity, Uniswap V3/V4 quote simulation, routing,
  price-impact curves, order simulator.
- PostgreSQL/Drizzle persistence, Redis, background workers, wallet
  connection, trading, transaction signing, authentication, production
  deployment.

These are intentionally out of scope per the project's incremental build
plan; see [Phase 5 direction](#phase-5-direction-not-implemented) below.

## Known limitations

- **Cache is cleared on restart.** The market snapshot cache
  (`src/domain/market/cache.ts`) is an in-memory module-level singleton
  — correct for the current single-instance architecture, but a process
  restart or redeploy means the next request pays the full ~3.3-minute
  cold-build cost again. There is no persistence layer to survive a
  restart yet (see "Why no database yet" below).
- **The single-flight cache is one instance, one process.** If this
  application ever runs as multiple processes/instances without a shared
  cache, each would build and hold its own snapshot independently —
  fine for the current single-instance deployment target, not something
  that scales horizontally as-is.
- **Whole-response schema failure** at each provider's HTTP boundary
  means a single malformed record in an otherwise-valid response takes
  down that entire fetch (for that one asset, in Phase 4's case — not
  the whole snapshot, since it's caught and recorded as one entry in
  `failures[]`). Acceptable for the project's fail-closed posture.
- Phase 4's rate-limit ceiling (60 req/min) is a conservative assumption
  applied to an endpoint with no published limit of its own — see
  "Current provider rate limit" above. If Dexscreener's actual limit for
  this endpoint is materially higher, snapshots build slower than
  strictly necessary; if it's lower, this could still be too aggressive
  (no live evidence of that so far — the live smoke test ran at ~59
  req/min without any rate-limit response).
- No retry logic exists for transient per-asset failures (timeout,
  5xx, network) — a transient blip fails that one asset for this
  snapshot cycle; it gets another chance on the next TTL-triggered
  refresh. This was a deliberate choice, not an oversight (see
  "Rate-limit failure behavior" — retries were optional for this phase
  and were not added without evidence they're needed).
- Pool rejection reasons (`PoolRejectionReason`) and Phase 3's
  `symbolConflict` flag remain computed/tested but without dedicated UI
  treatment beyond the `⚠`/`†` markers already in place.

## Unresolved risks

- Both providers' schemas are undocumented beyond what was observed
  live; an upstream field-shape change surfaces as a
  `*SchemaValidationError` (fails closed, as intended) but there is
  currently no alerting on that beyond the request failing (or, in
  Phase 4, that one asset landing in `failures[]`).
- No live-network smoke test is included in the automated suite (by
  design — core tests stay deterministic). A full live bulk snapshot
  (194/194 succeeded, ~196.8s, ~59.1 req/min effective rate — see the
  Phase 4 completion report) and cross-checks against the direct
  per-asset endpoint were run manually during development but are not
  enforced by CI.
- Dexscreener's actual rate limit for `/token-pairs/v1` remains
  unconfirmed by documentation — the 60/min design ceiling is
  conservative, evidence-adjacent, not evidence-*proven*. A sustained
  429 response would need to be observed to know the true limit; none
  occurred during any live test in this project.
- The activity-aggregation assumption (cross-pool summation reflects
  independent per-pool activity, not provider-side duplication) remains
  based on inspecting one asset's pools at a time — Phase 4's full
  194-asset run didn't contradict it, but that's still consistent
  evidence, not proof, across every asset's every pool.

## Why no database yet

Phase 4 introduces real caching for the first time, which is exactly the
kind of feature that invites "just add Postgres" — deliberately not
done. A `MarketLiquiditySnapshot` is disposable, cheaply rebuildable
current-state data, not a record anything else depends on existing
historically. An in-memory single-value cache is simpler, has zero
operational surface (no connection pool, no migrations, no schema), and
correctly matches what's actually needed: "don't rebuild this for every
request," not "remember this forever." Historical persistence is a
different, real future need (Phase 5+ territory) — it shouldn't be
backed into this phase's cache just because a database would also incur.

## Phase 5 direction (not implemented)

Two candidate directions were identified; **Robinhood reference-price
comparison is the recommended next phase** — it adds another immediately
useful market-quality dimension (DEX price vs. Robinhood's own reference
price, premium/discount) with substantially less protocol complexity
than the alternative:

**A. Robinhood reference price + premium/discount** (recommended):
fetch Robinhood's reference price per asset (`GET
/rhj/prices/{symbol}`, not yet integrated), compare against each pool's
`priceUsd`/the asset's volume-weighted DEX price, and surface
premium/discount on both the per-asset page and the leaderboard.

**B. Executable liquidity engine**: on-chain quoting/simulation
(Uniswap V3/V4) to determine actual swap capacity before a given
price-impact threshold — the "displayed vs. executable" distinction this
project has maintained since Phase 3 finally gets its executable half.
Substantially more protocol complexity (pool-type-specific quoting,
routing across concentrated-liquidity ranges) than option A.

Do not implement either yet.
