# Taqwa Backend — Business Rules

Status: **Established constraints (Phase 00); user identity rules decided (Phase 03); category rules decided (Phase 04); product/variant rules decided (Phase 05); inventory & reservation rules decided (Phase 06); cart & order rules decided (Phase 07); payments & payment-methods rules decided (Phase 08)**

This document records the business rules that have been decided. It is the
starting point for detailed domain specifications. Detailed rules for each
domain are finalized in the phase that implements that domain.

---

## 1. Product Rule — Archival over Deletion

Products may be **archived** rather than physically deleted when historical
records (e.g., orders) depend on them. Physical deletion is only acceptable
where no historical record depends on the product.

## 2. Inventory Rule — Ownership & Mutation Path

- Inventory belongs to **product variants** (not products as a whole).
- Inventory mutations MUST go through the **inventory domain/service**.
  No other module may mutate inventory records directly.

## 3. Financial Rule — Historical Snapshots

Historical order items MUST **snapshot their financial and product
information** at the time of the order (price, variant attributes, product
identity, etc.). Later changes to the catalog must not corrupt order history.

## 4. Stock Rule — Reserved vs. Available

Reserved stock is separate from physically available stock:

```
availableOnlineStock = onlineStock - reservedStock
```

Reservations (e.g., items held while an order is in progress) must not be
counted as freely available online stock.

## 5. Audit Rule — Sensitive Actions

Sensitive administrative actions MUST be auditable. A record of who did what
and when must be retained for administrative and staff operations.

## 6. Courier Rule — Abstraction over Pathao

Business logic communicates with a **courier abstraction**, not directly with
the Pathao API. Pathao-specific concerns are contained in an adapter.

## 7. External Integration Rule — Secrets

Secrets (API keys, credentials) remain **backend-only**. They are never exposed
to the frontend and never committed to the repository (see `.gitignore`).

## 8. User Identity Rules (decided — Phase 03)

- **Authentication is frontend-owned.** The backend is a resource server: it
  never stores passwords, password hashes, sessions, refresh tokens, or any
  authentication secret (ADR-0010). Better Auth runs on the frontend.
- **Two identities per request** (ADR-0011): `req.auth` (verified authentication
  identity from the JWT) and `req.user` (application identity from MongoDB).
- **Application roles are authoritative.** The `role` used for authorization is
  the MongoDB `User` record's role; a JWT `role` claim is never trusted.
- **One `User` collection** for customers, staff, and admins. No separate
  `Customer`/`StaffUser`/`AdminUser` collections; `CustomerProfile` is a
  documented future extension.
- **Status gates access.** Only `ACTIVE` accounts are admitted.
  `SUSPENDED`/`DISABLED` accounts are rejected (403) at `resolveCurrentUser`.
  (Session revocation remains a frontend/Better Auth concern.)
- **Auto-provisioning** (`AUTO_PROVISION_CUSTOMERS`, default `true`) creates a
  `CUSTOMER/ACTIVE` application user when a verified identity is unknown. It
  never creates `ADMIN`/`STAFF`. With provisioning disabled, an unknown
  identity fails with `403 "User account not found"`.
- **No admin self-creation.** There is no backend user-registration or
  admin-creation endpoint (`POST /users` is not implemented).
- **Profile safety.** API responses serialize only the safe user fields;
  `authProviderId` and internals never reach clients.

## 9. Category Rules (decided — Phase 04)

- **Generic taxonomy.** Categories are ordinary database rows, not hard-coded
  product-type enums (`ABAYA`, `JEWELRY`, ...). The taxonomy is
  admin-managed through the API (ADR-0012).
- **Decoupled from Product.** The Category model stores no product/variant/
  stock fields. Products reference a category by `categoryId` and require an
  ACTIVE category (see §10.7).
- **Soft deactivation over deletion.** A category is deactivated
  (`isActive: false`), never hard-deleted. There is no DELETE endpoint. This
  mirrors the product archival rule (§1) so future products/orders keep valid
  historical references.
- **Storefront visibility.** Public reads expose ACTIVE categories only; an
  inactive category behaves as not-found (404) publicly. Admin management can
  see/operate on any status.
- **Access control.** Public catalog reads are unauthenticated. Create/update/
  deactivate is ADMIN-only; STAFF and CUSTOMER may NOT mutate categories.
