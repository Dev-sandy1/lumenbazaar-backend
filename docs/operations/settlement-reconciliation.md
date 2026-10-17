# Settlement reconciliation

Hosted workers use BullMQ and Redis. Settlement confirmation jobs use
`settlement-<paymentAttemptId>` as the deterministic job identifier, survive worker restarts, retry
with eight bounded exponential-backoff attempts, and move to the dead-letter queue after attempts
are exhausted.

At startup the worker scans for `settling` attempts without a settlement and non-final settlements
with transaction evidence. It enqueues one reconciliation job per payment attempt. The API does not
resubmit these payments. The API also enqueues the same deterministic job immediately after it
durably records a non-final submission; an enqueue outage is audit-logged and the startup scan is
the recovery path.

## Observation sources

The worker compares two independent observation sources before finalizing a
settlement:

- **Horizon** - the canonical transaction lookup used for transaction visibility and
ledger attribution.
- **RPC finality adapter** - an optional secondary observation source that can confirm,
fail, or remain pending for the same transaction hash. When the adapter is not wired in, the
worker falls back to Horizon-only behavior for backward compatibility.

Each observation is one of the following shapes:

- `confirmed` with a ledger number
- `failed` with a reason
- `pending` with a reason (transaction not yet visible)
- `unavailable` with a reason (transport error or timeout)

## Agreement and disagreement states

The comparison is classified explicitly by `classifyReconciliationAgreement` in
`packages/stellar-payments/src/reconciliation.ts`:

| State | Meaning | Worker action |
| --- | --- | --- |
| `agreed_confirmed` | Horizon and RPC agree on the same confirmed ledger. | Finalize settlement and receipt atomically. |
| `agreed_failed` | Horizon and RPC agree the transaction failed. | Mark for operator review; never resubmit. |
| `agreed_pending` | Neither source has observed a final result yet. | Preserve pending outcome and retry within the bounded policy. |
| `disagree_only_horizon` | Horizon confirmed but RPC has not yet observed. | Preserve pending; retry until convergence or dead-letter. |
| `disagree_only_rpc` | RPC confirmed but Horizon has not yet observed. | Preserve pending; retry until convergence or dead-letter. |
| `disagree_ledger_mismatch` | Both confirmed but at different ledgers. | Mark for operator review. |
| `disagree_confirmed_conflict` | One source confirmed and the other reported failure. | Mark for operator review. |
| `insufficient_evidence` | At least one source was unavailable or the combination is inconclusive. | Preserve pending; retry within the bounded policy. |

Only `agreed_confirmed` allows finalization. A timeout, missing observation, or a single
source confirmation is never treated as a confirmed payment.

## States

- `pendig`: no final agreed result yet; retry within the bounded policy.
- `reconciled`: chain confirmation agreed by both sources, payment state, and finalized receipt
were committed atomically.
- `needs_review`: conflicting evidence, chain failure, exhausted retries, or missing
transaction evidence requires an operator decision.

Each check increments `reconciliationAttempts` and records `lastReconciledAt`. Terminal reasons are
stored in `reconciliationReason` and a public-safe audit record. Dead-letter reasons must not include
signed payloads, credentials, private keys, or authorization entries.

## Recovery

For `needs_review`, compare the stored transaction hash with Horizon and the RPC finality
adapter before changing state. Never move a payment back to `verified` and never submit it
again from the worker. If both sources confirm the transaction at the same ledger, rerun
reconciliation to finalize the existing receipt evidence. If both sources report failure, retain
the attempt, settlement, receipt, and audit rows.

Cleanup may mark expired unsubmitted attempts and add retention audit records. It must not delete
financial payment, settlement, receipt, or reconciliation evidence.
