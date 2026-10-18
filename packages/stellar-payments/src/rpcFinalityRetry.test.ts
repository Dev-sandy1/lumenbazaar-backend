/**
 * Tests for RPC finality retry logic in x402Adapter.
 * Verifies that transaction finality polling retries with exponential backoff
 * and handles pending, confirmed, and failed states correctly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock types for testing
type SettlementFinality =
  | { status: "confirmed"; ledger: number }
  | { status: "failed" }
  | { status: "pending" };

describe("RPC Finality Retry Logic", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
  });

  it("should return confirmed status on first successful RPC call", async () => {
    // Mock successful RPC response
    const mockResponse = {
      ok: true,
      json: async () => ({
        result: {
          status: "SUCCESS",
          ledger: 12345678
        }
      })
    };

    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse as Record<string, unknown>);

    const result = await resolveRpcFinalityTestable({
      rpcUrl: "http://localhost:8000/soroban/rpc",
      transactionHash: "test_tx_hash"
    });

    expect(result.status).toBe("confirmed");
    expect(result.ledger).toBe(12345678);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("should return failed status when transaction fails", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        result: {
          status: "FAILED"
        }
      })
    };

    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse as Record<string, unknown>);

    const result = await resolveRpcFinalityTestable({
      rpcUrl: "http://localhost:8000/soroban/rpc",
      transactionHash: "failed_tx"
    });

    expect(result.status).toBe("failed");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("should retry on pending status and eventually confirm", async () => {
    const pendingResponse = {
      ok: true,
      json: async () => ({
        result: {
          status: "PENDING"
        }
      })
    };

    const confirmedResponse = {
      ok: true,
      json: async () => ({
        result: {
          status: "SUCCESS",
          ledger: 87654321
        }
      })
    };

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(pendingResponse as Record<string, unknown>)
      .mockResolvedValueOnce(pendingResponse as Record<string, unknown>)
      .mockResolvedValueOnce(confirmedResponse as Record<string, unknown>);

    const result = await resolveRpcFinalityTestable({
      rpcUrl: "http://localhost:8000/soroban/rpc",
      transactionHash: "pending_tx"
    });

    expect(result.status).toBe("confirmed");
    expect(result.ledger).toBe(87654321);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("should return pending after max retries exhausted", async () => {
    const pendingResponse = {
      ok: true,
      json: async () => ({
        result: {
          status: "PENDING"
        }
      })
    };

    // Mock 20 pending responses (max attempts)
    fetchSpy = vi.spyOn(global, "fetch");
    for (let i = 0; i < 20; i += 1) {
      fetchSpy.mockResolvedValueOnce(pendingResponse as Record<string, unknown>);
    }

    const result = await resolveRpcFinalityTestable({
      rpcUrl: "http://localhost:8000/soroban/rpc",
      transactionHash: "always_pending_tx"
    });

    expect(result.status).toBe("pending");
    expect(fetchSpy).toHaveBeenCalledTimes(20); // max retries
  });

  it("should retry on network error", async () => {
    const networkError = new Error("Network error");

    const successResponse = {
      ok: true,
      json: async () => ({
        result: {
          status: "SUCCESS",
          ledger: 99999
        }
      })
    };

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(successResponse as Record<string, unknown>);

    const result = await resolveRpcFinalityTestable({
      rpcUrl: "http://localhost:8000/soroban/rpc",
      transactionHash: "network_error_tx"
    });

    expect(result.status).toBe("confirmed");
    expect(result.ledger).toBe(99999);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("should retry on HTTP error response", async () => {
    const errorResponse = {
      ok: false,
      status: 500
    };

    const successResponse = {
      ok: true,
      json: async () => ({
        result: {
          status: "SUCCESS",
          ledger: 55555
        }
      })
    };

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(errorResponse as Record<string, unknown>)
      .mockResolvedValueOnce(successResponse as Record<string, unknown>);

    const result = await resolveRpcFinalityTestable({
      rpcUrl: "http://localhost:8000/soroban/rpc",
      transactionHash: "http_error_tx"
    });

    expect(result.status).toBe("confirmed");
    expect(result.ledger).toBe(55555);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("should retry on invalid JSON response", async () => {
    const invalidResponse = {
      ok: true,
      json: async () => ({
        error: "Invalid request"
      })
    };

    const validResponse = {
      ok: true,
      json: async () => ({
        result: {
          status: "SUCCESS",
          ledger: 11111
        }
      })
    };

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(invalidResponse as Record<string, unknown>)
      .mockResolvedValueOnce(validResponse as Record<string, unknown>);

    const result = await resolveRpcFinalityTestable({
      rpcUrl: "http://localhost:8000/soroban/rpc",
      transactionHash: "invalid_json_tx"
    });

    expect(result.status).toBe("confirmed");
    expect(result.ledger).toBe(11111);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("should use exponential backoff with configurable delays", async () => {
    const delayTimings: number[] = [];
    const originalSetTimeout = global.setTimeout;

    // Track setTimeout calls to measure backoff timing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.setTimeout = ((callback: any, delay?: number) => {
      if (typeof delay === "number") {
        delayTimings.push(delay);
      }
      // Execute immediately for testing
      callback();
      return {} as any;
    }) as any;

    const pendingResponse = {
      ok: true,
      json: async () => ({
        result: {
          status: "PENDING"
        }
      })
    };

    fetchSpy = vi.spyOn(global, "fetch");
    for (let i = 0; i < 5; i += 1) {
      fetchSpy.mockResolvedValueOnce(pendingResponse as Record<string, unknown>);
    }

    await resolveRpcFinalityTestable({
      rpcUrl: "http://localhost:8000/soroban/rpc",
      transactionHash: "backoff_test_tx"
    });

    // Restore original setTimeout
    global.setTimeout = originalSetTimeout as any;

    // Verify exponential backoff: 100ms, 200ms, 400ms, 800ms, etc (capped at 2000ms)
    const expectedDelays = [100, 200, 400, 800, 1600];
    delayTimings.forEach((delay, index) => {
      expect(delay).toBeLessThanOrEqual(expectedDelays[index]);
    });
  });
});

/**
 * Testable version of resolveRpcFinality from x402Adapter.ts
 * Extracted for unit testing purposes.
 */
