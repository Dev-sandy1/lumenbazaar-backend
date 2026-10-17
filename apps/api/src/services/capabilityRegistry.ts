/**
 * Capability registry — single source of truth for supported payment schemes
 * at runtime.
 *
 * A scheme is registered only when its adapter passes a startup check with a
 * bounded timeout.  Config flags and environment variables alone are not
 * sufficient — they may restrict but never add capabilities.
 *
 * The registry is immutable after `buildCapabilityRegistry` resolves: all
 * mutating operations are absent from the public type.
 */

import {
  checkExactAdapter,
  checkUptoAdapter,
  type AdapterStartupCheckFailureReason,
  type AdapterStartupCheckOptions,
} from "@lumenbazaar/stellar-payments";
import {
  type PaymentSessionService,
  type X402StellarAdapter,
} from "@lumenbazaar/stellar-payments";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Supported scheme identifiers.  Extend here if new schemes are added.
 */
export type PaymentScheme = "exact" | "upto";

/**
 * A registered, supported (scheme, network) capability.
 */
export type RegisteredCapability = {
  scheme: PaymentScheme;
  network: string;
};

/**
 * Diagnostic record for a scheme that failed to register.
 */
export type CapabilityDiagnostic = {
  scheme: PaymentScheme;
  /**
   * Stable reason code — never includes raw error messages, secrets, keys,
   * connection strings, or signed payloads.
   */
  reason: AdapterStartupCheckFailureReason;
};

/**
 * Immutable runtime capability registry.
 *
 * Populated once during startup and never mutated afterwards.  Consumers
 * should call `getSupportedSchemes()` or `isSupported()` rather than holding
 * a reference to the returned arrays.
 */
export type CapabilityRegistry = {
  /**
   * All (scheme, network) pairs that passed their adapter startup check.
   */
  getSupportedSchemes(): ReadonlyArray<RegisteredCapability>;

  /**
   * True if `scheme` is registered for `network`.
   *
   * @param scheme - e.g. "exact" or "upto"
   * @param network - e.g. "stellar:testnet"
   */
  isSupported(scheme: PaymentScheme, network: string): boolean;

  /**
   * Diagnostics for schemes that were NOT registered, explaining why.
   * Reason codes are stable and safe to log or expose in structured responses.
   * Never includes secrets or raw provider errors.
   */
  getUnavailableReasons(): ReadonlyArray<CapabilityDiagnostic>;
};

// ─── Build options ────────────────────────────────────────────────────────────

export type CapabilityRegistryBuildOptions = {
  /**
   * The exact payment adapter.  When undefined, the exact scheme is not
   * registered and `adapter_not_configured` is recorded.
   */
  exactAdapter?: X402StellarAdapter;

  /**
   * The upto (capped-session) payment session service.  When undefined, the
   * upto scheme is not registered and `adapter_not_configured` is recorded.
   */
  uptoService?: PaymentSessionService;

  /**
   * Networks for which to attempt capability registration.
   */
  networks: ReadonlyArray<string>;

  /**
   * Upper-bound restriction.  When provided, a scheme that passes its startup
   * check is still omitted if `allowedCapabilities[scheme]` is explicitly
   * `false`.  This lets tests inject `paymentCapabilities: { exact: false }`
   * without a live adapter.  The option can only restrict, never add.
   *
   * Both fields default to `true` when omitted.
   */
  allowedCapabilities?: {
    exact?: boolean;
    upto?: boolean;
  };

  /**
   * Options forwarded to each adapter startup check.
   */
  checkOptions?: AdapterStartupCheckOptions;

  /**
   * Structured logger.  When provided, the registry emits a diagnostic line
   * per scheme after startup checks complete.
   */
  logger?: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
  };
};

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Run adapter startup checks and build an immutable `CapabilityRegistry`.
 *
 * Both checks run in parallel.  A scheme is registered only when:
 *   1. Its startup check passes (adapter responds within the timeout), AND
 *   2. `allowedCapabilities[scheme]` is not explicitly `false`.
 *
 * This function always resolves — a failed or timed-out check records a
 * diagnostic and leaves the scheme unregistered instead of throwing.
 */
