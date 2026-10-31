# ADR-0017: Courier Integration (Pathao)

## Status

Accepted

## Date

2026-08-08

## Context

Phase 09 wires courier delivery onto the Phase 07 order lifecycle (ADR-0015).
A Taqwa order is confirmed by staff/admin, then handed to a courier who picks
up the parcel from the shop and delivers it to the customer. The courier also
collects cash on delivery (COD).

The business selected **Pathao Courier** as the first (and only, this phase)
provider. Before writing code, the following questions had to be answered:

- **Scope.** Which courier features belong in this phase? Order creation,
  order status tracking, cancellation, webhooks, price estimates, live
  COD settlement reconciliation?
- **Provider abstraction.** The provider-agnostic architecture (ADR-0004,
  ADR-0005) says integrations live behind interfaces. But Pathao is a real
  HTTP API with OAuth2, its own payloads, and its own error taxonomy. What is
  the seam, and what does the business logic know?
- **Provider coupling.** Does an order confirm automatically create a courier
  order, or is dispatch an explicit staff action? When does dispatch happen
  relative to order confirmation?
- **Money integrity.** COD amounts are integer minor units (paisa, ADR-0013/
  ADR-0015). Pathao works in whole taka (`amount_to_collect`) and reports a
  delivery fee in taka. How are these converted without float rounding?
- **State machine.** Delivery has its own lifecycle (pending, out for
  delivery, delivered, cancelled) that is NOT the order state machine. Where
  does it live, and how do webhooks/reconciliation converge on the truth?
- **Idempotency & concurrency.** Two admins dispatching the same order at once
  must not mint two consignments. A webhook and a poll must not double-apply.
  An order cancelled after auto-dispatch must cancel the courier shipment too.
- **Security.** Webhook endpoints are public by definition. How are provider
  webhooks authenticated? Which internal provider errors may reach clients?
- **Environment.** There are no live Pathao production credentials in this
  environment. How do we build, test, and document a real integration that
  cannot be exercised against production here?

## Decision

Implement a **provider-agnostic courier module** (`src/modules/courier/`) with
a **single shipment state machine**, a **provider interface**, a **Pathao
adapter** (OAuth2 + REST, no SDK), and a **deterministic mock provider** for
development/tests.

### Provider interface (the only seam)

The `CourierService` depends ONLY on the provider interface
(`courier.provider.interface.js`):

- `submitShipment(payload)` → `SubmitResult`
  `{ consignmentId, providerDeliveryFeeMinorUnits, providerStatus,
    providerStatusUpdatedAt, localStatus, raw }`
- `fetchShipmentStatus(consignmentId)` → `StatusResult`
  `{ providerStatus, providerStatusUpdatedAt, localStatus, raw }`
- `cancelShipment(consignmentId)` → `CancelResult { cancelledAt, raw }`
- `mapProviderStatus(providerLabel)` → local `COURIER_STATUSES`
- All failures throw `CourierProviderError` with a stable machine code:
  `PROVIDER_UNAVAILABLE` (retryable), `PROVIDER_REJECTED` (4xx/validation),
  `TRACKING_NOT_FOUND`, `CANCEL_REJECTED`, `NOT_CONFIGURED`.

The service **never** maps provider labels, converts currencies, or builds
provider payloads — the adapter does. Pathao and the mock are drop-in
replacements selected by `COURIER_PROVIDER` (`mock` default; `pathao` in
production).

### Courier shipment state machine

One `CourierShipment` document per order (unique `orderId` — the DB-level
dispatch idempotency guard), wrapping a single delivery handoff:

```
PENDING → ACTIVE                  (submitted to provider, tracking assigned)
PENDING → FAILED                  (provider rejected/errored on submit)
PENDING → CANCELLED               (cancelled before dispatch)
FAILED  → ACTIVE                  (retry succeeded)
FAILED  → CANCELLED               (cancelled after failure)
ACTIVE  → DELIVERED               (provider confirmed)
ACTIVE  → CANCELLED               (provider confirmed cancellation)
ACTIVE  → CANCELLATION_FAILED     (provider refused/errored on cancel)
CANCELLATION_FAILED → DELIVERED   (provider reported delivered meanwhile)
CANCELLATION_FAILED → CANCELLED   (retried cancel succeeded)
```

`DELIVERED` / `CANCELLED` are **terminal**. All transitions go through
**atomic guarded updates** (conditional on the source status) so concurrent
webhooks/polls/cancels cannot double-apply. Full rationale in
`docs/courier-state-machine.md`.

