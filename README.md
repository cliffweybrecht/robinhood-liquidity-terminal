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
  [Discovered API shape](#discovered-api-shape)).
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

## Discovered API shape

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

No API keys or secrets are required for Phase 1 — `/rhj/assets` is a
public, unauthenticated endpoint.

## Project scope

**Implemented (Phase 1):**
- Canonical Robinhood asset registry (fetch, validate, normalize, index).
- `GET /api/assets`.
- A minimal page rendering the registry (proves consumption end-to-end;
  intentionally not the liquidity dashboard described in the product
  vision).

**Explicitly NOT implemented yet:**
- Dexscreener ingestion or pool discovery.
- Liquidity aggregation, displayed vs. executable liquidity.
- Robinhood reference-price comparison.
- On-chain quoting, price-impact curves, order simulation.
- Historical data, PostgreSQL/Drizzle persistence, charts, alerts,
  wallet connection, trading, authentication, production deployment.

These are intentionally out of scope for Phase 1 per the project's
incremental build plan; see `Phase 2 direction` below for what's next.

## Known limitations

- **No caching layer.** Every call to `getRobinhoodAssets()` — including
  every page load and every `/api/assets` request — performs a fresh
  upstream fetch. Robinhood's API itself caches for ~15s server-side, so
  this is not incorrect, just not optimized. Deliberately deferred:
  introducing caching prematurely would add complexity (invalidation,
  staleness policy) before there's a proven need — Phase 2's pool data
  will clarify what a shared caching/persistence strategy should look
  like across both provider integrations.
- **Whole-response schema failure** (see above) means a single malformed
  asset in an otherwise-valid 194-asset response takes down the entire
  registry fetch. Acceptable for Phase 1's fail-closed posture; may need
  refinement if upstream data quality turns out to be inconsistent.
- The home page is a minimal proof of consumption, not the liquidity
  leaderboard UI described in the product vision.

## Unresolved risks

- Robinhood's `/rhj/assets` schema is undocumented beyond what was
  observed live; an upstream field-shape change would surface as
  `RobinhoodSchemaValidationError` (fails closed, as intended) but there
  is currently no alerting on that beyond the request failing.
- No live-network smoke test is included in the automated suite (by
  design, per the Phase 1 requirement that core tests stay
  deterministic) — a manual `curl localhost:3000/api/assets` was used to
  confirm live-network behavior during development but is not enforced
  by CI.

## Phase 2 direction (not implemented)

**Dexscreener pool discovery and normalization**: take canonical
addresses from this registry, query Dexscreener's
`/token-pairs/v1/{chainId}/{tokenAddress}` for each, validate that the
canonical contract actually participates in each returned pool, and
normalize pool-level liquidity/volume/transaction/price/quote-asset data
— preserving provenance back to Dexscreener and keeping pool-level detail
available even once aggregate metrics are introduced. Explicitly not
started: liquidity aggregation, executable liquidity, or any UI beyond
what's needed to prove pool discovery works.
