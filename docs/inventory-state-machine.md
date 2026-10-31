# Taqwa Backend — Inventory State Machine

Status: **Stock model decided (Phase 00); inventory & reservation state machine finalized (Phase 06, ADR-0014); Order boundary implemented (Phase 07, ADR-0015); return restock implemented (Phase 10, ADR-0018)**

## 1. Decided Model

- Inventory belongs to **product variants**, not products (one `Inventory`
  record per `ProductVariant._id`; unique).
- Inventory mutations MUST go through the **inventory domain/service**.
- Reserved stock is separate from physically available stock:

```
availableOnlineQuantity = onlineQuantity - reservedQuantity
totalPhysicalQuantity   = onlineQuantity + offlineQuantity
```

- `isLowStock = availableOnlineQuantity <= lowStockThreshold`;
  `isOutOfStock = availableOnlineQuantity <= 0`. These four derived values are
  **never stored** — the serializer computes them centrally.

## 2. Inventory Record

Per-variant stock (Phase 06, `src/modules/inventory/`).

Stored fields (all non-negative integers, max `1,000,000,000`):

| Field | Meaning |
| ----- | ------- |
| `onlineQuantity` | Storefront-visible stock. |
| `offlineQuantity` | Warehouse/other stock, not sold directly online. |
| `reservedQuantity` | Held ONLINE stock (see the reservation machine). |
| `lowStockThreshold` | Low-stock flag boundary. |

Invariants (enforced, **never clamped**): all quantities are non-negative
integers; `reservedQuantity <= onlineQuantity`; zero is valid (out-of-stock).
A violating operation FAILS with a domain error, e.g.:

- OFFLINE shortfall on a decrease → `INSUFFICIENT_STOCK` (409).
- ONLINE shortfall respecting reserved stock → `INSUFFICIENT_AVAILABLE_STOCK`
  (409).
- Negative OFFLINE adjustment → `NEGATIVE_STOCK_FORBIDDEN` (409).

## 3. Stock Mutation Machine (per variant)

All stock mutations are **explicit business commands** executed in **ONE
MongoDB transaction**; each appends an **immutable `InventoryMovement`** in the
same commit. No generic inventory PATCH/DELETE — corrections are new movements.

```
                    ┌────────────────┐
                    │  no inventory  │── initialize ──► INITIAL_STOCK (seed)
                    └────────────────┘
                            │
                            ▼
                  ┌─────────────────────┐
                  │   Inventory exists   │◄─ stock-in / stock-out / transfer / adjust
                  └─────────┬───────────┘
                            │ reserve (atomic: available >= qty)
                            ▼
                    Reservation ACTIVE
```

Commands and their ledger type:

| Command | Effect | Movement |
| ------- | ------ | -------- |
| `initialize` | Create inventory record + seed locations (ONLINE first, then OFFLINE; zero quantities skipped). | `INITIAL_STOCK` |
| `stock-in` | Unconditional increase of a location. | `STOCK_IN` |
| `stock-out` | Conditional decrease of a location. | `STOCK_OUT` |
| `transfer` | Conditional decrease of source + increase of target (locations differ). | `TRANSFER` |
| `adjust` | Signed delta; positive increases, negative decreases (guarded). | `ADJUSTMENT` |
| reservation `create` | Conditional increment of `reservedQuantity`. | `RESERVATION` |
| reservation `release` | Decrement `reservedQuantity`. | `RESERVATION_RELEASE` |
| reservation `consume` | Decrement `reservedQuantity` AND `onlineQuantity`. | `RESERVATION_CONSUME` |
| reservation `expire` | Like release (ledger `reason: "expired"`). | `RESERVATION_RELEASE` |
| return restock (Phase 10) | Unconditional ONLINE increase; return completion only, in the same txn as the refund. No ACTIVE-variant requirement. | `RETURN_RESTOCK` |

**Atomicity/concurrency:** mutations are **atomic conditional updates**
(`findOneAndUpdate` with a guard — e.g. `$expr: {
$gte: [{ $subtract: ['$onlineQuantity', '$reservedQuantity'] }, qty] }`), never
read-check-update. A lost race returns `null` and is mapped to the domain error
above, so concurrent reservations can never oversell.

## 4. Reservation State Machine

```
                reserve (available >= qty)
                        │
                        ▼
                  ┌──────────┐
                  │  ACTIVE  │
                  └────┬─────┘
                       │
     ┌─────────────────┼─────────────────┐
     │                 │                 │
 release           consume          expiresAt passed
     │                 │                 │
     ▼                 ▼                 ▼
 RELEASED          CONSUMED          EXPIRED
(terminal)         (terminal)        (terminal)
```

