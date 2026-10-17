# Testnet Deployment

This runbook deploys the backend API, worker, and MCP server against Stellar testnet. The
deployment owns Postgres, Redis, and the discovery search index used by the API.

## Services

- API: `pnpm start:api`
- Worker: `pnpm start:worker`
- MCP stdio: `pnpm start:mcp`
- MCP Streamable HTTP: `pnpm start:mcp:http`

## MCP Endpoint

The MCP server exposes a single Streamable HTTP transport endpoint:

```
POST  https://lumenbazaar-mcp.onrender.com/mcp    MCP requests (initialize, tools/list, tools/call)
GET   https://lumenbazaar-mcp.onrender.com/mcp    SSE event stream (session resumption)
```

All other HTTP methods on `/mcp` return `405 Method Not Allowed`.

Supporting utility routes (all `GET` only):

| Path       | Description                                         |
|------------|-----------------------------------------------------|
| `/health`  | Process liveness — always 200 while the process is up |
| `/ready`   | Backend readiness — 200 when API is up; 503 otherwise |
| `/version` | Service version, git commit, and environment        |
| `/schema`  | JSON schema document of all available MCP tools     |
| `/metrics` | Prometheus text metrics                             |

## Transport and CORS Settings

The MCP HTTP server uses `StreamableHTTPServerTransport` from the official
`@modelcontextprotocol/sdk`. Session identity is carried in the `Mcp-Session-Id` header
which is generated server-side and exposed via `Access-Control-Expose-Headers`.

**CORS policy — no wildcard with credentials:**
Browser-based and hosted MCP clients send custom headers (`Mcp-Session-Id`,
`Mcp-Protocol-Version`) that require CORS. Because `Mcp-Session-Id` acts as a bearer
credential, the server does **not** use `Access-Control-Allow-Origin: *` by default
— browsers refuse to attach credentials to wildcard responses. Instead:

- Set `MCP_ALLOWED_ORIGINS` to a comma-separated list of trusted frontend origins.
  The server reflects only the exact origin back, and includes
  `Access-Control-Allow-Credentials: true`.
- `MCP_ALLOWED_ORIGINS=*` is supported for fully public, credential-free deployments
  (no `Allow-Credentials` header is emitted in this mode).
- Unrecognised origins receive **no** CORS header — the browser blocks the request.
  This is the secure default.

Required headers always allowed: `Content-Type`, `Accept`, `Mcp-Session-Id`,
`Mcp-Protocol-Version`, `Authorization`.

`OPTIONS` preflight requests are handled before rate-limiting, so they are always
answered quickly and do not consume the caller's rate-limit quota.

## Render Deployment

The repo ships a `render.yaml` at the root that defines two Render web services
(`lumenbazaar-backend` and `lumenbazaar-mcp`) built from the shared `Dockerfile`.
The only difference between the two services is the `dockerCommand` override:

| Service                | `dockerCommand`        |
|------------------------|------------------------|
| `lumenbazaar-backend`  | `pnpm start:api`       |
| `lumenbazaar-mcp`      | `pnpm start:mcp:http`  |

Render reads `render.yaml` on first import or after you click **Sync** in the
dashboard. Both services use the same Docker image (built from the repo root) which
contains the full monorepo, so only one image build is needed.

**Required secret/non-default env vars to set in the Render dashboard** (not in render.yaml):

