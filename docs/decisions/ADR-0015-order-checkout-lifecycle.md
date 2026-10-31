# ADR-0015: Order & Checkout Lifecycle

## Status

Accepted

## Date

2026-08-08

## Context

Phase 07 introduces the **cart and order domains** on top of the Phase 05
catalog and the Phase 06 inventory/reservation foundation. The business already
decided (Phase 00 constraints, `docs/order-state-machine.md`): orders support
manual payments and cash on delivery, orders support returns and
cancellations, and order items snapshot their financial and product
information at order time. Several architectural questions had to be answered
so later phases (payments, courier, returns) can build on a stable core:

- **Cart ownership & pricing.** Does a cart store prices? Is a cart a
  persistent resource or a checkout-only concept? How are item merges /
  quantity caps handled?
- **Checkout atomicity.** Checkout spans the customer's cart, the order
  document, the order items, and the Phase 06 stock reservations. A crash in
  the middle must not create an order without reserved stock (or vice versa).
- **Reservation semantics vs. Phase 06.** Phase 06 reserves online stock with
  an `ACTIVE → RELEASED | CONSUMED | EXPIRED` machine and enforces **one
  ACTIVE reservation per reference** (service-level `RESERVATION_CONFLICT`).
  Orders need to reserve **many lines** for one reference. When does an order
  hold stock, and when does that stock physically leave ONLINE?
- **Price integrity & historical snapshots.** Order items must keep the price
  the customer saw, independent of later catalog changes. All money is integer
  minor units (paisa, ADR-0013); who computes the totals, and where do they
  come from?
- **Server-derived delivery data.** Delivery zones and fees cannot be trusted
  from the client. The repository has **no authoritative delivery-fee amounts**
  yet — how do we keep the boundary explicit without inventing pricing?
- **Order identity.** An order needs a human-readable, collision-safe order
  number that is distinct from the Mongo `_id`.
- **Idempotency.** A network retry on checkout must not create two orders.
- **Order status machine.** What states exist now vs. are reserved for the
  payments/courier phases, and what are the exact allowed transitions?
- **Who may act.** Customers must only reach their own orders; staff/admin
  operate across all orders; no one may fabricate prices, stock, roles, or
  actors.

## Decision

Introduce two modules: `src/modules/cart/` and `src/modules/orders/`. No
payments, courier, returns, uploads, or notifications in this phase. No new
dependencies.

### Cart — a per-customer draft, prices never stored

- One `Cart` per customer (`customerId` unique). A cart holds **only**
  references and quantities: `items: [{ productVariantId, quantity }]`,
  normalized so each variant appears **at most once** (adding an existing
  variant merges quantities; duplicate variants are rejected as invalid input).
- A cart **stores no prices** — all money is re-derived from the live catalog
  at read time (enrichment) and from the catalog **inside the checkout
  transaction** (snapshot). This makes stale-price carts impossible.
- Quantity per line: integer `1..CART_ITEM_QUANTITY_MAX`. Number of lines:
  `1..CART_ITEMS_MAX`.
- The cart is a **draft**: it never blocks anyone, and stock is only touched
  at checkout.
- Customer cart endpoints (`authenticate → resolveCurrentUser →
  authorizeRoles(CUSTOMER)`):
  - `GET /api/v1/cart` — current cart, enriched with live prices/availability
    (display only; totals recomputed server-side at checkout).
  - `POST /api/v1/cart/items` — `{ productVariantId, quantity }` (upserts).
  - `PATCH /api/v1/cart/items/:productVariantId` — `{ quantity }` (set; a
    `quantity` of `0` removes the line).
  - `DELETE /api/v1/cart/items/:productVariantId` — remove a line.
  - `DELETE /api/v1/cart` — clear the whole cart.
- All cart line references are validated to existing **ACTIVE** product
  variants before write; the enriched read reports `availableOnlineQuantity`
  and a computed `available` boolean but the cart itself does not enforce it
  (a cart may hold more than is currently available — checkout fails cleanly).

### Checkout — one transaction, order + items + reservations

- `POST /api/v1/orders` (CUSTOMER) is the checkout entry point. The body is
  the **delivery address**; the items come **from the server-side cart** —
  the client can never dictate line items, prices, discounts, or fees.
