# Asia Electronics Backend

REST API backend for the **Asia Electronics** e-commerce platform — consumer
electronics and electronic accessories.

## Status

**Phase 11 — Notification & Email Infrastructure: transactional customer email
notifications wired onto the order and payment lifecycles. Business services
emit events through a provider-agnostic EmailProvider abstraction (mock in
development/tests, dependency-free SMTP in production) via a best-effort
NotificationService that NEVER fails the underlying business operation; every
message is a durable audit record (`QUEUED → SENT | FAILED | SKIPPED`) with
within-window deduplication. 8 event types are wired (ORDER_PLACED / ORDER_
CONFIRMED / ORDER_PROCESSING / ORDER_REJECTED / ORDER_CANCELLED / PAYMENT_
SUBMITTED / PAYMENT_VERIFIED / PAYMENT_REJECTED); courier/return/refund event
templates are reserved for future phases (ADR-0019).**
Phase 10 adds the **Returns + Refunds** modules (`src/modules/returns/`,
`src/modules/refunds/`): customers request returns on their own orders
(replay-safe `{ orderId, idempotencyKey }` submissions; eligibility is
server-derived — own order, CONFIRMED/PROCESSING, within 30 days of
`order.createdAt`); STAFF/ADMIN approve/reject/cancel returns and complete them
in ONE transaction that restocks each line ONLINE (`RETURN_RESTOCK`) and
auto-creates the refund at PENDING with a SERVER-DERIVED amount from immutable
item snapshots (no delivery-fee refunds); STAFF/ADMIN then process or void the
refund (`PENDING → PROCESSED | VOIDED`). Per-item availability plus the unique
compound index prevent double-claim and replay. See `docs/return-state-machine.md`
and `docs/decisions/ADR-0018-returns-and-refunds.md`.
The database connection layer, fail-fast startup, graceful shutdown, and
repository infrastructure are in place (Phase 01), plus the
authentication/authorization security foundation (Phase 02: the backend is a
resource server — it verifies JWTs from the frontend's Better Auth and enforces
roles; it does not issue credentials). Phase 03 adds the application `User`
domain in MongoDB (identity separated from authentication), a protected
`GET /api/v1/me`, application roles resolved from the database (JWT role claims
are never trusted), account status enforcement (only `ACTIVE` accounts are
admitted), and customer auto-provisioning. Phase 04 adds the generic
`Category` catalog taxonomy (`src/modules/categories/`): public, unauthenticated
storefront reads (`GET /api/v1/categories`, `/:id`, `/slug/:slug`, ACTIVE
categories only), ADMIN-only create/update with a single normalized `slugify`,
duplicate/operator-injection defense, deterministic `sortOrder` ordering, and
soft deactivation (no DELETE). Phase 05 adds Products + ProductVariants
(`src/modules/products/` and `src/modules/products/variants/`): public catalog
listing/detail/by-slug with allowlisted filters/sorts and pagination, STAFF+ADMIN
create and ADMIN-only update (atomic variant replacement, soft deactivation),
per-product measurement guides validated against variant sizes, integer minor-unit
money (paisa), centrally computed effective prices, ADMIN-only purchase-price
visibility, globally unique immutable SKUs, and product+variants committed in one
MongoDB transaction. Phase 06 adds Inventory (`src/modules/inventory/`):
per-variant stock (`onlineQuantity`/`offlineQuantity`/`reservedQuantity`/
`lowStockThreshold`, with `availableOnlineQuantity` and
`totalPhysicalQuantity` derived — never stored), ADMIN-only stock commands
(initialize, stock-in, stock-out, transfer, adjust), an **immutable
`InventoryMovement` ledger** appended in the same MongoDB transaction as every
stock change, and a reservation lifecycle
(`ACTIVE → RELEASED | CONSUMED | EXPIRED`) with idempotent resolution.
Stock updates are atomic conditional updates (never read-check-update), so
concurrent reservations cannot oversell. Phase 07 adds the **Cart** module
(`src/modules/cart/`: server-side per-customer cart — variant references +
quantities only, no stored prices) and the **Orders** module
(`src/modules/orders/`): idempotent checkout (`Idempotency-Key` header) that
recomputes all money server-side, derives the delivery zone, reserves ONLINE
stock per order line inside the checkout transaction, and snapshots immutable
OrderItem subdocuments into the Order; customer-scoped order history/detail/
pre-confirmation cancel; and `/api/v1/admin/orders` confirm/process/reject/
list/detail for ADMIN+STAFF with a `PENDING → CONFIRMED → PROCESSING` +
`CANCELLED`/`REJECTED` state machine. Cancellation/rejection releases the order's
reservations; confirmation keeps stock held until a future fulfillment phase.
Phase 08 adds the **Payments** module (`src/modules/payments/`): customers submit
a manual (bank transfer) proof as multipart/form-data with an `Idempotency-Key`;
the service enforces eligibility and an **exact-amount** policy, uploads the file
through the **media abstraction** (`src/integrations/media/`, Cloudinary
adapter), and persists a safe media object. STAFF/ADMIN list and verify/reject
payments (`SUBMITTED → VERIFIED | REJECTED`, idempotent in the target state)
with atomic conditional transitions; a rejected payment is resubmitted in place.
Payment methods are ADMIN-managed (soft deactivation only, unique `code`) and
customers see ACTIVE methods only. **Verify never auto-confirms the order.** No
online gateways or webhooks — Phase 08 is deliberately manual-proof + COD only.
Phase 09 adds the **Courier** module (`src/modules/courier/`): Pathao dispatch
with consignment creation, webhook signature verification, status
reconciliation, and an idempotent cancel — order cancellation can cancel an
ACTIVE shipment. A mock courier provider is active in non-production environments.
Phase 10 adds the **Returns + Refunds** modules (`src/modules/returns/`,
`src/modules/refunds/`): customers request returns on their own orders
(replay-safe `{ orderId, idempotencyKey }` submissions; eligibility is
server-derived — own order, CONFIRMED/PROCESSING, within 30 days of
`order.createdAt`); STAFF/ADMIN approve/reject/cancel returns and complete them
in ONE transaction that restocks each line ONLINE (`RETURN_RESTOCK`) and
auto-creates the refund at PENDING with a SERVER-DERIVED amount from immutable
item snapshots (no delivery-fee refunds); STAFF/ADMIN then process or void the
refund (`PENDING → PROCESSED | VOIDED`). Per-item availability plus the unique
compound index prevent double-claim and replay. See `docs/return-state-machine.md`
and `docs/decisions/ADR-0018-returns-and-refunds.md`.
Fulfillment (dispatch from confirmed orders) and payment gateways remain future
phases.