| Service        | Variable                      | Notes                                                  |
|----------------|-------------------------------|--------------------------------------------------------|
| Both           | `DATABASE_URL`                | Postgres connection string                             |
| Both           | `REDIS_URL`                   | Redis connection string                                |
| api            | `API_PUBLIC_URL`              | e.g. `https://lumenbazaar-backend.onrender.com`        |
| api            | `CORS_ALLOWED_ORIGINS`        | Frontend origins                                       |
| api            | `STELLAR_TESTNET_USDC_ISSUER` |                                                        |
| api            | `STELLAR_TESTNET_USDC_CONTRACT_ID` |                                                   |
| api            | `FACILITATOR_ACCOUNT`         |                                                        |
| api            | `FACILITATOR_SIGNING_KEY`     | Secret; never in repo                                  |
| api            | `FACILITATOR_SIGNING_KEY_VERSION` |                                                    |
| api            | `EVENT_STREAM_SIGNING_SECRET` |                                                        |
| mcp            | `MCP_PUBLIC_URL`              | e.g. `https://lumenbazaar-mcp.onrender.com/mcp`        |
| mcp            | `MCP_ALLOWED_ORIGINS`         | Comma-separated trusted origins; omit for no CORS      |
| mcp            | `API_BASE_URL`                | e.g. `https://lumenbazaar-backend.onrender.com`        |

`MCP_TRUST_PROXY=true` is already set in `render.yaml` for the mcp service
because Render injects `X-Forwarded-For`.

## Environment

`config/testnet.release.env` records the non-secret public release profile and Phase 10 testnet
contract identifiers. Supply deployment secrets, including database credentials and signer access,
through the hosting provider rather than committing them.

Required settings:

- `NODE_ENV=production`
- `LUMEN_ENV=testnet`
- `API_PUBLIC_URL`
- `MCP_PUBLIC_URL`
- `MCP_TRUST_PROXY` (`true` only behind an ingress that replaces client forwarding headers)
- `MCP_ALLOWED_ORIGINS` (comma-separated list of allowed CORS origins, or `*` for public deployments)
- `DATABASE_URL`
- `REDIS_URL`
- `STELLAR_TESTNET_RPC_URL`
- `STELLAR_TESTNET_HORIZON_URL`
- `STELLAR_TESTNET_USDC_ISSUER`
- `STELLAR_TESTNET_USDC_CONTRACT_ID`
- `FACILITATOR_ACCOUNT`
- `FACILITATOR_SIGNER_PROVIDER=environment`
- `FACILITATOR_SIGNER_NETWORK=stellar:testnet`
- `FACILITATOR_SIGNING_KEY_VERSION`
- `STELLAR_MAX_TRANSACTION_FEE_STROOPS` (recommended initial ceiling: `50000`)
- `STELLAR_INCLUSION_FEE_STROOPS` (recommended initial bid: `100`)

Store `FACILITATOR_SIGNING_KEY` only in the hosting provider's secret manager. It is intentionally
absent from `config/testnet.release.env`. Follow
[`docs/security/facilitator-signer.md`](../security/facilitator-signer.md) for provisioning,
rotation, revocation, and incident handling.

Validate the file before rollout:

```bash
pnpm deploy:testnet:check
```

The placeholder template can be checked separately for schema completeness:

```bash
pnpm deploy:testnet:check:example
```

To validate the Compose topology before creating `.env.testnet`, point the service env file at the
committed example:

```bash
LUMEN_ENV_FILE=.env.testnet.example docker compose --env-file .env.testnet.example -f docker-compose.testnet.yml config
```

## Docker Compose

```bash
docker compose --env-file .env.testnet -f docker-compose.testnet.yml build
docker compose --env-file .env.testnet -f docker-compose.testnet.yml up -d postgres redis
docker compose --env-file .env.testnet -f docker-compose.testnet.yml run --rm api pnpm prisma:migrate:deploy
docker compose --env-file .env.testnet -f docker-compose.testnet.yml up -d api worker mcp-server
```

Health checks:

```bash
curl "$API_PUBLIC_URL/health"
curl "$API_PUBLIC_URL/ready"
curl "$API_PUBLIC_URL/version"
curl "$API_PUBLIC_URL/metrics"
curl "$API_PUBLIC_URL/v1/supported"
curl "https://lumenbazaar-mcp.onrender.com/health"
curl "https://lumenbazaar-mcp.onrender.com/metrics"
curl "https://lumenbazaar-mcp.onrender.com/ready"
curl "https://lumenbazaar-mcp.onrender.com/version"
curl "https://lumenbazaar-mcp.onrender.com/schema"
curl "$PAID_RESOURCE_PUBLIC_URL/health"
curl "$PAID_RESOURCE_PUBLIC_URL/ready"
curl "$PAID_RESOURCE_PUBLIC_URL/version"
curl "$PAID_RESOURCE_PUBLIC_URL/metrics"
```