### Dispatch is explicit by default

- `COURIER_AUTO_DISPATCH_ON_CONFIRM=false` (default): dispatch happens only via
  `POST /admin/orders/:orderId/courier/dispatch` — an explicit staff/admin
  action after confirmation. Confirming an order never creates a real courier
  order implicitly.
- `=true`: an admin confirming an order also best-effort dispatches it.
  Provider failures are absorbed and logged — the confirmation stands and the
  shipment stays retryable (`POST /admin/shipments/:id/retry`).
- Dispatch is only allowed from order status `CONFIRMED`
  (`COURIER_DISPATCH_NOT_ALLOWED` otherwise); a terminal shipment on the same
  order → `COURIER_SHIPMENT_EXISTS`.

### Concurrency: no double consignments

- **DB guard:** `create` is idempotent via the unique `orderId` index; a
  duplicate-key race re-reads the winner.
- **Submit lock:** an in-process per-shipment promise lock serializes
  concurrent submit calls in one instance, so two HTTP requests cannot both
  call the provider and mint two consignments.
- **Atomic recording:** `recordSubmissionSuccess/Failure` only apply while the
  shipment is still `PENDING`/`FAILED`; a lost race re-reads and reports the
  current state instead of clobbering it.
- **Provider calls always run OUTSIDE any DB transaction** (HTTP + long
  timeouts must never hold MongoDB sessions). All DB changes after a provider
  call are single-document atomic updates.

### Money integrity

- COD `amount_to_collect` is derived server-side from the order
  (`paymentMethod === 'COD' ? totals.grandTotalMinorUnits : 0`) and passed to
  Pathao as **whole taka** (`Math.round(minorUnits / 100)`).
- Pathao's reported `delivery_fee` (whole taka) is stored back as
  **minor units** (`feeTaka * 100`) — round-trip safe, no floats.
- All amounts on the shipment are integer minor units, consistent with
  ADR-0013/ADR-0015.

### Status truth: webhooks + reconciliation

- **Webhooks** (`POST /webhooks/pathao`): Pathao posts delivery events signed
  with the registered secret in `X-Pathao-Signature`. The service verifies it
  **constant-time and fail-closed** (empty/missing secret ⇒ 401). Shipments are
  matched by `consignmentId`, then `merchant_order_id` (order number) fallback.
  Unknown shipments are acknowledged and ignored. System transitions record
  `by: null` in history.
- **Reconciliation** (`COURIER_RECONCILE_ENABLED=true`): a periodic poll of
  `ACTIVE`/`CANCELLATION_FAILED` shipments whose last check is stale. Missing
  consignments are touched-and-skipped (no hammering). Both paths converge
  through the SAME `applyProviderStatusUpdate` transition logic, so poll and
  webhook can never disagree about the state machine.

### Webhook / reconciliation semantics

Only confirmed terminal provider labels transition the local state:
`*delivered*` → `DELIVERED`, `*cancelled*` → `CANCELLED`. Exceptions (returns,
partial deliveries, pickup failures) stay `ACTIVE` so they keep requiring
fulfillment attention rather than being silently misclassified as terminal.

### Actor model & RBAC

- Dispatch/retry/cancel are `ADMIN`+`STAFF`; the acting id is always
  `req.user.id` (never a body field).
