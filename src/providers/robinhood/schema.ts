import { z } from "zod";

/**
 * Zod schemas for the Robinhood asset registry API response
 * (`GET https://api.robinhood.com/rhj/assets`).
 *
 * These schemas describe the *actual observed* upstream response shape
 * (verified against the live endpoint), not the conceptual shape
 * described in product docs. Field names intentionally mirror the
 * provider's own casing (`tokenSymbol`, `tokenName`, ...) — normalization
 * into our internal domain model happens separately, in
 * `src/domain/asset/registry.ts`.
 *
 * Fields the provider returns but this application does not use
 * (`tradingCapabilities`, `isin`, `deployments[].networkName`,
 * `pendingMultiplier`, `pendingMultiplierEffectiveTime`) are deliberately
 * left out of these schemas. Zod's default (non-strict) object parsing
 * ignores unrecognized keys, so additive upstream changes don't break
 * validation — only a genuine deviation in a field we *do* depend on does.
 */

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export const robinhoodDeploymentSchema = z.object({
  contractAddress: z
    .string()
    .regex(
      HEX_ADDRESS_PATTERN,
      "contractAddress must be a 0x-prefixed 40-hex-character address",
    ),
  chainId: z.number().int(),
});

export const robinhoodAssetStatusSchema = z.enum([
  "ASSET_STATUS_ACTIVE",
  "ASSET_STATUS_INACTIVE",
]);

export const robinhoodAssetSchema = z.object({
  id: z.string().min(1),
  tokenSymbol: z.string().min(1),
  tokenName: z.string().min(1),
  deployments: z.array(robinhoodDeploymentSchema),
  currentMultiplier: z.string().min(1),
  logoUrl: z.string().min(1).optional(),
  status: robinhoodAssetStatusSchema,
  tokenDecimals: z.number().int().nonnegative().optional(),
});

export const robinhoodAssetsResponseSchema = z.object({
  assets: z.array(robinhoodAssetSchema),
});

export type RobinhoodDeployment = z.infer<typeof robinhoodDeploymentSchema>;
export type RobinhoodAsset = z.infer<typeof robinhoodAssetSchema>;
export type RobinhoodAssetsResponse = z.infer<
  typeof robinhoodAssetsResponseSchema
>;
