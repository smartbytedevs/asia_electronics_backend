# ADR-0014: Inventory, Stock Ledger & Reservation Foundation

## Status

Accepted

## Date

2026-08-08

## Context

Phase 06 introduces the **inventory domain** on top of the Phase 05 catalog.
Stock belongs to `ProductVariant`, which is the smallest sellable unit; the
business already decided (Phase 00 business rules §2/§4) that inventory belongs
to variants and that reserved stock is separate from freely available online
stock. Several architectural questions had to be answered so later phases
(orders, payments, returns) can rely on the foundation without rewriting it:

- **What an inventory record holds.** A variant has online stock (storefront,
  resellable) and offline stock (warehouse, not sold online), plus held
  (reserved) stock. Which of these are stored vs. computed, and what invariants
  hold?
- **Auditability.** Stock corrections happen after the fact; the business must
  know who did what, when. A stock count alone cannot answer that.
- **Concurrency safety.** Two admins (or two order reservations later) can act
  on the same variant at once. Read-check-update loses updates and can
  oversell.
- **Reservations vs. orders.** The orders phase will hold items while an order
  is in progress, but **Orders do not exist yet**. Reservations must be created
  now in a way that a future Order can reference, without inventing order
  identifiers.
- **Multi-collection atomicity.** Every stock mutation changes an Inventory
  record AND appends a ledger movement. A crash between the two corrupts the
  audit trail.
- **Who may touch stock.** Stock control is a sensitive administrative
  capability; it must not be available to storefront customers or general
  staff.
- **Mutation surface.** A generic PATCH/DELETE on stock invites
  mass-assignment and unrecorded changes. Corrections must be explicit business
  commands.

## Decision

Introduce an **Inventory module** (`src/modules/inventory/`) layered on the
Phase 05 catalog: an `Inventory` record per variant, an **immutable
`InventoryMovement` ledger**, and a `Reservation` lifecycle. No orders,
payments, carts, or worker infrastructure in this phase. No new dependencies.

### Ownership & data boundaries

- **Inventory belongs to product variants.** One `Inventory` record per
  variant (`productVariantId` unique). The record references
  `ProductVariant._id` and **NEVER duplicates catalog data** — name, slug,
  size, color, and SKU live in the catalog. Initializing or reserving for an
  **inactive** variant is rejected; existing inventory stays historically
  readable.

### Stored vs. derived fields

- **Stored:** `onlineQuantity`, `offlineQuantity`, `reservedQuantity`,
  `lowStockThreshold`. All are non-negative integers, `max 1,000,000,000`.
  Zero is valid (out-of-stock) — operations **never clamp**; a violation fails
  the operation.
- **Derived (never stored, computed centrally in the serializer):**
  `availableOnlineQuantity = onlineQuantity - reservedQuantity` and
  `totalPhysicalQuantity = onlineQuantity + offlineQuantity`, plus the
  boolean flags `isLowStock` (`available <= threshold`) and `isOutOfStock`
  (`available <= 0`).
- **Invariants:** all quantities non-negative integers;
  `reservedQuantity <= onlineQuantity`. Offline shortfall on a decrease →
  `INSUFFICIENT_STOCK`; an online shortfall (respecting reserved stock) →
  `INSUFFICIENT_AVAILABLE_STOCK`; a negative OFFLINE adjustment →
  `NEGATIVE_STOCK_FORBIDDEN`.

### Immutable movement ledger

- Every operation that changes an Inventory record appends an
  `InventoryMovement` in the **same transaction**. Movements are **never
  updated or deleted** — a correction is a **new** movement (e.g. `STOCK_IN`
  or `ADJUSTMENT`).
- Movement `quantity` is **always a positive integer magnitude**. Direction is
  carried by `fromLocation` (stock decreases) and `toLocation` (stock
  increases). Types: `INITIAL_STOCK | STOCK_IN | STOCK_OUT | TRANSFER |
  ADJUSTMENT | RESERVATION | RESERVATION_RELEASE | RESERVATION_CONSUME`.
- `performedBy` (the acting `User._id`) is **always** the resolved
  `req.user.id` passed by the controller — never a request body field.
