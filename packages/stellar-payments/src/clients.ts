import {
  LumenError,
  type AppConfig,
  type NetworkConfig,
  type NetworkId,
  type SupportedAsset,
  isSupportedNetwork,
  normalizeAssetCode
} from "@lumenbazaar/shared";

export type StellarRpcClientRef = {
  kind: "stellar-rpc";
  network: NetworkId;
  url: string;
  passphrase: string;
};

export type HorizonClientRef = {
  kind: "horizon";
  network: NetworkId;
  url: string;
  passphrase: string;
};

export function getNetworkConfig(config: AppConfig, network: string): NetworkConfig {
  if (!isSupportedNetwork(network)) {
    throw new LumenError("UNSUPPORTED_NETWORK", `Network ${network} is not supported.`);
  }

  return config.networks[network];
}

export function createRpcClient(config: AppConfig, network: string): StellarRpcClientRef {
  const networkConfig = getNetworkConfig(config, network);

  return {
    kind: "stellar-rpc",
    network: networkConfig.id,
    url: networkConfig.rpcUrl,
    passphrase: networkConfig.passphrase
  };
}

export function createHorizonClient(config: AppConfig, network: string): HorizonClientRef {
  const networkConfig = getNetworkConfig(config, network);

  return {
    kind: "horizon",
    network: networkConfig.id,
    url: networkConfig.horizonUrl,
    passphrase: networkConfig.passphrase
  };
}

export function findSupportedAsset(
  config: AppConfig,
  network: string,
  assetCode: string,
  assetIssuer: string
): SupportedAsset | undefined {
  const networkConfig = getNetworkConfig(config, network);
  const normalizedCode = normalizeAssetCode(assetCode);

  return networkConfig.assets.find(
    (asset) => normalizeAssetCode(asset.code) === normalizedCode && asset.issuer === assetIssuer
  );
}

export function requireSupportedAsset(
  config: AppConfig,
  network: string,
  assetCode: string,
  assetIssuer: string
) {
  const asset = findSupportedAsset(config, network, assetCode, assetIssuer);

  if (asset === undefined) {
    throw new LumenError(
      "UNSUPPORTED_ASSET",
      `Asset ${normalizeAssetCode(assetCode)} is not supported on ${network}.`
    );
  }

  return asset;
}

/**
 * Lightweight connectivity probe for a Stellar RPC endpoint.
 *
 * Issues a `getLatestLedger` JSON-RPC call and throws if the endpoint is
 * unreachable, returns a non-2xx HTTP status, or returns a malformed response.
 * Raw error messages are intentionally not enriched here — callers must redact
 * before surfacing to consumers.
 *
 * @param rpcUrl    - The Stellar Soroban RPC URL to probe.
 * @param timeoutMs - AbortSignal deadline in milliseconds (default: 2 000).
 */
export async function probeRpcEndpoint(rpcUrl: string, timeoutMs = 2_000): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
    signal
  });
  if (!response.ok) {
    throw new Error(`Stellar RPC returned HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as { result?: unknown; error?: unknown };
  if (payload.result === undefined || payload.error !== undefined) {
    throw new Error("Stellar RPC did not return a latest ledger result.");
  }
}

/**
 * Lightweight connectivity probe for a Horizon endpoint.
 *
 * Issues a GET request to the root of the Horizon API and throws on any
 * non-2xx HTTP response or network error. Raw error messages are not enriched
 * here — callers must redact before surfacing to consumers.
 *
 * @param horizonUrl - The Horizon base URL to probe.
 * @param timeoutMs  - AbortSignal deadline in milliseconds (default: 2 000).
 */
export async function probeHorizonEndpoint(horizonUrl: string, timeoutMs = 2_000): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(horizonUrl, { signal });
  if (!response.ok) {
    throw new Error(`Horizon returned HTTP ${response.status}.`);
  }
}
