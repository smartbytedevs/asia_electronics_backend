# Taqwa Backend — Database Schema

Status: **Foundation established (Phase 01); `User` implemented (Phase 03); `Category` implemented (Phase 04); `Product` + `ProductVariant` implemented (Phase 05); `Inventory`, `InventoryMovement`, `Reservation` implemented (Phase 06); `Cart`, `Order` (+ embedded `OrderItem` snapshot subdocuments) implemented (Phase 07); `Payment` + `PaymentMethod` implemented (Phase 08); remaining schemas Planned**

## 1. Access Layer

```
Service
  ↓
Repository
  ↓
Mongoose Model
  ↓
MongoDB (Atlas)
```

## 1b. Repository Pattern

- Persistence operations are encapsulated in repositories.
- `src/modules/base/base.repository.js` provides a minimal reusable base
  (`findById`, `findOne`, `findMany`, `create`, `updateById`, `deleteById`,
  `count`). It forwards filters/options to Mongoose and does not hide Mongoose
  capabilities.
- Future modules create module-specific repositories that may extend the base
  or call their model directly (e.g. for complex or transactional queries).
- Repositories MUST NOT make business decisions, read HTTP requests, send
  responses, handle authentication, or call external APIs.

## 2. Planned Entities

The following collections correspond to the approved business scope. Their
existence is established; their field-level schemas are NOT yet defined.

| Entity              | Notes |
| ------------------- | ----- |
| `User`              | **Implemented (Phase 03).** Application identity for customers, staff, and admins in ONE collection (see §4). |
| `Customer`          | E-commerce customer profile extension of `User` (Planned — future phase). |
| `Category`          | **Implemented (Phase 04).** Generic catalog taxonomy node (see §4.2). |
| `Product`           | **Implemented (Phase 05).** Catalog products, soft-deactivated, with measurement guides (see §4.3). |
| `ProductVariant`    | **Implemented (Phase 05).** Product variants; **inventory belongs to variants** (see §4.4). |
| `Inventory`         | **Implemented (Phase 06).** Stock levels per variant: online + offline + reserved (see §4.5). |
| `InventoryMovement` | **Implemented (Phase 06).** Immutable stock-mutation ledger (see §4.6). |
| `Reservation`       | **Implemented (Phase 06).** Held ONLINE stock; `ACTIVE → RELEASED \| CONSUMED \| EXPIRED` (see §4.7). |
| `Cart`              | **Implemented (Phase 07).** Server-side per-customer draft, one per customer; stores ONLY variant references + quantities — no prices/fees (see §4.8). |
| `Order`             | **Implemented (Phase 07).** Customer order with embedded `OrderItem` snapshot subdocuments, server-derived money fields, `Idempotency-Key` uniqueness, state machine (see §4.9). |
| `OrderItem`         | **Implemented (Phase 07).** IMMUTABLE embedded subdocument of `Order` snapshotting product/variant/price at checkout — NOT a separate collection. |
| `Payment`           | **Implemented (Phase 08).** Manual-payment record, one per order, with proof snapshot, idempotency, and state machine (see §4.10). |
| `PaymentMethod`     | **Implemented (Phase 08).** Manual-payment instructions, soft-deactivated, referenced by `Payment` snapshots (see §4.11). |
| `Return`            | **Implemented (Phase 10, ADR-0018).** SEPARATE return state machine decoupled from the order machine; item price snapshots; `{ orderId, idempotencyKey }` uniqueness; 1:1 refund link (see §4.12). |
| `Refund`            | **Implemented (Phase 10, ADR-0018).** Financial record for a COMPLETED return; server-derived amount; `PENDING → PROCESSED \| VOIDED` (see §4.13). |
| `Cancellation`      | Cancellations lifecycle (Planned — cancel is pre-confirmation only in Phase 07; admin/return cancels are atomic transitions, not separate documents). |
| `Expense`           | Business expenses. |
| `AuditLog`          | Audit trail for sensitive administrative actions. |
| `Notification`      | **Implemented (Phase 11, ADR-0019).** One audit record per best-effort customer-facing email; `QUEUED → SENT \| FAILED \| SKIPPED` (see §4.14). |
| `Setting`           | Application settings. |
| `CourierShipment`   | **Implemented (Phase 09, ADR-0017).** Courier consignment/shipment records (`src/modules/courier/courierShipment.model.js`). |

## 3. Conventions (decided)

- Inventory is stored per product variant.
- Order items snapshot their financial and product information at order time.
- Products are archived, not deleted, when history depends on them.
- Sensitive administrative actions are recorded in `AuditLog`.

## 3b. Model Conventions (decided)

- **Naming:** `camelCase` for JavaScript/Mongoose fields and references (e.g.
  `createdAt`, `updatedAt`, `productId`, `variantId`, `customerId`). No
  unnecessary abbreviations.
- **Timestamps:** future schemas should use `timestamps: true` unless a
  domain-specific reason says otherwise.
- **References:** Mongoose `ObjectId` for internal references unless a future
  domain has a specific reason for another identifier.
