import { getReleaseCommit, serviceName } from "@lumenbazaar/shared";

type HttpMethod = "get" | "post" | "patch" | "delete";
type SchemaObject = Record<string, unknown>;

type RouteContract = {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  requestBody?: SchemaObject;
  requestBodyRequired?: boolean;
  response: SchemaObject;
  responseMediaType?: string;
  /** Optional schema for a 503 Service Unavailable response (e.g. readiness endpoint). */
  degradedResponse?: SchemaObject;
};

const jsonObject: SchemaObject = {
  type: "object",
  additionalProperties: true
};

const livenessResponse: SchemaObject = {
  type: "object",
  required: ["ok", "service", "app"],
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", enum: [true] },
    service: { type: "string" },
    app: { type: "string" }
  }
};

const readinessCheckStatus: SchemaObject = {
  type: "string",
  enum: ["ready", "unavailable", "timeout", "not_configured", "not_required"]
};

const readinessCheck: SchemaObject = {
  type: "object",
  required: ["status"],
  properties: {
    status: readinessCheckStatus,
    latencyMs: {
      type: "integer",
      minimum: 0,
      description:
        "Elapsed probe time in ms. Omitted when status is not_required or not_configured."
    },
    reason: {
      type: "string",
      description:
        "Stable, generic reason code. Never includes raw error messages, hostnames, credentials, or stack traces."
    }
  }
};

const readinessResponse: SchemaObject = {
  type: "object",
  required: ["ok", "environment", "checks", "capabilities"],
  properties: {
    ok: { type: "boolean", description: "true only when all required dependencies are ready." },
    environment: { type: "string", enum: ["local", "testnet", "staging", "mainnet"] },
    checks: {
      type: "object",
      required: ["database", "redis", "stellarRpc", "horizon", "signer", "migrations", "assets"],
      properties: {
        database: readinessCheck,
        redis: readinessCheck,
        stellarRpc: readinessCheck,
        horizon: readinessCheck,
        signer: readinessCheck,
        migrations: readinessCheck,
        assets: readinessCheck
      }
    },
    capabilities: {
      type: "object",
      required: ["exact", "upto"],
      properties: {
        exact: { type: "boolean" },
        upto: { type: "boolean" }
      }
    }
  }
};

const errorResponse: SchemaObject = {
  type: "object",
  required: ["ok", "error"],
  properties: {
    ok: {
      type: "boolean",
      enum: [false]
    },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: {
          type: "string"
        },
        message: {
          type: "string"
        },
        details: jsonObject
      }
    },
    requestId: {
      type: "string"
    }
  }
};

const rateLimitHeaders: Record<string, unknown> = {
  "x-ratelimit-limit": {
    description: "Maximum number of requests allowed in the current rate limit window.",
    schema: { type: "integer" }
  },
  "x-ratelimit-remaining": {
    description:
      "Number of requests remaining in the current rate limit window. Zero means limit reached.",
    schema: { type: "integer" }
  },
  "x-ratelimit-reset": {
    description: "ISO 8601 timestamp when the current rate limit window resets.",
    schema: { type: "string", format: "date-time" }
  },
  "retry-after": {
    description:
      "Number of seconds to wait before retrying. Only present in 429 responses. Per RFC 6585.",
    schema: { type: "integer", minimum: 1 }
  }
};

const assetSchema: SchemaObject = {
  type: "object",
  required: ["code", "issuer"],
  properties: {
    code: { type: "string" },
    issuer: { type: "string" }
  }
};

const seller: SchemaObject = {
  type: "object",
  required: ["id", "displayName", "walletAddress", "domain", "domainVerifiedAt"],
  properties: {
    id: { type: "string" },
    displayName: { type: "string" },
    walletAddress: { type: "string" },
    domain: { type: "string" },
    domainVerifiedAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  }
};

