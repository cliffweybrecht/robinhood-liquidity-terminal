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
**not** aggregate liquidity across pools, compare against Robinhood's
reference price, or attempt executable liquidity — those remain later
phases (see [Phase 3 direction](#phase-3-direction-not-implemented)).

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

No API keys or secrets are required for either phase — both `/rhj/assets`
and Dexscreener's `/token-pairs/v1` are public, unauthenticated
endpoints. Dexscreener documents a 60 requests/minute limit on this
endpoint; Phase 2 makes exactly one Dexscreener request per pool
discovery call (one asset at a time, only when a user visits its page or
calls its API route — no bulk/background fetching), which stays well
under that limit without any additional client-side rate limiting.

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
- `/assets/{symbol}` page showing the normalized pool list (DEX, pair,
  addresses, liquidity, volume, buys/sells, Dexscreener link).

**Explicitly NOT implemented yet:**
- Liquidity aggregation across pools (total, USDG-specific, or
  cross-pool volume), ranking/leaderboard, liquidity score.
- Robinhood reference-price comparison, premium/discount.
- Executable liquidity, Uniswap V3/V4 quoting, routing, order simulator.
- Historical data, PostgreSQL/Drizzle persistence, Redis, background
  workers, charts, alerts, wallet connection, trading, authentication,
  production deployment.

These are intentionally out of scope per the project's incremental build
plan; see [Phase 3 direction](#phase-3-direction-not-implemented) below.

## Known limitations

- **No caching layer.** Every call to `getRobinhoodAssets()` or
  `getDexScreenerPoolsFor*()` performs a fresh upstream fetch. Both
  providers cache briefly server-side (Robinhood ~15s, Dexscreener's
  response headers advertise `max-age=30`), so this is not incorrect,
  just not optimized. Deliberately deferred for both phases — introducing
  caching prematurely would add complexity (invalidation, staleness
  policy, and now two providers) before there's a proven need.
- **Whole-response schema failure** at each provider's HTTP boundary
  (see above) means a single malformed record in an otherwise-valid
  response takes down that entire fetch. Acceptable for the project's
  fail-closed posture; may need refinement if upstream data quality
  turns out to be inconsistent. Note this is *not* true of individual
  pool rejection within an otherwise-valid Dexscreener response — a
  malformed or non-participating pool is excluded, not a batch failure
  (see [Zero pools vs. provider failure](#zero-pools-vs-provider-failure)).
- The asset-pools page is a minimal proof of consumption (DEX, pair,
  liquidity, volume, buys/sells, link) — not the liquidity leaderboard or
  aggregate metrics described in the product vision.
- Pool rejection reasons (`PoolRejectionReason` — wrong chain, invalid
  address, doesn't contain canonical asset, etc.) are computed and
  tested but not currently surfaced through the HTTP API or UI, only
  used internally to decide inclusion/exclusion.

## Unresolved risks

- Both providers' schemas are undocumented beyond what was observed
  live; an upstream field-shape change surfaces as a
  `*SchemaValidationError` (fails closed, as intended) but there is
  currently no alerting on that beyond the request failing.
- No live-network smoke test is included in the automated suite (by
  design — core tests stay deterministic) — manual `curl` smoke tests
  against `localhost:3000/api/assets` and
  `localhost:3000/api/assets/NVDA/pools` were used to confirm
  live-network behavior during development but are not enforced by CI.
- Dexscreener's dual-length `pairAddress` behavior (20-byte address vs.
  32-byte Uniswap v4 PoolId) was reverse-engineered from one asset's live
  data (NVDA, 30 pools); it's possible other DEXes on Robinhood Chain use
  a third identifier shape not yet observed, which would surface as
  `INVALID_PAIR_ADDRESS` rejections rather than a crash.

## Phase 3 direction (not implemented)

**Displayed liquidity aggregation across pools**: sum `liquidityUsd`
across a canonical asset's accepted pools (and separately, USDG-quoted
liquidity specifically), aggregate 5m/1h/6h/24h volume and buy/sell
counts, and identify the single largest pool/DEX by liquidity — while
still preserving pool-level detail (never collapsing the pool list into
just a total). This is explicitly *displayed* liquidity aggregation, not
executable liquidity — the distinction from on-chain quoting/simulation
remains a later phase after that.