- **Indexes:** indexes belong to the model/domain that owns the query pattern
  and must be justified by expected access patterns. No speculative indexes.
  Business indexes are defined in the phase that implements each model.
- **Transactions:** MongoDB sessions/transactions are used for multi-collection
  operations that must commit atomically. Phase 05 added
  `withTransaction(work)` in `src/config/database.js` (throws clearly when
  Mongo is not connected) and uses it for product create + initial variants and
  PATCH variant replacement. Phase 06 (inventory) uses the same helper for
  every stock mutation — the inventory change, any reservation status
  transition, and the ledger movement append commit or roll back together.
  Phase 07 (checkout) uses it for the whole checkout: cart load, catalog
  validation, reservation creation, order + embedded item creation, and cart
  clear all commit or roll back together.
  Phase 08 (payment submission) uses it for the payment record create/resubmit,
  the reference-reuse conflict check, and the status-history append. The proof
  **upload happens OUTSIDE the transaction** (the media boundary), and on a DB
  failure the uploaded file is best-effort deleted.
  Repositories accept an optional `session` option and pass it to Mongoose.
  Future phases (e.g., payment capture) reuse it rather than adding new
  transaction utilities.
- **Atomic conditional updates:** Phase 06 stock mutations are
  `findOneAndUpdate` operations guarded by a condition (e.g. `$expr` on
  `onlineQuantity - reservedQuantity >= qty`), never read-check-update, so
  concurrent operations cannot oversell or lose updates (see §4.5).

## 4. Detailed Schemas

### 4.1 `User` (implemented — Phase 03, `src/modules/users/user.model.js`)

Single collection holding the application identity for customers, staff, and
admins (ADR-0011). There are NO separate `Customer`/`StaffUser`/`AdminUser`
collections; `CustomerProfile` is a documented future extension.

| Field            | Type      | Required | Notes |
| ---------------- | --------- | -------- | ----- |
| `authProviderId` | `String`  | Yes      | Frontend (Better Auth) user id. Unique; immutable; trimmed. This is the join key from the verified JWT subject. |
| `email`          | `String`  | No       | Trimmed + lower-cased on save. Unique (sparse) so absent emails do not collide. |
| `displayName`    | `String`  | No       | Human-readable name. |
| `phone`          | `String`  | No       | Optional contact phone. |
| `role`           | `String`  | Yes (default `CUSTOMER`) | Enum: `CUSTOMER` / `STAFF` / `ADMIN`. The AUTHORITATIVE role for authorization; never taken from the JWT. |
| `status`         | `String`  | Yes (default `ACTIVE`) | Enum: `ACTIVE` / `SUSPENDED` / `DISABLED`. Only `ACTIVE` accounts are admitted. |
| `createdAt` / `updatedAt` | `Date` | —      | Via `timestamps: true`. |

Indexes:

- `{ authProviderId: 1 }` — unique (lookup key for every authenticated request).
- `{ email: 1 }` — unique, sparse.

Security guarantees:

- The schema stores NO password, password hash, session, refresh token, or
  authentication secret of any kind (identity is separated from authentication
  — ADR-0010/ADR-0011).
- `authProviderId` is never serialized in API responses (`toSafeUser`).

### 4.2 `Category` (implemented — Phase 04, `src/modules/categories/category.model.js`)

Generic taxonomy node, deliberately decoupled from Product (ADR-0012). No
product/variant/stock fields exist here, and no Product model exists yet.
Categories are **deactivated** (`isActive: false`), never hard-deleted.

| Field            | Type      | Required | Notes |
| ---------------- | --------- | -------- | ----- |
| `name`           | `String`  | Yes      | Human-readable category name, trimmed, max 100 chars. Unique. |
| `slug`           | `String`  | Yes      | URL-safe identifier, trimmed, max 120 chars, normalized through the single `slugify` on set. Unique. |
| `description`    | `String`  | No       | Trimmed, max 1000 chars. Nullable. |
| `image`          | `String`  | No       | Plain http(s) URL string (max 500 chars). Nullable. No Cloudinary/multipart in this phase. |
| `isActive`       | `Boolean` | Yes (default `true`) | Deactivation over deletion. Public reads expose ACTIVE categories only. |
| `sortOrder`      | `Number`  | Yes (default `0`) | Integer 0–9999; drives the public catalog ordering (`sortOrder ASC, createdAt ASC`). |
| `createdAt` / `updatedAt` | `Date` | —      | Via `timestamps: true`. |

Indexes:

- `{ slug: 1 }` — unique. Final consistency layer for slug collisions.
- `{ name: 1 }` — unique. Prevents near-duplicate taxonomy.
- `{ isActive: 1, sortOrder: 1, createdAt: 1 }` — public catalog ordering.

API serialization (`toSafeCategory`): `id`, `name`, `slug`, `description`,
`image`, `isActive`, `sortOrder`, `createdAt`, `updatedAt`. `_id`, `__v`, and
Mongoose internals are never exposed.

### 4.3 `Product` (implemented — Phase 05, `src/modules/products/product.model.js`)

