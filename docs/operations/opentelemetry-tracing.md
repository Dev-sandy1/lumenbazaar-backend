# OpenTelemetry trace propagation

The API, MCP HTTP server, and BullMQ workers support W3C Trace Context (`traceparent`) and export sampled spans using the vendor-neutral OTLP/HTTP JSON protocol. Telemetry is best-effort: an unavailable exporter or an export timeout must not fail an API request, queue operation, or payment.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OTEL_SDK_DISABLED` | `false` | Set to `true` to disable trace creation, propagation, and export. |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on` | Sampler strategy: `always_on`, `always_off`, `parentbased_always_on`, `parentbased_always_off`, `traceidratio`, or `parentbased_traceidratio`. Unknown values fail closed. |
| `OTEL_TRACES_SAMPLER_ARG` | `1` | Sampling probability from `0` to `1` when a ratio sampler is selected. Values outside the range are clamped. |
| `OTEL_SERVICE_NAME` | `lumenbazaar-backend` | Resource service name sent to OTLP. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Base OTLP endpoint; the exporter appends `/v1/traces`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | Full traces endpoint; takes precedence over the base endpoint. |

If no endpoint is configured, spans are not sent anywhere. The exporter uses a short request timeout and swallows transport failures so telemetry cannot interrupt business operations.

## Propagation and data safety

- Incoming W3C trace context is validated before it is trusted. New span IDs are generated for each instrumented request or job.
- The API and MCP HTTP entrypoints create bounded request spans. BullMQ enqueue helpers copy the current `traceparent` into job data, and worker handlers create processing spans from that context.
- Exported attributes are allowlisted. Route templates are used instead of raw URLs; settlement and receipt identifiers are represented only by truncated SHA-256 hashes. Request bodies, headers, payment payloads, credentials, and raw identifiers are not span attributes.
- Do not use trace IDs, settlement IDs, receipt IDs, or other per-request values as metric labels.
- Use synthetic/testnet data for tests. Never commit credentials, signing keys, seed phrases, or production payment records.

## Validation

Run `pnpm check` after changing tracing code. Focused tests cover W3C header validation, parent trace continuity, sampling controls, span-attribute redaction, identifier hashing, queue/HTTP propagation, and disabled mode.
