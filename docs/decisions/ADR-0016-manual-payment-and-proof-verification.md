# ADR-0016: Manual Payment & Proof Verification

## Status

Accepted

## Date

2026-08-08

## Context

Phase 08 implements **manual payment capture** on top of the Phase 07 order
lifecycle (ADR-0015). Phase 00 already constrained orders to two payment
methods — **manual payments** and **cash on delivery (COD)** — and Phase 07
reserved `paymentMethod` values beyond `COD` for this phase. The following
architectural questions had to be answered before writing code:

- **Scope.** Which payment integrations exist in this phase? bKash / Nagad /
  SSLCommerz / Stripe / webhooks would all be "payment" work — do any of them
  belong here?
- **Manual workflow.** A manual payment is: the customer picks a bank-transfer
  payment method, transfers the exact order total, then uploads proof (a
  receipt screenshot) with the transaction reference. A staff/admin operator
  then reviews the proof and accepts or rejects it. How is that modeled?
- **Order vs. payment coupling.** Does verifying a payment confirm the order?
  Does payment capture apply to COD orders?
- **Money integrity.** The order total is server-derived integer minor units
  (paisa, ADR-0013/ADR-0015). Partial payments, overpayments, and client-trusted
  totals must be impossible. What is the amount policy?
- **Idempotency & duplicates.** A retried submission, a double-click, and a
  reused bank reference are all real. How do we make submission replay-safe and
  prevent the same transaction reference from being claimed twice?
- **Proof upload.** The project has NO upload infrastructure and, until now,
  no multipart parsing (Express JSON only), no Cloudinary SDK, and no media
  dependency. Uploads are a classic XSS/polyglot/file-hosting attack surface.
  How much infrastructure do we build, and where do files live?
- **Audit & non-repudiation.** Every payment decision must record who acted and
  when. Payment methods must be deactivatable without corrupting history.
- **Who may act.** Customers may only submit/view their own payments; staff/admin
  review; no client may fabricate amounts, statuses, actors, or roles.

## Decision

Implement a **manual-only payment module** (`src/modules/payments/`) with a
**separate payment state machine**, an **ADMIN-managed payment-method
catalogue**, and a **Cloudinary adapter behind an interface**. No gateways, no
webhooks, no auto-verification, no courier/email/SMS side-effects, and **no new
dependencies** (media upload is called via the Cloudinary REST API over
`fetch` with a hand-rolled signature, and the client multipart body is parsed
by a strict in-house parser).

### Payment state machine (separate from the order machine)

States: `UNPAID → SUBMITTED → VERIFIED | REJECTED`; `REJECTED → SUBMITTED`
(resubmission). `VERIFIED` is **terminal**.

| From | To | Actor |
| ---- | -- | ----- |
| `UNPAID` (no record) | `SUBMITTED` | customer (own order) |
| `REJECTED` | `SUBMITTED` | customer (own order) |
| `SUBMITTED` | `VERIFIED` | staff/admin |
| `SUBMITTED` | `REJECTED` | staff/admin |

One `Payment` document per order (unique `{ orderId }`), created lazily on the
first submission. Resubmission mutates the SAME document (new proof/amount/
reference/method, appended `statusHistory`, rejection fields cleared). The
superseded proof is best-effort deleted from Cloudinary.

### Manual-only scope

- Checkout now accepts `paymentMethod: 'MANUAL'` (server-controlled enum, no
  client money/status). COD stays default and paid-on-delivery with **no
  payment-capture record**.
- Payment submission is only allowed for the caller's OWN order with
  `paymentMethod: 'MANUAL'` in `PENDING` or `CONFIRMED`. `CANCELLED`,
  `REJECTED`, `PROCESSING`+, and COD orders are ineligible
  (`PAYMENT_ORDER_NOT_ELIGIBLE`).
- **Verifying a payment does NOT confirm the order.** Order confirmation stays
  an explicit staff/admin action on the order state machine. Payment and order
  are deliberately decoupled so operators can accept payment and confirm
  fulfilment separately.

### Money integrity (exact-match policy)

- `expectedAmountMinorUnits` is ALWAYS read from the order
  (`totals.grandTotalMinorUnits`) server-side; the client value is compared,
  never trusted.
- `submittedAmountMinorUnits` must equal the expected amount **exactly**.
  Partial and over-payments are rejected (`INVALID_PAYMENT_AMOUNT`) and
  documented as unsupported.

### Idempotency & reference reuse

- Submission requires an `Idempotency-Key` header (mirrors checkout ADR-0015):
  stored with an `idempotencyFingerprint`; a retry with the same key + body
  returns the existing payment; same key + different body →
  `PAYMENT_IDEMPOTENCY_CONFLICT`.
- A new submission while `SUBMITTED` → `PAYMENT_ALREADY_SUBMITTED`; while
  `VERIFIED` → `PAYMENT_ALREADY_VERIFIED`; while `REJECTED` → resubmission.
- A `transactionReference` may not be reused across a DIFFERENT order under the
  same payment method while any active (non-`REJECTED`) payment holds it
  (service-level guard → `PAYMENT_IDEMPOTENCY_CONFLICT`). Reusing it on the
  same rejected payment (resubmission) is allowed.

### Proof upload (no new dependencies)

- Submission is **multipart/form-data only**: text fields `paymentMethodId`,
  `submittedAmountMinorUnits`, `transactionReference`, optional `notes`, and a
  single `proof` file.