Catalog product. Soft-deactivated (`isActive: false`), never hard-deleted.
Contains **no** inventory, order, cart, or stock fields — inventory belongs to
the variant (a future phase references `productVariantId`). Money is stored as
**integer minor units (paisa)** — never floats. `purchasePrice` is ADMIN-only
in API responses.

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `name` | `String` | Yes | Trimmed, max 150 chars. |
| `slug` | `String` | Yes | URL-safe, unique, normalized through the single `slugify`; derived from `name` when omitted, `-2`-suffixed on collision. |
| `description` | `String` | Yes (default `''`) | Trimmed, max 5000 chars. |
| `categoryId` | `ObjectId` | Yes | References `Category`. Must reference an **ACTIVE** category on create/update. |
| `images` | `Array` | Yes (default `[]`) | Image subdocuments `{ url, altText }`; plain http(s) URLs — no Cloudinary/multipart this phase. Max 10. |
| `sellingPrice` | `Number` | Yes | Integer minor units (paisa). 1 – 100,000,000. |
| `purchasePrice` | `Number` | No | Integer minor units. Never serialized publicly; accepted on create, ADMIN-only in responses. |
| `discount` | `Subdoc` | No | `{ type: 'percentage'\|'fixed', value }`. Percentage 1–99; fixed cannot exceed selling price. Never stored as an effective price — effective price is computed centrally in the serializer. |
| `featured` / `newArrival` / `bestDeal` | `Boolean` | Yes (default `false`) | Catalog flags, public-list filterable. |
| `isActive` | `Boolean` | Yes (default `true`) | Soft deactivation. Public reads expose ACTIVE products only. |
| `measurementGuide` | `Subdoc` | No | `{ imageUrl }` — image-only guide (image uploaded through the media system). Legacy `{ unit, fields[], sizes[] }` structured data is tolerated on existing records. |
| `createdAt` / `updatedAt` | `Date` | — | Via `timestamps: true`. |

`measurementGuide` shape:

| Field | Type | Notes |
| ----- | ---- | ----- |
| `imageUrl` | `String` | Optional http(s) URL of the uploaded guide image (max 500 chars). |
| `unit` / `fields` / `sizes` | (legacy) | Structured measurement-table data from older records — never written for new products; tolerated when present. |

Indexes:

- `{ slug: 1 }` — unique. Final consistency layer for slug collisions.
- `{ isActive: 1, createdAt: 1 }` — newest-first public listing.
- `{ isActive: 1, categoryId: 1, createdAt: 1 }` — filtered listing by category.
- `{ isActive: 1, sellingPrice: 1 }` — price-sorted listing.

### 4.4 `ProductVariant` (implemented — Phase 05, `src/modules/products/variants/productVariant.model.js`)

Variant of a product. **No stock fields** — inventory is a future phase that
references `productVariantId`. Variants are soft-deactivated (never deleted).
SKU is globally unique and **immutable after creation**.

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `productId` | `ObjectId` | Yes | References `Product`. |
| `sku` | `String` | Yes | Trimmed + uppercased. Globally unique. **Immutable after creation** — a PATCH changing SKU is rejected (`INVALID_PRODUCT`, "SKU cannot be changed after creation"). |
| `attributes` | `Object` | Yes (default `{}`) | Dynamic attributes, e.g. `{ size: '52' }`. Attribute keys allowlisted; sorted-key JSON `attributeKey` enforces uniqueness. |
| `attributeKey` | `String` | Yes | Canonical sorted-key JSON of `attributes`; unique per product. |
| `sellingPriceOverride` | `Number` | No | Integer minor units, overrides `Product.sellingPrice` for this variant. |
| `purchasePriceOverride` | `Number` | No | Integer minor units. ADMIN-only in responses. |
| `isActive` | `Boolean` | Yes (default `true`) | Soft deactivation; dropped variants in a PATCH replacement are deactivated, never deleted. |
| `createdAt` / `updatedAt` | `Date` | — | Via `timestamps: true`. |

Indexes:

- `{ sku: 1 }` — unique. Final consistency layer for SKU collisions.
- `{ productId: 1, attributeKey: 1 }` — unique. Final layer preventing duplicate attribute sets per product.
- `{ productId: 1, isActive: 1 }` — per-product variant listing.

`attributeKey` example: attributes `{ size: '52', color: 'Black' }` →
`{"color":"Black","size":"52"}` (keys sorted). The service pre-checks SKU and
duplicate-attribute collisions inside the transaction; the unique indexes are
the DB-level final layer, and duplicate-key errors are mapped to
`VARIANT_SKU_ALREADY_EXISTS` / `VARIANT_DUPLICATE_ATTRIBUTES`.

### 4.5 `Inventory` (implemented — Phase 06, `src/modules/inventory/inventory.model.js`)

Stock levels for ONE product variant. References `ProductVariant._id` and
**never duplicates catalog data** (name/slug/size/color/SKU live in the
catalog). One inventory record per variant (`productVariantId` unique).

