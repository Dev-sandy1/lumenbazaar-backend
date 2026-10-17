# Facilitator Signer Operations

The hosted testnet signer uses the `environment` provider. Render stores
`FACILITATOR_SIGNING_KEY` as a secret; it must not be placed in a committed env file, build
argument, log statement, metric, health response, or support ticket. Application configuration
contains only the public account, network, provider name, key version, and the retirement
window length.

## Signer identity

Every signer has a public key identifier derived from the key version label and a
deterministic digest of the signing material. The identifier is stable across restarts,
can be stored on in-flight payment records, and never exposes the secret itself. The
identifier is the only signer reference persisted on in-flight records; the raw secret
and any historical signer material are never stored or accepted. Signers exist in one of
four states:

- `active` - receives new work.
- `retiring` - can still sign for in-flight records during the overlap window.
- `retired` - unusable after the overlap window closes.
- `revoked` - forced unavailable for incident response.

New work always uses the active signer. In-flight records preserve the key identifier and
are signed by the same key during the overlap window. Once the overlap window closes, a
retiring signer transitions to `retired` and becomes unusable: it is rejected for new work
and for any in-flight record that has not settled. A `revoked` signer is unusable
immediately, regardless of the remaining window.

## Provisioning

1. Create or select the funded Stellar testnet facilitator account outside the application
   process.
2. Set `FACILITATOR_ACCOUNT` to its public address and
   `FACILITATOR_SIGNER_NETWORK=stellar:testnet`.
3. Add `FACILITATOR_SIGNING_KEY` through the Render secret manager and set a non-secret
   `FACILITATOR_SIGNING_KEY_VERSION` label.
4. Set `FACILITATOR_SIGNER_PROVIDER=environment` and deploy.
5. Require `/ready` to report `checks.signer.status=ready` and the signer state to be
   `active` before enabling payment traffic.

Startup fails when the secret is missing, malformed, for the wrong account, or configured for
a different network. There is no hosted fallback to a development signer. On restart the
provider re-derives the signer identifier from the configured material; a restart with the
same key version and secret yields the same identifier and state, and a restart with a new
key version promotes the new key as active and moves the previous key to `retiring` for a
fresh window.

## Rotation

Overlap windows are controlled by `FACILITATOR_SIGNER_RETIRE_WINDOW_MS` (default 60000,
60 seconds). The window is the maximum time an in-flight record may continue to sign
with the previous key after promotion. Shorter windows are allowed but must exceed the
maximum settlement latency observed in production.

1. Prepare and fund the replacement testnet account.
2. Set the new `FACILITATOR_SIGNING_KEY` and key-version label in Render.
3. Restart all API instances. On startup the provider promotes the new key as active
   and moves the previous key into the retiring state for the configured window. The
   previous key remains usable only for in-flight records that already reference its
   identifier; it is never selected for new work.
4. Confirm the new public address and key identifier under `/v1/supported.signers` and
   confirm signer readiness.
5. Revoke and defund the previous testnet account only after in-flight settlement is
   reconciled and the retirement window has closed.

Changing only the key-version label reloads the current account material and produces a new
identifier for the same account. A secret whose derived address differs from
`FACILITATOR_ACCOUNT` is rejected. Rotation commands and state transitions are recorded as
audit records containing the signer identifier, previous and next states, key version, and
timestamp; audit records never contain secret material.

## Rollback

Within the overlap window, operators may roll back to the previous signer by calling
the provider's `rollback()` command. The previous key returns to the active state and the
currently configured key becomes retiring for a fresh window. Rollback fails closed once the
window has expired, no retiring signer is present, or the retiring signer has been revoked.
A failed rollback leaves the active signer unchanged and records the attempt in the audit log.

## Revocation And Incident Response

1. Disable exact and capped payment capabilities or stop the API deployment.
2. Remove the compromised secret from Render and rotate to a new account. Use the
   provider's `revoke()` command to force the retiring key to become unusable immediately.
   Revocation is terminal: a revoked signer cannot be reactivated by rollback or restart.
3. Review audit records, settlement hashes, and provider access logs for the incident window.
4. Reconcile every submitted transaction before restoring payment traffic.
5. Redeploy, verify readiness, run conformance checks, and record the new key version.

Never paste signing material into application logs or diagnostic commands. Error responses expose
only a stable signer-unavailable message and the `facilitator_signer` component identifier.