- The whole checkout runs in **ONE MongoDB transaction**
  (`withTransaction`):
  1. Load the customer's cart; reject an empty cart
     (`CART_EMPTY` / `CHECKOUT_EMPTY_CART`).
  2. For each line, load the `ProductVariant` (must be ACTIVE) and its
     `Product` (must be ACTIVE). Any inactive/missing variant aborts the whole
     order (`PRODUCT_NOT_FOUND` / `VARIANT_NOT_FOUND`).
  3. Compute the price snapshot per line from the **live catalog**:
     `unitPrice = sellingPriceOverride ?? product.sellingPrice`;
     `effectiveUnitPrice = computeEffectiveSellingPrice(unitPrice, product.discount)`;
     `lineSubtotal = unitPrice * quantity`;
     `lineDiscountTotal = (unitPrice - effectiveUnitPrice) * quantity`.
  4. Reserve online stock per line through the Phase 06 machinery (see below).
     Insufficient availability → `INSUFFICIENT_AVAILABLE_STOCK`, aborting the
     transaction (no order, no partial reservations).
  5. Create the `Order` (status `PENDING`, order number, address + server-derived
     `deliveryZone`, snapshots, totals) and its embedded `OrderItem`s.
  6. Clear the cart.
  Any failure rolls back the order, the items, and every reservation together.
- The **`Idempotency-Key` header** makes checkout replay-safe: it is stored on
  the order and guarded by a **unique compound index
  `{ customerId, idempotencyKey }`**. A retry with the same key returns the
  original order (200); a replayed key with a **different request body** →
  `409 ORDER_IDEMPOTENCY_CONFLICT`. Keys are scoped to the customer, so one
  customer's key can never collide with another's.

### Reservation semantics — reserved at checkout, released on cancel/reject, consumed at fulfillment

- Checkout creates **one ACTIVE reservation per order line**:
  `referenceType: 'ORDER'`, `referenceId: <order._id>`. The `OrderService`
  runs the reservation **inside the order's own transaction** via a new
  transaction-embedded primitive on `ReservationService`
  (`createReservationInTransaction`, which performs the atomic
  `reserveOnline` + reservation insert + `RESERVATION` movement ledger write).
  This bypasses the **service-level** single-reservation-per-reference guard
  (that guard stays for the admin reservation API), because the order itself
  guarantees one line per variant; the `{ referenceType, referenceId, status }`
  index is non-unique at the database level, so many ACTIVE reservations may
  share one order reference. The conflict guard is intentionally NOT weakened —
  it only never sees order-created reservations.
- **Confirm does NOT consume and does NOT release.** Confirming an order
  (`PENDING → CONFIRMED`) only records staff/admin acceptance. The stock stays
  reserved (`ACTIVE`), so an accepted-but-unfulfilled order keeps its stock
  held. Consuming (`RESERVATION_CONSUME`, stock physically leaves ONLINE) is a
  **fulfillment-time** action reserved for the courier/shipping phase; the
  existing admin inventory reservation endpoints already expose manual
  release/consume/expire for operational corrections.
- **Cancel and reject release.** `PENDING → CANCELLED`,
  `CONFIRMED → CANCELLED`, `PENDING → REJECTED` all release every ACTIVE
  reservation of the order (`referenceType 'ORDER'`, `referenceId orderId`)
  via `releaseReservation`, returning the held stock to availability.
  Releases are idempotent per Phase 06.
- **Reservations have no auto-expiry in this phase** (consistent with ADR-0014:
  no worker exists). Order reservations are created without `expiresAt`;
  stale `PENDING` orders remain visible to staff and are resolved by explicit
  operations (reject/cancel or manual expiry). Documented, not silently
  handled.

### Order number

- `orderNumber` format **`TAQ-YYYYMMDD-XXXXXX`** (e.g. `TAQ-20260808-000042`):
  date-based prefix plus a six-digit sequence. Generation is **server-side and
  collision-safe**: a **unique index** on `orderNumber` is the final guard and
  a duplicate-key error triggers a bounded retry with a fresh sequence value
  (per-process counter, seed randomized at boot). `orderNumber` is **immutable
  after creation** and is never the Mongo `_id`.

