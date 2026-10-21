import { getTraceparent } from "@lumenbazaar/shared";

import { BackendError } from "./errors.js";
import { type McpToolCapabilities } from "./tools.js";

/**
 * Backend client for MCP server.
 * Wraps API calls to the facilitator and discovery endpoints.
 * Configurable API base URL for local dev, testnet, or mainnet.
 */
export class BackendClient {
  private baseUrl: string;

  constructor(baseUrl: string = process.env.API_BASE_URL || "http://localhost:3000") {
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("API_BASE_URL must not contain credentials, query parameters, or fragments.");
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  /**
   * Fetch supported payment schemes, networks, and assets
   */
  async getSupported(): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>("/v1/supported");
  }

  async getToolCapabilities(): Promise<McpToolCapabilities> {
    try {
      const [readiness, supported] = await Promise.all([
        this.requestJson<Record<string, unknown>>("/ready"),
        this.getSupported()
      ]);
      const kinds = Array.isArray(supported.kinds) ? supported.kinds : [];
      return {
        backend: readiness.ok === true,
        exact: kinds.some(
          (kind) =>
            typeof kind === "object" &&
            kind !== null &&
            !Array.isArray(kind) &&
            (kind as Record<string, unknown>).scheme === "exact" &&
            (kind as Record<string, unknown>).x402Version === 2
        )
      };
    } catch {
      return { backend: false, exact: false };
    }
  }

  /**
   * List all supported networks
   */
  async listNetworks(): Promise<Array<{ id: string; name: string; chain: string }>> {
    const data = await this.requestJson<Record<string, unknown>>("/v1/networks");
    const networks = asRecordArray(data.networks);

    return networks.map((n) => ({
      id: (n.id as string) || "",
      name: (n.displayName as string) || (n.name as string) || "",
      chain: (n.chain as string) || "stellar"
    }));
  }

  /**
   * Search for paid resources with filters
   */
  async searchResources(params: {
    q?: string;
    type?: "http" | "mcp";
    network?: string;
    asset?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    resources: Array<Record<string, unknown>>;
    cursor?: string;
    total?: number;
  }> {
    const query = new URLSearchParams();
    if (params.q) query.append("q", params.q);
    if (params.type) query.append("type", params.type);
    if (params.network) query.append("network", params.network);
    if (params.asset) query.append("asset", params.asset);
    if (params.limit) query.append("limit", String(params.limit));
    if (params.cursor) query.append("cursor", params.cursor);

    const data = await this.requestJson<Record<string, unknown>>(
      `/v1/discovery/search?${query.toString()}`
    );
    const resources = asRecordArray(data.resources).map(withPaymentTerms);
    const cursor = (data.cursor ?? data.nextCursor) as string | undefined;
    const total = data.total as number | undefined;

    const result: { resources: Array<Record<string, unknown>>; cursor?: string; total?: number } = {
      resources
    };
    if (cursor !== undefined) {
      result.cursor = cursor;
    }
    if (total !== undefined) {
      result.total = total;
    }

    return result;
  }

  /**
   * Get a specific resource by ID
   */
  async getResource(resourceId: string): Promise<Record<string, unknown>> {
    return withPaymentTerms(
      await this.requestJson<Record<string, unknown>>(
        `/v1/resources/${encodeURIComponent(resourceId)}`
      )
    );
  }

  /**
   * Get payment receipt by ID
   */
  async getReceipt(receiptId: string): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      `/v1/receipts/${encodeURIComponent(receiptId)}`
    );
  }

  private async requestJson<T>(path: string): Promise<T> {
    let response: Response;
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      const traceparent = getTraceparent();
      if (traceparent !== undefined) headers.traceparent = traceparent;
      response = await fetch(`${this.baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(5_000)
      });
    } catch {
      throw new BackendError("Backend request failed.");
    }
    if (!response.ok) {
      throw new BackendError("Backend request failed.", { status: response.status });
    }
    return unwrapApiData<T>(await response.json());
  }
}

export function createBackendClient(baseUrl?: string): BackendClient {
  return new BackendClient(baseUrl);
}

function unwrapApiData<T>(input: unknown): T {
  if (typeof input === "object" && input !== null && "ok" in input && "data" in input) {
    return (input as { data: T }).data;
  }

  return input as T;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function withPaymentTerms(resource: Record<string, unknown>) {
  if (resource.paymentTerms !== undefined) {
    return resource;
  }

  const extensions = asRecord(resource.extensions);
  const assetContractId = extensions?.assetContractId;
  return {
    ...resource,
    paymentTerms: {
      scheme: "exact",
      network: resource.network,
      asset: typeof assetContractId === "string" ? assetContractId : "",
      amount: decimalToAtomic(String(resource.amount ?? "")),
      payTo: resource.payTo,
      maxTimeoutSeconds: 60,
      extra: {
        assetCode: resource.assetCode,
        assetIssuer: resource.assetIssuer
      }
    }
  };
}

function decimalToAtomic(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  if (!/^\d+$/u.test(whole ?? "") || !/^\d*$/u.test(fraction) || fraction.length > 7) {
    throw new BackendError("Backend resource price is invalid.");
  }
  return `${whole}${fraction.padEnd(7, "0")}`.replace(/^0+(?=\d)/u, "");
}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