- **`ACTIVE`** — the only mutable state. The reservation holds `quantity` of
  ONLINE availability (`reservedQuantity` incremented).
- **`RELEASED`** — `reservedQuantity` decremented; stock returns to
  availability. Usually when the holding business object is cancelled.
- **`CONSUMED`** — `reservedQuantity` decremented AND `onlineQuantity`
  decremented; the stock physically leaves ONLINE. Usually on fulfillment.
- **`EXPIRED`** — the reservation was ACTIVE past `expiresAt`; treated like a
  release. In this phase nothing expires silently in the background —
  `expireReservation()` is an explicit service operation (a future worker may
  sweep `{ status: ACTIVE, expiresAt: { $lte: now } }`).

Transition safety (**idempotent resolution**):

| Attempted transition | Result |
| -------------------- | ------ |
| release of `RELEASED` | Retry-safe no-op (success). |
| consume of `CONSUMED` | Retry-safe no-op (success). |
| expire of any terminal | No-op (success). |
| release/consume of the OTHER terminal state | `409 RESERVATION_NOT_ACTIVE`. |
| release/consume/expire of an ACTIVE reservation past `expiresAt` | Auto-expires first, then `409 RESERVATION_EXPIRED`. |

Conflict point: release/consume/expire use an **atomic status transition**
(`transitionStatus(id, 'ACTIVE', <terminal>, { resolvedAt, resolvedBy })`).
A caller that loses the race **re-classifies idempotently** instead of
double-mutating stock.

Reservations link to the holding business object via generic
`referenceType`/`referenceId`; an ACTIVE reservation for the same reference →
`409 RESERVATION_CONFLICT`.

## 5. Order Boundary (implemented — Phase 07)

Orders (Phase 07, ADR-0015) build on this foundation:

- **Checkout reserves per line, inside the order transaction.** Every order line
  gets exactly **one ACTIVE `Reservation`** with `referenceType: 'ORDER'` and
  `referenceId = orderId`. Order reservations are created through a new
  **transaction-embedded primitive** (`createReservationInTransaction`) called
  from inside the checkout `withTransaction`, so the order and its reservations
  commit or roll back together. This primitive **bypasses the admin service's
  one-reference guard** (`RESERVATION_CONFLICT`): the DB index on
  `{referenceType, referenceId, status}` is non-unique, and one unique order
  legitimately maps to N reservations (one per line). The admin reservation API
  and its guard are unchanged.
- **Confirm does NOT release or consume.** Stock stays reserved while the order
  is open; `CONSUMED` is a future fulfillment-time action (the movement types
  `RESERVATION_CONSUME` already exist). **Cancel and reject DO release** all
  ACTIVE reservations for the order (`RESERVATION_RELEASE`), in the same
  transaction as the status change.
- **No auto-expiry in Phase 07.** Order reservations are created without
  `expiresAt`; stale `PENDING` orders need explicit staff action (cancel/reject)
  or a future background job. The `{ status: ACTIVE, expiresAt: { $lte: now } }`
  sweep remains future work.
- **Fulfillment is not implemented.** `SHIPPED`/`DELIVERED` are reserved order
  states; consuming order reservations is a future fulfillment step.
- The customer-facing reservation surface does not exist — customers never
  call inventory endpoints (those remain ADMIN-only).

## 6. Test Coverage & Limitation

- Unit tests cover models, validation, serializers, both services, the
  repository update shapes (guards + location-field mapping + session
  passthrough), and a concurrency file.
- Integration tests (`tests/integration/inventory.test.js`) exercise the full
  HTTP surface with JWT fixtures: 401s, STAFF/CUSTOMER 403s on every path,
  role-spoofing (JWT claim / `X-Role` / query / body), the full 5-movement
  ledger, low-stock, the reservation lifecycle over HTTP, and raw-token
  non-echo.
- **Documented limitation:** there is no live MongoDB / MongoMemoryServer in
  this environment, so real snapshot-race concurrency cannot be exercised
  against a database. The concurrency tests drive repository **stubs that apply
  the same conditional guards** (single-threaded); the guards themselves are
  asserted verbatim against the real repository in
  `tests/unit/inventory/inventory.repository.test.js`. The same limitation
  applies to the Phase 07 checkout: transaction rollback and idempotency races
  are simulated via stubs (see `docs/order-state-machine.md`). True concurrent
  behavior must be re-verified once a live MongoDB is available (e.g. in
  integration against Atlas).