## Stack

- Node.js (>= 20.12.0) · Express.js · JavaScript (CommonJS)
- Mongoose · MongoDB Atlas
- `jose` — JWT verification + JWKS (caching/rotation)
- Cloudinary (media adapter — Phase 08); Pathao (courier adapter — Phase 09);
  email (provider abstraction — Phase 11: mock + dependency-free SMTP)

## Quick Start

```bash
npm install
cp .env.example .env   # then fill in MONGODB_URI (do NOT commit .env)
npm run dev            # start with file watching
```

`MONGODB_URI` is **required** — the server refuses to start without a reachable
database. The server starts on `http://localhost:4000` (override with `PORT`).

Health check (also reports database state):

```bash
curl http://localhost:4000/api/v1/health
```

```json
{ "success": true, "message": "Asia Electronics API is healthy", "data": { "database": "connected" } }
```

## Scripts

| Script        | Description                         |
| ------------- | ----------------------------------- |
| `npm run dev` | Start server with `--watch`         |
| `npm start`   | Start server                        |
| `npm test`    | Run tests (Node built-in test runner) |

## Repository Layout

```
src/
  app.js                 Express app assembly
  server.js              Entry point (connect DB → start HTTP server)
  config/
    index.js             Centralized environment configuration
    database.js          MongoDB/Mongoose connection module
  constants/             Shared constants (API paths, roles, error codes)
  routes/                Route registration (version + namespaces)
  middlewares/           Cross-cutting middleware (authenticate, authorizeRoles, ...)
  modules/
    base/                Shared infrastructure (base repository)
    users/               Application User domain (identity, roles, /me)
    categories/          Category taxonomy (public reads + admin management)
    products/            Product catalog (variants under products/variants/)
    inventory/           Per-variant stock, movement ledger, reservations
    cart/                Server-side per-customer cart
    orders/              Orders, checkout, order state machine
    payments/            Manual payments, payment methods, proof verification
    notifications/       Notification orchestration + email templates (Phase 11)
    ...                  Feature/domain modules (future phases)
  integrations/
    auth/                JWT verification + identity mapping (Better Auth JWKS)
    email/               Email provider abstraction (mock + SMTP, Phase 11)
    media/               Media abstraction (interface + Cloudinary adapter)
    ...                  External provider adapters (future phases)
  utils/                 Shared helpers
  docs/                  Developer notes co-located with code
tests/                   Automated tests
docs/                    Architecture/design context (see below)
```