- **Slug contract.** One `slugify` implementation is shared by the model and
  the service. Client slugs are respected but normalized; a collision →
  `400 CATEGORY_SLUG_ALREADY_EXISTS`. A missing slug is derived from `name`
  with a deterministic numeric suffix (`baby-dresses`, `baby-dresses-2`, ...).
  Unique indexes on `slug` and `name` are the final consistency layer for
  concurrent races.
- **Duplicate names are rejected.** A second category with the same `name` is
  `400 CATEGORY_ALREADY_EXISTS`.
- **PATCH semantics.** Updates change only the provided fields; omitted fields
  are preserved. Deactivation is `PATCH { "isActive": false }`.
- **Validation.** Server-side allowlist validation rejects unknown/immutable
  keys and Mongo operators (`$set`) — the category API is not a mass-assignment
  or operator-injection surface.
- **Image as URL.** `image` is a plain http(s) URL string; Cloudinary and
  uploads are a planned integration, not part of the category module.
- **Ordering.** The public list orders by `sortOrder ASC, createdAt ASC`
  (deterministic; no unsanitized client sort fields; no pagination yet).
- **Safe serialization.** Responses expose only `id, name, slug, description,
  image, isActive, sortOrder, createdAt, updatedAt`; never `_id`/`__v`.

## 10. Product & Variant Rules (decided — Phase 05)

### 10.1 Catalog scope

- **No inventory, orders, payments, cart, or stock in this phase.** The product
  and variant models contain no stock fields; inventory is a future phase that
  references `productVariantId` (§2). No Cloudinary/multipart/upload — `images`
  are plain http(s) URL strings.

### 10.2 Money

- Money is stored as **integer minor units (paisa)**: `৳1,500.00 = 150000`.
  There is no float price math anywhere. Prices are integers in
  `1 .. 100,000,000`.

### 10.3 Pricing & discounts

- `Product.sellingPrice` is the base price; `ProductVariant.sellingPriceOverride`
  overrides it for a variant when set. The **effective** price
  (`effectiveSellingPrice`) is computed centrally in the serializer and is
  **never stored**.
- `discount` is a product-level `{ type: 'percentage'|'fixed', value }`.
  Percentage is 1–99; a fixed discount cannot exceed the selling price.
  Effective price = base × (1 − percentage/100), or base − fixed.
- Effective price can never be lower than `0`.

### 10.4 Purchase-price privacy

- `purchasePrice` / `purchasePriceOverride` are stored but exposed **only in
  ADMIN responses**. The visibility decision comes from the resolved
  application `User.role` passed through the controller — never from JWT
  claims. STAFF create responses and all public reads are guaranteed free of
  purchase-cost fields (proven by tests).

### 10.5 Variants

- Variants are **optional** on create (`variants: []` or omitted → a product
  with no variants). When provided, product + initial variants commit
  **atomically in one MongoDB transaction**.
- `sku` is trimmed + uppercased, **globally unique**, and **immutable after
  creation** — a PATCH that changes SKU is rejected with `400 INVALID_PRODUCT`
  ("SKU cannot be changed after creation").
- `attributes` is a dynamic object (e.g. `{ size: '52' }`). The sorted-key JSON
  `attributeKey` is unique per product; duplicate attribute sets are rejected
  (`VARIANT_DUPLICATE_ATTRIBUTES`). Service pre-checks run inside the
  transaction; the unique `{ productId, attributeKey }` index is the final
  consistency layer for races.
- Variants are **soft-deactivated** (`isActive: false`), never deleted. In a
  PATCH replacement, an existing variant not referenced by any `id` is
  deactivated.

### 10.6 Measurement guides

- A `measurementGuide` is product-specific and optional: `{ imageUrl }` — an
  http(s) URL of the guide image, uploaded through the media system and stored
  with the product. Omit it or send `null`/`{}` for no guide.
- Legacy structured guides (`{ unit, fields, sizes }`) are tolerated **on
  existing records only** — new writes reject them (`400
  INVALID_MEASUREMENT_GUIDE`), and the legacy size-consistency rule applies
  only to those existing records.

### 10.7 Slugs & categories

- Product slugs normalize through the single `slugify`; collisions →
  `400 PRODUCT_SLUG_ALREADY_EXISTS`; a missing slug is derived from `name`
  with a `-2` numeric suffix.
- A product's `categoryId` must reference an **ACTIVE** category on create and
  update → else `400 INVALID_CATEGORY`.

