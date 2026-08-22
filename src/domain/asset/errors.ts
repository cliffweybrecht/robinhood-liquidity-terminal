export type AssetRegistryErrorCode =
  | "NO_CHAIN_DEPLOYMENT"
  | "DUPLICATE_CONTRACT_ADDRESS"
  | "INVALID_CONTRACT_ADDRESS"
  | "AMBIGUOUS_SYMBOL"
  | "ASSET_NOT_FOUND"
  | "INVALID_ADDRESS_INPUT";

export abstract class AssetRegistryError extends Error {
  abstract readonly code: AssetRegistryErrorCode;
}

/** The provider response was valid but contained no Robinhood Chain deployment at all. */
export class NoChainDeploymentError extends AssetRegistryError {
  readonly code = "NO_CHAIN_DEPLOYMENT" as const;
  readonly chainId: number;

  constructor(chainId: number) {
    super(
      `No assets with a deployment on chain ${chainId} (Robinhood Chain) were found in the Robinhood asset registry`,
    );
    this.name = "NoChainDeploymentError";
    this.chainId = chainId;
  }
}

/**
 * Integrity violation: two or more assets claim the same canonical
 * contract address. Address uniqueness is the invariant this entire
 * application's identity model rests on, so this fails the whole
 * registry build rather than being resolved silently.
 */
export class DuplicateContractAddressError extends AssetRegistryError {
  readonly code = "DUPLICATE_CONTRACT_ADDRESS" as const;
  readonly address: string;
  readonly assetIds: readonly string[];

  constructor(address: string, assetIds: readonly string[]) {
    super(
      `Integrity violation: multiple assets (${assetIds.join(", ")}) claim canonical contract address ${address}`,
    );
    this.name = "DuplicateContractAddressError";
    this.address = address;
    this.assetIds = assetIds;
  }
}

/** An asset's deployment contract address is not a validly formed EVM address. */
export class InvalidContractAddressError extends AssetRegistryError {
  readonly code = "INVALID_CONTRACT_ADDRESS" as const;
  readonly assetId: string;
  readonly rawAddress: string;

  constructor(assetId: string, rawAddress: string) {
    super(`Asset ${assetId} has an invalid contract address: "${rawAddress}"`);
    this.name = "InvalidContractAddressError";
    this.assetId = assetId;
    this.rawAddress = rawAddress;
  }
}

/**
 * Two or more canonical assets normalize to the same symbol. Symbols are
 * a convenience index, not an identity guarantee, so this does not fail
 * the registry — it only makes symbol lookup for that symbol fail
 * explicitly rather than silently resolving to an arbitrary asset.
 */
export class AmbiguousSymbolError extends AssetRegistryError {
  readonly code = "AMBIGUOUS_SYMBOL" as const;
  readonly symbol: string;

  constructor(symbol: string) {
    super(
      `Symbol "${symbol}" is ambiguous: multiple canonical Robinhood assets share this symbol. Look up by contract address instead.`,
    );
    this.name = "AmbiguousSymbolError";
    this.symbol = symbol;
  }
}

export class AssetNotFoundError extends AssetRegistryError {
  readonly code = "ASSET_NOT_FOUND" as const;

  constructor(message: string) {
    super(message);
    this.name = "AssetNotFoundError";
  }
}

/** Caller-supplied address input is not a validly formed EVM address. */
export class InvalidAddressInputError extends AssetRegistryError {
  readonly code = "INVALID_ADDRESS_INPUT" as const;
  readonly input: string;

  constructor(input: string) {
    super(`"${input}" is not a validly formatted EVM address`);
    this.name = "InvalidAddressInputError";
    this.input = input;
  }
}
