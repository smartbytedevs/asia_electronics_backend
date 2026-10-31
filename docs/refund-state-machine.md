# Taqwa Backend — Refund State Machine

Status: **Decided (Phase 10, ADR-0018); machine implemented (Phase 10) in `src/modules/refunds/`**

## 1. Decided Constraints

- A refund is the **financial record** for an accepted, `COMPLETED` return
  (ADR-0018). It is auto-created at `PENDING` inside the return's
  `APPROVED → COMPLETED` transaction — it is never created by API input.
- The amount is **server-derived**: Σ (item `unitPriceMinorUnits` −
  `discountMinorUnits`) × returned quantity, from the return's embedded
  snapshots. **No delivery-fee refunds**, no client-supplied amount, no
  edit-amount endpoint.
- The refund **never mutates** the original `Payment` or `Order` documents. For
  `MANUAL` orders it snapshots the verified payment id (`paymentId`); for `COD`
  the `paymentId` is `null`. Actually moving money is out of scope (no gateway).
- Refunds are **ADMIN/STAFF-only**; there is no customer-facing refund surface.
- Every status change is an **atomic conditional transition**
  (`conditionalTransition`), so concurrent process/void cannot double-apply.

## 2. State Machine (implemented — Phase 10)

Reachable transitions:

```
                     staff/admin          staff/admin
   PENDING ──────────────────────────► PROCESSED   (terminal)
      │
      └──────────────────────────────► VOIDED      (terminal)
                    staff/admin
```

Transition table (source of truth: `src/modules/refunds/refund.state-machine.js`):

| From | To | Actor | Code on violation |
| ---- | -- | ----- | ----------------- |
| `PENDING` | `PROCESSED` | staff/admin | `409 REFUND_INVALID_STATE` |
| `PENDING` | `VOIDED` | staff/admin | `409 REFUND_INVALID_STATE` |

`PROCESSED` and `VOIDED` are terminal — no outgoing transition. Idempotent
retries of the same action return `200` with the existing document; the other
terminal state → `409 REFUND_INVALID_STATE`.

## 3. Process guard (documented, NOT yet enforced in code)

The service documents that `PROCESSED` requires the linked return to be
`COMPLETED` (guarding against processing a refund whose return was reopened).
`REFUND_RETURN_NOT_COMPLETED` is defined but `returnNotCompleted()` is
**uninvoked** — the guard is guaranteed by construction because refunds are only
auto-created at return-completion. Enforcing it in `processRefund` needs a
`returnRepository` dependency on `RefundService`; tracked as an open follow-up
in the Phase 10 report.

## 4. Test Coverage

Unit tests cover the transition table (valid moves + every guard code),
serialization (dates as ISO, populated vs bare refs), the repository query/
`conditionalTransition` shapes, and the service's process/void/not-found paths
(`tests/unit/refunds/`).