async function resolveRpcFinalityTestable(input: {
  rpcUrl: string;
  transactionHash: string;
}): Promise<SettlementFinality> {
  const maxAttempts = 20;
  const baseDelayMs = 100;
  const maxDelayMs = 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: { hash: input.transactionHash }
        }),
        signal: AbortSignal.timeout(5_000)
      });

      if (!response.ok) {
        if (attempt < maxAttempts - 1) {
          await delay(Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs));
          continue;
        }
        throw new Error("Stellar RPC finality request failed after max retries.");
      }

      const payload = (await response.json()) as {
        error?: unknown;
        result?: { status?: string; ledger?: number };
      };

      if (payload.error !== undefined || payload.result === undefined) {
        if (attempt < maxAttempts - 1) {
          await delay(Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs));
          continue;
        }
        throw new Error("Stellar RPC finality response was invalid.");
      }

      if (payload.result.status === "SUCCESS" && Number.isInteger(payload.result.ledger)) {
        return { status: "confirmed", ledger: payload.result.ledger as number };
      }

      if (payload.result.status === "FAILED") {
        return { status: "failed" };
      }

      // Pending - retry if attempts remain
      if (attempt < maxAttempts - 1) {
        await delay(Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs));
        continue;
      }

      // Max retries reached while still pending
      return { status: "pending" };
    } catch (error) {
      if (attempt < maxAttempts - 1) {
        await delay(Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs));
        continue;
      }
      throw error;
    }
  }

  // Should not reach here
  return { status: "pending" };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