| Field              | Type      | Required | Notes |
| ------------------ | --------- | -------- | ----- |
| `productVariantId` | `ObjectId`| Yes      | References `ProductVariant`. Unique — one inventory per variant. |
| `onlineQuantity`   | `Number`  | Yes (default `0`) | Non-negative integer, max 1,000,000,000. Storefront-visible stock. |
| `offlineQuantity`  | `Number`  | Yes (default `0`) | Non-negative integer. Warehouse/other stock, not sold directly online. |
| `reservedQuantity` | `Number`  | Yes (default `0`) | Non-negative integer. Held ONLINE stock; invariant `reservedQuantity <= onlineQuantity`. |
| `lowStockThreshold`| `Number`  | Yes (default `0`) | Non-negative integer. Low-stock flag boundary. |
| `createdAt` / `updatedAt` | `Date` | —      | Via `timestamps: true`. |

Derived quantities (computed centrally in `inventory.serializer.js`, **never
stored**):

```
availableOnlineQuantity = onlineQuantity - reservedQuantity
totalPhysicalQuantity   = onlineQuantity + offlineQuantity
isLowStock              = availableOnlineQuantity <= lowStockThreshold
isOutOfStock            = availableOnlineQuantity <= 0
```

Invariants (enforced by the service/atomic guards, never by clamping): all
quantities are non-negative integers; `reservedQuantity <= onlineQuantity`;
zero is valid (out-of-stock). Violating decreases fail with domain codes
(`INSUFFICIENT_STOCK` for OFFLINE shortfall, `INSUFFICIENT_AVAILABLE_STOCK`
for ONLINE shortfall, `NEGATIVE_STOCK_FORBIDDEN` for a negative OFFLINE
adjustment).

Indexes:

- `{ productVariantId: 1 }` — unique. Database-level guard for initialize
  races (mapped to `INVENTORY_ALREADY_EXISTS`).
- `{ onlineQuantity: 1, lowStockThreshold: 1 }` — cheap candidate lookup for
  the low-stock sweep (the `available <= threshold` predicate is expressed
  with an `$expr` filter).

### 4.6 `InventoryMovement` (implemented — Phase 06, `src/modules/inventory/inventoryMovement.model.js`)

IMMUTABLE audit record of one inventory mutation. Every operation that changes
an Inventory record appends a movement in the SAME MongoDB transaction.
Movements are **never updated or deleted** — a correction is a NEW movement.
`quantity` is always a POSITIVE integer magnitude; direction is carried by
`fromLocation` (stock decreases) and `toLocation` (stock increases).

| Field              | Type      | Required | Notes |
| ------------------ | --------- | -------- | ----- |
| `inventoryId`      | `ObjectId`| Yes      | References `Inventory`. |
| `productVariantId` | `ObjectId`| Yes      | References `ProductVariant`. |
| `type`             | `String`  | Yes      | Enum: `INITIAL_STOCK` / `STOCK_IN` / `STOCK_OUT` / `TRANSFER` / `ADJUSTMENT` / `RESERVATION` / `RESERVATION_RELEASE` / `RESERVATION_CONSUME`. |
| `quantity`         | `Number`  | Yes      | Positive integer magnitude (1 – 1,000,000,000). |
| `fromLocation`     | `String`  | No       | `ONLINE` / `OFFLINE` when the movement decreases a location, else `null`. |
| `toLocation`       | `String`  | No       | `ONLINE` / `OFFLINE` when the movement increases a location, else `null`. |
| `reason`           | `String`  | No       | Trimmed, max 500 chars. Free-text audit note. |
| `referenceType` / `referenceId` | `String` | No | Generic link to the business object (e.g. a reservation/order reference). |
| `performedBy`      | `ObjectId`| Yes      | References `User`. ALWAYS the resolved `req.user.id` — never a body field. |
| `metadata`         | `Mixed`   | No (default `{}`) | Free-form extra context. |
| `createdAt` / `updatedAt` | `Date` | —      | Via `timestamps: true`. |

Indexes:

- `{ productVariantId: 1, createdAt: -1 }` — per-variant ledger reads.
- `{ inventoryId: 1, createdAt: -1 }` — per-inventory ledger reads.
- `{ type: 1, createdAt: -1 }` — type-based queries.

### 4.7 `Reservation` (implemented — Phase 06, `src/modules/inventory/reservation.model.js`)

A held portion of a variant's ONLINE stock. State machine:
`ACTIVE → RELEASED | CONSUMED | EXPIRED` (terminal). `RELEASED` returns the
reserved quantity to availability; `CONSUMED` moves it physically out of
ONLINE; `EXPIRED` releases it after `expiresAt` passes.

