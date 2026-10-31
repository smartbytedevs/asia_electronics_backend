# Taqwa Backend — Payment State Machine

Status: **Constraints established (Phase 00); machine implemented (Phase 08, ADR-0016); return refunds implemented as a SEPARATE refund machine (Phase 10, ADR-0018); payment notification side-effects wired (Phase 11, ADR-0019); courier transitions reserved for later phases**

## 1. Decided Constraints (Phase 00 — still binding)

- Orders support **manual payments** and **cash on delivery (COD)**. Phase 08
  realizes manual-payment capture (`paymentMethod: 'MANUAL'` at checkout);
  COD remains paid on delivery and has no payment-capture record.
- Payment capture is **manual-only** in this phase. There are NO gateways
  (bKash, Nagad, SSLCommerz, Stripe), no provider webhooks, and no automatic
  verification. A staff/admin operator reviews the customer-submitted proof.
- Payment and Order are **SEPARATE state machines**. Payment verification does
  NOT auto-confirm the order and does NOT trigger courier, email, or SMS in
  this phase (order confirmation stays an explicit staff/admin action).
- The amount is always the order's **server-derived grand total** (integer
  minor units / paisa). The client never supplies a total; **partial payments
  are not supported** — a submission must match `grandTotalMinorUnits` exactly.

## 2. State Machine (implemented — Phase 08)

Reachable states and the actors that can drive each transition:

```
                 customer submits proof
                           │
                           ▼
        ┌─────────────► SUBMITTED ◄────────────┐
        │ (from UNPAID,         │              │ (resubmission after
        │  first submission)    │              │  REJECTED)
        │                      │               │
   UNPAID ────────────────────►┼──────────────►┼
   (no payment                │               │
    record yet)               │               │
                              ▼               ▼
                          VERIFIED         REJECTED
                         (terminal)      (mutable: → SUBMITTED)
```