### Delivery zone & fee boundary

- `deliveryZone` is **always derived server-side** from the address by a single
  pure resolver (`classifyDeliveryZone(address)` in
  `src/modules/orders/delivery.js`): `INSIDE_CHITTAGONG`
  when the post code lies in the Chittagong district range (4000–4399) or the
  normalized city/district/area matches Chittagong aliases; otherwise
  `OUTSIDE_CHITTAGONG`. The client can never supply `deliveryZone`.
- **The repository has no authoritative fee amounts.** The fee policy lives in
  `order.constants.js` as an explicitly-marked **PENDING** configuration:
  `DELIVERY_FEES_MINOR_UNITS = { INSIDE_CHITTAGONG: <pending>, OUTSIDE_CHITTAGONG: <pending> }`.
  Until the business confirms amounts, the resolver contributes **0** to the
  total and the pending state is documented in `docs/business-rules.md`.
  When confirmed, the single constant is updated and every order total picks it
  up automatically. No silent invented pricing.

### Totals (all integer minor units, computed server-side)

- `itemsSubtotal = Σ(unitPrice * quantity)`.
- `discountTotal = Σ((unitPrice - effectiveUnitPrice) * quantity)`.
- `deliveryFee = deliveryFeeForZone(deliveryZone)` (0 while PENDING).
- `totalAmount = itemsSubtotal - discountTotal + deliveryFee`
  (equivalently `Σ(effectiveUnitPrice * quantity) + deliveryFee`).
- The serializer re-verifies the invariant
  `itemsSubtotal - discountTotal + deliveryFee === totalAmount` before
  emitting an order; a violation is treated as a server error (`INTERNAL_ERROR`),
  never silently corrected.

### OrderItem — embedded immutable snapshot

- OrderItems are **embedded subdocuments** of the Order (`order.items`):
  they are immutable historical snapshots that always travel with their order
  (single-document reads, no orphan risk, naturally atomic). No separate
  collection.