### 10.8 Access control

- Public catalog reads are unauthenticated and expose ACTIVE products only;
  inactive products behave as not-found (404).
- `POST /api/v1/products` → `ADMIN` + `STAFF`. `PATCH /api/v1/products/:id` →
  `ADMIN` only. No DELETE — deactivation is `PATCH { "isActive": false }`.

### 10.9 Validation & serialization

- Server-side allowlist validation rejects unknown/immutable/operator keys
  (`$set`, `_id`, `role`, `stock`, ...) — no mass-assignment or operator
  injection. Variant entries reject `id` unless it is stripped by the service
  in the PATCH path.
- Responses expose `id` (string), never `_id`/`__v`/`attributeKey`.

## 11. Inventory & Reservation Rules (decided — Phase 06)

### 11.1 Ownership & data boundary

- **Inventory belongs to product variants** (one `Inventory` per variant,
  `productVariantId` unique) and is managed by the inventory domain — no other
  module mutates inventory directly (§2).
- Inventory **never duplicates catalog data** (name/slug/size/color/SKU live
  in the catalog). Initializing or reserving for an **inactive** variant is
  rejected (`VARIANT_INACTIVE`); existing inventory stays historically
  readable.

### 11.2 Stored vs. derived stock

- **Stored:** `onlineQuantity`, `offlineQuantity`, `reservedQuantity`,
  `lowStockThreshold` — non-negative integers, max `1,000,000,000`. Zero is
  valid (out-of-stock); operations **never clamp** — a violation fails the
  operation.
- **Derived (never stored, computed centrally in the serializer):**
  `availableOnlineQuantity = onlineQuantity - reservedQuantity`;
  `totalPhysicalQuantity = onlineQuantity + offlineQuantity`;
  `isLowStock = available <= threshold`; `isOutOfStock = available <= 0`.

### 11.3 Invariants & failure codes

- All quantities are non-negative integers; `reservedQuantity <= onlineQuantity`.
- OFFLINE shortfall on a decrease → `409 INSUFFICIENT_STOCK`.
- ONLINE shortfall respecting reserved stock → `409
  INSUFFICIENT_AVAILABLE_STOCK` (stock-out, transfer source, reserve, negative
  online adjust).
- Negative OFFLINE adjustment → `409 NEGATIVE_STOCK_FORBIDDEN`.

### 11.4 Immutable movement ledger

- Every operation that changes an Inventory record appends an
  `InventoryMovement` in the **same MongoDB transaction**.
- Movements are **never updated or deleted** — a correction is a **new**
  movement. There is **no generic inventory PATCH and no DELETE**; mutations
  are explicit commands (`initialize`, `stock-in`, `stock-out`, `transfer`,
  `adjust`, reservation `create`/`release`/`consume`/`expire`).
- Movement `quantity` is always a **positive integer magnitude**; direction is
  carried by `fromLocation` (decrease) / `toLocation` (increase). Types:
  `INITIAL_STOCK | STOCK_IN | STOCK_OUT | TRANSFER | ADJUSTMENT | RESERVATION |
  RESERVATION_RELEASE | RESERVATION_CONSUME`.
- `performedBy` is always the resolved `req.user.id` — never a body field.

### 11.5 Atomicity & concurrency

- Every mutation runs in **one transaction** (`withTransaction`, session
  threaded through repository calls).
- Stock mutations are **atomic conditional updates** (`findOneAndUpdate` with
  a guard, e.g. `$expr` on `onlineQuantity - reservedQuantity >= qty`) — never
  read-check-update — so concurrent reservations can never oversell and lost
  updates cannot happen.

### 11.6 Reservations

- Lifecycle: **`ACTIVE` → `RELEASED` | `CONSUMED` | `EXPIRED`** (terminal).
  `RELEASED` returns stock to availability; `CONSUMED` moves it physically out
  of ONLINE; `EXPIRED` releases it after `expiresAt`.
- Reservations use **generic `referenceType`/`referenceId`** — Orders arrive in
  a later phase and will pass their own stable reference; no order identifiers
  are invented now. An active reservation for the same reference → `409
  RESERVATION_CONFLICT`.
- **Idempotent resolution:** release of `RELEASED` and consume of `CONSUMED`
  are retry-safe no-ops; expire of any terminal is a no-op. Release/consume of
  the other terminal state → `409 RESERVATION_NOT_ACTIVE`. An ACTIVE
  reservation past `expiresAt` auto-expires when touched, then → `409
  RESERVATION_EXPIRED`.