`/health` is process liveness only. `/ready` returns HTTP 503 unless Postgres, Redis, migrations,
the active Stellar RPC and Horizon endpoints, configured assets, and any required signer are ready.
The supported-schemes response uses the same evaluated state and cannot advertise a payment adapter
whose dependencies are unavailable.

The MCP service advertises discovery and receipt tools only while its backend is ready, and
advertises payment preparation and paid-call tools only while the backend reports the official
exact capability. Its HTTP boundary rate-limits callers, caps declared request bodies, does not
publish OAuth metadata, never forwards caller credentials, and pins paid calls to the resource URL
stored in the catalog.

## Smoke Test

The smoke script validates the full MCP protocol handshake against any live or local endpoint.
It is the fastest way to confirm that a deployment is serving correct MCP responses.

```bash
# Against the deployed testnet MCP endpoint
MCP_SMOKE_URL=https://lumenbazaar-mcp.onrender.com/mcp pnpm smoke:mcp

# Against a specific URL passed as an argument
pnpm smoke:mcp https://lumenbazaar-mcp.onrender.com/mcp

# Against a locally running server
MCP_SMOKE_URL=http://localhost:3001/mcp pnpm smoke:mcp
```

The script performs four steps in order:
1. **initialize** — MCP `initialize` + `notifications/initialized`
2. **tools/list** — lists available tools and validates their schemas
3. **tools/call inspect_budget** — calls the always-available read-only local tool

`inspect_budget` was chosen as the smoke call because its capability is `"local"` — it
requires no backend connection and always succeeds as long as the MCP server process is
healthy. It carries no payment risk.

### Expected output (pass)

```
MCP smoke test → https://lumenbazaar-mcp.onrender.com/mcp
  commit  : a1b2c3d4e5f6...
  timeout : 10000ms per step

  ✓ initialize (protocolVersion=2024-11-05) [312ms]
  ✓ tools/list (count=5) [88ms]
  ✓ tools/call inspect_budget [54ms]

PASSED: all smoke steps passed.
```

Machine-readable JSON is printed to stdout:

```json
{
  "smokeAt": "2026-10-17T00:00:00.000Z",
  "url": "https://lumenbazaar-mcp.onrender.com/mcp",
  "commit": "a1b2c3d4e5f6...",
  "protocolVersion": "2024-11-05",
  "toolCount": 5,
  "steps": [
    { "step": "initialize",                  "pass": true, "durationMs": 312 },
    { "step": "tools/list",                  "pass": true, "durationMs": 88,  "detail": "count=5" },
    { "step": "tools/call inspect_budget",   "pass": true, "durationMs": 54  }
  ],
  "pass": true
}
```

### Failure: non-zero exit

When any step fails the script exits with code 1 and marks `pass: false` in the JSON:

```json
{
  "smokeAt": "...",
  "url": "...",
  "commit": "unknown",
  "protocolVersion": null,
  "toolCount": null,
  "steps": [
    { "step": "initialize", "pass": false, "durationMs": 2001, "detail": "initialize timed out after 2000ms" }
  ],
  "pass": false
}
```

### Rollback

If the smoke test fails after a deployment:

1. Identify the last passing commit from the CI artifacts (`deployment-evidence/smoke-mode.json`).
2. In the Render dashboard, navigate to the failing service → **Deploys** → select the last
   passing deploy → **Rollback to this deploy**.
3. Re-run the smoke test to confirm recovery:
   ```bash
   MCP_SMOKE_URL=https://lumenbazaar-mcp.onrender.com/mcp pnpm smoke:mcp
   ```

## Endpoint Manifest

Publish the current testnet URLs in `docs/deployment/testnet-endpoints.json` after DNS and ingress
are configured. The docs repository can import that manifest directly or copy the values into
Mintlify pages.

