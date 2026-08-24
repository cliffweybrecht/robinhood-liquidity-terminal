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

## Phase 5: Robinhood Reference Price + DEX Price Comparison

Phase 5 adds a second, independent market-quality dimension: **price
dislocation**, not liquidity depth. It answers "how does this asset's
on-chain DEX price compare with Robinhood's own reference price for the
same underlying equity?" It is explicitly **not** executable
liquidity/slippage/price-impact — see "Out of scope" below.

### DEX price semantics — verified live, not assumed

Dexscreener's `priceUsd` is always the **base token's** USD price; there
is no separate "quote-side" price field. Two situations occur depending
on `LiquidityPool.canonicalAssetSide` (Phase 2's field — the only
legitimate basis for this decision, never inferred from symbol/name):

- **`canonicalAssetSide: "base"`** — the canonical Robinhood token is
  the pool's base token, so `priceUsd` already *is* the canonical
  asset's price. Used directly.
- **`canonicalAssetSide: "quote"`** — the canonical token is the quote
  token instead (a decoy/imitation token, e.g. "Apple Cat" `AAPLCAT`, is
  the base). The canonical price is derived as
  `priceUsd / priceNative`, since `priceNative` is the base token's
  price *in units of the quote token* — dividing the base's USD price by
  that ratio yields the quote (canonical) token's own USD price.

