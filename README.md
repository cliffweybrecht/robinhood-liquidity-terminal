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
[Phase 4 direction](#phase-4-direction-not-implemented)).

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
endpoints. Dexscreener documents a 60 requests/minute limit on this
endpoint; both Phase 2 and Phase 3 make exactly one Dexscreener request
per asset lookup (one asset at a time, only when a user visits its page
or calls its API route — no bulk/background fetching, no leaderboard),
which stays well under that limit without any additional client-side
rate limiting.

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

**Explicitly NOT implemented yet:**
- Bulk liquidity fetching across all ~194 assets, a home-page
  leaderboard, scheduled/background refresh, request caching, historical
  snapshots.
- Robinhood reference-price comparison, premium/discount, liquidity
  score, price-discrepancy alerts.
- Executable liquidity, Uniswap V3/V4 quote simulation, routing,
  price-impact curves, order simulator.
- PostgreSQL/Drizzle persistence, Redis, background workers, wallet
  connection, trading, transaction signing, authentication, production
  deployment.

These are intentionally out of scope per the project's incremental build
plan; see [Phase 4 direction](#phase-4-direction-not-implemented) below.

## Known limitations

- **No caching layer.** Every call to `getRobinhoodAssets()`,
  `getDexScreenerPoolsFor*()`, or `getAssetLiquidityProfileFor*()`
  performs a fresh upstream fetch (Phase 3 does not add its own —
  aggregation runs on whatever pools Phase 2 just fetched). Both
  providers cache briefly server-side (Robinhood ~15s, Dexscreener's
  response headers advertise `max-age=30`), so this is not incorrect,
  just not optimized. Deliberately deferred across all three phases —
  see [Phase 4 direction](#phase-4-direction-not-implemented), which is
  exactly where a real caching/refresh strategy becomes necessary.
- **Whole-response schema failure** at each provider's HTTP boundary
  means a single malformed record in an otherwise-valid response takes
  down that entire fetch. Acceptable for the project's fail-closed
  posture. Note this is *not* true of individual pool rejection within an
  otherwise-valid Dexscreener response, nor of Phase 3 aggregation over
  pools with partial data — both degrade gracefully (excluded pool /
  `null` aggregate + incomplete coverage) rather than failing outright.
- The asset page is still one-asset-at-a-time by design (see
  [Project scope](#project-scope)) — no cross-asset ranking or comparison
  exists yet.
- Pool rejection reasons (`PoolRejectionReason`) and Phase 3's
  `symbolConflict` flag are computed and tested but have no dedicated UI
  treatment beyond the `⚠` marker on conflicting quote-asset rows.
- Phase 3's coverage tracking is per-metric (`liquidity`,
  `volume{5m,1h,6h,24h}`, `txns{5m,1h,6h,24h}`) but not per
  composition-group — a quote-asset or DEX row's `null` liquidity already
  implies incomplete coverage for that group, but there's no separate
  `QuoteAssetComposition.coverage` field spelling that out.

## Unresolved risks

- Both providers' schemas are undocumented beyond what was observed
  live; an upstream field-shape change surfaces as a
  `*SchemaValidationError` (fails closed, as intended) but there is
  currently no alerting on that beyond the request failing.
- No live-network smoke test is included in the automated suite (by
  design — core tests stay deterministic) — manual `curl` smoke tests
  against `localhost:3000/api/assets/NVDA/{pools,liquidity}` were used to
  confirm live-network behavior, and results were independently
  cross-checked against a fresh raw Dexscreener fetch, but this is not
  enforced by CI.
- Dexscreener's dual-length `pairAddress` behavior (20-byte address vs.
  32-byte Uniswap v4 PoolId) was reverse-engineered from one asset's live
  data (NVDA, 30 pools); it's possible other DEXes on Robinhood Chain use
  a third identifier shape not yet observed.
- The activity-aggregation assumption (cross-pool summation reflects
  independent per-pool activity, not provider-side duplication) is based
  on inspecting one asset's 30 live pools finding no duplicate
  `volume.h24` values — documented as an explicit assumption, not a
  provider guarantee (see "Activity aggregation" above); it should be
  revisited if a future asset's data contradicts it.

## Phase 4 direction (not implemented)

**Bulk market snapshot + liquidity leaderboard**: fetch all canonical
Robinhood assets' liquidity profiles to power a home-page leaderboard.
This needs deliberate design Phase 3 deferred: Dexscreener's 60
req/min limit across ~194 assets, bounded concurrency, per-asset partial
failure handling (one asset's provider error shouldn't blank the whole
leaderboard), request caching with defined freshness/staleness
semantics, and a refresh strategy that avoids 194 sequential requests on
every page load. Phase 3's `buildAssetLiquidityProfile(asset, pools)` is already a pure
function decoupled from fetching, so this is a matter of orchestration
(fetch many assets' pools, call the same aggregation function per asset)
rather than new aggregation logic — the per-asset math doesn't change,
only how many assets get fetched and how often.
