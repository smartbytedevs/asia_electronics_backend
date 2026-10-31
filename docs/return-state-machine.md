# Taqwa Backend — Return State Machine

Status: **Decided (Phase 10, ADR-0018); machine implemented (Phase 10) in `src/modules/returns/`**

## 1. Decided Constraints

- Returns are a **SEPARATE state machine** from the order machine (ADR-0018).
  The return service NEVER mutates the Order document, and the order-level
  `RETURN_REQUESTED`/`RETURNED` statuses stay reserved and unreachable.
- A customer may submit **multiple DISTINCT returns** for the same order over
  the return window (different idempotency keys).
- Eligibility is **server-derived**: the customer's own order, order status
  `CONFIRMED` or `PROCESSING`, within `RETURN_LIMITS.ELIGIBLE_DAYS` (30) of
  `order.createdAt`. There is no delivered-flag dependency.
- Item prices are **immutable snapshots** copied from the order items at
  request time; refund amounts are later derived ONLY from these snapshots.
- The **ONLY** transition with side effects is `APPROVED → COMPLETED` (restock
  + refund in one transaction). No other transition has a side effect to undo,
  which is why `APPROVED` returns can be safely cancelled.
- Every status change is an **atomic conditional transition**
  (`conditionalTransition`): the update applies only while the document is still
  in `fromStatus`, so concurrent actions cannot double-apply.

## 2. State Machine (implemented — Phase 10)

Reachable transitions:

```
                 staff/admin
                    │
   PENDING ─────────┤────► APPROVED ──(staff/admin, ONE txn)──► COMPLETED
      │             │                                            (terminal)
      │             ├────► REJECTED  ───────────────────────────► (terminal)
      │             │
      └─────────────┴────► CANCELLED ───────────────────────────► (terminal)
     (customer own            (admin can also cancel APPROVED)
      PENDING only)
```

Transition table (source of truth: `src/modules/returns/return.state-machine.js`):

| From | To | Actor | Code on violation |
| ---- | -- | ----- | ----------------- |
| `PENDING` | `APPROVED` | staff/admin | `409 RETURN_INVALID_STATE` |
| `PENDING` | `REJECTED` | staff/admin | `409 RETURN_INVALID_STATE` |
| `PENDING` | `CANCELLED` | customer (own) / admin / staff | `409 RETURN_INVALID_STATE` |
| `APPROVED` | `COMPLETED` | staff/admin | `409 RETURN_INVALID_STATE` |
| `APPROVED` | `CANCELLED` | admin / staff | `409 RETURN_INVALID_STATE` |

`COMPLETED`, `REJECTED`, and `CANCELLED` are terminal — no outgoing transition.

## 3. Submission & Idempotency

- `POST /api/v1/orders/:orderId/returns` requires the **`Idempotency-Key`**
  header (same conventions as checkout, ADR-0015). The unique compound index
  `{ orderId: 1, idempotencyKey: 1 }` makes a retried submit return the
  ORIGINAL return (`200`, `created: false`); a same-key/different-body retry →
  `409 RETURN_IDEMPOTENCY_CONFLICT` (fingerprint mismatch).
- Per-item availability = `orderItem.quantity` minus the quantity claimed by
  `PENDING`/`APPROVED`/`COMPLETED` returns. Partial returns are therefore
  allowed; requesting more than the remaining quantity →
  `409 RETURN_QUANTITY_EXCEEDED`.
- Duplicate `orderItemId` in one request → `400 RETURN_ITEM_DUPLICATE`; an
  `orderItemId` not on the order → `404 RETURN_ITEM_NOT_FOUND`.

**Documented limitation (accepted, Phase 10):** two CONCURRENT submissions with
DIFFERENT idempotency keys overlapping the same quantity can both pass the
availability check before either commits — there is no atomic "claim"
document. Same-key replays remain blocked by the unique index. See ADR-0018.

## 4. Completion (the side-effect transaction)

`APPROVED → COMPLETED` runs in **ONE MongoDB transaction**:

1. Conditional transition `APPROVED → COMPLETED` (the conflict point — a lost
   race returns null → `409 RETURN_INVALID_STATE`).
2. Per-line ONLINE restock (`RETURN_RESTOCK` ledger movement,
   `inventory.service.restockOnlineInTransaction`).
3. Auto-create the `PENDING` refund with a server-derived amount
   (`refund.service.createRefundInTransaction`).
4. Persist `refundId` on the return.

Because steps 2–4 share the completion transaction, there is no partial
restock/refund and no double-apply.

## 5. Test Coverage & Limitation

- Unit tests cover the transition table (valid moves + every guard code),
  submission idempotency (replay, fingerprint conflict), per-item availability,
  eligibility, serialization, and both repositories' update shapes
  (`tests/unit/returns/`).
- The customer cancel surface is `PENDING`-only: an `APPROVED`+ return →
  `409 RETURN_INVALID_STATE`; later states need staff (admin cancel).