| Field              | Type      | Required | Notes |
| ------------------ | --------- | -------- | ----- |
| `productVariantId` | `ObjectId`| Yes      | References `ProductVariant`. |
| `quantity`         | `Number`  | Yes      | Positive integer (1 – 1,000,000,000). |
| `status`           | `String`  | Yes (default `ACTIVE`) | Enum: `ACTIVE` / `RELEASED` / `CONSUMED` / `EXPIRED`. |
| `expiresAt`        | `Date`    | No       | Optional; when set, an ACTIVE reservation past it is expired on touch. |
| `referenceType` / `referenceId` | `String` | Yes | GENERIC link to the holding business object — Orders arrive in a later phase, so no order identifiers are invented. |
| `metadata`         | `Mixed`   | No (default `{}`) | Free-form context. |
| `createdBy`        | `ObjectId`| Yes      | References `User`. Actor who created the reservation. |
| `resolvedAt`       | `Date`    | No       | Set when the reservation leaves ACTIVE. |
| `resolvedBy`       | `ObjectId`| No       | References `User`. Actor who resolved it. |
| `createdAt` / `updatedAt` | `Date` | —      | Via `timestamps: true`. |

Indexes:

- `{ productVariantId: 1, status: 1 }` — per-variant lookups.
- `{ referenceType: 1, referenceId: 1, status: 1 }` — active-reference conflict
  check (`RESERVATION_CONFLICT`).
- `{ status: 1, expiresAt: 1 }` — expiry sweep support (future background job;
  this phase has no worker infrastructure).

### 4.8 `Cart` (implemented — Phase 07, `src/modules/cart/cart.model.js`)

Server-side draft cart, **one per customer** (`customerId` unique). A cart is a
**reference + quantity list only** — it NEVER stores prices, discounts,
effective prices, or fees. All money is derived server-side at checkout from
the live catalog. `isCheckedOut` is a soft-close flag so a cleared cart does
not need to be hard-deleted (a checked-out cart can be reused by clearing it).

| Field              | Type      | Required | Notes |
| ------------------ | --------- | -------- | ----- |
| `customerId`       | `ObjectId`| Yes      | References `User`. Unique — one cart per customer. |
| `items`            | `Array`   | Yes (default `[]`) | Embedded subdocuments, max `CART_ITEM_LIMIT` (100). |
| `isCheckedOut`     | `Boolean` | Yes (default `false`) | Set `true` on successful checkout; the transaction clears `items` in the same commit. |
| `createdAt` / `updatedAt` | `Date` | —      | Via `timestamps: true`. |

`items[]` embedded subdocument shape:

| Field              | Type      | Required | Notes |
| ------------------ | --------- | -------- | ----- |
| `productVariantId` | `ObjectId`| Yes      | References `ProductVariant`. |
| `productId`        | `ObjectId`| Yes      | References `Product`. Denormalized for reads; kept in sync by the cart service. |
| `quantity`         | `Number`  | Yes      | Positive integer 1 – `INVENTORY_LIMITS.MAX_QUANTITY` (1,000,000,000). |
| `_id`              | `ObjectId`| —        | Subdocument id; used as the cart-item id in PATCH/DELETE routes. |

Indexes:

- `{ customerId: 1 }` — **unique**. One cart per customer; the DB-level guard
  for concurrent first-add races (mapped to `CART_NOT_FOUND` on create, then
  the service returns the existing cart).

### 4.9 `Order` (implemented — Phase 07, `src/modules/orders/order.model.js`)

Customer order created by checkout. **All money is integer minor units
(paisa)** and is **server-derived** — client-supplied totals, discounts, and
delivery fees are ignored. `orderNumber` (`TAQ-YYYYMMDD-XXXXXX`) is unique and
generated server-side with bounded retry. `statusHistory` records every
transition with the actor. Order items are IMMUTABLE embedded snapshots
(subdocuments, NOT a separate collection) so historical orders are stable even
if the catalog or inventory changes.

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `customerId` | `ObjectId` | Yes | References `User`. Order owner. |
| `orderNumber` | `String` | Yes | Unique, `TAQ-YYYYMMDD-XXXXXX`. Generated server-side; `ORDER_NUMBER_GENERATION_FAILED` after bounded retry. |
| `idempotencyKey` | `String` | Yes | Client `Idempotency-Key` header value, stored on the order. |
| `status` | `String` | Yes (default `PENDING`) | Enum: `PENDING` / `CONFIRMED` / `PROCESSING` (reachable) + `CANCELLED` / `REJECTED` (terminal). `SHIPPED` / `DELIVERED` / `RETURN_REQUESTED` / `RETURNED` reserved for future phases — unreachable (see `docs/order-state-machine.md`). |
| `statusHistory` | `Array` | Yes (default `[]`) | Embedded `{ status, at, by, note }` records; every transition appends. |
| `delivery` | `Subdoc` | Yes | `{ address: { fullName, phone, line1, line2, city, area, district, postalCode, country }, zone, deliveryFeeMinorUnits }`. `zone` (`INSIDE_CHITTAGONG` / `OUTSIDE_CHITTAGONG`) is the customer-selected delivery-charge zone, validated against the enum and defaulted to the address-derived zone (`classifyDeliveryZone`) when omitted; `deliveryFeeMinorUnits` is the zone's server-side constant — `INSIDE_CHITTAGONG` = `8000`, `OUTSIDE_CHITTAGONG` = `15000` (paisa). |
| `totals` | `Subdoc` | Yes | `{ itemsSubtotalMinorUnits, totalDiscountMinorUnits, deliveryFeeMinorUnits, grandTotalMinorUnits }`. Server-computed at checkout. |
| `items` | `Array` | Yes | IMMUTABLE embedded `OrderItem` snapshot subdocuments (see below). |
| `reservationReference` | `Subdoc` | No | `{ reservationIds: [ObjectId], referenceType: 'ORDER' }` — links to the Phase 06 `Reservation` records created in the checkout transaction. |
| `paymentMethod` | `String` | Yes (default `COD`) | `COD` / `MANUAL` in Phase 08 (ADR-0016). `MANUAL` marks the order eligible for manual-payment submission. |
| `notes` | `String` | No | Customer note, trimmed, max 1000 chars. |
| `createdAt` / `updatedAt` | `Date` | — | Via `timestamps: true`. |