- No generic inventory PATCH and no movement/inventory/reservation DELETE —
  mutations are explicit business commands (`initialize`, `stock-in`,
  `stock-out`, `transfer`, `adjust`, reservation `create`/`release`/`consume`/
  `expire`).

### Reservation lifecycle

- Status machine: **`ACTIVE` → `RELEASED` | `CONSUMED` | `EXPIRED`** (terminal).
  `RELEASED` returns the reserved quantity to availability; `CONSUMED` moves it
  physically out of ONLINE; `EXPIRED` releases it after `expiresAt` passes.
- Reservations use **generic `referenceType`/`referenceId`** to link to the
  business object holding them — Orders arrive in a later phase and will pass
  their own stable reference. No order identifiers are invented now. An active
  reservation for the **same reference** → `409 RESERVATION_CONFLICT`.
- `expiresAt` is optional; an ACTIVE reservation past `expiresAt` is expired
  automatically when touched. `expireReservation()` is an **explicit service
  operation** — there is no worker/background infrastructure in this phase.
- **Idempotent resolution.** Release of `RELEASED` and consume of `CONSUMED`
  are retry-safe no-ops (`{ reservation, inventory: null }`); expire of any
  terminal is a no-op. Release/consume of the **other** terminal state →
  `409 RESERVATION_NOT_ACTIVE`; release/consume/expire of an expired-while-
  ACTIVE reservation auto-expires, then → `409 RESERVATION_EXPIRED`.

### Atomicity & concurrency

- Every inventory mutation runs in **ONE MongoDB transaction**
  (`withTransaction` from `src/config/database.js`; the session is threaded
  through every repository call via an `options` argument). Inventory change,
  status transition, and ledger append commit or roll back together.
- Repository mutations are **atomic conditional updates**
  (`findOneAndUpdate` with a guard condition) — never read-check-update. For
  example, an ONLINE decrease/reserve uses an `$expr` guard on
  `onlineQuantity - reservedQuantity >= quantity`; an OFFLINE decrease guards
  `offlineQuantity >= quantity`. A lost race returns `null` → mapped to the
  domain error above. This makes concurrent stock operations safe.
- Repository location handling maps the `ONLINE`/`OFFLINE` constants to the
  real field names (`onlineQuantity`/`offlineQuantity`) via a shared
  `locationField()` helper — a location string can never name an arbitrary
  `$inc` field (defense-in-depth against operator injection).

### Reservation conflict point

- Release/consume/expire use an **atomic status transition**
  (`transitionStatus(id, 'ACTIVE', <terminal>, { resolvedAt, resolvedBy })`)
  as the single conflict point. A caller that loses the transition
  **re-classifies idempotently** instead of double-mutating stock.

### Access control

- **ALL inventory endpoints are ADMIN-only**:
  `authenticate → resolveCurrentUser → authorizeRoles(ROLES.ADMIN)`.
  STAFF and CUSTOMER → 403; JWT/body/query/header role spoofing never
  elevates (the stored application role is authoritative, per ADR-0011).

## Consequences

### Positive

- The ledger is a complete, immutable audit trail: every quantity change is
  attributable and reconstructible.
- Atomic conditional updates make overselling impossible at the database level
  — critical for the future order-reservation flow.
- Stored/derived separation means flags like `isLowStock` and `isOutOfStock`
  can never drift from the underlying quantities.
- The generic reservation reference lets a future Order phase adopt
  reservations without schema changes or invented IDs.
- No new dependencies; reuses the existing transaction helper, error envelope,
  and RBAC chain.

### Negative / costs

- Every mutation requires a transaction + ledger write, adding write volume
  (bounded to the inventory service).
- Real snapshot-race concurrency cannot be tested without a live MongoDB in
  this environment; concurrency tests exercise conditional-update logic
  through repository stubs that apply the same guards (documented limitation,
  see `docs/inventory-state-machine.md`).
- Auto-expiry of stale reservations requires an explicit operation or a future
  worker; nothing expires them silently in the background yet.

### Not decided here

- Orders/payments/cart — they will consume reservations (via
  `referenceType`/`referenceId`) and the `RESERVATION_CONSUME` flow, but their
  own lifecycle is a later phase.
- Courier, Cloudinary, email, staff/admin management, and ownership checks
  remain future work.
- Exact Better Auth JWKS values remain pending frontend confirmation.