## Post-Deployment Checks

Replace every placeholder in `docs/deployment/testnet-endpoints.json`, set `status` to `deployed`,
record the full Git SHA for each service and the hosting provider's separate migration run ID, then
run the public probe from outside the hosting environment:

```bash
pnpm deploy:testnet:probe -- --output deployment-evidence/testnet-probe.json
```

The probe fails unless API, MCP, and paid-resource health, readiness, version, and metrics endpoints
are public; deployed version endpoints match the pinned commits; exact testnet is advertised; MCP
advertises its paid-call tool; and the paid resource returns a canonical v2 `PAYMENT-REQUIRED`.

Fund a separate testnet client account with the configured asset and supply its secret only through
the operator's secret environment. The exact gate creates the authorization with the official
`@x402/stellar` client, executes `402 -> sign -> verify -> retry -> settle -> receipt`, and pauses
without writing the replayable signature. Restart the pinned API and worker while it is paused, wait
for readiness, then press Enter:

```bash
CLIENT_PRIVATE_KEY="$CLIENT_PRIVATE_KEY" pnpm deploy:testnet:exact
```

The gate retrieves the same receipt and repeats settlement with the in-memory authorization. It
fails if the receipt or transaction identity changes. The generated evidence contains only a hash
of the authorization, public transaction/receipt facts, commit pins, and probe results. Review it
before publication; never publish the client secret or encoded `PAYMENT-SIGNATURE`.

Run conformance:

```bash
curl -X POST "$API_PUBLIC_URL/v1/conformance/runs" \
  -H "content-type: application/json" \
  -d '{"network":"stellar:testnet","includeReserved":true}'
```

Run load baselines:

```bash
pnpm load:test \
  --environment testnet \
  --base-url "$API_PUBLIC_URL" \
  --targets verify,settle,search,worker \
  --requests 200 \
  --concurrency 10 \
  --verify-template docs/performance/exact-payment-template.json \
  --settle-template docs/performance/exact-payment-template.json \
  --output load-results/testnet.json
```

Check the matching metrics snapshot:

```bash
curl "$API_PUBLIC_URL/metrics"
```

## Search

The testnet API serves discovery search from the resource catalog and search index. No separate
search container is required for this backend deployment. Run the worker beside the API so
`resource-indexing` and `search-sync` queues continue to refresh indexed metadata.

## Testnet Example Catalog

Deploy the weather, RAG, and MCP example applications with these start commands:

```bash
pnpm --filter @lumenbazaar/example-paid-weather-api start
pnpm --filter @lumenbazaar/example-paid-rag-api start
pnpm --filter @lumenbazaar/example-paid-mcp-tool start
```

Create one seller record for each deployment hostname and complete its domain challenge. Catalog
publication rejects unverified sellers, non-HTTPS targets, IP or local hostnames, URLs outside the
seller domain, route mismatches, and oversized or deeply nested schemas. Once the sellers and
public URLs exist, validate, publish, inspect, browse, and search all three records in one gate:

```bash
API_BASE_URL="$API_PUBLIC_URL" \
WEATHER_RESOURCE_BASE_URL="$WEATHER_PUBLIC_URL" \
WEATHER_SELLER_ID="$WEATHER_SELLER_ID" \
RAG_RESOURCE_BASE_URL="$RAG_PUBLIC_URL" \
RAG_SELLER_ID="$RAG_SELLER_ID" \
MCP_RESOURCE_BASE_URL="$MCP_RESOURCE_PUBLIC_URL" \
MCP_SELLER_ID="$MCP_SELLER_ID" \
pnpm catalog:testnet:seed
```

The command exits nonzero unless every metadata document validates, all three resources are
cataloged and inspectable, and both browse and search return the new durable records. The paid
weather and MCP examples also expose clean buyer SDK calls for the official exact verification,
paid retry, settlement, and receipt sequence. Do not record the phase as live evidence until one
of those calls completes against the public testnet services without fixture substitution.
