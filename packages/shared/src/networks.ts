export const networkIds = ["stellar:testnet", "stellar:pubnet"] as const;

export type NetworkId = (typeof networkIds)[number];

/**
 * Asset kind identifier: "usdc" for the official Stellar testnet USDC,
 * "lbt" for the custom Lumen Bazaar test-only asset.
 */
export type AssetKind = "usdc" | "lbt";

export type SupportedAsset = {
  code: string;
  issuer: string;
  contractId?: string;
  decimals: number;
  /**
   * Asset kind: "usdc" for official Stellar USDC, "lbt" for custom test-only asset.
   * Used to distinguish between production-ready and test-only assets in output
   * and to enforce asset selection rules (e.g., USDC default for exact testnet, LBT test-only).
   */
  kind?: AssetKind;
  /**
   * True if this asset is a custom test-only asset and should be clearly labeled as such.
   * When true, asset must never be reported as "USDC" or production-ready.
   */
  isTestOnly?: boolean;
};

export type NetworkConfig = {
  id: NetworkId;
  displayName: string;
  passphrase: string;
  rpcUrl: string;
  rpcUrls: string[];
  horizonUrl: string;
  assets: SupportedAsset[];
  uptoSessionContractId?: string;
};

export const stellarPassphrases: Record<NetworkId, string> = {
  "stellar:testnet": "Test SDF Network ; September 2015",
  "stellar:pubnet": "Public Global Stellar Network ; September 2015"
};

export const localIssuerPublicKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export function isSupportedNetwork(network: string): network is NetworkId {
  return networkIds.includes(network as NetworkId);
}

export function normalizeAssetCode(code: string) {
  return code.trim().toUpperCase();
}

export function assetKey(asset: Pick<SupportedAsset, "code" | "issuer">) {
  return `${normalizeAssetCode(asset.code)}:${asset.issuer}`;
}