- `expireReservation()` is an explicit service operation; there is no worker/
  background infrastructure in this phase.

### 11.7 Access control

- **All inventory endpoints are ADMIN-only** (`authorizeRoles(ROLES.ADMIN)`).
  STAFF/CUSTOMER → 403. JWT `role` claims / body / query / header role
  spoofing never elevates (the stored application role is authoritative).

### 11.8 Money & identifiers

- No new money handling in this phase — inventory carries quantities only;
  variant prices live in the catalog.
- Serialized responses expose string `id`, never `_id`/`__v`.

## 12. Cart & Order Rules (decided — Phase 07, ADR-0015)

### 12.1 Server-side cart

- The cart is **server-side and per-customer** (one `Cart` per customer,
  `customerId` unique). It stores **only** `productVariantId` + `quantity` —
  **no prices, discounts, effective prices, or fees** are ever stored in a
  cart (ADR-0015; future phases must not start persisting prices in carts).
- All money shown with a cart is **derived live** from the catalog/inventory at
  read time; it is informational, not authoritative. Only checkout computes the
  authoritative numbers, and it recomputes everything from the catalog
  (**client-supplied totals, discounts, delivery fees are always ignored**).
- Cart operations are CUSTOMER-only and customer-scoped (the service always
  uses `req.user.id`). Cart item limit: **100 lines** (`CART_ITEM_LIMIT`);
  per-line quantity: positive integer ≤ `1,000,000,000`.

### 12.2 Money at checkout

- All order money is **integer minor units (paisa)**. Every amount is computed
  server-side inside the checkout transaction:
  - `unitPriceMinorUnits` = variant effective price at checkout
    (`computeEffectiveSellingPrice(sellingPrice, discount)`, override-aware).
  - `discountMinorUnits` = per-unit discount; `lineTotalMinorUnits =
    unitPriceMinorUnits × quantity`.
  - `itemsSubtotalMinorUnits` = Σ line totals.
  - `totalDiscountMinorUnits` = Σ per-unit discounts × quantities.
  - `deliveryFeeMinorUnits` = zone constant from
    `DELIVERY_FEES_MINOR_UNITS` — **`INSIDE_CHITTAGONG` = `8000` (৳80),
    `OUTSIDE_CHITTAGONG` = `15000` (৳150)**; single-point change in
    `order.constants.js`.
  - `grandTotalMinorUnits = itemsSubtotal − totalDiscount + deliveryFee`.
- **No purchase-price snapshots** this phase (even for admins) — selling-side
  snapshots only (§3, ADR-0015); purchase-cost protection is a future
  expenses/costing concern.

### 12.3 Delivery zone

- `delivery.zone` (`INSIDE_CHITTAGONG` / `OUTSIDE_CHITTAGONG`) is the
  **customer-selected delivery-charge zone**: it is validated against the enum
  at checkout (a malformed zone → `400 INVALID_ORDER`) and its fee is ALWAYS
  read server-side from `DELIVERY_FEES_MINOR_UNITS`. When omitted, it falls
  back to the pure function `classifyDeliveryZone(address)` in
  `src/modules/orders/delivery.js`; the fee table lives in one place
  (`order.constants.js`).
- The delivery address `country` must be `BD` (`INVALID_DELIVERY_ADDRESS`).

### 12.4 Order state machine

- Reachable states (Phase 07): **`PENDING` → `CONFIRMED` → `PROCESSING`**, with
  **`CANCELLED`** (customer + admin, from `PENDING`/`CONFIRMED`) and
  **`REJECTED`** (staff, from `PENDING`) as terminal states.
- `SHIPPED` / `DELIVERED` / `RETURN_REQUESTED` / `RETURNED` are **reserved** for
  future phases and unreachable — any attempt → `409 ORDER_INVALID_STATE`.
  Customers cannot cancel `PROCESSING` orders.
- Every transition appends to `statusHistory` (`{ status, at, by, note }`);
  `by` is always the resolved actor (`req.user.id`).
- Transitions must be **atomic and idempotent at the conflict point**: a
  `PENDING → CONFIRMED` transition uses a conditional update guarded on the
  current status, so two concurrent confirms cannot double-apply.

### 12.5 Checkout & idempotency