- Snapshot fields: `productId`, `productVariantId`, `productName`,
  `productSlug`, `sku`, `size`, `variantAttributes`, `unitPrice`, `discount`
  (the product's discount at order time, `{ type, value } | null`),
  `effectiveUnitPrice`, `quantity`, `lineSubtotal`.
- **Purchase-price data is never snapshotted and never serialized to any
  caller in this phase** (no profit/loss yet); even the admin representation
  omits it. Future financial phases can add an ADMIN-only purchase snapshot as
  a separate decision.

### Order status machine

- States implemented now: **`PENDING → CONFIRMED → PROCESSING`** operational
  spine plus terminal **`CANCELLED`** and **`REJECTED`**.
- **Allowed transitions** (explicit commands only — no arbitrary status
  PATCH):
  - `PENDING` → `CONFIRMED` (staff/admin).
  - `PENDING` → `REJECTED` (staff/admin; `rejectionReason` required).
  - `PENDING` → `CANCELLED` (customer, staff/admin; `cancellationReason`).
  - `CONFIRMED` → `PROCESSING` (staff/admin).
  - `CONFIRMED` → `CANCELLED` (customer, staff/admin; releases reservations).
  - `PROCESSING` → `CANCELLED` (staff/admin only; releases reservations).
  - `CANCELLED` / `REJECTED` are terminal.
- Every transition records an immutable `statusHistory` entry
  `{ status, at, by, note }`.
- **Reserved for later phases** (documented in `docs/order-state-machine.md`,
  not implemented, not reachable by any route): `SHIPPED`, `DELIVERED`,
  `RETURN_REQUESTED`, `RETURNED`. A transition attempt toward a reserved state
  fails with `ORDER_INVALID_STATE`.

### API surface

- Customer (`authenticate → resolveCurrentUser → authorizeRoles(CUSTOMER)`):
  - `POST /api/v1/orders` (checkout; `Idempotency-Key` header; body =
    delivery address).
  - `GET /api/v1/orders` — own orders, newest first, paginated.
  - `GET /api/v1/orders/:id` — own order detail (a different customer's order
    → 404, never 403, to avoid leaking existence).
  - `POST /api/v1/orders/:id/cancel` — customer cancellation
    (`PENDING`/`CONFIRMED`).
- Staff/admin (`authorizeRoles(STAFF, ADMIN)`), mounted at `/api/v1/admin/orders`:
  - `GET /api/v1/admin/orders` — all orders, filterable by `status`,
    paginated.
  - `GET /api/v1/admin/orders/:id` — detail.
  - `POST /api/v1/admin/orders/:id/confirm`.
  - `POST /api/v1/admin/orders/:id/process`.
  - `POST /api/v1/admin/orders/:id/reject` — `{ rejectionReason }`.
  - `POST /api/v1/admin/orders/:id/cancel` — `{ cancellationReason }`.
- Controllers follow the existing pattern: validate input, call the service,
  respond with the standard `{ success, message, data }` envelope. The actor
  (`req.user.id`) is always the resolved user — never a body field.

### Authorization & security

- Customer order scoping is enforced **in the service** (every customer order
  query filters by `customerId`), so IDOR is impossible even if a controller
  passed the wrong id.
- STAFF sees order data (not purchase cost); only `ADMIN` may eventually see
  financials — none exist in this phase, so customer and staff serializers
  differ only by scope, and the admin serializer must never leak anything the
  staff one hides.
- Field allowlists on every input (address, cancel/reject reasons); `$`-keys,
  unknown keys, `role`, `userId`, `changedBy`, prices, stock, `deliveryZone`,
  `orderNumber`, `status`, `totalAmount` are **never** client-writable.
- Reasons are trimmed, length-bounded, optional for customer cancel, required
  for staff reject.

### Error codes (added to `src/constants/index.js`, no duplicates)

`CART_NOT_FOUND`, `CART_EMPTY`, `INVALID_CART_ITEM`, `CART_ITEM_LIMIT`,
`ORDER_NOT_FOUND`, `ORDER_INVALID_STATE`, `ORDER_CANCELLATION_NOT_ALLOWED`,
`ORDER_CONFIRMATION_NOT_ALLOWED`, `ORDER_PROCESSING_NOT_ALLOWED`,
`ORDER_REJECTION_NOT_ALLOWED`, `ORDER_IDEMPOTENCY_CONFLICT`,
`INVALID_DELIVERY_ADDRESS`, `CHECKOUT_FAILED`, `ORDER_NUMBER_GENERATION_FAILED`.

## Consequences

### Positive

- Checkout is atomic: an order cannot exist without its stock reservations
  (and vice versa), and the cart is cleared in the same commit.
- Price snapshots make orders immune to later catalog edits; totals are
  computed once, server-side, in integer minor units.
- Reserve-on-checkout / release-on-cancel / consume-on-fulfillment is
  unambiguous, matches Phase 06 idempotency, and leaves confirmed-but-unshipped
  orders holding their stock without any premature physical movement.
- Server-derived zones with an explicit PENDING fee boundary respect the
  "no invented pricing" rule while keeping the system testable.
- The transaction-embedded reservation primitive reuses Phase 06's atomic
  stock machinery instead of duplicating it, and leaves the admin
  reservation API's conflict guard untouched.
- Idempotency keys + unique compound index make checkout network-retries safe.

### Negative / costs

- Order reservations are deliberately not auto-expired (no worker); stale
  `PENDING` orders need explicit staff action or a future background job.
- Consume at fulfillment is deferred, so `availableOnlineQuantity` includes
  stock held by confirmed orders — staff must read reservations to see the
  full picture (existing Phase 06 admin views cover this).
- No live MongoDB in this environment: checkout transaction atomicity and
  idempotency races are exercised through repository stubs that apply the same
  guards (documented limitation, see `docs/order-state-machine.md`).
- The delivery-fee constant is PENDING (0); totals will change when the
  business confirms amounts (a deliberate, single-point change).

### Not decided here

- Payments (manual/COD flows), Pathao/courier status sync, returns, expenses,
  profit/loss, and analytics remain future phases.
- Whether a later financial phase adds an ADMIN-only purchase-price snapshot
  to order items.
- Exact delivery-fee amounts and the precise shipping-zone model (Chittagong
  aliases, post-code edges) await business + courier confirmation.
