import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithTraceparent } from "@lumenbazaar/shared";

import { BackendClient } from "./client.js";

describe("MCP backend client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("propagates W3C trace context to backend HTTP requests", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, data: { kinds: [] } }));
    vi.stubGlobal("fetch", fetchImpl);
    const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

    await runWithTraceparent(traceparent, () =>
      new BackendClient("https://api.example.test").getSupported()
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/v1/supported",
      expect.objectContaining({
        headers: { accept: "application/json", traceparent }
      })
    );
  });

  it("reads direct network responses from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          networks: [
            {
              id: "stellar:testnet",
              displayName: "Stellar Testnet"
            }
          ]
        })
      )
    );

    await expect(new BackendClient("https://api.example.test").listNetworks()).resolves.toEqual([
      {
        id: "stellar:testnet",
        name: "Stellar Testnet",
        chain: "stellar"
      }
    ]);
  });

  it("advertises exact tools only when readiness and supported capabilities agree", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/ready")) {
          return Response.json({ ok: true });
        }
        return Response.json({
          kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }]
        });
      })
    );

    await expect(
      new BackendClient("https://api.example.test").getToolCapabilities()
    ).resolves.toEqual({ backend: true, exact: true });
  });

  it("fails capability probing closed when the backend cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection failed");
      })
    );

    await expect(
      new BackendClient("https://api.example.test").getToolCapabilities()
    ).resolves.toEqual({ backend: false, exact: false });
  });

  it("computes MCP payment terms from direct resource search results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          resources: [resource()],
          nextCursor: "cursor_2"
        })
      )
    );

    const result = await new BackendClient("https://api.example.test").searchResources({
      q: "weather"
    });

    expect(result).toMatchObject({
      cursor: "cursor_2",
      resources: [
        {
          paymentTerms: {
            scheme: "exact",
            amount: "500000",
            payTo: "GBZXN7PIRZGNMHGAIQW7QEJWW36L5CVVNRYANMDW2G3QOF2VCR4DQSQE"
          }
        }
      ]
    });
  });

  it("fetches resources from the canonical resource endpoint", async () => {
    const fetchImpl = vi.fn(async () => Response.json(resource()));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      new BackendClient("https://api.example.test").getResource("resource_1")
    ).resolves.toMatchObject({
      id: "resource_1",
      paymentTerms: {
        amount: "500000"
      }
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/v1/resources/resource_1",
      expect.objectContaining({ headers: { accept: "application/json" } })
    );
  });
});

function resource() {
  return {
    id: "resource_1",
    name: "Weather API",
    description: "Weather data",
    type: "http",
    url: "https://seller.example/weather",
    routeTemplate: "/weather/{city}",
    inputSchema: {
      type: "object"
    },
    outputSchema: {
      type: "object"
    },
    network: "stellar:testnet",
    assetCode: "USDC",
    assetIssuer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amount: "0.05",
    payTo: "GBZXN7PIRZGNMHGAIQW7QEJWW36L5CVVNRYANMDW2G3QOF2VCR4DQSQE"
  };
}