- Checkout runs in **ONE MongoDB transaction**: cart load → catalog validation
  → price snapshots → zone + fee derivation → **per-line ONLINE stock
  reservation** (`createReservationInTransaction`; reference
  `{referenceType: 'ORDER', referenceId: orderId}`) → order + embedded items +
  `statusHistory` create → cart `isCheckedOut: true` (items cleared). Any
  failure rolls the whole thing back — no partial orders, no leaked
  reservations.
- Checkout is **idempotent** via the `Idempotency-Key` header (unique compound
  index `{customerId, idempotencyKey}`). A retry returns the original order; a
  conflicting body under the same key → `409 ORDER_IDEMPOTENCY_CONFLICT`.
- Every checkout requires a non-empty cart → else `400 CART_EMPTY`.

### 12.6 Reservations & orders

- Each order line holds **exactly one ACTIVE `Reservation`** with
  `referenceType: 'ORDER'` and `referenceId = orderId` — the reference value is
  the order id, so it is stable before and after order creation.
- Order reservations are created **inside the checkout transaction** and
  bypass the admin API's service-level one-reference guard (the DB index on
  `{referenceType, referenceId, status}` is non-unique; one reservation per
  line means a unique order still maps to N reservations).
- **Confirm does NOT release or consume** — stock stays reserved while the
  order is open; consuming is a future fulfillment-time action. **Cancel and
  reject DO release** all ACTIVE reservations for the order in the same
  transaction. Reservation auto-expiry is not implemented in Phase 07 (no
  worker); stale `PENDING` orders need explicit staff action or a future
  background job.

### 12.7 Order number

- `orderNumber` = `TAQ-YYYYMMDD-XXXXXX`, generated server-side, unique
  (unique index + bounded retry; exhaustion → `ORDER_NUMBER_GENERATION_FAILED`).
- Customers cannot set `orderNumber`; status, totals, items, and
  `delivery.deliveryFeeMinorUnits` are never client-controllable. The delivery
  `zone` IS customer-selectable (§12.3) — the only client-supplied checkout
  value that affects money, and its fee is still server-derived.

### 12.8 Customer scoping & access control

- Customer order/cart reads are **customer-scoped in the service**: the query
  always includes `customerId = req.user.id`. A cross-customer order read →
  **404 `ORDER_NOT_FOUND`** (never 403) to avoid leaking order existence.
- Cart/orders customer endpoints → `CUSTOMER` only. Admin/STAFF order
  operations → `ADMIN` + `STAFF` (`/api/v1/admin/orders`). The acting actor id
  (`by`, `performedBy`) is always `req.user.id`; body `performedBy`/`role`/
  `userId`/`customerId` are rejected.
- No DELETE on orders or order items; no edit of totals/items after creation
  (immutable embedded snapshots).

### 12.9 Access control for order mutations

- Customer cancel: only `PENDING`/`CONFIRMED` → else `409
  ORDER_CANCELLATION_NOT_ALLOWED`.
- Staff confirm: `PENDING → CONFIRMED` → else `409
  ORDER_CONFIRMATION_NOT_ALLOWED`.
- Staff process: `CONFIRMED → PROCESSING` → else `409
  ORDER_PROCESSING_NOT_ALLOWED`.
- Staff reject: `PENDING → REJECTED` → else `409 ORDER_REJECTION_NOT_ALLOWED`.
- Reserved-state transitions (`SHIPPED`/`DELIVERED`/`RETURN_*`) → `409
  ORDER_INVALID_STATE`.

## 13. Payment Rules (decided — Phase 08, ADR-0016)

### 13.1 Scope & ownership

- **Manual (bank transfer) and cash-on-delivery only.** No online gateway,
  card, or auto-verification in this phase (ADR-0016). `CARD`/other payment
  methods are rejected at order validation.
- **Separate state machine.** A payment has its own lifecycle that is
  **decoupled from the order lifecycle** (§12.4). Reviewing a payment
  **never auto-confirms the order** — the payment service never mutates the
  Order document. Confirming/proceeding with an order is a separate, explicit
  action (future phase or staff operation).
- There is exactly **one payment record per order** (unique `orderId`). An
  `UNPAID` state is never persisted — a payment record is created only on the
  first submission.

### 13.2 Payment methods

