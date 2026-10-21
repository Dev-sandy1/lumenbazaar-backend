import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getTraceparent,
  parseTraceparent,
  runWithTraceparent,
  safeIdentifierHash,
  sanitizeSpanAttributes,
  startTraceSpan
} from "./tracing.js";

const originalDisabled = process.env.OTEL_SDK_DISABLED;
const originalSampler = process.env.OTEL_TRACES_SAMPLER;
const originalSamplerArg = process.env.OTEL_TRACES_SAMPLER_ARG;

beforeEach(() => {
  process.env.OTEL_SDK_DISABLED = "false";
  delete process.env.OTEL_TRACES_SAMPLER;
  delete process.env.OTEL_TRACES_SAMPLER_ARG;
});

afterEach(() => {
  if (originalDisabled === undefined) delete process.env.OTEL_SDK_DISABLED;
  else process.env.OTEL_SDK_DISABLED = originalDisabled;
  if (originalSampler === undefined) delete process.env.OTEL_TRACES_SAMPLER;
  else process.env.OTEL_TRACES_SAMPLER = originalSampler;
  if (originalSamplerArg === undefined) delete process.env.OTEL_TRACES_SAMPLER_ARG;
  else process.env.OTEL_TRACES_SAMPLER_ARG = originalSamplerArg;
});

describe("trace propagation", () => {
  it("accepts valid W3C trace context and normalizes casing", () => {
    expect(parseTraceparent("00-ABCDEF0123456789ABCDEF0123456789-ABCDEF0123456789-01")).toEqual({
      traceId: "abcdef0123456789abcdef0123456789",
      spanId: "abcdef0123456789",
      traceFlags: 1
    });
  });

  it.each([
    undefined,
    "",
    "bad",
    "00-00000000000000000000000000000000-abcdef0123456789-01",
    "00-abcdef0123456789abcdef0123456789-0000000000000000-01",
    "00-abcdef0123456789abcdef0123456789-abcdef0123456789-zz",
    "00-abcdef0123456789abcdef0123456789-abcdef0123456789-01-extra"
  ])("rejects malformed trace context: %s", (header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });

  it("creates a child span while retaining the incoming trace id", () => {
    const incoming = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    runWithTraceparent(incoming, () => {
      const span = startTraceSpan("test.span");
      expect(span.traceparent).toMatch(/^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/);
      expect(getTraceparent()).toBe(incoming);
      span.end();
    });
  });

  it("supports the standard ratio sampler controls", () => {
    process.env.OTEL_TRACES_SAMPLER = "traceidratio";
    process.env.OTEL_TRACES_SAMPLER_ARG = "0";
    const span = startTraceSpan("unsampled.span");
    expect(span.traceparent).toMatch(/-00$/);
    span.end();
  });

  it("supports disabled mode without creating trace context", () => {
    process.env.OTEL_SDK_DISABLED = "true";
    expect(runWithTraceparent(undefined, () => getTraceparent())).toBeUndefined();
    const span = startTraceSpan("disabled.span");
    expect(span.traceparent).toBeUndefined();
    span.end();
  });

  it("redacts unapproved and oversized span attributes", () => {
    const attributes = sanitizeSpanAttributes({
      "http.request.method": "GET",
      "http.route": "/resources/:id",
      "http.response.status_code": 200,
      authorization: "Bearer synthetic-secret",
      "app.job.name": "x".repeat(161)
    });

    expect(attributes.map((attribute) => attribute.key)).toEqual([
      "http.request.method",
      "http.route",
      "http.response.status_code"
    ]);
    expect(JSON.stringify(attributes)).not.toContain("synthetic-secret");
  });

  it("hashes identifiers instead of exposing their raw values", () => {
    const hash = safeIdentifierHash("receipt_test_123");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain("receipt_test_123");
    expect(safeIdentifierHash("x".repeat(513))).toBeUndefined();
  });
});
