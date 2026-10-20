# Health Checks: Liveness vs Readiness

## Overview

LumenBazaar exposes two health endpoints with distinct semantics. Understanding the difference is critical for correct orchestrator configuration — misusing them causes unnecessary restarts (liveness as readiness) or invisible degradation (readiness as liveness).

| Endpoint | Probe type | Performs I/O? | Returns 503? | Purpose |
|---|---|---|---|---|
| `GET /health` | Liveness | **No** | Never | Is the process alive? |
| `GET /ready` | Readiness | **Yes** | When degraded | Is the process ready to serve traffic? |

---

## `/health` — Liveness Probe

**Use for:** Kubernetes `livenessProbe`, ECS health checks, load balancer keepalives.

**Behaviour:** Returns `200 OK` immediately with a static JSON body. Makes zero network calls, database queries, or Redis operations. If this endpoint returns anything other than 200, the process is deadlocked or crashed — restart it.

```json
{ "ok": true, "service": "lumenbazaar-backend", "app": "api" }
```

**Configuration example (Kubernetes):**

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3
```

**Do not use liveness for dependency checking.** A database outage should never restart the API process.

---

## `/ready` — Readiness Probe

**Use for:** Kubernetes `readinessProbe`, ALB target group health checks, canary gating.

**Behaviour:** Runs all dependency probes **concurrently**, each with a bounded timeout (default 2 s, configurable via `READINESS_PROBE_TIMEOUT_MS`). Returns:

- `200 OK` — all required dependencies are healthy
- `503 Service Unavailable` — one or more required dependencies are not ready

The response body always has the same shape regardless of HTTP status:

```jsonc
{
  "ok": false,
  "environment": "testnet",
  "checks": {
    "database":   { "status": "unavailable", "latencyMs": 12,   "reason": "dependency_check_failed" },
    "redis":      { "status": "ready",        "latencyMs": 3 },
    "stellarRpc": { "status": "timeout",      "latencyMs": 2001, "reason": "probe_timeout" },
    "horizon":    { "status": "ready",        "latencyMs": 45 },
    "signer":     { "status": "not_required" },
    "migrations": { "status": "ready",        "latencyMs": 9 },
    "assets":     { "status": "unavailable", "reason": "dependency_check_failed" }
  },
  "capabilities": { "exact": false, "upto": false }
}
```

**Configuration example (Kubernetes):**

```yaml
readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 15
  failureThreshold: 2
  timeoutSeconds: 10   # Must exceed READINESS_PROBE_TIMEOUT_MS × number of probe retries
```

**Configuration example (AWS ALB):**

```
Path: /ready
Healthy threshold:   2
Unhealthy threshold: 2
Timeout:             10 s
Interval:            15 s
Success codes:       200
```

---

## Status Codes

| Status | Meaning |
|---|---|
| `ready` | Dependency responded successfully within the deadline |
| `unavailable` | Dependency is reachable but returned an error, or the probe threw an exception |
| `timeout` | Probe did not complete within the configured deadline (`READINESS_PROBE_TIMEOUT_MS`) |
| `not_configured` | The dependency is required for the current capabilities but has no probe registered (treat as failure) |
| `not_required` | The dependency is optional and not enabled for this deployment (not a failure) |

---

## Probe Timeout Configuration

The default probe deadline is **2 000 ms**. All probes run concurrently so the worst-case `/ready` response time is approximately one deadline plus HTTP overhead.

Override the deadline:

```env
READINESS_PROBE_TIMEOUT_MS=3000   # 3 seconds
```

Set the orchestrator health check timeout to at least `READINESS_PROBE_TIMEOUT_MS + 2000 ms` to avoid spurious failures from the orchestrator timing out before the probes finish.

---

## Error Redaction

The `/ready` endpoint never returns:

- Raw exception messages
- Hostnames or IP addresses from connection strings
- Credentials, passwords, tokens, or signing keys
- Stack traces

Errors are always mapped to stable reason codes: `dependency_check_failed` or `probe_timeout`. This is enforced at the service layer — individual probes may throw descriptive errors, but those are classified and discarded before the response is built.

---

## Dependency Probes

| Dependency | Probe method | Notes |
|---|---|---|
| PostgreSQL | `SELECT 1` + disconnect | Uses a short-lived Prisma client |
| Redis | `CONNECT` + `PING` + disconnect | ioredis with `maxRetriesPerRequest: 0` |
| Stellar RPC | `getLatestLedger` JSON-RPC | Checks for a valid `result` field |
| Horizon | `GET /` | Checks for HTTP 2xx |
| Signer | `assertReady()` + state check | Only probed when a payment adapter is enabled |
| Migrations | `_prisma_migrations` query | Checks all required migrations are applied |
| Assets | Config validation | Checks networks have real (non-placeholder) asset issuers |

---

## Runbook: `/ready` returning 503

1. Check the response body for the specific failing dependency and its `status` field.
2. `unavailable` — the dependency is reachable but unhealthy. Check the dependency's own logs.
3. `timeout` — the dependency didn't respond within `READINESS_PROBE_TIMEOUT_MS`. Check for network issues or overload.
4. `not_configured` — a required dependency has no probe. Check that the relevant environment variables are set (e.g., `DATABASE_URL`, `REDIS_URL`, `FACILITATOR_SIGNER_PROVIDER`).
5. Once the dependency recovers, `/ready` will automatically return 200 on the next probe — no restart needed.
6. While `/ready` is 503, `/health` continues to return 200. Do not restart the process based on `/ready` alone.

---

## Runbook: Testnet Deployment Gates and Rollback

This section ties the health endpoints into the executable testnet deployment checklist in `docs/deployment/testnet.md`. The checklist is the source of truth for ordering; this section records the health-check evidence expected at each gate.

### Gate ordering

1. **Migrations** — apply migrations in order and confirm the `migrations` probe reports `ready` on `/ready`.
2. **Readiness** — `/ready` returns 200 with all required dependencies `ready` or `not_required`.
3. **Smoke** — run the smoke suite against the deployed instance.
4. **Capability advertising** — only after readiness and smoke gates pass may the deployment advertise capabilities. The `/ready` `capabilities` object must reflect the actually enabled adapters; unsupported network and payment capabilities must remain `false` and fail closed.

### Evidence capture

At each gate, capture and attach to the deployment record:

- The `/ready` response body (redacted as described above) with the deploy commit SHA.
- The `/health` response body for the running process.
- Smoke suite output and exit code.
- The applied migration names and order.
- The advertised capabilities object and the configured adapter flags.

Never capture or commit credentials, seed phrases, private keys, signed private payloads, or production records. Use synthetic or explicitly public testnet data only.

### Rollback and health gates

1. Roll back the API, worker, and MCP to the previous image deferred in the checklist.
2. Confirm `/health` returns 200 for the rolled-back process.
3. Confirm `/ready` returns 200 and that the `migrations` probe still reports `ready` for the rolled-back schema.
4. Re-run the smoke suite and attach the output to the deployment record.
5. Preserve idempotency and payment evidence: do not delete or mutate idempotency keys or payment evidence records during rollback. Rollback must not recreate or replay payments.
6. Restore capability advertising to the previous known-good state only after readiness and smoke gates pass again.

---

## Migrations

Database schema migrations are not affected by this feature. The migrations probe is a **read-only check** against `_prisma_migrations` and does not modify the schema.
