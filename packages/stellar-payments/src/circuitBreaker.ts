/**
 * Bounded circuit breaker for Stellar RPC / Horizon endpoint probes.
 *
 * State machine (per-endpoint, in-process):
 *   CLOSED    → normal operation, failures counted
 *   OPEN      → endpoint skipped for `cooldownMs`; probe not attempted
 *   HALF_OPEN → after cooldown, one trial probe is allowed
 *               success → CLOSED; failure → OPEN (cooldown restarts)
 *
 * In-process state is intentional: each worker maintains its own view of
 * endpoint health. Sharing across processes would require Redis and is
 * out of scope for this issue.
 */

export type CircuitState = "closed" | "open" | "half_open";

type Entry = {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
};

const BREAKER_BY_URL = new Map<string, Entry>();

export type CircuitBreakerOptions = {
  /** Failures before the circuit opens. Default: 3. */
  failureThreshold?: number;
  /** How long an OPEN circuit waits before a HALF_OPEN trial. Default: 30 000 ms. */
  cooldownMs?: number;
};

const DEFAULTS = {
  failureThreshold: 3,
  cooldownMs: 30_000
};

function entryFor(url: string): Entry {
  let entry = BREAKER_BY_URL.get(url);
  if (entry === undefined) {
    entry = { state: "closed", consecutiveFailures: 0, openedAt: null };
    BREAKER_BY_URL.set(url, entry);
  }
  return entry;
}

/** Returns true if the endpoint may be probed right now. */
export function isEndpointAvailable(
  url: string,
  now = Date.now(),
  options: CircuitBreakerOptions = {}
): boolean {
  const entry = entryFor(url);
  const { cooldownMs } = { ...DEFAULTS, ...options };

  if (entry.state === "closed") return true;
  if (entry.state === "half_open") return true; // a trial is already allowed

  // state === "open"
  if (entry.openedAt !== null && now - entry.openedAt >= cooldownMs) {
    entry.state = "half_open";
    return true;
  }
  return false;
}

export function recordSuccess(url: string): void {
  const entry = entryFor(url);
  entry.state = "closed";
  entry.consecutiveFailures = 0;
  entry.openedAt = null;
}

export function recordFailure(url: string, options: CircuitBreakerOptions = {}): void {
  const { failureThreshold } = { ...DEFAULTS, ...options };
  const entry = entryFor(url);
  entry.consecutiveFailures += 1;

  if (entry.state === "half_open") {
    // Trial failed → reopen immediately.
    entry.state = "open";
    entry.openedAt = Date.now();
    return;
  }

  if (entry.state === "closed" && entry.consecutiveFailures >= failureThreshold) {
    entry.state = "open";
    entry.openedAt = Date.now();
  }
}

/** Observability — redacts the URL so callers never log credentials. */
export function getCircuitSnapshot(now = Date.now()): Array<{
  endpoint: string;
  state: CircuitState;
  consecutiveFailures: number;
  cooldownRemainingMs: number;
}> {
  const out: Array<{
    endpoint: string;
    state: CircuitState;
    consecutiveFailures: number;
    cooldownRemainingMs: number;
  }> = [];

  for (const [url, entry] of BREAKER_BY_URL.entries()) {
    const remaining =
      entry.state === "open" && entry.openedAt !== null
        ? Math.max(0, DEFAULTS.cooldownMs - (now - entry.openedAt))
        : 0;

    out.push({
      endpoint: redactEndpoint(url),
      state: entry.state,
      consecutiveFailures: entry.consecutiveFailures,
      cooldownRemainingMs: remaining
    });
  }
  return out;
}

/** Test-only: wipe breaker state between cases. */
export function resetCircuitState(): void {
  BREAKER_BY_URL.clear();
}

/**
 * Redact a URL for logging: keep scheme + host, drop path/query/userinfo.
 * Avoids leaking tokens embedded in RPC URLs.
 */
function redactEndpoint(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<invalid-url>";
  }
}