const resource: SchemaObject = {
  type: "object",
  required: [
    "id",
    "sellerId",
    "type",
    "name",
    "description",
    "url",
    "routeTemplate",
    "network",
    "payTo",
    "assetCode",
    "assetIssuer",
    "amount",
    "inputSchema",
    "outputSchema",
    "extensions",
    "status"
  ],
  properties: {
    id: { type: "string" },
    sellerId: { type: "string" },
    type: { type: "string", enum: ["http", "mcp"] },
    name: { type: "string" },
    description: { type: "string" },
    url: { type: "string", format: "uri" },
    routeTemplate: { type: "string" },
    network: { type: "string", enum: ["stellar:testnet", "stellar:pubnet"] },
    payTo: { type: "string" },
    assetCode: { type: "string" },
    assetIssuer: { type: "string" },
    amount: { type: "string" },
    inputSchema: jsonObject,
    outputSchema: jsonObject,
    extensions: jsonObject,
    status: { type: "string", enum: ["draft", "active", "inactive"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  }
};

const resourceVersion: SchemaObject = {
  type: "object",
  required: ["id", "resourceId", "version", "metadata", "createdAt"],
  properties: {
    id: { type: "string" },
    resourceId: { type: "string" },
    version: { type: "integer", minimum: 1 },
    metadata: jsonObject,
    createdAt: { type: "string", format: "date-time" }
  }
};

const resourceVersionList: SchemaObject = {
  type: "object",
  required: ["versions"],
  properties: {
    versions: { type: "array", items: resourceVersion }
  }
};

const rollbackResourceRequest: SchemaObject = {
  type: "object",
  required: ["version"],
  properties: {
    version: {
      type: "integer",
      minimum: 1,
      description: "Historical version number to roll back to."
    }
  }
};

const rollbackResourceResponse: SchemaObject = {
  type: "object",
  required: ["resource", "version"],
  properties: {
    resource,
    version: resourceVersion
  }
};

const paymentRequirements: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds", "extra"],
  properties: {
    scheme: { type: "string", enum: ["exact"] },
    network: { type: "string", enum: ["stellar:testnet", "stellar:pubnet"] },
    asset: { type: "string", description: "SEP-41 token contract ID." },
    amount: {
      type: "string",
      pattern: "^[1-9]\\d*$",
      description: "Amount in the token's atomic units."
    },
    payTo: { type: "string" },
    maxTimeoutSeconds: { type: "integer", minimum: 1 },
    extra: jsonObject
  }
};

const paymentPayload: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["x402Version", "accepted", "payload"],
  properties: {
    x402Version: { type: "integer", enum: [2] },
    resource: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri" },
        description: { type: "string" },
        mimeType: { type: "string" }
      }
    },
    accepted: paymentRequirements,
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["transaction"],
      properties: {
        transaction: {
          type: "string",
          contentEncoding: "base64",
          description: "Wallet-signed Stellar transaction envelope XDR."
        }
      }
    },
    extensions: jsonObject
  }
};

const verificationRequestProperties: Record<string, unknown> = {
  x402Version: { type: "integer", enum: [2] },
  paymentPayload,
  paymentRequirements
};

const verificationRequest: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["x402Version", "paymentPayload", "paymentRequirements"],
  properties: verificationRequestProperties
};

const verificationResponse: SchemaObject = {
  type: "object",
  required: ["isValid"],
  properties: {
    isValid: { type: "boolean" },
    invalidReason: { type: "string" },
    invalidMessage: { type: "string" },
    payer: { type: "string" },
    extensions: jsonObject,
    extensionResponses: jsonObject,
    extra: jsonObject
  }
};

const settlementResponse: SchemaObject = {
  type: "object",
  required: ["success", "transaction", "network"],
  properties: {
    success: { type: "boolean" },
    errorReason: { type: "string" },
    errorMessage: { type: "string" },
    payer: { type: "string" },
    transaction: { type: "string" },
    network: { type: "string", enum: ["stellar:testnet", "stellar:pubnet"] },
    amount: { type: "string", pattern: "^[1-9]\\d*$" },
    extensions: jsonObject,
    extensionResponses: jsonObject,
    extra: jsonObject
  }
};

const supportedResponse: SchemaObject = {
  type: "object",
  required: ["kinds", "extensions", "signers"],
  properties: {
    kinds: {
      type: "array",
      items: {
        type: "object",
        required: ["x402Version", "scheme", "network"],
        properties: {
          x402Version: { type: "integer", enum: [2] },
          scheme: { type: "string" },
          network: { type: "string" },
          extra: jsonObject
        }
      }
    },
    extensions: { type: "array", items: { type: "string" } },
    signers: {
      type: "object",
      additionalProperties: { type: "array", items: { type: "string" } }
    }
  }
};