**Live proof, reproduced during Phase 5 verification** (see "Live smoke
test results" below for the full run): AAPL pool
`0x719a752f...ba74061c5b6` (`AAPLCAT`/`AAPL`, `canonicalAssetSide:
"quote"`) reported raw `priceUsd: "0.00004943"`,
`priceNative: "0.0000001625"` directly from Dexscreener's API. `0.00004943
/ 0.0000001625 = 304.18461538461536`, matching this system's derived
`canonicalAssetPriceUsd: 304.18461538461537` to full floating-point
precision. The formula was proved against a live pool, not assumed from
documentation.

### Robinhood reference price semantics — verified live, not assumed

`GET /rhj/prices/{symbol}` (and, undocumented but live-confirmed, `GET
/rhj/prices` with no symbol — see "Bulk endpoint discovery" below)
returns a `bid`/`ask` pair, not a single price:

```json
{
  "quotes": [
    {
      "tokenSymbol": "NVDA",
      "bid": "213.00",
      "ask": "217.55",
      "currency": "USD",
      "isTradingHalt": false,
      "generatedAt": "2026-08-22T19:47:38.042029192Z",
      "...": "dailyHigh/dailyLow/dailyTradingVolume/mintBurn*/deployments — observed but not used downstream"
    }
  ]
}
```

This system synthesizes a single reference number as
`rawUnderlyingMidUsd = (bid + ask) / 2` — a documented choice (mid of
the spread), not Robinhood's own "the price." **`bid`/`ask` are the raw
underlying-equity quote, not multiplier-adjusted** — converting to a
token-equivalent price requires `referencePriceUsd = rawUnderlyingMidUsd
* Number(asset.currentMultiplier)`, using Phase 1's already-fetched
`currentMultiplier` string.

**Live evidence that the multiplier must be applied:** CRWD's canonical
asset carries `currentMultiplier: "4.000000000000000000"` (a documented
4-for-1 forward-split adjustment). Its live quote (`bid: "191.01", ask:
"191.8"`) has a raw mid of ~191.4 — implausible against CRWD's real
market price, which is in the ~$750-800 range. `191.4 × 4 ≈ 765.6`,
consistent with the real price. Most other assets carry
`currentMultiplier: "1.000000000000000000"` (a no-op), which is why a
naive spot-check against one of those (e.g. SGOV) looks "correct" even
without applying the multiplier — CRWD's split is the decisive case,
not an average across assets that mostly don't exercise this field.
AAPL's live multiplier (`"1.000566080061092436"`, see the smoke-test
results below) is a further live confirmation that this field is
real-valued and asset-specific, not always exactly `1`.

### Reference price lookups always use the canonical symbol

`getAssetPriceComparisonForAsset`/`ByAddress` resolve through Phase 1's
canonical registry first and pass `asset.symbol` — never a
Dexscreener-reported token label — into
`fetchRobinhoodPriceForSymbol`/`fetchAllRobinhoodPrices`. The full
Phase 1 → Phase 2 trust chain (contract-address validation, chain-ID
check, ambiguous-symbol rejection) gates every price lookup exactly as
it gates every liquidity lookup.

### Provider layer (`src/providers/robinhood-price/`)

A dedicated provider, not merged into `src/providers/robinhood/`
(Phase 1's asset-registry provider) — different endpoint, different
response shape, different schema. `schema.ts` defines
`robinhoodPriceQuoteSchema`/`robinhoodPricesResponseSchema` (numeric
fields are validated as decimal *strings*, matching the live shape, not
coerced to numbers at the schema boundary). `client.ts` exposes
`fetchRobinhoodPriceForSymbol(symbol)` (`GET /rhj/prices/{symbol}`) and
`fetchAllRobinhoodPrices()` (`GET /rhj/prices`, no symbol — the bulk
form). Both deliberately reuse `ROBINHOOD_API_BASE_URL`/
`ROBINHOOD_API_TIMEOUT_MS` rather than introducing duplicate env vars,
since `/rhj/prices` is the same host as `/rhj/assets` with comparable
latency. `errors.ts` mirrors the existing provider error hierarchy
exactly (`RobinhoodPriceNetworkError`/`TimeoutError`/`HttpError`/
`InvalidJsonError`/`SchemaValidationError`).

### Domain layer (`src/domain/price/`)

Also dedicated, not merged into `src/domain/liquidity`. Pure functions,
fully unit-tested with zero live network calls:

- **`deriveCanonicalAssetPriceUsd(pool)`** — the orientation-aware
  formula above, returning `{ priceUsd, derivation }` where
  `derivation` is `CANONICAL_AS_BASE` / `CANONICAL_AS_QUOTE_DERIVED` /
  `UNAVAILABLE` (never silently coerced to `0` when a price can't be
  derived — e.g. `priceNative <= 0` or missing fields).
- **`buildDexPriceSummary(pools)`** — computes **three** independent DEX
  price methodologies, never just one:
  - `largestPoolPriceUsd` — price from the single usable-price pool with
    the greatest liquidity (deterministic pairAddress tie-break).
  - `liquidityWeightedPriceUsd` — `Σ(price·liquidity) / Σ(liquidity)`
    over pools with a usable price **and** `liquidityUsd > 0`.
  - `medianPriceUsd` — median of every usable per-pool price.

  Plus outlier-awareness diagnostics that are never used to silently
  discard data: `minPriceUsd`/`maxPriceUsd`, `priceDispersionPct`
  (`(max − min) / median × 100`, only when `median > 0`),
  `usablePricePoolCount`/`totalPoolCount`/`weightedPricePoolCount`, and
  `priceCoverage`/`weightedPriceCoverage` (reusing Phase 3's `Coverage`
  shape). Every pool — usable or not — remains visible in `pools[]`.
- **`calculatePremiumDiscountPct(dexPriceUsd, referencePriceUsd)`** —
  `(dexPriceUsd − referencePriceUsd) / referencePriceUsd × 100`, `null`
  (never `NaN`/`Infinity`) whenever `dexPriceUsd` is `null` or
  `referencePriceUsd` is not strictly positive.
- **`buildAssetPriceComparison(asset, pools, robinhoodPrice)`** —
  assembles the full comparison, computing premium/discount for **all
  three** DEX methodologies against the same reference price, never
  just one.

### Coverage/outlier diagnostics, exercised live

AAPL's live smoke-test run (below) surfaced a genuine dirty-data pool:
one AAPL pool reported `canonicalAssetPriceUsd: 5.364e-24` (`liquidityUsd:
null`). This is exactly the case the design anticipated — it is
**excluded** from `liquidityWeightedPriceUsd`
(`weightedPricePoolCount: 29` of `30` usable pools) because it has no
liquidity to weight by, but it is **not deleted**: it remains in
`pools[]`, and it correctly widens `priceDispersionPct` to ~104% for
that asset, visibly flagging that AAPL's DEX price picture includes an
extreme outlier rather than hiding it behind a single clean-looking
number.

### Terminology and visual semantics

Robinhood's value is always labeled **"Robinhood Reference"** — never
"True Price" or "Fair Value." The computed difference is always
**"Premium"/"Discount"** — never "arbitrage," "opportunity," or
"mispricing." Both providers' own timestamps are preserved and shown
separately (`robinhood.generatedAt`, this comparison's own
`generatedAt`) — the UI never implies the two prices were observed at
the same instant.

### Public service API (`src/domain/price/service.ts`)

- **`getAssetPriceComparisonForAsset(asset, pools, options)`** — the
  core operation: an already-resolved canonical asset plus an
  already-fetched pool list. The per-asset UI page uses this directly,
  reusing the pools it already fetched for the Phase 3 liquidity
  profile rather than issuing a second Dexscreener round-trip for the
  same asset — a deliberate, documented tradeoff (one extra cheap,
  non-rate-limited Robinhood registry call instead).
- **`getAssetPriceComparisonBySymbol(symbol, options)`** /
  **`getAssetPriceComparisonByAddress(address, options)`** — resolve
  through Phase 1 → Phase 2 first, then call the core function above.
  Inherit `AssetNotFoundError`/`AmbiguousSymbolError` unchanged; throw
  `RobinhoodReferencePriceNotFoundError` if the resolved canonical
  symbol is absent from Robinhood's price response (a genuine upstream
  data inconsistency between Robinhood's own asset and price
  registries, not a client error).

### API

#### `GET /api/assets/{symbol}/price`

```json
{
  "data": {
    "asset": { "symbol": "NVDA", "name": "NVIDIA • Robinhood Token", "contractAddress": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
    "robinhood": {
      "rawUnderlyingBidUsd": 213, "rawUnderlyingAskUsd": 217.55, "rawUnderlyingMidUsd": 215.275,
      "currentMultiplier": "1.000000000000000000", "referencePriceUsd": 215.275,
      "currency": "USD", "isTradingHalt": false,
      "generatedAt": "2026-08-22T19:47:38.042029192Z", "source": "robinhood"
    },
    "dex": {
      "largestPoolPriceUsd": 216.16, "liquidityWeightedPriceUsd": 216.02637823572405, "medianPriceUsd": 216.077,
      "minPriceUsd": 215.055, "maxPriceUsd": 225.59, "priceDispersionPct": 4.875576761987623,
      "usablePricePoolCount": 30, "totalPoolCount": 30, "weightedPricePoolCount": 30,
      "priceCoverage": { "poolsReporting": 30, "poolsMissing": 0, "complete": true },
      "weightedPriceCoverage": { "poolsReporting": 30, "poolsMissing": 0, "complete": true },
      "pools": [ "..." ]
    },
    "comparison": {
      "largestPoolPremiumDiscountPct": 0.4111020787364956,
      "liquidityWeightedPremiumDiscountPct": 0.34903181313392045,
      "medianPremiumDiscountPct": 0.3725467425386099
    },
    "generatedAt": "2026-08-22T19:47:43.140Z"
  }
}
```

Errors follow the same mapping pattern as the other per-asset routes,
extended with `RobinhoodPriceProviderError` (502/504) and
`PriceComparisonError` (502) branches. A genuine "no usable DEX price"
result is a normal `200` with `null` aggregates — not an error.

### Per-asset UI

The `/assets/{symbol}` page adds a "Price" section below the existing
liquidity stat cards: Robinhood Reference (with its bid/ask/multiplier
composition, or "Trading halted"), DEX Liquidity-Weighted, DEX
Premium/Discount, DEX Price Range (min–max with a dispersion sub-label),
Largest-Pool Price, Largest-Pool Premium/Discount, DEX Median, Median
Premium/Discount, and Price Coverage. A methodology disclosure sentence
is always visible: *"DEX price is derived from validated pools.
Premium/discount compares that observed DEX price with Robinhood's
reference price; data sources may be observed at different times."* A
price-fetch failure renders its own inline error and never blanks the
liquidity section above it — the two are fetched and rendered
independently.

### Bulk endpoint discovery — a real simplification vs. the anticipated design

The Phase 5 spec anticipated needing new rate-limiting infrastructure
for ~194 individual `/rhj/prices/{symbol}` calls (mirroring Phase 4's
Dexscreener limiter). Live investigation found this unnecessary:
`GET /rhj/prices` with **no** symbol suffix is undocumented but returns
**all 194 quotes in a single ~2.6s request**. `fetchAllRobinhoodPrices()`
uses this directly — no per-symbol limiter, no new
`ROBINHOOD_PRICE_*_CONCURRENCY`/`INTERVAL_MS` env vars, because there is
no per-symbol loop to rate-limit. Dexscreener's existing
`DEXSCREENER_BULK_CONCURRENCY`/`DEXSCREENER_REQUEST_INTERVAL_MS` config
is not reused for this provider — it governs a fundamentally different,
per-asset rate-limited loop that Robinhood's price fetch simply doesn't
have.

### Market-wide integration (`src/domain/market`)

`buildMarketLiquiditySnapshot` starts the bulk price fetch concurrently
with (not after) the rate-limited per-asset Dexscreener loop, then
merges by canonical symbol once both finish. Its failure is converted
via `.then(ok => ..., () => ({ ok: false }))` — it can never throw and
can never fail the liquidity snapshot.

Three-way distinction, kept as separate signals rather than one
ambiguous boolean (`MarketPriceMeta`, a sibling of `rows`/`failures`):

```ts
interface MarketPriceMeta {
  available: boolean;        // did the bulk price fetch itself succeed?
  generatedAt: string | null;
  symbolsMatched: number;    // canonical symbols found in the price response
  symbolsMissing: number;    // canonical symbols absent from it
}
```

Per-row price fields (`robinhoodReferencePriceUsd`,
`dexLiquidityWeightedPriceUsd`, `premiumDiscountPct`,
`priceDispersionPct`, `priceCoverageComplete`) default to `null` and are
filled in only when `price.available` is `true` **and** that specific
asset's symbol was present in the bulk response — a liquidity success
with a missing/failed price is never converted into a fabricated `0`,
and a total price outage never removes or nulls out any row's already-
computed liquidity metrics. This is directly exercised by dedicated
tests (`snapshot.test.ts`, "Phase 5 price integration" describe block):
price success, whole-bulk-fetch failure, one symbol missing from the
response, a zero-pool asset with a valid reference price (no fabricated
DEX comparison), and confirmation that the Dexscreener and
Robinhood-price fetches run independently (one failing doesn't block or
alter the other's results).

Row sort order (`sortMarketRows`, unchanged from Phase 4: displayed
liquidity descending, nulls last, symbol ascending tie-break) is still
liquidity-based, not price-based — price availability does not disturb
the existing deterministic ordering.

### Caching — price data shares the liquidity snapshot's TTL, deliberately

Robinhood reference prices are **not** given an independent cache
lifetime. They're fetched once per `buildMarketLiquiditySnapshot()`
call and therefore implicitly share the existing 5-minute
`MARKET_SNAPSHOT_TTL_MS` window along with the liquidity data it's
merged into — a deliberate choice, not an oversight: the two datasets
are consumed together on every row, a snapshot is already rebuilt from
scratch every 5 minutes regardless, and Robinhood's own quotes don't
publish a cache-control lifetime of their own to size a separate TTL
against. The single-asset `GET /api/assets/{symbol}/price` route is
uncached (`force-dynamic`, same as every other single-asset route) —
independent per-request freshness there was never in question.

### Testing

`src/providers/robinhood-price/__tests__/` (schema + client, 19 tests):
valid/invalid quote shapes, bulk vs. single-symbol URL construction, 404
unknown-symbol handling, network/timeout/invalid-JSON/schema-invalid
failures. `src/domain/price/__tests__/dex-price.test.ts` (25 tests):
base-side and quote-side derivation (using the exact live COST/HOTDOG
numbers as a fixture), orientation determined only by
`canonicalAssetSide` never by symbol, zero/negative `priceNative`
denominators, largest-pool tie-breaking, weighted-average math,
median odd/even, min/max/dispersion, all-missing/some-missing prices,
zero- and negative-liquidity pools excluded from weighting but not
deleted from the pool list, deterministic ordering, empty-pools case.
`compare.test.ts` (13 tests): mid computation, multiplier scaling
(including the documented CRWD 4-for-1 case), premium/discount sign and
edge cases (zero/negative reference, null DEX price, never NaN/
Infinity), full assembly. `service.test.ts`: symbol/address resolution
end-to-end, unknown/ambiguous-symbol/malformed-address short-circuits
(no downstream calls), Dexscreener/Robinhood-price failure propagation,
missing-symbol-in-price-response error. `snapshot.test.ts` "Phase 5
price integration": the market-integration scenarios listed above.

### Live smoke test results

Run against the real Robinhood and Dexscreener APIs for NVDA, AAPL, and
MSFT (`RUN_LIVE_SMOKE=1 npx vitest run
src/domain/price/__tests__/live-smoke.manual.test.ts` — skipped by
default in `npm test`, kept as an on-demand tool rather than a
one-off script):

| Symbol | Robinhood mid | Multiplier | Reference | Largest-pool | Weighted | Median | Min–Max | Dispersion | Pools (usable/total) | Weighted premium/discount |
|---|---|---|---|---|---|---|---|---|---|---|
| NVDA | 215.275 | 1.0 | 215.275 | 216.16 | 216.0264 | 216.077 | 215.055–225.59 | 4.88% | 30/30 | +0.349% |
| AAPL | 310.90 | 1.000566 | 311.076 | 309.24 | 309.5543 | 309.925 | 5.364e-24–323.38 | 104.34% | 30/30 | −0.489% |
| MSFT | 483.20 | 1.0 | 483.200 | 484.11 | 484.10999502 | 484.048 | 481.384–498.011 | 3.43% | 19/19 | +0.188% |

All six invariant checks passed for all three assets: liquidity-weighted
and median prices fall within `[min, max]`; the largest-pool price
matches the actual highest-liquidity usable pool; premium/discount sign
agrees with the underlying price comparison's sign; no numeric field is
`NaN`/`Infinity`; `priceCoverage.poolsReporting + poolsMissing ===
totalPoolCount`; `usablePricePoolCount === priceCoverage.poolsReporting`.
AAPL's extreme dispersion is the outlier pool documented above — the
diagnostics surfaced it correctly rather than smoothing it away.

**Manual quote-side derivation proof** (mandatory, done against a live
pool rather than only the earlier COST/HOTDOG fixture): AAPL pool
`0x719a752f07c591328c94ba2d1cb44f11d0eafb98f3caf67566c33ba74061c5b6`
(`AAPLCAT`/`AAPL`, `canonicalAssetSide: "quote"`) — raw Dexscreener
`priceUsd: "0.00004943"`, `priceNative: "0.0000001625"`. `0.00004943 /
0.0000001625 = 304.18461538461536`, matching this system's derived
`canonicalAssetPriceUsd: 304.18461538461537` (floating-point rounding
only).

### Hardening pass (post-independent-review, still Phase 5)

Four correctness/observability gaps were identified during independent
review of the uncommitted Phase 5 diff and fixed before commit. Not a
redesign — the core Phase 5 architecture (provider layer, domain layer,
API shape, per-asset UI) is unchanged; these are targeted fixes.

**1. Reference-price domain validation.** `buildRobinhoodReferencePrice`
previously trusted `Number(bid)`/`Number(ask)`/`Number(currentMultiplier)`
almost entirely to the upstream Zod schema, which only guarantees
numeric-*looking* strings — not finiteness, non-negativity, or a
sane bid/ask relationship. It now explicitly validates, before
constructing a `RobinhoodReferencePrice`: `bid`/`ask` finite and `>= 0`;
`currentMultiplier` finite and `> 0`; and `bid <= ask` (a crossed
market is rejected, never silently averaged into a midpoint). Any
violation throws a typed `PriceComparisonError` subclass —
`InvalidReferenceQuoteError` (bad bid/ask/multiplier) or
`CrossedReferenceMarketError` (bid > ask) — never a fabricated
`NaN`/negative/zero-from-invalid-input reference price. For the
market-wide snapshot, one invalid quote is caught per-asset and tracked
(see `symbolsInvalid`/`invalidSymbols` below) rather than throwing out
of `buildMarketLiquiditySnapshot()` and aborting all ~194 assets — for
the single-asset API/page, it propagates as a normal `PriceComparisonError`
(502), exactly like the pre-existing `RobinhoodReferencePriceNotFoundError`.

**2. Outlier resistance — evidence and decision.** Before writing any
outlier-filtering code, live per-pool price deviation from the median
was inspected across eight liquid assets (NVDA, AAPL, MSFT, TSLA,
GOOGL, AMZN, META, COST). Finding: among pools that are already
liquidity-weighting-eligible (`liquidityUsd > 0`), deviation from the
median ranged continuously from ~1% to **8.36%** (AMZN) with no natural
gap separating "legitimate cross-DEX dispersion" from "garbage" — a
fixed threshold anywhere in that range would either exclude genuine,
meaningfully-liquid pools (AMZN's outlier pools carried $1.6k–$80k of
liquidity) or fail to catch anything at all. The one dramatic outlier
actually observed (an NVDA pool priced at `0.00762` against a `~218.68`
median, a 100% deviation) already had `liquidityUsd: 0` and was
*already* excluded from `liquidityWeightedPriceUsd` by the existing
`liquidityUsd > 0` filter — the failure mode the design was worried
about (a garbage price with *positive* liquidity materially moving the
headline number) was not observed live. Per the explicit fallback
instruction for this situation: **no arbitrary threshold was
implemented.** Instead, `medianPriceUsd` is now the headline DEX price
basis everywhere a single number is needed — the market-wide
`MarketLiquidityRow.premiumDiscountPct`/`dexMedianPriceUsd` (new field)
and the per-asset page's primary "DEX Premium / Discount" card.
`liquidityWeightedPriceUsd` (and its premium/discount) remain fully
computed and exposed, unfiltered, exactly as originally implemented —
now labeled as a raw diagnostic, not the headline. No fields were
removed and no computation changed in `dex-price.ts`; this is a
headline-selection change in `domain/market/snapshot.ts` and the
per-asset UI only.

**3. Bulk symbol-mismatch observability.** `MarketPriceMeta` previously
exposed `symbolsMissing` as a count with no way to identify *which*
canonical symbols were absent from the bulk Robinhood price response.
It now also carries `missingSymbols: string[]` — canonical registry
symbols only (never a Dexscreener label, never fuzzy-matched),
deterministically sorted ascending, empty when nothing is missing or
when the whole bulk fetch is unavailable (enumerating all ~194 symbols
in that case would be redundant with `available: false`). A missing
symbol's price fields stay `null`, exactly as before — this is
observability, not a behavior change. The same pattern was extended to
the new invalid-quote case from item 1: `symbolsInvalid`/
`invalidSymbols` name symbols that *were* present in the bulk response
but failed domain validation — a genuinely different failure mode from
"absent," so it is never merged into `missingSymbols`.

**4. Price freshness metadata.** `MarketPriceMeta.generatedAt` is this
application's snapshot-completion time, not Robinhood's own quote time
— a materially different thing. `MarketPriceMeta` now also carries
`oldestQuoteGeneratedAt`/`newestQuoteGeneratedAt`, computed from every
individual quote's own `generatedAt` field in the bulk response (`null`
when the bulk fetch is unavailable). No new cache, database, or cron —
this reads timestamps Robinhood was already sending. The per-asset
page's existing disclosure sentence already covered this ("data sources
may be observed at different times"); it was tightened to name the two
sources explicitly: *"Robinhood reference quotes and DEX pool
observations may be captured at different times."* No claim is made,
anywhere, that DEX and Robinhood observations are synchronized.

### Out of scope (Phase 5)

Executable liquidity, slippage, price-impact curves, swap simulation,
routing/quoting, RPC/on-chain reads, trading, wallet connection,
database/Redis persistence, scheduled/background jobs, and
authentication remain unimplemented — see "Project scope" and
"[Phase 6 direction](#phase-6-direction-not-implemented)" below.

## Phase 6A: Robinhood Chain RPC Foundation

Phase 6A implements exactly one thing: a fail-closed, typed,
deterministic Robinhood Chain JSON-RPC provider (`src/providers/
robinhood-rpc/`) that later Phase 6 work (protocol classification,
on-chain pool identity, executable quoting) can safely depend on. It
does **not** implement any of that later work — no Uniswap adapters, no
PoolId resolution, no executable quotes, no price-impact math, no
routing, no UI changes. See "Phase 6 direction" below for what's still
ahead.

### The trust boundary — three distinct claims, only two proved here

1. **RPC transport success** — the HTTP request succeeded and the
   response body is a well-formed JSON-RPC 2.0 message for the exact
   request sent (matching id, `jsonrpc: "2.0"`, a `result` or a
   well-formed `error`). A `200 OK` HTTP status is **never** treated as
   sufficient evidence of this on its own — every state-reading
   operation independently validates the full JSON-RPC envelope.
2. **Robinhood Chain verification** — the endpoint reports chain ID
   `4663` (`0x1237`). Proved **structurally**, not by caller convention:
   the only way to obtain a usable client at all is
   `createVerifiedRobinhoodRpcClient()`, and construction fails closed
   unless the endpoint reports `4663`. There is no exported function
   that reads chain state without having gone through that check first
   — see "Hardening pass" below for why this changed from the original
   Phase 6A design.
3. **Pool identity verification** — that some on-chain address/PoolId is
   genuinely the pool Dexscreener claims it is, for the protocol
   Dexscreener claims it uses. **Not proved by anything in Phase 6A.**
   This is the next layer, and it is deliberately not implemented yet.

The eventual full trust chain, once later Phase 6 work lands:

```
canonical Robinhood asset (Phase 1)
  → validated Dexscreener discovery (Phase 2)
  → protocol classification (not yet implemented)
  → on-chain pool identity verification (not yet implemented)
  → token metadata verification (not yet implemented)
  → executable quote (not yet implemented)
```

Phase 6A only establishes the RPC transport that the unimplemented
layers will eventually build on — it does not attempt any of them.

### Hardening pass — verification is structural, not a caller convention

The original Phase 6A design exported five independent functions
(`getChainId`, `getBlockNumber`, `getCode`, `call`,
`verifyRobinhoodChainConnection`) and documented "call
`verifyRobinhoodChainConnection` once before trusting the others."
Independent architectural review correctly flagged this as too weak for
infrastructure that later on-chain pool identity and executable-quoting
work will build on: nothing *structurally* prevented calling
`getBlockNumber`/`getCode`/`call` directly against an unverified
endpoint — the API documented the right order but did not enforce it.

The fix: the only exported entry point into this module's state-reading
capability is now

```ts
const rpc = await createVerifiedRobinhoodRpcClient(options);
// rpc.chainId === 4663, guaranteed — or the promise above already rejected.
await rpc.getBlockNumber();
await rpc.getCode(address, blockTag?);
await rpc.call({ to, data }, blockTag?);
```

`getChainId`/`getBlockNumber`/`getCode`/`call` are now module-private.
Successful construction of a `VerifiedRobinhoodRpcClient` is itself the
proof that the connection was verified — there is no code path that
produces a usable client without having proven the chain ID first, and
no exported function whose name could be mistaken for an
already-verified operation when it isn't one. `verifyRobinhoodChainConnection`
as a standalone export was removed entirely — its logic (call
`eth_chainId`, compare to `4663`, throw `RobinhoodRpcWrongChainError`
otherwise) now lives inside the factory, since a separate public
function performing the same check would just reintroduce a second,
bypassable path.

Verification still happens **exactly once**, at construction — the
factory never re-checks `eth_chainId` before an individual
`getBlockNumber`/`getCode`/`call`, matching the original design's
"don't re-handshake per call" reasoning, which review confirmed was
correct. The resolved `rpcUrl`/`timeoutMs` are captured in a closure at
construction time and reused for every subsequent call on that client,
so a client's calls are guaranteed to target the exact endpoint that
was verified — even if `process.env.ROBINHOOD_RPC_URL` were somehow
mutated afterward.

### Configuration — `ROBINHOOD_RPC_URL` has no default

Unlike every other provider's base URL in this project (each has a real
public default), `ROBINHOOD_RPC_URL` is **required** — there is no
value safe to silently fall back to. Guessing wrong here means talking
to the wrong chain entirely, which is exactly what this module exists
to prevent. Missing, empty, or non-http(s) configuration fails
immediately with a typed `RobinhoodRpcConfigError`, thrown out of
`createVerifiedRobinhoodRpcClient` before any network request.
`ROBINHOOD_RPC_TIMEOUT_MS` is optional (default 8000ms), following the
same pattern as every other provider's timeout config.

### RPC operations implemented

Exactly three generic, protocol-agnostic state-reading operations,
reachable only via a verified client's methods — no protocol-specific
functionality, no Multicall, no log/event scanning, no transaction
submission:

- **`rpc.getBlockNumber()`** — `eth_blockNumber`, returns a `bigint`
  (never a floating-point `number` — block numbers are chain
  quantities).
- **`rpc.getCode(address, blockTag?)`** — `eth_getCode`. `address` is
  validated as a 20-byte EVM address *before* any network request.
  `"0x"` is a valid, successful result meaning "no code at this
  address" — returned exactly as `"0x"`, never coerced to `null`,
  `false`, or treated as failure.
- **`rpc.call({to, data}, blockTag?)`** — `eth_call`. Both `to` and
  `data` are validated before any network request. Returns raw
  validated hex bytes — **no ABI decoding**, no knowledge of Uniswap,
  pools, PoolIds, token decimals, or Dexscreener. That belongs in a
  protocol-specific layer above this one, not implemented yet.

`eth_chainId` itself is not separately exposed — it's an implementation
detail of `createVerifiedRobinhoodRpcClient`, and its result is
surfaced only as the client's `chainId` property (always `4663` on a
successfully-constructed client).

Block tags support `"latest"` and an explicit non-negative `bigint`
block number — enough for a future service to pin multiple related
reads to the same block, without committing to every Ethereum block-tag
variant (`"pending"`, `"safe"`, `"finalized"`, …) this codebase has no
present use for.

### Address vs. PoolId — foundational for later Phase 6 work

`getCode`/`call` destinations accept **only** valid 20-byte (`0x` + 40
hex) addresses. A 32-byte Uniswap V4 PoolId (`0x` + 64 hex, the same
shape Phase 2's pool discovery already had to handle — see
`src/domain/pool/address.ts`) is rejected before any network request —
never truncated, coerced, or reinterpreted. This distinction matters
now, before any protocol-specific code exists, precisely so it can't be
gotten wrong later under time pressure.

### Hex/bigint normalization (`src/lib/evm/hex.ts`)

Two distinct hex shapes, deliberately never conflated:

- **Hex bytes** (`isHexBytes`) — `0x` + an *even* number of hex digits.
  Used for bytecode/calldata. `"0x"` (zero bytes) is valid.
- **Hex quantities** (`isHexQuantity`) — `0x` + *at least one* hex
  digit, odd counts allowed. Used for `eth_chainId`/`eth_blockNumber`
  results and explicit block-number parameters.

`hexQuantityToBigInt` parses a validated quantity into a `bigint` —
chain quantities are never run through `parseInt` or any
floating-point path; a block number like `0xffffffffffffffff` parses
exactly, without the precision loss a `Number()` conversion would cause
past `Number.MAX_SAFE_INTEGER`.

### Error model

Every failure mode is a distinct, typed `RobinhoodRpcError` subclass —
network failure, timeout, non-2xx HTTP, invalid JSON, malformed
JSON-RPC response (wrong version / missing or mismatched id / neither
result nor error present), a JSON-RPC-level error response, an
invalid/malformed result shape, invalid address input, invalid hex
bytes input, invalid block tag input, missing/invalid configuration,
and — most explicitly — `RobinhoodRpcWrongChainError`, carrying both
`expectedChainId` (4663) and the `actualChainId` actually reported (the
only failure mode that can only occur inside
`createVerifiedRobinhoodRpcClient`, never from a state-reading call on
an already-verified client). Nothing is ever silently swallowed into a
fabricated result.

### Request-id counter — deliberately left unbounded

Each JSON-RPC request gets a fresh id from a simple per-process
incrementing counter, with no rollover handling. This was inspected
during the hardening pass and left as-is: reaching
`Number.MAX_SAFE_INTEGER` would require ~9 quadrillion RPC calls within
one process's lifetime, which isn't realistic for this application, and
a rollover branch could not be meaningfully unit-tested without either
exposing private module state (defeating the point of it being private)
or actually looping billions of times. Adding untestable code for a
threat that isn't real at this scale was judged worse than leaving the
counter simple.

### Testing

Normal tests (`npm test`) are completely network-independent — every
JSON-RPC response is mocked via an injectable `fetchImpl`, exactly like
every other provider in this project. Coverage includes: construction
success/wrong-chain/malformed-chain-quantity/config-failure, with
explicit assertions that a failed construction never yields a client at
all; that state-reading calls on an already-verified client never issue
a second `eth_chainId` request; block-number parsing including a value
beyond `Number.MAX_SAFE_INTEGER`; `getCode`/`call` success, `"0x"`
preserved as success, malformed bytecode/calldata rejected, invalid
address and PoolId-shaped input rejected *before* any state-operation
network call; and JSON-RPC transport correctness (non-2xx HTTP, timeout
distinct from network failure, invalid JSON, a JSON-RPC error object,
missing/mismatched response id, wrong `jsonrpc` version, a response
with neither/both `result`/`error`) exercised both at construction and
on a post-construction state call, proving the shared transport
validation applies identically in both contexts.

An opt-in live smoke test
(`src/providers/robinhood-rpc/__tests__/live-smoke.manual.test.ts`),
gated by `RUN_LIVE_SMOKE=1` exactly like Phase 5's, proves only that
`createVerifiedRobinhoodRpcClient()` succeeds against the configured
endpoint and that the resulting client's `getBlockNumber()` returns a
plausible current block — deliberately narrow, with no
Dexscreener/Uniswap/token/pool dependency:

```bash
RUN_LIVE_SMOKE=1 npx vitest run src/providers/robinhood-rpc/__tests__/live-smoke.manual.test.ts
```

### Out of scope (Phase 6A)

Protocol classification, Uniswap V2/V3/V4 adapters, PoolId resolution,
pool-state reconstruction, executable quotes, price-impact calculation,
executable depth, multi-pool aggregation, routing, wallet functionality,
transaction construction/signing, database functionality, market-wide
RPC refreshes, and any UI change remain unimplemented — this phase is
transport only. See [Phase 6 direction](#phase-6-direction-not-implemented)
below for what comes next.

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
endpoints, and `ROBINHOOD_RPC_URL` (Phase 6A) is a plain RPC endpoint
URL, not a credential. Phase 2/3's single-asset lookups make exactly
one Dexscreener request each, well under any plausible limit. Phase 4's
bulk snapshot is the one place volume matters — see
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

Phase 5 introduces no new required configuration — `fetchRobinhoodPriceForSymbol`/`fetchAllRobinhoodPrices` reuse `ROBINHOOD_API_BASE_URL`/`ROBINHOOD_API_TIMEOUT_MS` (see "Phase 5: Bulk endpoint discovery" above for why no rate-limit config was needed).

Phase 6A introduces the project's first genuinely **required**
configuration value — but only for code that actually calls the new RPC
provider, which nothing in the running app does yet (no route or page
wires it in). `npm run dev`/`build`/`test` all work with no
`ROBINHOOD_RPC_URL` set at all.

| Variable | Default | Purpose |
|---|---|---|
| `ROBINHOOD_RPC_URL` | *(none — required to use the RPC provider)* | JSON-RPC endpoint for Robinhood Chain. See "Phase 6A" above — no public default exists or is safely guessable. |
| `ROBINHOOD_RPC_TIMEOUT_MS` | `8000` | Timeout for outbound Robinhood Chain RPC requests. |

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

**Implemented (Phase 5):**
- Robinhood reference price (`GET /rhj/prices/{symbol}` and the
  live-discovered bulk `GET /rhj/prices`) compared against three DEX
  price methodologies (largest-pool, liquidity-weighted, median) with
  outlier-aware diagnostics (min/max, dispersion, coverage) and
  premium/discount for all three, never fabricated as zero on partial
  failure.
- `GET /api/assets/{symbol}/price`.
- `getAssetPriceComparisonForAsset/BySymbol/ByAddress` domain API,
  gated on the same Phase 1 → Phase 2 trust chain, always resolving the
  Robinhood price lookup by canonical symbol.
- `/assets/{symbol}` page now shows a "Price" section with the
  Robinhood reference price, all three DEX price methodologies, their
  premium/discount, and price coverage — labeled with neutral
  "Premium"/"Discount" terminology and both providers' own timestamps.
- Market-wide leaderboard rows (`GET /api/market/liquidity`) now carry
  the same reference price/premium-discount fields, filled in only when
  Robinhood's bulk price fetch succeeds and matches that row's symbol —
  a whole-fetch failure or one missing symbol never touches that row's
  already-computed liquidity metrics.
- **Hardening pass** (see above): domain-level reference-quote
  validation with typed errors and crossed-market rejection; a
  median-based headline DEX price (`dexMedianPriceUsd`) chosen over
  liquidity-weighted after live evidence found no defensible outlier
  threshold, with liquidity-weighted retained as a raw diagnostic;
  `missingSymbols`/`invalidSymbols` naming exactly which canonical
  symbols lack a valid bulk price and why; and
  `oldestQuoteGeneratedAt`/`newestQuoteGeneratedAt` freshness metadata
  for the bulk price response.

**Implemented (Phase 6A):**
- A generic, protocol-agnostic Robinhood Chain JSON-RPC provider
  (`src/providers/robinhood-rpc/`), built around one factory —
  `createVerifiedRobinhoodRpcClient()` — that verifies chain ID 4663 at
  construction and returns a client exposing `getBlockNumber`/`getCode`/
  `call`. Chain verification is structural, not a caller convention:
  there is no exported function that reads chain state without having
  gone through the factory first — see "Hardening pass" above.
- Full JSON-RPC 2.0 response correctness validation (id match, version,
  result-vs-error) — a `200 OK` HTTP status is never treated as
  sufficient evidence of RPC success.
- Fail-closed address/PoolId safety: a 32-byte PoolId-shaped value is
  rejected before any network request wherever a 20-byte address is
  required, never truncated or coerced.
- Bigint-based chain-quantity handling (`src/lib/evm/hex.ts`) — no
  floating-point block numbers or chain IDs.
- Not wired into any route, page, or existing domain layer yet — this
  phase is transport only. See "Phase 6A" above.

**Explicitly NOT implemented yet:**
- Historical snapshots, scheduled/background refresh, a persistent job
  queue.
- Liquidity score, price-discrepancy alerts, or any automated
  significance/threshold judgment on the premium/discount numbers
  Phase 5 exposes.
- Protocol classification, Uniswap V2/V3/V4 adapters, PoolId
  resolution, pool-state reconstruction, executable quotes,
  price-impact calculation, executable depth, multi-pool aggregation,
  routing, order simulator.
- PostgreSQL/Drizzle persistence, Redis, background workers, wallet
  connection, trading, transaction signing/submission, authentication,
  production deployment.

These are intentionally out of scope per the project's incremental build
plan; see [Phase 6 direction](#phase-6-direction-not-implemented) below.

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
- **Robinhood price data shares the market snapshot's cache/TTL, not an
  independent one** — see "Phase 5: Caching" above. If Robinhood's
  quotes update on a materially different cadence than Dexscreener's
  pool data, the shared 5-minute window is a simplification, not a
  precision guarantee either provider's own freshness promises.
- **The mid-of-bid-ask synthesis is this system's own choice, not
  Robinhood's.** `rawUnderlyingMidUsd = (bid + ask) / 2` collapses a
  two-sided quote into one number for comparison purposes; the raw
  `bid`/`ask` remain available on `RobinhoodReferencePrice` for anyone
  who wants the spread itself rather than its midpoint.
- Premium/discount numbers are presented with no significance
  threshold, confidence interval, or "this matters" judgment attached —
  intentionally left for a human to interpret, not classified into
  "notable" vs. "noise" by this system.

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
- The quote-side derivation formula (`priceUsd / priceNative`) and the
  multiplier-application formula are each proved against one live
  example (an AAPL pool; CRWD's 4-for-1 split) — strong, decisive
  evidence, but not an exhaustive check across all 194 assets' every
  pool. An asset with a currently-unknown edge case (e.g. a multiplier
  that changes mid-session, or a pool type with different native-price
  semantics) has not been individually verified.
- The undocumented bulk `GET /rhj/prices` endpoint is empirically real
  (live-confirmed, all 194 quotes in ~2.6s) but unpublished — Robinhood
  could change or remove it without notice, since it isn't a documented
  contract. `fetchRobinhoodPriceForSymbol` (the documented per-symbol
  form) remains available as a fallback path, just not currently wired
  into the market-wide snapshot.

## Why no database yet

Phase 4 introduces real caching for the first time, which is exactly the
kind of feature that invites "just add Postgres" — deliberately not
done. A `MarketLiquiditySnapshot` is disposable, cheaply rebuildable
current-state data, not a record anything else depends on existing
historically. An in-memory single-value cache is simpler, has zero
operational surface (no connection pool, no migrations, no schema), and
correctly matches what's actually needed: "don't rebuild this for every
request," not "remember this forever." Historical persistence is a
different, real future need (Phase 6+ territory) — it shouldn't be
backed into this phase's cache just because a database would also incur.

## Phase 6 direction (not implemented)

With both displayed liquidity (Phase 3/4) and price dislocation
(Phase 5) now covered, the remaining candidate direction is:

**Executable liquidity engine**: on-chain quoting/simulation (Uniswap
V3/V4) to determine actual swap capacity before a given price-impact
threshold — the "displayed vs. executable" distinction this project has
maintained since Phase 3 finally gets its executable half. This requires
RPC access to Robinhood Chain, pool-type-specific quoting logic
(constant-product vs. concentrated-liquidity math), and routing across
multiple pools/ranges — substantially more protocol complexity than
either Phase 3/4 (aggregation) or Phase 5 (a bid/ask/mid comparison).

Phase 6A (above) built the RPC access layer this requires — a generic,
protocol-agnostic transport only. Still ahead, none of it implemented:
protocol classification (identifying which pools are Uniswap V2/V3/V4
and reconciling that against Dexscreener's own labels), on-chain PoolId
resolution, pool-state reconstruction, executable quote/price-impact
math, and routing across multiple pools.

Do not implement any of that yet.