- A strict in-house multipart parser (no multer/busboy): exact boundary
  handling, field-name allowlist, single file, **max 2 MiB**, and every error is
  a clean 4xx (`INVALID_PAYMENT` / `INVALID_PAYMENT_PROOF` /
  `PAYMENT_PROOF_REQUIRED`), never an unhandled 5xx.
- Proof media: **JPEG / PNG / WEBP only** (MIME + extension + magic-byte
  checked — rejects SVG/HTML/JS/PDF/executables and polyglot files); original
  filenames are never trusted; the stored shape is the safe object
  `{ provider, publicId, secureUrl, resourceType, format }` with a
  server-generated `publicId` (`payments/<uuid>`); **no binary in MongoDB**.
- Cloudinary is called through `src/integrations/media/` behind
  `media.interface.js`. `cloudinary/cloudinary.client.js` signs requests with
  SHA-1 (`api_secret`) and calls the upload/destroy REST endpoints over
  `fetch` — the SDK is NOT installed. `media.mock.js` is the test double.
- **Distributed boundary:** the upload happens BEFORE the MongoDB transaction.
  Upload success + DB failure → best-effort `deleteFile`; cleanup failure logs
  only the safe `publicId`. Credentials are never serialized or logged.

### Payment methods (ADMIN-managed catalogue)

- `PaymentMethod` fields: `code` (unique, `[A-Z0-9_]{1,50}`, e.g.
  `BANK_TRANSFER`), `displayName`, `type` (`MANUAL` reachable; future types
  reserved), structured `metadata` (`accountName`, `accountNumber`, `bankName`,
  `branch`, `routingNumber`, `instructions`), `isActive`, `sortOrder`.
- ADMIN creates/updates/deactivates; customers only list ACTIVE methods;
  STAFF cannot manage methods.
- Deactivation is **soft** (`isActive: false`) — never a hard delete — and
  payments snapshot `{ code, displayName, accountNumber }` so history stays
  readable after deactivation.

### API surface

- Customer: `GET /api/v1/payment-methods` (active only); `GET|POST
  /api/v1/orders/:orderId/payment` (own order, multipart submit).
- Staff/admin: `GET /api/v1/admin/payments` (allowlisted filters `status`,
  `paymentMethodId`, `dateFrom`, `dateTo`, `orderNumber`, `customerId` +
  pagination), `GET /api/v1/admin/payments/:id`, `POST .../:id/verify`,
  `POST .../:id/reject`.
- Admin: `POST /api/v1/admin/payment-methods`, `PATCH
  /api/v1/admin/payment-methods/:id`.
- The acting id (`verifiedBy`/`rejectedBy`) is always `req.user.id`. Client
  `status`/`verifiedBy`/`verifiedAt`/`rejectedBy`/`rejectedAt`/
  `expectedAmountMinorUnits`/`orderTotal`/`customerId`/`userId`/`role` and all
  `$`-operators are rejected. Duplicate verify/reject is idempotent; wrong-state
  transitions → `PAYMENT_INVALID_STATE`.

### Error codes (added to `src/constants/index.js`, no duplicates)

`PAYMENT_NOT_FOUND`, `PAYMENT_ALREADY_SUBMITTED`, `PAYMENT_ALREADY_VERIFIED`,
`PAYMENT_INVALID_STATE`, `INVALID_PAYMENT`, `INVALID_PAYMENT_AMOUNT`,
`PAYMENT_ORDER_NOT_ELIGIBLE`, `PAYMENT_IDEMPOTENCY_CONFLICT`,
`PAYMENT_PROOF_REQUIRED`, `INVALID_PAYMENT_PROOF`, `PAYMENT_PROOF_UPLOAD_FAILED`,
`PAYMENT_METHOD_NOT_FOUND`, `PAYMENT_METHOD_INACTIVE`, `INVALID_PAYMENT_METHOD`,
`PAYMENT_METHOD_CODE_ALREADY_EXISTS`, `INVALID_PAYMENT_STATUS`.

## Consequences

### Positive

- Payments are replay-safe, exact-amount enforced, actor-audited, and scoped:
  no fabricated amounts/statuses, no IDOR, no cross-order reference double
  claiming, no secrets in responses.
- Payment and order stay decoupled, so operators retain full control of
  fulfilment and future phases (courier/returns) can hang off the stable
  terminal `VERIFIED` state.
- No new dependencies and no gateway SDKs: the media boundary, the multipart
  parser, and the Cloudinary REST call are all internal and fully unit-testable
  against mocks.
- Soft-deactivated methods with payment-side snapshots preserve the audit
  trail.

### Negative / costs

- No auto-verification: a staff/admin operator must review every submission
  (intentional — manual capture).
- No live MongoDB / Cloudinary in this environment: the transaction boundary
  and the distributed upload→DB→cleanup path are exercised via stubs/mocks
  (documented limitation in `docs/payment-state-machine.md`); real behaviour
  must be re-verified once live credentials exist.
- The in-house multipart parser is a deliberate small surface (single file,
  strict allowlists); it is not a general-purpose upload library.
- Payments over `VERIFIED` are immutable — correcting a wrong verification
  requires a compensating administrative process (future phase).

### Not decided here

- Gateway integrations (bKash/Nagad/SSLCommerz/Stripe) and provider webhooks —
  explicitly out of scope for this phase.
- Auto-confirm of orders on payment verification; courier/shipping; email/SMS
  notifications on payment states.
- Purchase-price / financial reporting tied to verified payments.