- `PaymentMethod` is a soft-managed reference row: unique `code`
  (`[A-Z0-9_]{1,50}`, normalized server-side), `displayName`,
  `accountNumber`, `isActive`, `sortOrder`. Soft deactivation only — no
  DELETE, no hard removal (archival over deletion, §1).
- Management (`POST /admin/payment-methods`, `PATCH /admin/payment-methods/:id`)
  is **ADMIN-only**. Customers see **ACTIVE methods only** (inactive behaves
  as not-found). A duplicate `code` → `409 PAYMENT_METHOD_CODE_ALREADY_EXISTS`.
- Submissions **snapshot** `{ code, displayName, accountNumber }` into the
  payment at submit time, so later method edits never alter existing proofs'
  instructions (§3 historical snapshots).

### 13.3 Submission eligibility

- Only the **owning customer** may submit; `paymentMethod` must be `'MANUAL'`
  and the order `PENDING`/`CONFIRMED` → else `409 PAYMENT_ORDER_NOT_ELIGIBLE`.
  Cross-customer access → **404 PAYMENT_NOT_FOUND** (existence never leaked,
  §12.8).
- **Exact-amount policy:** the submitted `amountMinorUnits` must equal the
  server-computed `order.totals.grandTotalMinorUnits` exactly → else `400
  INVALID_PAYMENT_AMOUNT`. Client amounts are never trusted (§12.1).
- **Idempotency:** the `Idempotency-Key` header (same rules as checkout,
  §12.5) makes a retry return the original result; a conflicting body under
  the same key → `409 PAYMENT_IDEMPOTENCY_CONFLICT`.
- **Reference reuse guard:** an already-used `{ paymentMethodId,
  transactionReference }` on a **non-REJECTED** payment → `409
  PAYMENT_IDEMPOTENCY_CONFLICT`. Reusing a reference on the **same rejected**
  payment (a resubmission) is allowed.

### 13.4 Proof media

- Proof is a **multipart file upload** (JPEG/PNG/WEBP only; MIME + file
  extension + magic bytes all checked), file ≤ 2 MiB, body ≤ 4 MiB, one file.
  Violations → `400 PAYMENT_PROOF_REQUIRED` / `INVALID_PAYMENT_PROOF` /
  `PAYMENT_PROOF_UPLOAD_FAILED`.
- The backend talks to storage through the **media abstraction**
  (ADR-0016, §6/§7): uploads go to Cloudinary via the adapter; the `public_id`
  is server-generated (`payments/<uuid>`), never client-supplied; persisted
  proof is the **safe media object** `{ provider, publicId, secureUrl,
  resourceType, format }`. If Cloudinary is unconfigured the module is
  disabled (501) rather than failing half-way.
- Uploads happen **outside** the payment transaction; if the DB write fails,
  the uploaded file is **best-effort deleted** to avoid orphan media.

### 13.5 Review (verify / reject)

- `POST /admin/payments/:id/verify` and `POST /admin/payments/:id/reject` are
  **ADMIN + STAFF**. Verify applies only to `SUBMITTED` → `VERIFIED`
  (terminal); reject applies to `SUBMITTED` → `REJECTED`. Wrong state → `409
  PAYMENT_INVALID_STATE`; actions are idempotent in the target status.
- Transitions are **atomic conditional updates** (guarded on the current
  status), so concurrent reviews cannot double-apply (§12.4). `verifiedBy`/
  `rejectedBy` are always `req.user.id` — never a body field.
- A **rejected payment is resubmitted by the customer** — the SAME record is
  mutated (new proof, reference retained, reviewer fields cleared), not a new
  payment; the order eligibility stays `PENDING`/`CONFIRMED` throughout.

### 13.6 Serialization

- Customer/admin responses expose the safe payment shape and **never expose
  reviewer identities**; only ADMIN responses add `verifiedBy`/`rejectedBy`.
  `id` is a string; `_id`/`__v` never leak.

---

## 14. Returns & Refunds Rules (decided — Phase 10, ADR-0018)

### 14.1 Separation & scope

- Returns are a **SEPARATE state machine, deliberately decoupled from the
  order machine** (§12.4): the return service **never mutates the Order
  document**, and the order-level `RETURN_REQUESTED` / `RETURNED` states stay
  **reserved and unreachable**. The refund service **never mutates the Payment
  or Order documents** either.
- A refund is the **financial record for an accepted, COMPLETED return**. It
  is auto-created at `PENDING` inside the return's `APPROVED → COMPLETED`
  transaction and is 1:1 with the return (unique `return` index).