const paymentSessionRequired = [
  "id",
  "network",
  "buyer",
  "payTo",
  "assetCode",
  "assetIssuer",
  "assetContractId",
  "capAmount",
  "spentAmount",
  "remainingAmount",
  "contractId",
  "contractSessionId",
  "resourceHash",
  "expiresAtLedger",
  "status"
];

const paymentSessionProperties: Record<string, unknown> = {
  id: { type: "string" },
  resourceId: { type: ["string", "null"] },
  sellerId: { type: ["string", "null"] },
  network: { type: "string", enum: ["stellar:testnet", "stellar:pubnet"] },
  buyer: { type: "string" },
  payTo: { type: "string" },
  assetCode: { type: "string" },
  assetIssuer: { type: "string" },
  assetContractId: { type: "string" },
  capAmount: { type: "string" },
  spentAmount: { type: "string" },
  remainingAmount: { type: "string" },
  contractId: { type: "string" },
  contractSessionId: { type: "string" },
  resourceHash: { type: "string" },
  expiresAtLedger: { type: "integer" },
  status: { type: "string", enum: ["open", "settled"] },
  transactionHash: { type: ["string", "null"] },
  ledger: { type: ["integer", "null"] },
  usageHash: { type: ["string", "null"] },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" }
};

const paymentSession: SchemaObject = {
  type: "object",
  required: paymentSessionRequired,
  properties: paymentSessionProperties
};

const createPaymentSessionRequest: SchemaObject = {
  type: "object",
  required: ["scheme", "network", "buyer", "asset", "capAmount", "payTo", "expiresAtLedger"],
  properties: {
    scheme: { type: "string", enum: ["upto"] },
    network: { type: "string", enum: ["stellar:testnet", "stellar:pubnet"] },
    buyer: { type: "string" },
    asset: assetSchema,
    capAmount: { type: "string" },
    payTo: { type: "string" },
    resourceId: { type: "string" },
    sellerId: { type: "string" },
    expiresAtLedger: { type: "integer" },
    currentLedger: { type: "integer" }
  }
};

const settlePaymentSessionRequest: SchemaObject = {
  type: "object",
  required: ["amount", "usageHash"],
  properties: {
    amount: { type: "string" },
    usageHash: { type: "string" },
    currentLedger: { type: "integer" }
  }
};

const settledPaymentSession: SchemaObject = {
  type: "object",
  required: ["scheme", "id", "status", "settlementId", "transactionHash", "ledger"],
  properties: {
    ...paymentSessionProperties,
    scheme: { type: "string", enum: ["upto"] },
    settlementId: { type: "string" },
    settledAt: { type: "string", format: "date-time" }
  }
};

const conformanceRun: SchemaObject = {
  type: "object",
  required: [
    "id",
    "network",
    "suite",
    "status",
    "mode",
    "commit",
    "x402Version",
    "x402PackageVersion",
    "results",
    "startedAt",
    "completedAt"
  ],
  properties: {
    id: { type: "string" },
    network: { type: "string", enum: ["stellar:testnet", "stellar:pubnet"] },
    suite: { type: "string", enum: ["stellar-x402"] },
    status: { type: "string", enum: ["passed", "failed"] },
    mode: {
      type: "string",
      enum: ["local", "live"],
      description:
        "Execution environment mode: 'local' for simulation/unit checks; 'live' for verified deployed runs."
    },
    commit: {
      type: "string",
      description: "Source commit SHA of the code running the conformance suite."
    },
    x402Version: {
      type: "integer",
      enum: [2],
      description: "x402 protocol specification version."
    },
    x402PackageVersion: {
      type: "string",
      description: "Installed @x402/core package version."
    },
    passedCount: { type: "integer" },
    failedCount: { type: "integer" },
    reservedCount: { type: "integer" },
    exactResults: { type: "integer" },
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "scheme", "endpoint", "method", "status", "passed"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          scheme: { type: "string", enum: ["exact", "upto"] },
          endpoint: { type: "string" },
          method: { type: "string", enum: ["GET", "POST"] },
          status: { type: "string", enum: ["passed", "failed", "reserved"] },
          passed: { type: "boolean" },
          durationMs: { type: "integer" },
          details: jsonObject,
          error: { type: "string" }
        }
      }
    },
    startedAt: { type: "string", format: "date-time" },
    completedAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" }
  }
};