Embedded `OrderItem` snapshot (created once at checkout, never updated after):

| Field | Type | Notes |
| ----- | ---- | ----- |
| `productId` / `productVariantId` | `ObjectId` | References into the catalog for future traceability. |
| `productName` / `variantAttributes` | `String` / `Object` | Name + attributes frozen at checkout. |
| `sku` | `String` | Frozen at checkout. |
| `quantity` | `Number` | Positive integer. |
| `unitPriceMinorUnits` | `Number` | Effective unit price AFTER discount at checkout (`computeEffectiveSellingPrice`). |
| `discountMinorUnits` | `Number` | Per-unit discount amount applied at checkout. |
| `lineTotalMinorUnits` | `Number` | `unitPriceMinorUnits * quantity`. |

Indexes:

- `{ customerId: 1, idempotencyKey: 1 }` — **unique**. The DB-level idempotency
  guard; a retried checkout returns the original order, a conflicting body
  under the same key → `ORDER_IDEMPOTENCY_CONFLICT`.
- `{ orderNumber: 1 }` — **unique**. Final layer for order-number generation
  races.
- `{ customerId: 1, createdAt: -1 }` — customer order-history listing.
- `{ status: 1, createdAt: -1 }` — staff/admin order-listing filters.

### 4.10 `Payment` (implemented — Phase 08, `src/modules/payments/payment.model.js`)

Manual-payment record, **one per order** (`orderId` unique). The state machine
is `UNPAID → SUBMITTED → VERIFIED | REJECTED`, `REJECTED → SUBMITTED`;
`VERIFIED` is terminal (see `docs/payment-state-machine.md`). `UNPAID` is
conceptual — the record is created lazily at `SUBMITTED`. **Money is integer
minor units (paisa)** and the expected amount is ALWAYS derived server-side from
`order.totals.grandTotalMinorUnits`; the client amount is compared, never
trusted. `statusHistory` records every transition with the actor. The proof and
the payment-method details are **embedded snapshots** — later edits to the
method or order never rewrite historical payments.

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `orderId` | `ObjectId` | Yes | References `Order`. **Unique** — one payment per order (DB-level guard for the first-submission race). |
| `customerId` | `ObjectId` | Yes | References `User`. Order owner; every customer query filters on it (cross-customer reads → 404). |
| `paymentMethodId` | `ObjectId` | Yes | References `PaymentMethod` captured at submission. |
| `paymentMethodSnapshot` | `Subdoc` | Yes | `{ code, displayName, accountNumber }` frozen at submission. |
| `transactionReference` | `String` | Yes | Customer's bank/transfer reference, trimmed, max 100. Must not be reused by another ACTIVE payment under the same method. |
| `submittedAmountMinorUnits` | `Number` | Yes | Integer minor units the customer declared. |
| `expectedAmountMinorUnits` | `Number` | Yes | Server-derived `order.totals.grandTotalMinorUnits` at submission time; submission requires an exact match. |
| `proof` | `Subdoc` | Yes | SAFE media reference: `{ provider, publicId, secureUrl, resourceType, format }`. Credentials/raw bytes never stored. |
| `status` | `String` | Yes | Enum: `SUBMITTED` / `VERIFIED` / `REJECTED` (persisted) + `UNPAID` (documented, never stored). |
| `statusHistory` | `Array` | Yes (default `[]`) | Embedded `{ status, at, by, note }`; every transition appends. |
| `idempotencyKey` | `String` | Yes | Client `Idempotency-Key` header value. |
| `idempotencyFingerprint` | `String` | Yes | SHA-256 of the normalized submission body; retries compare key + fingerprint. |
| `notes` | `String` | No | Customer note, trimmed, max 1000. |
| `verifiedBy` / `verifiedAt` | `ObjectId` / `Date` | No | Set on verify; unset on resubmission. |
| `rejectedBy` / `rejectedAt` | `ObjectId` / `Date` | No | Set on reject; unset on resubmission. |
| `createdAt` / `updatedAt` | `Date` | — | Via `timestamps: true`. |

Indexes:

- `{ orderId: 1 }` — **unique**. One payment per order; final guard for
  concurrent first submissions (duplicate-key error → the service re-reads the
  winner and applies the idempotency rules).