### 14.2 Eligibility

- Only the **owning customer** may start a return for their own order
  (`{ _id, customerId }` lookup; cross-customer → **404 RETURN_NOT_FOUND**,
  existence never leaked, §12.8).
- Server-derived only: the order must be `CONFIRMED` or `PROCESSING` (§12.4)
  → else `409 RETURN_NOT_ELIGIBLE`, and the request must arrive within
  `RETURN_LIMITS.ELIGIBLE_DAYS` (30) of `order.createdAt` → else `409
  RETURN_WINDOW_EXPIRED`. The client can never supply or override eligibility.

### 14.3 Idempotency & duplicate prevention

- The `Idempotency-Key` header (same rules as checkout, §12.5) plus the unique
  compound index `{ orderId, idempotencyKey }` make submission replay-safe:
  same key + same body → returns the original return (`created: false`); same
  key + different body → `409 RETURN_IDEMPOTENCY_CONFLICT`. A missing key →
  `400 INVALID_RETURN`.
- **Per-item availability** (no double-refund): available = `orderItem.quantity`
  minus the quantity claimed by `PENDING` / `APPROVED` / `COMPLETED` returns
  (§14.5). Claiming more than available → `409 RETURN_QUANTITY_EXCEEDED`. An
  item that is not part of the order → `404 RETURN_ITEM_NOT_FOUND`. `REJECTED`
  and `CANCELLED` returns release their claim (they never restocked).
- DOCUMENTED LIMITATION: two concurrent submissions with **different** keys for
  overlapping quantities can both pass the availability check before either
  commits (there is no atomic "claim" document); the unique index still blocks
  same-key replays.

### 14.4 Item snapshots & money

- Return items **snapshot** the order's immutable OrderItem price fields
  (`unitPriceMinorUnits`, `discountMinorUnits`, `productId`,
  `productVariantId`, `productName`, `sku`) at submission time (§3) — later
  catalog edits never rewrite historical returns or refunds.
- The refund amount is always **server-derived**: `Σ (unitPriceMinorUnits −
  discountMinorUnits) × quantity` across the return's snapshots. **No
  delivery-fee refunds.** All money is INTEGER minor units (paisa); the Refund
  model enforces `min 0` + `isInteger`.

### 14.5 Return state machine

- `PENDING → APPROVED | REJECTED | CANCELLED`; `APPROVED → COMPLETED |
  CANCELLED`. `REJECTED`, `COMPLETED`, `CANCELLED` are terminal.
- **Refund + restock side effects happen ONLY at `APPROVED → COMPLETED`**
  — never on approval — so cancelling an `APPROVED` return has nothing to undo.
- Every transition is an **atomic conditional update** (`conditionalTransition`
  guarded on the current status, §12.4), so concurrent approve/reject/complete/
  cancel calls cannot double-apply. `approve`/`reject`/`cancel` are idempotent
  in the target status; wrong status → `409 RETURN_INVALID_STATE`.

### 14.6 Completion transaction (restock + refund)

- `POST /admin/returns/:id/complete` (ADMIN+STAFF) runs **ONE** `withTransaction`:
  1. atomic `APPROVED → COMPLETED` transition (conflict point — two concurrent
     completes cannot double-restock),
  2. each returned line is restocked ONLINE via
     `restockOnlineInTransaction` (one `RETURN_RESTOCK` `InventoryMovement`
     per line),
  3. the refund is auto-created at `PENDING` (`createRefundInTransaction`) with
     the server-derived amount,
  4. the `refundId` is persisted back onto the Return in the same transaction.
- A `MANUAL` order's refund links the **verified** Payment via `paymentId`; a
  `COD` order has no captured payment → `paymentId: null` (informational).

### 14.7 Refund state machine

- `PENDING → PROCESSED | VOIDED`, both terminal. `process` and `void` are
  ADMIN+STAFF, idempotent in the target status, atomic conditional transitions;
  wrong status → `409 REFUND_INVALID_STATE`.
- Customers never mutate refund records; every transition records the actor in
  `statusHistory`. Refund `refundNumber` is `RFD-YYYYMMDD-XXXXXX` (unique).

### 14.8 Access control