const streamAccessGrant: SchemaObject = {
  type: "object",
  required: ["token", "scope", "subjectId", "expiresAt", "streamPath"],
  properties: {
    token: {
      type: "string",
      description: "Short-lived signed grant presented as a Bearer token or access_token query."
    },
    scope: { type: "string", enum: ["receipt", "seller"] },
    subjectId: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    streamPath: { type: "string" }
  }
};

const receiptEventStream: SchemaObject = {
  type: "string",
  description:
    "Server-sent event stream. Emits `stream.ready`, `receipt.status`, optional `stream.reset`, " +
    "`stream.end`, and `: hb` heartbeat comments. Frames carry an `id` sequence and a signed " +
    "resume `cursor`; `receipt.status` data contains status metadata only and never includes " +
    "signed payment payloads, transaction signatures, or receipt evidence material."
};

const sellerApiKeyScope: SchemaObject = {
  type: "string",
  enum: ["resources:read", "resources:write", "seller:read", "seller:write"]
};

const sellerApiKey: SchemaObject = {
  type: "object",
  required: [
    "id",
    "sellerId",
    "name",
    "keyPrefix",
    "scopes",
    "status",
    "expiresAt",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    sellerId: { type: "string" },
    name: { type: "string" },
    keyPrefix: {
      type: "string",
      description: "Non-secret prefix used to locate the key by hash."
    },
    scopes: { type: "array", items: sellerApiKeyScope },
    status: { type: "string", enum: ["active", "revoked"] },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    lastUsedAt: { type: ["string", "null"], format: "date-time" },
    revokedAt: { type: ["string", "null"], format: "date-time" },
    rotatedOutAt: {
      type: ["string", "null"],
      format: "date-time",
      description: "Set on rotation; the key stays valid for a bounded overlap window."
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  }
};

const sellerApiKeyIssuance: SchemaObject = {
  type: "object",
  required: ["apiKey", "key"],
  properties: {
    apiKey: sellerApiKey,
    key: {
      type: "string",
      description:
        "Plaintext seller API key (lbk_...). Shown only in this response; only a SHA-256 hash is stored."
    }
  }
};

const sellerApiKeyList: SchemaObject = {
  type: "object",
  required: ["apiKeys"],
  properties: {
    apiKeys: { type: "array", items: sellerApiKey }
  }
};

export const apiRouteContracts: RouteContract[] = [
  {
    method: "get",
    path: "/health",
    operationId: "getHealth",
    summary: "Liveness probe — returns 200 while the process is running. Performs no I/O.",
    tags: ["metadata"],
    response: livenessResponse
  },
  {
    method: "get",
    path: "/ready",
    operationId: "getReadiness",
    summary:
      "Readiness probe — actively checks all dependencies and returns 503 if any required dependency is unavailable.",
    tags: ["metadata"],
    response: readinessResponse,
    degradedResponse: readinessResponse
  },
  {
    method: "get",
    path: "/version",
    operationId: "getVersion",
    summary: "Return backend version and environment.",
    tags: ["metadata"],
    response: jsonObject
  },
  {
    method: "get",
    path: "/v1/networks",
    operationId: "listNetworks",
    summary: "List configured Stellar networks and assets.",
    tags: ["metadata"],
    response: jsonObject
  },
  {
    method: "get",
    path: "/v1/supported",
    operationId: "listSupportedPaymentSchemes",
    summary: "List supported x402 payment schemes.",
    tags: ["facilitator"],
    response: supportedResponse
  },
  {
    method: "post",
    path: "/v1/verify",
    operationId: "verifyPayment",
    summary: "Verify an exact Stellar x402 payment payload.",
    tags: ["facilitator"],
    requestBody: verificationRequest,
    response: verificationResponse
  },
  {
    method: "post",
    path: "/v1/settle",
    operationId: "settlePayment",
    summary: "Settle a previously verified exact Stellar x402 payment.",
    tags: ["facilitator"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["x402Version", "paymentPayload", "paymentRequirements"],
      properties: verificationRequestProperties
    },
    response: settlementResponse
  },
  {
    method: "get",
    path: "/v1/receipts/{receiptId}",
    operationId: "getReceipt",
    summary: "Fetch a settlement receipt.",
    tags: ["facilitator"],
    response: jsonObject
  },
  {
    method: "post",
    path: "/v1/receipts/{receiptId}/stream-access",
    operationId: "createReceiptStreamAccessGrant",
    summary: "Mint a short-lived grant for a receipt status event stream.",
    tags: ["facilitator"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      properties: {
        ttlSeconds: { type: "integer", minimum: 1, maximum: 900, default: 300 }
      }
    },
    requestBodyRequired: false,
    response: streamAccessGrant
  },
  {
    method: "get",
    path: "/v1/receipts/{receiptId}/stream",
    operationId: "streamReceiptStatusEvents",
    summary: "Stream authorized receipt status updates until the receipt reaches a final state.",
    tags: ["facilitator"],
    response: receiptEventStream,
    responseMediaType: "text/event-stream"
  },
  {
    method: "post",
    path: "/v1/payment-sessions",
    operationId: "createPaymentSession",
    summary: "Create a capped Stellar upto payment session.",
    tags: ["facilitator"],
    requestBody: createPaymentSessionRequest,
    response: paymentSession
  },
  {
    method: "get",
    path: "/v1/payment-sessions/{sessionId}",
    operationId: "getPaymentSession",
    summary: "Fetch a capped payment session.",
    tags: ["facilitator"],
    response: paymentSession
  },
  {
    method: "post",
    path: "/v1/payment-sessions/{sessionId}/settle",
    operationId: "settlePaymentSession",
    summary: "Settle a capped payment session up to its authorized amount.",
    tags: ["facilitator"],
    requestBody: settlePaymentSessionRequest,
    response: settledPaymentSession
  },
  {
    method: "post",
    path: "/v1/sellers",
    operationId: "createSeller",
    summary: "Create a seller profile.",
    tags: ["sellers"],
    requestBody: {
      type: "object",
      required: ["displayName", "walletAddress", "domain"],
      properties: {
        displayName: { type: "string" },
        walletAddress: { type: "string" },
        domain: { type: "string" }
      }
    },
    response: seller
  },
  {
    method: "get",
    path: "/v1/sellers/{sellerId}",
    operationId: "getSeller",
    summary: "Fetch a seller profile.",
    tags: ["sellers"],
    response: seller
  },
  {
    method: "post",
    path: "/v1/sellers/{sellerId}/stream-access",
    operationId: "createSellerStreamAccessGrant",
    summary: "Mint a short-lived seller stream grant from a wallet signature.",
    tags: ["sellers"],
    requestBody: {
      type: "object",
      required: ["walletAddress", "expiresAt", "signature"],
      additionalProperties: false,
      properties: {
        walletAddress: { type: "string" },
        expiresAt: {
          type: "string",
          format: "date-time",
          description: "Requested grant expiry; must be within 900 seconds of the server clock."
        },
        signature: {
          type: "string",
          description:
            "SEP-53 signature by the seller wallet over the canonical stream access message."
        }
      }
    },
    response: streamAccessGrant
  },
  {
    method: "get",
    path: "/v1/sellers/{sellerId}/receipts/stream",
    operationId: "streamSellerReceiptStatusEvents",
    summary: "Stream authorized receipt status updates for one seller.",
    tags: ["sellers"],
    response: receiptEventStream,
    responseMediaType: "text/event-stream"
  },
  {
    method: "post",
    path: "/v1/sellers/{sellerId}/verify-domain",
    operationId: "verifySellerDomain",
    summary: "Create or complete a seller domain verification challenge.",
    tags: ["sellers"],
    requestBody: jsonObject,
    response: jsonObject
  },
  {
    method: "post",
    path: "/v1/sellers/{sellerId}/api-keys",
    operationId: "createSellerApiKey",
    summary: "Issue a scoped seller API key; the plaintext key is returned exactly once.",
    tags: ["sellers"],
    requestBody: {
      type: "object",
      required: ["name", "scopes"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        scopes: { type: "array", minItems: 1, items: sellerApiKeyScope },
        expiresInDays: {
          type: "integer",
          minimum: 1,
          maximum: 365,
          description: "Optional key lifetime in days."
        }
      }
    },
    response: sellerApiKeyIssuance
  },
  {
    method: "get",
    path: "/v1/sellers/{sellerId}/api-keys",
    operationId: "listSellerApiKeys",
    summary: "List seller API key metadata; plaintext keys and hashes are never returned.",
    tags: ["sellers"],
    response: sellerApiKeyList
  },
  {
    method: "post",
    path: "/v1/sellers/{sellerId}/api-keys/{keyId}/rotate",
    operationId: "rotateSellerApiKey",
    summary: "Rotate a seller API key; the previous key stays valid for a bounded overlap window.",
    tags: ["sellers"],
    requestBody: jsonObject,
    requestBodyRequired: false,
    response: {
      type: "object",
      required: ["apiKey", "key", "overlapSeconds", "previousKeyId"],
      properties: {
        ...(sellerApiKeyIssuance.properties as Record<string, unknown>),
        overlapSeconds: { type: "integer" },
        previousKeyId: { type: "string" }
      }
    }
  },
  {
    method: "delete",
    path: "/v1/sellers/{sellerId}/api-keys/{keyId}",
    operationId: "revokeSellerApiKey",
    summary: "Immediately revoke a seller API key; revocation is terminal.",
    tags: ["sellers"],
    response: sellerApiKey
  },
  {
    method: "get",
    path: "/v1/resources",
    operationId: "listResources",
    summary: "List catalog resources.",
    tags: ["resources"],
    response: {
      type: "object",
      required: ["resources", "nextCursor"],
      properties: {
        resources: {
          type: "array",
          items: resource
        },
        nextCursor: { type: ["string", "null"] }
      }
    }
  },
  {
    method: "post",
    path: "/v1/resources",
    operationId: "createResource",
    summary: "Create a paid resource owned by a seller.",
    tags: ["resources"],
    requestBody: resource,
    response: resource
  },
  {
    method: "get",
    path: "/v1/resources/{id}",
    operationId: "getResource",
    summary: "Fetch a paid resource by ID.",
    tags: ["resources"],
    response: resource
  },
  {
    method: "patch",
    path: "/v1/resources/{id}",
    operationId: "updateResource",
    summary: "Update mutable paid resource fields.",
    tags: ["resources"],
    requestBody: resource,
    response: resource
  },
  {
    method: "delete",
    path: "/v1/resources/{id}",
    operationId: "deleteResource",
    summary: "Deactivate a paid resource.",
    tags: ["resources"],
    response: resource
  },
  {
    method: "get",
    path: "/v1/resources/{id}/versions",
    operationId: "listResourceVersions",
    summary: "List the immutable version history of a resource.",
    tags: ["resources"],
    response: resourceVersionList
  },
  {
    method: "get",
    path: "/v1/resources/{id}/versions/{version}",
    operationId: "getResourceVersion",
    summary: "Fetch a specific historical version of a resource.",
    tags: ["resources"],
    response: resourceVersion
  },
  {
    method: "post",
    path: "/v1/resources/{id}/rollback",
    operationId: "rollbackResource",
    summary: "Roll back a resource to a historical version, creating a new immutable version.",
    tags: ["resources"],
    requestBody: rollbackResourceRequest,
    response: rollbackResourceResponse
  },
  {
    method: "get",
    path: "/v1/sellers/{sellerId}/resources",
    operationId: "listSellerResources",
    summary: "List resources owned by a seller.",
    tags: ["resources"],
    response: jsonObject
  },
  {
    method: "get",
    path: "/v1/discovery/resources",
    operationId: "browseDiscoveryResources",
    summary: "Browse discoverable paid resources.",
    tags: ["discovery"],
    response: jsonObject
  },
  {
    method: "get",
    path: "/v1/discovery/search",
    operationId: "searchDiscoveryResources",
    summary: "Search paid resources by query and filters.",
    tags: ["discovery"],
    response: jsonObject
  },
  {
    method: "post",
    path: "/v1/discovery/validate",
    operationId: "validateDiscoveryMetadata",
    summary: "Validate Bazaar discovery metadata without cataloging it.",
    tags: ["discovery"],
    requestBody: jsonObject,
    response: jsonObject
  },
  {
    method: "post",
    path: "/v1/discovery/catalog",
    operationId: "catalogDiscoveryMetadata",
    summary: "Catalog valid Bazaar discovery metadata.",
    tags: ["discovery"],
    requestBody: jsonObject,
    response: jsonObject
  },
  {
    method: "post",
    path: "/v1/sellers/{sellerId}/catalog",
    operationId: "catalogResourceForSeller",
    summary: "Catalog a resource for a seller using an authenticated API key.",
    tags: ["discovery", "sellers"],
    requestBody: jsonObject,
    response: jsonObject
  },
  {
    method: "post",
    path: "/v1/conformance/runs",
    operationId: "createConformanceRun",
    summary: "Run backend x402 conformance checks and persist the result.",
    tags: ["conformance"],
    requestBody: {
      type: "object",
      properties: {
        network: { type: "string", enum: ["stellar:testnet", "stellar:pubnet"] },
        includeReserved: { type: "boolean", default: true },
        mode: {
          type: "string",
          enum: ["local", "live"],
          default: "local",
          description:
            "Execution mode label: 'local' for simulation/unit checks; 'live' for verified deployed runs."
        }
      }
    },
    response: conformanceRun
  },
  {
    method: "get",
    path: "/v1/conformance/runs",
    operationId: "listConformanceRuns",
    summary: "List persisted conformance runs.",
    tags: ["conformance"],
    response: {
      type: "array",
      items: conformanceRun
    }
  },
  {
    method: "get",
    path: "/v1/conformance/runs/{runId}",
    operationId: "getConformanceRun",
    summary: "Fetch a persisted conformance run.",
    tags: ["conformance"],
    response: conformanceRun
  }
];

export const apiOpenApiSpec = buildOpenApiSpec();

export function buildOpenApiSpec(
  options: {
    commit?: string;
    version?: string;
    x402PackageVersion?: string;
  } = {}
) {
  const commit = options.commit ?? getReleaseCommit();
  const version = options.version ?? "0.1.0";
  const x402PackageVersion = options.x402PackageVersion ?? "2.28.0";

  const paths: Record<string, Record<string, unknown>> = {};

  for (const contract of apiRouteContracts) {
    const pathItem = (paths[contract.path] ??= {});
    pathItem[contract.method] = {
      operationId: contract.operationId,
      summary: contract.summary,
      tags: contract.tags,
      ...(contract.requestBody === undefined
        ? {}
        : {
            requestBody: {
              required: contract.requestBodyRequired ?? true,
              content: {
                "application/json": {
                  schema: contract.requestBody
                }
              }
            }
          }),
      responses: {
        "200": {
          description:
            contract.responseMediaType === "text/event-stream"
              ? "Server-sent event stream"
              : "Successful response",
          headers: rateLimitHeaders,
          content: {
            [contract.responseMediaType ?? "application/json"]: {
              schema: contract.response
            }
          }
        },
        ...(contract.degradedResponse === undefined
          ? {}
          : {
              "503": {
                description:
                  "Service Unavailable. One or more required dependencies are not ready. Response body has the same shape as 200 with ok: false.",
                content: {
                  "application/json": {
                    schema: contract.degradedResponse
                  }
                }
              }
            }),
        "429": {
          description:
            "Rate limit exceeded. The client must wait before retrying. See Retry-After header.",
          headers: rateLimitHeaders,
          content: {
            "application/json": {
              schema: errorResponse
            }
          }
        },
        default: {
          description: "Error response",
          headers: rateLimitHeaders,
          content: {
            "application/json": {
              schema: errorResponse
            }
          }
        }
      }
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "LumenBazaar Backend API",
      version,
      description: "Facilitator, seller catalog, discovery, and conformance APIs for LumenBazaar.",
      "x-release": {
        commit,
        version,
        protocol: "stellar-x402",
        x402Version: 2,
        x402PackageVersion
      },
      "x-compatibility": {
        protocol: "x402",
        x402Version: 2,
        x402PackageVersion,
        supportedSchemes: ["exact", "upto"],
        networks: ["stellar:testnet", "stellar:pubnet"]
      },
      "x-rate-limiting": {
        description:
          "The API implements distributed rate limiting across all replicas using Redis. Each endpoint scope has different limits per 60-second window.",
        scopes: {
          facilitator:
            "Payment verification and settlement endpoints (verify, settle): 60 requests per minute per API key or IP",
          seller:
            "Seller management endpoints (create, verify domain): 30 requests per minute per API key or IP",
          discovery:
            "Resource discovery and catalog endpoints: 120 requests per minute per API key or IP"
        },
        headers: [
          "x-ratelimit-limit: Maximum requests in current window",
          "x-ratelimit-remaining: Requests remaining in current window",
          "x-ratelimit-reset: ISO 8601 timestamp when window resets",
          "retry-after: Seconds to wait before retrying (429 responses only, RFC 6585)"
        ],
        identification:
          "Authenticated seller API keys are identified by their key ID; other requests use the x-api-key header value if present, otherwise by request IP address (x-forwarded-for not trusted)",
        behavior:
          "During Redis unavailability, rate limiting degrades to in-memory per-instance limits, prioritizing availability over perfect enforcement"
      }
    },
    servers: [
      {
        url: "http://localhost:3000",
        description: "Local development"
      }
    ],
    tags: [...new Set(apiRouteContracts.flatMap((contract) => contract.tags))].map((name) => ({
      name
    })),
    paths,
    components: {
      headers: {
        "X-RateLimit-Limit": rateLimitHeaders["x-ratelimit-limit"],
        "X-RateLimit-Remaining": rateLimitHeaders["x-ratelimit-remaining"],
        "X-RateLimit-Reset": rateLimitHeaders["x-ratelimit-reset"],
        "Retry-After": rateLimitHeaders["retry-after"]
      }
    },
    "x-docs-consumption": {
      source: `${serviceName}/docs/api/openapi.json`,
      markdown: `${serviceName}/docs/api/openapi.md`,
      conformance: `${serviceName}/docs/api/conformance.json`,
      conformanceMarkdown: `${serviceName}/docs/api/conformance.md`,
      checksums: `${serviceName}/docs/api/checksums.json`
    }
  };
}

export function renderOpenApiMarkdown(spec: ReturnType<typeof buildOpenApiSpec> = apiOpenApiSpec) {
  const releaseInfo = spec.info["x-release"] as
    | {
        commit?: string;
        version?: string;
        x402Version?: number;
        x402PackageVersion?: string;
        protocol?: string;
      }
    | undefined;

  const lines = [
    "# LumenBazaar Backend API",
    "",
    "Generated from `apps/api/src/openapi.ts`. Do not edit this file manually.",
    "",
    `OpenAPI version: ${spec.openapi}`,
    `API version: ${spec.info.version}`,
    `Source commit: \`${releaseInfo?.commit ?? "unspecified"}\``,
    `x402 protocol version: ${releaseInfo?.x402Version ?? 2}`,
    `x402 package version: \`${releaseInfo?.x402PackageVersion ?? "2.28.0"}\``,
    "",
    "## Compatibility & Release",
    "",
    `- Source commit: \`${releaseInfo?.commit ?? "unspecified"}\``,
    `- Protocol version: x402 v${releaseInfo?.x402Version ?? 2}`,
    `- Core package: \`@x402/core@${releaseInfo?.x402PackageVersion ?? "2.28.0"}\``,
    `- Supported schemes: \`exact\`, \`upto\``,
    `- Supported networks: \`stellar:testnet\`, \`stellar:pubnet\``,
    "",
    "## Endpoints",
    "",
    "| Method | Path | Summary |",
    "| --- | --- | --- |"
  ];

  for (const contract of apiRouteContracts) {
    lines.push(`| ${contract.method.toUpperCase()} | \`${contract.path}\` | ${contract.summary} |`);
  }

  lines.push(
    "",
    "## Docs Repo Consumption",
    "",
    "- Import `docs/api/openapi.json` for machine-readable API contracts.",
    "- Import `docs/api/openapi.md` for a human-readable endpoint summary.",
    "- Import `docs/api/conformance.json` for testnet & pubnet conformance definitions.",
    "- Import `docs/api/checksums.json` for SHA-256 release artifact checksums."
  );

  return `${lines.join("\n")}\n`;
}