export async function buildCapabilityRegistry(
  options: CapabilityRegistryBuildOptions
): Promise<CapabilityRegistry> {
  const { exactAdapter, uptoService, networks, checkOptions, logger } = options;
  const allowExact = options.allowedCapabilities?.exact !== false;
  const allowUpto = options.allowedCapabilities?.upto !== false;

  // Run both startup checks in parallel with bounded timeouts.
  const [exactResult, uptoResult] = await Promise.all([
    checkExactAdapter(exactAdapter, checkOptions),
    checkUptoAdapter(uptoService, checkOptions),
  ]);

  // Determine which schemes are available.
  const exactAvailable = allowExact && exactResult.ok;
  const uptoAvailable = allowUpto && uptoResult.ok;

  // Build the registered capabilities list.
  const supported: RegisteredCapability[] = [];
  if (exactAvailable) {
    for (const network of networks) {
      supported.push({ scheme: "exact", network });
    }
  }
  if (uptoAvailable) {
    for (const network of networks) {
      supported.push({ scheme: "upto", network });
    }
  }

  // Build unavailability diagnostics.
  const unavailable: CapabilityDiagnostic[] = [];

  if (!exactAvailable) {
    const reason: AdapterStartupCheckFailureReason = !exactResult.ok
      ? exactResult.reason
      : "adapter_not_configured"; // allowedCapabilities restricted it
    unavailable.push({ scheme: "exact", reason });
  }
  if (!uptoAvailable) {
    const reason: AdapterStartupCheckFailureReason = !uptoResult.ok
      ? uptoResult.reason
      : "adapter_not_configured";
    unavailable.push({ scheme: "upto", reason });
  }

  // Emit startup diagnostics (no secrets, keys, or raw errors in log output).
  if (logger !== undefined) {
    for (const cap of supported) {
      logger.info("capability_registered", { scheme: cap.scheme, network: cap.network });
    }
    for (const diag of unavailable) {
      logger.warn("capability_unavailable", { scheme: diag.scheme, reason: diag.reason });
    }
  }

  // Freeze the arrays so callers cannot mutate them.
  const frozenSupported = Object.freeze(supported.map((c) => Object.freeze({ ...c })));
  const frozenUnavailable = Object.freeze(
    unavailable.map((d) => Object.freeze({ ...d }))
  );

  return {
    getSupportedSchemes(): ReadonlyArray<RegisteredCapability> {
      return frozenSupported;
    },

    isSupported(scheme: PaymentScheme, network: string): boolean {
      return frozenSupported.some((c) => c.scheme === scheme && c.network === network);
    },

    getUnavailableReasons(): ReadonlyArray<CapabilityDiagnostic> {
      return frozenUnavailable;
    },
  };
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Create a static capability registry for use in tests.
 *
 * Unlike `buildCapabilityRegistry`, this runs no startup checks.
 * It directly populates the registry from the supplied capability map.
 */
export function createStaticCapabilityRegistry(
  capabilities: Partial<Record<PaymentScheme, boolean>>,
  networks: ReadonlyArray<string> = ["stellar:testnet"]
): CapabilityRegistry {
  const supported: RegisteredCapability[] = [];
  const unavailable: CapabilityDiagnostic[] = [];

  for (const scheme of ["exact", "upto"] as PaymentScheme[]) {
    if (capabilities[scheme] === true) {
      for (const network of networks) {
        supported.push({ scheme, network });
      }
    } else {
      unavailable.push({ scheme, reason: "adapter_not_configured" });
    }
  }

  const frozenSupported = Object.freeze(supported.map((c) => Object.freeze({ ...c })));
  const frozenUnavailable = Object.freeze(
    unavailable.map((d) => Object.freeze({ ...d }))
  );

  return {
    getSupportedSchemes: () => frozenSupported,
    isSupported: (scheme, network) =>
      frozenSupported.some((c) => c.scheme === scheme && c.network === network),
    getUnavailableReasons: () => frozenUnavailable,
  };
}