- A `Payment` document is created **lazily** on the first submission. `UNPAID`
  is therefore a conceptual initial state ("this order has no payment record
  yet") rather than a persisted document — but the machine still recognises
  `UNPAID → SUBMITTED` so the transition table is the single source of truth.

### 2.1 States

| State | Kind | Meaning |
| ----- | ---- | ------- |
| `UNPAID` | initial (no doc) | Order has no payment record yet. |
| `SUBMITTED` | mutable | Customer uploaded proof; pending operator review. |
| `VERIFIED` | **terminal** | Operator accepted the payment. No further transitions. |
| `REJECTED` | mutable | Operator rejected the proof; customer may resubmit. |

### 2.2 Transitions & guards

| From | To | Actor | Code on violation |
| ---- | -- | ----- | ----------------- |
| `UNPAID` | `SUBMITTED` | customer (own order) | `409 PAYMENT_ORDER_NOT_ELIGIBLE` |
| `REJECTED` | `SUBMITTED` | customer (own order) | `409 PAYMENT_ORDER_NOT_ELIGIBLE` |
| `SUBMITTED` | `VERIFIED` | staff/admin | `409 PAYMENT_INVALID_STATE` |
| `SUBMITTED` | `REJECTED` | staff/admin | `409 PAYMENT_INVALID_STATE` |
| `VERIFIED` → anything | — | nobody | `409 PAYMENT_ALREADY_VERIFIED` / `PAYMENT_INVALID_STATE` |

Notes:

- **Actors**: customers drive `UNPAID|REJECTED → SUBMITTED` only for their OWN
  order (cross-customer reads/submissions resolve as `404 PAYMENT_NOT_FOUND`,
  never 403 — consistent with the order module). Staff/admin drive
  `SUBMITTED → VERIFIED|REJECTED`; customers can never transition a payment
  themselves (a customer-submitted `status`/`verifiedBy`/`verifiedAt`/
  `rejectedBy`/`rejectedAt`/`expectedAmountMinorUnits` is rejected by the
  validator).
- **Verification is terminal.** Once `VERIFIED`, the payment cannot be
  resubmitted, re-rejected, or moved back to `SUBMITTED`. A duplicate
  verify on an already-`VERIFIED` payment is **idempotent** (returns the same
  payment); verify/reject on the wrong mutable state → `409 PAYMENT_INVALID_STATE`.
- **Resubmission** replaces the previous proof, amount, reference, and method
  on the SAME payment document (one payment record per order) and appends a
  `SUBMITTED` history entry; rejection fields are cleared. The superseded proof
  is best-effort deleted from the media provider.
- **No partial payments, no overpayments**: `submittedAmountMinorUnits` must
  equal `order.totals.grandTotalMinorUnits` exactly, else
  `400 INVALID_PAYMENT_AMOUNT`.
- **No auto side-effects on verify**: the order stays in `PENDING`/`CONFIRMED`
  exactly as it was. Confirming the order remains an explicit staff/admin
  action (order state machine), and courier side-effects remain future-phase
  work. Since Phase 11 (ADR-0019), the payment lifecycle DOES emit best-effort
  notification events through the notification abstraction after the
  transaction commits: `PAYMENT_SUBMITTED` (submit and resubmission),
  `PAYMENT_VERIFIED` (verify), and `PAYMENT_REJECTED` (reject). Notifications
  are delivered asynchronously/best-effort (`maybeNotify` after commit) and can
  never fail or roll back the payment operation.
- **Reference reuse guard**: a `transactionReference` may not be reused across
  two DIFFERENT orders with the same payment method while any active (non-
  `REJECTED`) payment holds it → `409 PAYMENT_IDEMPOTENCY_CONFLICT`. Reusing the
  reference on the SAME rejected payment (resubmission) is allowed.

## 3. Submission

- `POST /api/v1/orders/:orderId/payment` (CUSTOMER, own order) — **multipart/
  form-data only** (the proof file travels as `proof`; text fields
  `paymentMethodId`, `submittedAmountMinorUnits`, `transactionReference`, and
  optional `notes`).
- Eligibility: the order must belong to the caller, have `paymentMethod:
  'MANUAL'`, and be in `PENDING` or `CONFIRMED`. `CANCELLED`, `REJECTED`,
  `PROCESSING`+ orders, and COD orders are ineligible
  (`409 PAYMENT_ORDER_NOT_ELIGIBLE`).
- **Amount**: `expectedAmountMinorUnits` is ALWAYS read from the order
  (`totals.grandTotalMinorUnits`) server-side. The client value is compared
  and must match exactly; client money is never trusted.
- **Idempotency**: `Idempotency-Key` header is REQUIRED. One payment record per
  order (unique `{ orderId }`). A retry with the same key + same body returns
  the existing payment; the same key + a different body →
  `409 PAYMENT_IDEMPOTENCY_CONFLICT`. A NEW submission while the payment is
  already `SUBMITTED` → `409 PAYMENT_ALREADY_SUBMITTED`; while `VERIFIED` →
  `409 PAYMENT_ALREADY_VERIFIED`; while `REJECTED` → legitimate resubmission.
- **Distributed boundary**: the media upload (Cloudinary) happens BEFORE the
  MongoDB transaction. If the DB write fails after a successful upload, the
  uploaded asset is best-effort deleted; if that cleanup also fails, only safe
  identifiers (`publicId`) are logged — never credentials. On resubmission the
  superseded proof is best-effort deleted after the new write succeeds.
- **Proof rules** (see `docs/business-rules.md` §payments): JPEG/PNG/WEBP only,
  MIME + extension + magic-byte validated, max 2 MiB, server-controlled
  `public_id` (`payments/<uuid>`), and the stored media object is the safe
  shape `{ provider, publicId, secureUrl, resourceType, format }` — no binary
  is ever stored in MongoDB.

## 4. Admin/Operator Review

- `GET /api/v1/admin/payments` (ADMIN/STAFF) — allowlisted filters: `status`,
  `paymentMethodId`, `dateFrom`, `dateTo`, `orderNumber`, `customerId`,
  `page`, `limit`.
- `GET /api/v1/admin/payments/:id` — any payment.
- `POST /api/v1/admin/payments/:id/verify` — `SUBMITTED → VERIFIED`
  (idempotent when already verified). The acting id (`verifiedBy`) is always
  `req.user.id`, never a body field.
- `POST /api/v1/admin/payments/:id/reject` — `SUBMITTED → REJECTED`
  (idempotent when already rejected). `rejectedBy` likewise.
- Every transition appends `statusHistory` `{ status, at, by, note }`.

## 5. Payment Methods

- `PaymentMethod` is an ADMIN-managed catalogue (ADMIN-only create/update/
  deactivate; customers only LIST active methods for their submission).
- Deactivation is **soft** (`isActive: false`) — payment methods are NEVER hard
  deleted, because payments snapshot the method at submission time.
- The payment record stores a small **safe snapshot** (`code`, `displayName`,
  `accountNumber`) so deactivation preserves historical readability.
- `code` is unique and normalised to `[A-Z0-9_]{1,50}` (e.g. `BANK_TRANSFER`).

## 6. Test Coverage & Limitation

- Unit tests cover the transition table (valid moves + every guard code),
  submission validation (eligibility, exact amount, idempotency, reference
  reuse), verify/reject, resubmission, payment-method model/validation, the
  multipart parser (MIME/extension/magic-byte/size), and the media adapter
  (upload object shape, failure, cleanup).
- Integration tests (`tests/integration/payments.test.js`) exercise the HTTP
  surface: admin create/deactivate methods, customer list, checkout with
  `paymentMethod: 'MANUAL'`, multipart submission, admin list/get/verify/reject,
  resubmission, duplicate submissions, cross-customer reads → 404, role spoofing
  (JWT claim / `X-Role` / query / body), `$`-operator injection, client money /
  status / actor-field rejection, and credential/media non-leakage.
- **Documented limitation:** there is no live MongoDB and no real Cloudinary
  account in this environment. The transaction boundary and the distributed
  upload→DB→cleanup path are exercised through stubs/mocks (single-threaded
  simulations with the same conditional semantics), so real behaviour must be
  re-verified once a live MongoDB + Cloudinary credentials are available
  (consistent with `docs/order-state-machine.md`).