- Customer surface: `POST /api/v1/orders/:orderId/returns` (create), `GET
  /api/v1/orders/:orderId/returns` (list), `GET
  /api/v1/orders/:orderId/returns/:returnId` (detail), `POST
  /api/v1/orders/:orderId/returns/:returnId/cancel` — all scoped to the owning
  customer (`customerId` always in the query).
- Admin surface: `/api/v1/admin/returns` (list/detail/approve/reject/complete/
  cancel) and `/api/v1/admin/refunds` (list/detail/process/void) — ADMIN+STAFF
  only. The acting id always comes from `req.user.id`, never the body.

---

## Planned Domain Rules

The following are marked as **Planned — to be finalized in their implementing
phase** and MUST NOT be fabricated now:

| Domain | Status |
| ------ | ------ |
| Products | **Finalized — see §10 (Phase 05)** |
| Product variants | **Finalized — see §10 (Phase 05)** |
| Inventory & reservations | **Finalized — see §11 (Phase 06)** |
| Cart & orders lifecycle | **Finalized — see §12 (Phase 07)** |
| Payments (manual, cash on delivery) | **Finalized — see §13 (Phase 08)** |
| Returns & refunds | **Finalized — see §14 (Phase 10, ADR-0018)** |
| Customers (profile extension) | Planned — to be finalized in Phase XX |
| Expenses | Planned — to be finalized in Phase XX |
| Analytics & profit/loss | Planned — to be finalized in Phase XX |
| Staff/admin management APIs | Planned — to be finalized in a future users/rbac phase |
| Courier (Pathao) | **Finalized — Phase 09 (ADR-0017)** |
| Notifications (email) | **Finalized — see §15 (Phase 11, ADR-0019)** |

---

## 15. Notifications (email) — Phase 11 (ADR-0019)

Documented rules apply to the implemented transactional email notifications
(`src/modules/notifications/`, `src/integrations/email/`).

### 15.1 Delivery semantics

- Notifications are **asynchronous/best-effort from the business-operation
  perspective**: business services call `maybeNotify` AFTER their own
  transaction has committed, so a notification can never change the outcome of
  the order/payment operation that triggered it.
- **A notification failure never fails the underlying business operation.**
  `createMaybeNotify` catches and logs every error; provider failures are
  recorded on the `Notification` document (`status: FAILED` + `lastError`)
  instead of being thrown to the caller.
- **Disabled notifications are a safe no-op.** `NotificationService` returns
  `null` when `NOTIFICATIONS_ENABLED=false`; a missing/injected service is also
  a no-op (`maybeNotify` → `null`).

### 15.2 Recipient resolution

- The recipient is the application `User` record referenced by `userId`. A user
  **without an email** produces no notification (nothing is persisted) — there
  is no deliverable address.
- The email address used is `user.email`; the template `customer` snapshot is
  `{ name: user.displayName || user.email, email, phone }`.

### 15.3 Template safety

- Templates **must safely escape all dynamic HTML data** before interpolation
  (`escapeHtml` in `templates/helpers.js`); the shared email shell
  (`templates/base.js`) also escapes the greeting, title, and subject. Money is
  integer minor units rendered as BDT (`৳`) by `formatMinorUnits`.
- Notification **payloads are sanitized safe subsets** built by the business
  service (e.g. `entityRef`, `orderNumber`, `transactionReference`,
  `amountMinorUnits`, `note`) — never JWT/token material or credentials.

### 15.4 Deduplication

- Dedupe is **recipient + event + entity + time-window** based: an identical
  `{ recipient, eventType, entityRef }` notification created inside
  `dedupeWindowMs` (default 1 hour) is skipped. Backed by the
  `{ recipient: 1, eventType: 1, entityRef: 1, createdAt: -1 }` index.
- This is **defense-in-depth**: business-level idempotency (checkout/payment
  `Idempotency-Key`) short-circuits before any notification is emitted, so
  retried requests do not re-notify. Dedupe is window-based, not a durable
  event-idempotency system.

### 15.5 Provider configuration

- `EMAIL_PROVIDER=mock` (default) is the in-memory development/test provider;
  `EMAIL_PROVIDER=smtp` is the production provider. SMTP requires `EMAIL_HOST`
  and `EMAIL_FROM` at first send — missing credentials signal `NOT_CONFIGURED`
  (recorded on the Notification, never a boot failure).
- Provider credentials come **only from configuration** (`.env` / `.env.example`)
  and are never logged or echoed in responses.