## Documentation

- `docs/architecture.md` — approved architecture and conventions
- `docs/business-rules.md` — decided business rules
- `docs/rbac-matrix.md` — roles and authorization plan
- `docs/database-schema.md` — planned data entities
- `docs/api-contract.md` — API conventions and contract
- `docs/order-state-machine.md`, `docs/inventory-state-machine.md`,
  `docs/payment-state-machine.md` — state machines (inventory & reservation
  machine finalized in Phase 06; order machine implemented in Phase 07;
  payment machine implemented in Phase 08)
- `docs/decisions/` — Architecture Decision Records (ADRs)

## Configuration

Environment variables are read through `src/config/index.js`. See
`.env.example` for the full list. Never commit real secrets (see `.gitignore`).
`MONGODB_URI` is required; `BETTER_AUTH_JWKS_URL` is required in production
(authenticated routes return 401 when it is missing); `AUTO_PROVISION_CUSTOMERS`
(default `true`) controls customer auto-provisioning. `CLOUDINARY_CLOUD_NAME` /
`CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` enable the media adapter — when
they are missing the payment module is disabled (submit/verify endpoints return
501) so nothing fails half-way. Other service credentials are optional until
their phases.

## Authentication & authorization

- The backend is a **resource server**: the Next.js frontend owns
  authentication (Better Auth) and sends `Authorization: Bearer <jwt>`.
- `authenticate` verifies the JWT cryptographically against the Better Auth
  JWKS (via `jose`, with caching/rotation) and maps verified claims to
  `req.auth = { authProviderId, email?, displayName? }`. Failures return `401`.
- `resolveCurrentUser` resolves the **application identity** `req.user =
  { id, authProviderId, email, displayName, phone, role, status }` from the
  MongoDB `User` record and enforces account status (only `ACTIVE` is
  admitted). The application `role` is authoritative — a JWT `role` claim is
  never trusted (see `docs/decisions/ADR-0011-*`).
- `authorizeRoles(...)` (composed after `resolveCurrentUser`) enforces
  `CUSTOMER` / `STAFF` / `ADMIN`; disallowed roles return `403`. Roles are read
  from the application user record only — body/query/header role values are
  ignored.
- `GET /api/v1/me` returns the current application user's safe profile
  (`authProviderId` and internals are never serialized).
- `GET /api/v1/categories`, `GET /api/v1/categories/:id`, and
  `GET /api/v1/categories/slug/:slug` are **public** storefront reads of ACTIVE
  categories (no auth). `POST /api/v1/categories` and
  `PATCH /api/v1/categories/:id` are **ADMIN-only** (STAFF/CUSTOMER → 403) and
  use a single normalized `slugify`, reject duplicate names/slugs and operator
  injection, and support soft deactivation (`isActive: false`) with no DELETE
  endpoint.
- Products: `GET /api/v1/products`, `GET /api/v1/products/:id`, and
  `GET /api/v1/products/slug/:slug` are **public** storefront reads of ACTIVE
  products (no auth). `POST /api/v1/products` is **STAFF + ADMIN** (create is
  atomic: product + initial variants in one transaction). `PATCH
  /api/v1/products/:id` is **ADMIN-only** and supports partial updates,
  full variant replacement, and deactivation (`isActive: false`) — no DELETE.
  Money is integer paisa; `purchasePrice`/`purchasePriceOverride` are stored
  but serialized **only** for ADMIN (never in public or STAFF responses). SKUs
  are immutable after creation; measurement guides must match variant sizes.
- Inventory: `GET /api/v1/inventory`, `GET /api/v1/inventory/low-stock`,
  `GET /api/v1/inventory/:productVariantId`,
  `GET /api/v1/inventory/:productVariantId/movements`,
  `POST /api/v1/inventory/initialize`, `POST /api/v1/inventory/stock-in`,
  `POST /api/v1/inventory/stock-out`, `POST /api/v1/inventory/transfer`,
  `POST /api/v1/inventory/adjust`, and the reservation endpoints
  (`POST /api/v1/inventory/reservations`, `POST /reservations/:id/{release,
  consume, expire}`, `GET /api/v1/inventory/reservations`,
  `GET /api/v1/inventory/reservations/:id`) are **ADMIN-only** (STAFF and
  CUSTOMER → 403). Every mutation commits in one MongoDB transaction with an
  immutable ledger movement; stock updates are atomic conditional updates so
  concurrent reservations cannot oversell. `availableOnlineQuantity =
  onlineQuantity - reservedQuantity` and `totalPhysicalQuantity` are derived,
  never stored. There is no generic inventory PATCH/DELETE — corrections are
  new movements, and reservations follow `ACTIVE → RELEASED | CONSUMED |
  EXPIRED`.