- `{ customerId: 1, createdAt: -1 }` — customer payment reads.
- `{ status: 1, createdAt: -1 }` — staff/admin payment-listing filters.
- `{ paymentMethodId: 1, transactionReference: 1 }` — the reference-reuse guard
  (a different non-REJECTED payment claiming the same method + reference →
  `PAYMENT_IDEMPOTENCY_CONFLICT`).

### 4.11 `PaymentMethod` (implemented — Phase 08, `src/modules/payments/paymentMethod.model.js`)

Payment-method instructions for manual transfers (bank-style metadata). `code`
is the unique, immutable identity (`[A-Z0-9_]{1,50}`, normalized uppercase).
Deactivation is ALWAYS soft (`isActive: false`) — methods are never hard
deleted because `Payment` documents snapshot them at submission time. Customers
only read ACTIVE methods; the metadata is intentionally public transfer
instructions.

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `code` | `String` | Yes | Unique, `[A-Z0-9_]{1,50}`, uppercase. **Immutable after creation.** |
| `displayName` | `String` | Yes | Trimmed, max 100. |
| `type` | `String` | Yes (default `MANUAL`) | `MANUAL` in Phase 08; wallet types reserved for future phases. |
| `metadata` | `Subdoc` | Yes (default `{}`) | Allowlisted fields: `accountName`, `accountNumber`, `bankName`, `branch`, `district`, `accountType`, `routingNumber`, `instructions` (each ≤ 200 chars). |
| `isActive` | `Boolean` | Yes (default `true`) | Soft deactivation. |
| `sortOrder` | `Number` | Yes (default `0`) | Integer 0 – 100,000; drives customer listing (`sortOrder ASC`). |
| `createdAt` / `updatedAt` | `Date` | — | Via `timestamps: true`. |

Indexes:

- `{ code: 1 }` — **unique**. Final layer for create races (mapped to
  `PAYMENT_METHOD_CODE_ALREADY_EXISTS`).
- `{ isActive: 1, sortOrder: 1 }` — customer listing of ACTIVE methods.

### 4.12 `Return` (implemented — Phase 10, `src/modules/returns/return.model.js`)

A customer return request. It is a **SEPARATE state machine** decoupled from the
order machine (ADR-0018): the return service never mutates the Order document,
and the order-level `RETURN_*` states stay reserved. `PENDING → APPROVED |
REJECTED | CANCELLED`, `APPROVED → COMPLETED | CANCELLED`; side effects
(restock + refund) happen ONLY at `COMPLETED`.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `customerId` | ObjectId ref `User` | required; always in the customer-scoped query |
| `orderId` | ObjectId ref `Order` | required |
| `returnNumber` | String | unique, `RET-YYYYMMDD-XXXXXX` |
| `idempotencyKey` | String | required; replay-safe submission |
| `idempotencyFingerprint` | String | required; same key + different body → `RETURN_IDEMPOTENCY_CONFLICT` |
| `status` | String | enum `PENDING`/`APPROVED`/`REJECTED`/`COMPLETED`/`CANCELLED`, default `PENDING` |
| `statusHistory` | `[{ status, at, by, note }]` | required; every transition recorded with the actor |
| `items` | `[ReturnItem]` | embedded IMMUTABLE price snapshots (`orderItemId`, `productId`, `productVariantId`, `productName`, `sku`, `quantity` ≥ 1, `unitPriceMinorUnits` ≥ 0 integer, `discountMinorUnits` ≥ 0 integer) |
| `reason` | String | required, ≤ 500 |
| `notes` | String | ≤ 1000, default null |
| `refundId` | ObjectId ref `Refund` | default null; set on COMPLETION, never on approval |
| `approvedBy` / `approvedAt` | ObjectId / Date | set on approve |
| `rejectedBy` / `rejectedAt` | ObjectId / Date | set on reject |
| `cancelledBy` / `cancelledAt` | ObjectId / Date | set on cancel |
| `completedBy` / `completedAt` | ObjectId / Date | set on complete |
| `createdAt` / `updatedAt` | Date | timestamps |

Indexes:

- `{ orderId: 1, idempotencyKey: 1 }` — **unique**. Submission replay-safety
  per order; different keys allow multiple DISTINCT returns per order.
- `{ returnNumber: 1 }` — **unique**. Number-generation race guard (bounded
  retry on duplicate).
- `{ customerId: 1, createdAt: -1 }` — customer return history.
- `{ orderId: 1, createdAt: -1 }`, `{ orderId: 1, status: 1 }` — order history +
  the availability "claimed" query.
- `{ status: 1, createdAt: -1 }` — staff/admin listing filters.

### 4.13 `Refund` (implemented — Phase 10, `src/modules/refunds/refund.model.js`)

