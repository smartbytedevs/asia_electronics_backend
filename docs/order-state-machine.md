# Taqwa Backend — Order State Machine

Status: **Constraints established (Phase 00); machine implemented (Phase 07, ADR-0015); payments/returns/courier transitions reserved for later phases**

## 1. Decided Constraints (Phase 00 — still binding)

- Orders support the payment methods: **manual payments** and **cash on
  delivery (COD)**. Phase 07 only realizes `COD` (`paymentMethod: 'COD'`);
  manual-payment capture is a future payments phase.
- Orders support **returns** and **cancellations**. Phase 07 realizes
  **pre-confirmation cancellation** (customer cancel of `PENDING`/`CONFIRMED`,
  staff reject of `PENDING`) and reserves the `RETURN_*` states for the returns
  phase.
- Order items **snapshot** their financial and product information at order
  time (see `docs/business-rules.md` §12). Snapshots are IMMUTABLE embedded
  subdocuments; selling-side prices only (no purchase-price snapshots this
  phase).
- Courier lifecycle status is expected to synchronize with the order lifecycle
  through the courier abstraction (see `docs/architecture.md`). Phase 07
  reserves `SHIPPED`/`DELIVERED` but does not implement courier sync.

## 2. State Machine (implemented — Phase 07)

Reachable states and the actors that can drive each transition:

```
                    customer checkout
                          │
                          ▼
                     ┌─────────┐
          ┌─────────►│ PENDING │◄──────────┐
          │          └────┬────┘           │
          │               │                │
      customer       staff/admin       staff/admin
      cancel        confirm (PENDING    reject (PENDING
     (PENDING)       → CONFIRMED)         → REJECTED)
          │               │
          ▼               ▼
     ┌────────┐      ┌───────────┐
     │CANCELLED│     │ CONFIRMED │
     └────────┘      └─────┬─────┘
      (terminal)           │
                      staff/admin
                       process
                      (CONFIRMED
                       → PROCESSING)
                           │
                           ▼
                     ┌────────────┐
                     │ PROCESSING │   customer cancel NOT allowed
                     └────────────┘        (only admin cancel,
                                           future phases)
```

### 2.1 States

| State | Kind | Meaning |
| ----- | ---- | ------- |
| `PENDING` | initial (mutable) | Order created at checkout; stock reserved, not yet accepted. |
| `CONFIRMED` | mutable | Staff/admin accepted the order; stock stays reserved. |
| `PROCESSING` | mutable | Staff/admin began fulfilling the order. |
| `CANCELLED` | **terminal** | Customer or admin cancelled from `PENDING`/`CONFIRMED`. Reservations released. |
| `REJECTED` | **terminal** | Staff/admin rejected a `PENDING` order. Reservations released. |
| `SHIPPED` / `DELIVERED` | **reserved** | Future courier/fulfillment phase — **unreachable** in Phase 07. |
| `RETURN_REQUESTED` / `RETURNED` | **reserved** | Future returns phase — **unreachable** in Phase 07. |

### 2.2 Transitions & guards

| From | To | Actor | Code on violation |
| ---- | -- | ----- | ----------------- |
| `PENDING` | `CONFIRMED` | staff/admin | `409 ORDER_CONFIRMATION_NOT_ALLOWED` |
| `CONFIRMED` | `PROCESSING` | staff/admin | `409 ORDER_PROCESSING_NOT_ALLOWED` |
| `PENDING` | `REJECTED` | staff/admin | `409 ORDER_REJECTION_NOT_ALLOWED` |
| `PENDING` / `CONFIRMED` | `CANCELLED` | customer (own) / admin | `409 ORDER_CANCELLATION_NOT_ALLOWED` |
| anything → reserved (`SHIPPED`/`DELIVERED`/`RETURN_*`) | — | nobody | `409 ORDER_INVALID_STATE` |

Notes:

- Transitions are **atomic and idempotent at the conflict point**: the status
  move is a conditional update guarded on the current status, so two concurrent
  confirms cannot double-apply; the loser gets the appropriate `..._NOT_ALLOWED`
  code.
- Every transition appends `statusHistory` `{ status, at, by, note }`; `by` is
  always the resolved actor (`req.user.id`), never a body field.
- **Stock side effects**: confirm/process do **not** touch reservations (stock
  stays held). cancel/reject **release** all ACTIVE reservations for the order
  inside the same transaction (`RESERVATION_RELEASE`). Consuming reservations is
  a future fulfillment action. See `docs/inventory-state-machine.md` §5.
- **No auto-expiry**: order reservations carry no `expiresAt`; a stale
  `PENDING` order requires explicit staff action (reject/cancel) or a future
  background job.

## 3. Checkout

- `POST /api/v1/orders/checkout` creates the order at `PENDING` in **one
  MongoDB transaction** together with per-line ONLINE-stock reservations
  (`referenceType: 'ORDER'`, `referenceId: orderId`) and the cart clear. Any
  failure rolls everything back.
- Checkout is **idempotent** via `Idempotency-Key` (unique `{customerId,
  idempotencyKey}`); a retry returns the original order; a conflicting body →
  `409 ORDER_IDEMPOTENCY_CONFLICT`.
- Order numbers (`TAQ-YYYYMMDD-XXXXXX`), totals, zone/fees, and item snapshots
  are all **server-derived**; client values are never trusted
  (see `docs/business-rules.md` §12).

## 4. Phase References

- Payments (manual payment capture): payments phase — reserved `paymentMethod`
  values beyond `COD` will be added there.
- Returns (post-fulfillment `RETURN_REQUESTED`/`RETURNED`): reserved — the
  return lifecycle is implemented in **Phase 10** as a SEPARATE return state
  machine (`docs/return-state-machine.md`, ADR-0018) that never mutates the
  order machine; the order-level `RETURN_*` states stay reserved and unreachable
  until a future fulfillment phase.
- Courier status sync (`SHIPPED`/`DELIVERED`): courier phase — states already
  reserved in the model/constants.
- Post-fulfillment customer cancellation: future phase — currently only
  pre-confirmation cancellation is allowed.

## 5. Test Coverage & Limitation

- Unit tests cover the state-transition table (valid moves + every guard code),
  `classifyDeliveryZone`, checkout pricing/totals math, order-number
  generation, serializers, and both repositories' update shapes.
- Integration tests (`tests/integration/orders.test.js`,
  `tests/integration/adminOrders.test.js`, `tests/integration/cart.test.js`,
  `tests/integration/security.test.js`) exercise the HTTP surface: auth
  failures, role spoofing (JWT claim / `X-Role` / query / body), customer
  scoping (cross-customer reads → 404), cart add/list/update/remove/clear,
  checkout idempotency, the staff state machine, reservation release on
  cancel/reject, purchase-price/token non-leakage, `$`-operator injection,
  oversized-field rejection, and XSS-as-plain-data storage.
- **Actual results (Phase 07):** the full suite passes at **508/508** (0
  failures, baseline 410). New coverage: 45 order/cart unit tests + 29
  integration tests (cart 8, orders 10, adminOrders 7, security 4).
- **Documented limitation:** there is no live MongoDB in this environment, so
  the checkout transaction boundary, rollback, and true idempotency races are
  simulated via repository stubs that apply the same conditional semantics
  (single-threaded). Real behavior must be re-verified once a live MongoDB is
  available (consistent with `docs/inventory-state-machine.md`).