- Cart: `GET /api/v1/cart`, `POST /api/v1/cart/items`,
  `PATCH /api/v1/cart/items/:id`, `DELETE /api/v1/cart/items/:id`, and
  `DELETE /api/v1/cart` are **CUSTOMER-only** and operate on the caller's own
  cart. The cart stores only variant references + quantities — prices, discounts,
  and fees are never persisted in the cart; reads enrich lines with live prices
  and availability.
- Orders (customer): `POST /api/v1/orders/checkout` is **CUSTOMER-only** and
  **idempotent** (`Idempotency-Key` header). It recomputes all money server-side
  from the live catalog, derives the delivery zone, reserves ONLINE stock per
  line, and creates the order + immutable item snapshots in **one MongoDB
  transaction**. `GET /api/v1/orders`, `GET /api/v1/orders/:id`, and
  `POST /api/v1/orders/:id/cancel` are customer-scoped (cross-customer reads →
  404). Cancellation (from `PENDING`/`CONFIRMED`) releases the order's
  reservations.
- Admin/Staff orders: `GET /api/v1/admin/orders`,
  `GET /api/v1/admin/orders/:id`, `POST /api/v1/admin/orders/:id/{confirm,
  process, reject}` are **ADMIN + STAFF**. The state machine is
  `PENDING → CONFIRMED → PROCESSING` with terminal `CANCELLED`/`REJECTED`;
  `SHIPPED`/`DELIVERED`/`RETURN_*` are reserved for future phases. Rejection
  releases reservations; confirmation keeps stock held (consume = future
  fulfillment).
- Payments (customer): `GET /api/v1/orders/:orderId/payment` and
  `POST /api/v1/orders/:orderId/payment` are **CUSTOMER-only** and
  customer-scoped (cross-customer reads → 404). The submit is
  `multipart/form-data` with an `Idempotency-Key`; it requires an exact
  `amountMinorUnits` match against the order's `grandTotalMinorUnits`, an
  ACTIVE `paymentMethodId`, and a JPEG/PNG/WEBP proof ≤ 2 MiB (MIME +
  extension + magic bytes checked). The proof uploads through the **media
  abstraction** (Cloudinary adapter) and is persisted as a safe media object.
  The payment lifecycle is `UNPAID → SUBMITTED → VERIFIED | REJECTED` with
  in-place resubmission after rejection. `GET /api/v1/payment-methods` lists
  **ACTIVE** methods for building the form.
- Admin payments: `GET /api/v1/admin/payments`, `GET /api/v1/admin/payments/:id`,
  `POST /api/v1/admin/payments/:id/{verify, reject}` are **ADMIN + STAFF**.
  Transitions are atomic conditional updates (idempotent in the target state,
  wrong state → 409 `PAYMENT_INVALID_STATE`). **Verifying never auto-confirms
  the order.** Admin payment-method management (`POST /api/v1/admin/payment-methods`,
  `PATCH /api/v1/admin/payment-methods/:id`) is **ADMIN-only**, with soft
  deactivation (`isActive: false`) and an immutable, unique `code`.
- See `docs/rbac-matrix.md` and `docs/api-contract.md`.

## Runtime behavior

- **Startup:** the HTTP server only starts after a successful database
  connection. Failures produce a clear, redacted error and a non-zero exit.
- **Shutdown:** on `SIGINT`/`SIGTERM` the server stops accepting requests,
  closes the HTTP server, then closes the MongoDB connection before exiting.

## Notes

- The backend is a standalone REST API and has **no dependency on the frontend**.
- Authentication is owned by the frontend (Next.js + Better Auth); the backend
  verifies JWTs and enforces RBAC. It does not implement its own auth system.
- Production integration is wired end to end: the backend verifies tokens
  against the frontend's JWKS (`https://www.taqwactg.com/api/auth/jwks`) with
  issuer/audience `https://www.taqwactg.com` and the RS256 allowlist. The apex
  `https://taqwactg.com` 308-redirects to the www canonical origin.