The financial record for an accepted, COMPLETED return. Auto-created at
`PENDING` inside the return's `APPROVED → COMPLETED` transaction with a
server-derived amount (Σ (unitPrice − discount) × quantity from the return's
embedded snapshots). **Never mutates** the original Payment or Order documents.
`PENDING → PROCESSED | VOIDED`, both terminal.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `refundNumber` | String | unique, `RFD-YYYYMMDD-XXXXXX` |
| `return` | ObjectId ref `Return` | required, **unique** (1:1) |
| `order` | ObjectId ref `Order` | required |
| `customer` | ObjectId ref `User` | required |
| `paymentId` | ObjectId ref `Payment` | verified Payment for `MANUAL` orders; `null` for `COD` |
| `paymentMethod` | String | enum `MANUAL`/`COD`, required |
| `amount` | Number | required, `min 0` + integer validator (minor units / paisa) |
| `status` | String | enum `PENDING`/`PROCESSED`/`VOIDED`, default `PENDING` |
| `processedBy` / `processedAt` | ObjectId / Date | set on process |
| `voidedBy` / `voidedAt` | ObjectId / Date | set on void |
| `note` | String | ≤ 500, default `''` |
| `statusHistory` | `[{ status, at, by, note }]` | every transition recorded |
| `deleted` | Boolean | soft-delete guard (`select: false`) |
| `createdAt` / `updatedAt` | Date | timestamps |

Indexes:

- `{ refundNumber: 1 }` — **unique**. Number-generation race guard.
- `{ return: 1 }` — **unique** (inline `unique: true` on the field). 1:1 refund
  per return.
- `{ status: 1, createdAt: -1 }` — status-filtered listing.
- `{ order: 1, createdAt: -1 }` — supports the `orderId` list filter (query
  field is the persisted `order`, NOT `orderId`).
- `{ customer: 1, createdAt: -1 }` — supports the `customerId` list filter
  (query field is the persisted `customer`, NOT `customerId`).

### 4.14 `Notification` (implemented — Phase 11, `src/modules/notifications/notification.model.js`)

One audit record per best-effort customer-facing message (today: transactional
email). Created by business services at a real domain event and updated in place
as the email provider accepts or rejects it. Delivery is **best-effort**:
`status` starts `QUEUED` (the retry safety net — persisted BEFORE the send
attempt), then `SENT` / `FAILED` / `SKIPPED`. `payload` is a sanitized snapshot
of the event data (never secrets — the callers build safe subsets) so a
notification is re-renderable/auditable later. The triggering entity is
referenced by the string `entityRef` (e.g. an order/payment id) — there is NO
ObjectId relation to the Order/Payment/Return/Refund collections.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `recipient` | ObjectId ref `User` | required — the notification recipient |
| `channel` | String | required, enum `EMAIL`, default `EMAIL` |
| `eventType` | String | required, enum `NOTIFICATION_EVENT_TYPES` (17 values) |
| `templateKey` | String | required, trim — template registry key |
| `entityRef` | String | default `null`, trim, ≤ 128 — stable per-event identifier (e.g. order/payment id); used for within-window dedupe + audits |
| `payload` | Mixed | default `{}` — sanitized event snapshot (safe subsets only, no secrets) |
| `status` | String | required, enum `QUEUED`/`SENT`/`FAILED`/`SKIPPED`, default `QUEUED` |
| `attempts` | Number | required, default `0`, `min 0` — send attempts |
| `lastAttemptAt` | Date | default `null` |
| `lastError` | `{ code, message }` subdoc | default `null`; `_id: false`; `code` String default `null` trim; `message` String default `null` trim ≤ 500 |
| `provider` | String | default `null`, trim — provider label (`smtp`/`mock`) |
| `providerRef` | String | default `null`, trim — provider message-id for troubleshooting |
| `deliveredAt` | Date | default `null` |
| `createdAt` / `updatedAt` | Date | timestamps |

Indexes:

- `{ recipient: 1, createdAt: -1 }` — customer notification history (future
  customer-facing inbox).
- `{ status: 1, lastAttemptAt: 1 }` — retry scans for a future retry worker
  (failed/queued notifications oldest first).
- `{ recipient: 1, eventType: 1, entityRef: 1, createdAt: -1 }` — within-window
  deduplication for identical `{ recipient, eventType, entityRef }`.

### 4.15 Other entities

**Planned — to be finalized per module in their implementing phases.**

Field definitions, types, indexes, validation, and relationships between
collections are intentionally NOT specified yet. Do not fabricate them.

## 5. Model Ownership

Models live inside their feature module (`src/modules/<module>/`) and are
accessed through that module's repository. No cross-module direct model use
without going through the owning module's repository/service. Phase 07 follows
this: `Cart` lives in `src/modules/cart/`, `Order` in `src/modules/orders/`,
and the order service composes catalog (products module) + reservation
(inventory module) reads through their repositories/services, never directly
through their models. Phase 08 follows it too: `Payment` and `PaymentMethod`
live in `src/modules/payments/`, and `PaymentService` reads orders through the
orders module repository (never the Order model directly).

Note: Phase 07 deliberately does **not** snapshot `purchasePrice` into order
items (see ADR-0015) — selling-side snapshots only, to keep purchase-cost data
out of customer-adjacent documents until the expenses/costing phase defines how
it must be protected.
