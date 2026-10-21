import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

type TraceContext = {
  traceId: string;
  spanId: string;
  traceFlags: number;
};

type AttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, AttributeValue>;

const contextStorage = new AsyncLocalStorage<TraceContext>();
const allowedAttributes = new Set([
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "messaging.destination.name",
  "messaging.operation",
  "app.job.name",
  "app.settlement.id_hash",
  "app.receipt.id_hash"
]);

function disabled() {
  return process.env.OTEL_SDK_DISABLED === "true";
}

function samplerRatio() {
  const value = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? "1");
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

function shouldSample(parent?: TraceContext) {
  const configured = process.env.OTEL_TRACES_SAMPLER ?? "parentbased_always_on";
  const parentBased = configured.startsWith("parentbased_");
  if (parentBased && parent !== undefined) return (parent.traceFlags & 1) === 1;

  const sampler = parentBased ? configured.slice("parentbased_".length) : configured;
  if (sampler === "always_off") return false;
  if (sampler === "always_on") return true;
  if (sampler === "traceidratio") return Math.random() < samplerRatio();
  return false;
}

function randomHex(bytes: number) {
  return randomBytes(bytes).toString("hex");
}

export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  if (value === undefined || value.length > 256) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(value.trim());
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) {
    return undefined;
  }
  const traceFlags = Number.parseInt(match[3]!, 16);
  return {
    traceId: match[1]!.toLowerCase(),
    spanId: match[2]!.toLowerCase(),
    traceFlags
  };
}

export function getTraceparent() {
  if (disabled()) return undefined;
  const context = contextStorage.getStore();
  if (!context) return undefined;
  const flags = context.traceFlags.toString(16).padStart(2, "0");
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

export function safeIdentifierHash(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function sanitizeSpanAttributes(attributes: SpanAttributes) {
  return Object.entries(attributes)
    .filter(
      ([key, value]) =>
        allowedAttributes.has(key) && (typeof value !== "string" || value.length <= 160)
    )
    .map(([key, value]) => ({
      key,
      value:
        typeof value === "string"
          ? { stringValue: value }
          : typeof value === "boolean"
            ? { boolValue: value }
            : { intValue: String(value) }
    }));
}

function exporterEndpoint() {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesEndpoint) return tracesEndpoint;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/v1/traces`;
}

async function exportSpan(span: {
  context: TraceContext;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  kind: number;
  attributes: SpanAttributes;
}) {
  const endpoint = exporterEndpoint();
  if (!endpoint || disabled() || (span.context.traceFlags & 1) === 0) return;
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: {
                stringValue: (process.env.OTEL_SERVICE_NAME || "lumenbazaar-backend")
                  .replace(/[^a-zA-Z0-9_.-]/g, "_")
                  .slice(0, 128)
              }
            }
          ]
        },
        scopeSpans: [
          {
            scope: { name: "lumenbazaar.tracing", version: "1.0.0" },
            spans: [
              {
                traceId: span.context.traceId,
                spanId: span.context.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name.slice(0, 128),
                kind: span.kind,
                startTimeUnixNano: span.startTimeUnixNano,
                endTimeUnixNano: span.endTimeUnixNano,
                attributes: sanitizeSpanAttributes(span.attributes),
                status: { code: 1 }
              }
            ]
          }
        ]
      }
    ]
  };
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1500)
    });
  } catch {
    // Telemetry is best-effort and must never affect request or payment processing.
  }
}

export function startTraceSpan(name: string, attributes: SpanAttributes = {}, kind = 1) {
  const parent = contextStorage.getStore();
  if (disabled()) {
    return {
      context: undefined,
      traceparent: undefined,
      run: <T>(callback: () => T) => callback(),
      end: (_extra?: SpanAttributes) => {}
    };
  }

  const remoteParent = parent;
  const context: TraceContext = {
    traceId: remoteParent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    traceFlags: shouldSample(remoteParent) ? 1 : 0
  };
  const startTimeUnixNano = String(Date.now() * 1_000_000);
  const flags = context.traceFlags.toString(16).padStart(2, "0");
  const traceparent = `00-${context.traceId}-${context.spanId}-${flags}`;
  let ended = false;

  return {
    context,
    traceparent,
    run<T>(callback: () => T) {
      return contextStorage.run(context, callback);
    },
    end(extra: SpanAttributes = {}) {
      if (ended) return;
      ended = true;
      const endTimeUnixNano = String(Date.now() * 1_000_000);
      void exportSpan({
        context,
        ...(remoteParent ? { parentSpanId: remoteParent.spanId } : {}),
        name,
        startTimeUnixNano,
        endTimeUnixNano,
        kind,
        attributes: { ...attributes, ...extra }
      });
    }
  };
}

export function runWithTraceparent<T>(traceparent: string | undefined, callback: () => T) {
  if (disabled()) return callback();
  const parsed = parseTraceparent(traceparent);
  return parsed ? contextStorage.run(parsed, callback) : callback();
}

export function withTraceSpan<T>(
  name: string,
  attributes: SpanAttributes,
  callback: () => Promise<T>
): Promise<T> {
  const span = startTraceSpan(name, attributes);
  return span.run(async () => {
    try {
      return await callback();
    } finally {
      span.end();
    }
  });
}
