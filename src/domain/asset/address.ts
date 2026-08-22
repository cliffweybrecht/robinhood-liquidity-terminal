// Generic EVM address validation lives in `src/lib/evm/address.ts` — it's
// not specific to Robinhood assets, and `src/domain/pool` needs the same
// utilities. Re-exported here to keep this module's existing public API
// and import paths stable for callers/tests within `domain/asset`.
export { isValidEvmAddress, toChecksummedAddress } from "@/lib/evm/address";