- Customer tracking (`GET /orders/:orderId/tracking`) is strictly customer
  scoped: a cross-customer read resolves as `404 ORDER_NOT_FOUND` (never 403,
  matching ADR-0015's no-leak policy). A not-yet-dispatched order returns
  `tracking: null`.
- The order-cancel hook (`OrderService.cancelCustomerOrder`) best-effort calls
  `CourierService.cancelForOrder`; a provider refusal marks the shipment
  `CANCELLATION_FAILED` (actionable in admin UI) but NEVER rolls back the order
  cancellation.

### Client-visible errors

Every `CourierProviderError` maps to a stable HTTP `ApiError`:
`COURIER_PROVIDER_NOT_CONFIGURED` (503), `COURIER_PROVIDER_UNAVAILABLE` (503),
`COURIER_PROVIDER_REJECTED` (400), `COURIER_TRACKING_NOT_FOUND` (404),
`COURIER_CANCEL_REJECTED` (409), `COURIER_WEBHOOK_INVALID_SIGNATURE` (401),
`COURIER_SHIPMENT_NOT_FOUND` (404), `COURIER_SHIPMENT_EXISTS` (409),
`COURIER_DISPATCH_NOT_ALLOWED` (409), `COURIER_INVALID_STATE` (409),
`INVALID_COURIER_REQUEST` (400). Provider error internals (raw payloads) are
never serialized to clients.

### Payload handling

Recipient name/address/description/instruction are truncated to Pathao's
bounds (name ≤100, address ≤220, etc.) and the BD phone is normalized to the
11-digit local form. Weight falls back to `PATHAO_DEFAULT_ITEM_WEIGHT_KG`
(0.5, clamped to Pathao's 0.5–10 range) because orders do not capture item
weights yet.

### Environment & testing

- `COURIER_PROVIDER=mock` (default): deterministic in-memory provider —
  assigns `MOCK-<n>` consignment ids, charges a fixed 6000 minor-unit fee, and
  exposes harness hooks (`advance`, `failNextSubmitWith`,
  `failNextCancelWith`) so service flows are exercised end-to-end without
  credentials.
- `COURIER_PROVIDER=pathao` requires `PATHAO_CLIENT_ID/SECRET/USERNAME/
  PASSWORD/STORE_ID`. In production a missing value is a hard startup error
  (fail fast); in development it warns. The client uses the **public sandbox**
  in development (`https://courier-api-sandbox.pathao.com`) and Hermes in
  production (`https://api-hermes.pathao.com`), with lazy OAuth2 token caching
  + refresh-on-401. `PATHAO_BASE_URL` overrides the derived base URL in any
  environment.
- Production guards (`src/config/index.js`): with `NODE_ENV=production` and
  `COURIER_PROVIDER=pathao` the config **throws** at startup if (a) any of the
  five credentials is missing, (b) any credential still equals Pathao's
  publicly published sandbox demo values, or (c) `PATHAO_BASE_URL` resolves to
  the sandbox host. While `COURIER_PROVIDER=mock`, demo credentials and a
  sandbox base URL emit loud warnings instead (mock makes no network calls).
- Real merchant credentials and the store ID are supplied only via deployment
  secrets (e.g. Vercel env vars / platform secret store). They are never
  committed to `.env` or `.env.example`; `.env.example` carries placeholders
  and environment-selection comments only.
- Webhooks require `PATHAO_WEBHOOK_SECRET`; until it is set, the webhook
  endpoint fails closed.
- The Pathao request/response shapes were verified against the public sandbox
  on 2026-08-08 and are documented in `pathao.mapper.js`.
- Test coverage is HTTP-level (`tests/integration/courier.test.js`, wired
  through `tests/helpers/order-integration-fixtures.js`): auth/RBAC, dispatch,
  idempotent re-dispatch, webhook signature + delivered/cancelled mapping +
  merchant-reference matching + unknown-shipment ack, tracking scoping, retry
  after provider rejection, cancel (provider + delivered-invalid), the
  order-cancel → courier hook, auto-dispatch on confirm, and invalid bodies.
  The `courier.service.test.js` unit suite covers the state-machine edge cases
  and concurrency races.

## Consequences

### Positive

- Provider choice is a one-line config change; Pathao and mock share every
  service-level guarantee (idempotency, concurrency, money, errors).
- Dispatch is explicit and reversible-safe: no implicit courier orders, and an
  order cancel can never strand an in-flight parcel without an audit trail.
- Webhook + poll converge on one transition path; atomic guarded updates make
  double-applies impossible.
- No new dependencies and no SDK: OAuth2, signing, and webhook verification are
  small, tested, in-house surfaces.

### Negative / costs

- The provider HTTP path and the reconciliation loop are exercised via the
  mock provider in this environment; real behaviour against Hermes must be
  re-verified with real merchant credentials (token acquisition → store
  validation → first shipment → status/cancel) before go-live.
- `amount_to_collect` is rounded to whole taka (Pathao's constraint); sub-taka
  COD precision is lost at the provider boundary (stored locally in paisa).
- The submit lock is per-instance only; horizontal scaling would need a
  distributed lock or a `SUBMITTING` state (documented in the state machine).
- Reconciliation is best-effort and runs only when `COURIER_RECONCILE_ENABLED`.

### Not decided here

- Live COD settlement reconciliation against Pathao's ledger; price-estimate
  endpoints; multiple stores; returns (Reverse Pickup) flows.
- Courier → order status propagation (orders still expose their own state
  machine; a `SHIPPED`/`DELIVERED` order status is reserved for a future phase).
- Notifications (email/SMS) on delivery events.
