/**
 * Startup checks for payment adapters.
 *
 * Each check runs a lightweight, bounded self-test to confirm that an adapter
 * is wired up and reachable before the capability registry registers a scheme.
 *
 * Reason codes are stable and never include raw provider errors, secrets, keys,
 * connection strings, or signed payloads.
 */

export type AdapterStartupCheckResult =
  | { ok: true }
  | { ok: false; reason: AdapterStartupCheckFailureReason };

/**
 * Stable reason codes surfaced in startup diagnostics.
 *
 * - adapter_not_configured   — no adapter was provided; capability cannot be served
 * - startup_check_failed     — the adapter threw or returned an unhealthy result
 * - startup_check_timeout    — the check did not complete within the allowed deadline
 */
export type AdapterStartupCheckFailureReason =
  | "adapter_not_configured"
  | "startup_check_failed"
  | "startup_check_timeout";

export type AdapterStartupCheckOptions = {
  /**
   * Maximum milliseconds to wait for the startup check to complete.
   * Defaults to 5 000 ms.
   */
  timeoutMs?: number;
};

// ─── Exact adapter startup check ──────────────────────────────────────────────

import { type X402StellarAdapter } from "./x402Adapter.js";

/**
 * Run a startup check for the exact payment adapter.
 *
 * The check calls `verifyExact` with a synthetic sentinel payload and confirms
 * that the adapter responds — even a rejected verification counts as "alive".
 * The adapter is only considered failed when it throws or times out, not when
 * it returns a valid-false result (which is the expected no-op adapter path).
 *
 * When `adapter` is undefined the check immediately returns
 * `adapter_not_configured`.
 */
export async function checkExactAdapter(
  adapter: X402StellarAdapter | undefined,
  options: AdapterStartupCheckOptions = {}
): Promise<AdapterStartupCheckResult> {
  if (adapter === undefined) {
    return { ok: false, reason: "adapter_not_configured" };
  }

  const timeoutMs = options.timeoutMs ?? 5_000;

  try {
    const result = await raceTimeout(
      () =>
        adapter.verifyExact({
          paymentPayload: sentinelExactPayload,
          paymentRequirements: sentinelExactRequirements,
          normalizedRequest: sentinelNormalizedRequest
        }),
      timeoutMs
    );

    // Any response (even valid:false) means the adapter is alive and callable.
    if (result === "timeout") {
      return { ok: false, reason: "startup_check_timeout" };
    }

    return { ok: true };
  } catch {
    // The adapter threw — treat as failed, never surface the raw error.
    return { ok: false, reason: "startup_check_failed" };
  }
}

// ─── Upto adapter startup check ───────────────────────────────────────────────

import { type PaymentSessionService } from "./paymentSession.js";

/**
 * Run a startup check for the upto (capped session) adapter.
 *
 * The check calls `getSession` with a synthetic unknown ID.  The session service
 * is expected to throw a RESOURCE_NOT_FOUND LumenError.  Any response — including
 * that expected error — means the service is alive and wired up.
 *
 * When `service` is undefined the check immediately returns
 * `adapter_not_configured`.
 */
export async function checkUptoAdapter(
  service: PaymentSessionService | undefined,
  options: AdapterStartupCheckOptions = {}
): Promise<AdapterStartupCheckResult> {
  if (service === undefined) {
    return { ok: false, reason: "adapter_not_configured" };
  }

  const timeoutMs = options.timeoutMs ?? 5_000;

  try {
    const result = await raceTimeout(
      () =>
        service
          .getSession("startup_check_sentinel_session_id_0000000000000000")
          .then(() => "responded" as const)
          .catch(() => "responded" as const),
      timeoutMs
    );

    if (result === "timeout") {
      return { ok: false, reason: "startup_check_timeout" };
    }

    return { ok: true };
  } catch {
    return { ok: false, reason: "startup_check_failed" };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Race an async operation against a wall-clock timeout.
 * Returns `"timeout"` if the timer fires first.  Raw errors from `fn` are
 * re-thrown so the caller can classify them as startup_check_failed.
 */
async function raceTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<T | "timeout"> {
  return new Promise<T | "timeout">((resolve, reject) => {
    const id = setTimeout(() => resolve("timeout"), timeoutMs);

    if (typeof id === "object" && "unref" in id) {
      (id as NodeJS.Timeout).unref();
    }

    fn().then(
      (value) => {
        clearTimeout(id);
        resolve(value);
      },
      (err) => {
        clearTimeout(id);
        reject(err);
      }
    );
  });
}

// ─── Synthetic sentinel payloads (no real secrets or keys) ────────────────────

import type {
  ExactStellarPaymentPayload,
  ExactStellarPaymentRequirements,
  NormalizedVerifyPaymentRequest,
} from "./paymentPayload.js";

/** All-zeros sentinel Stellar public key (not a real key). */
const sentinelAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Sentinel contract ID (not a real contract). */
const sentinelContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

const sentinelExactRequirements: ExactStellarPaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: sentinelContractId,
  amount: "1",
  payTo: sentinelAddress,
  maxTimeoutSeconds: 10,
  extra: {}
};

const sentinelExactPayload: ExactStellarPaymentPayload = {
  x402Version: 2,
  accepted: sentinelExactRequirements,
  payload: {
    transaction: Buffer.from("startup_check_sentinel").toString("base64")
  }
};

const sentinelNormalizedRequest: NormalizedVerifyPaymentRequest = {
  x402Version: 2,
  paymentPayload: sentinelExactPayload,
  paymentRequirements: sentinelExactRequirements,
  network: "stellar:testnet",
  amount: "1",
  payTo: sentinelAddress,
  asset: {
    code: "USDC",
    issuer: sentinelAddress,
    contractId: sentinelContractId,
    decimals: 7
  }
};
