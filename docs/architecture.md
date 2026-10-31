# Asia Electronics Backend — Architecture

Status: **Approved (Phase 11 — Notification & Email Infrastructure on the Phase 10 foundation: a provider-agnostic EmailProvider abstraction with a dependency-free SMTP client and an in-memory mock (ADR-0004), a best-effort NotificationService that business services call AFTER their own committed transactions so delivery NEVER fails the business operation, durable Notification audit records with a `QUEUED → SENT | FAILED | SKIPPED` machine, within-window deduplication, and 8 wired order/payment events with courier/return/refund templates reserved — ADR-0019; Phase 10 added Returns + Refunds on the Phase 07 order / Phase 08 payment foundation: server-derived eligibility, item price snapshots, replay-safe idempotency, one completion transaction that restocks ONLINE stock and auto-creates a PENDING refund — ADR-0018)**

This document is the source of truth for the Asia Electronics backend architecture. Future
development phases MUST follow these decisions. Changes to the architecture
require an Architecture Decision Record (see `docs/decisions/`) and approval.

---

## 1. Project

- **Product:** Asia Electronics — e-commerce platform
- **Domains:** Consumer electronics, electronic accessories, gadgets
- **Backend scope:** Products, product variants, inventory, customers, orders,
  manual payments, cash on delivery, returns, cancellations, expenses,
  analytics, profit/loss, staff/admin management, Pathao courier integration,
  email notifications, audit logs.

## 2. Technology Stack (finalized — do not change)

| Layer        | Choice                          |
| ------------ | ------------------------------- |
| Runtime      | Node.js                         |
| Framework    | Express.js                      |
| Language     | JavaScript                      |
| Module system| CommonJS                        |
| API style    | REST (JSON)                     |
| ODM          | Mongoose                        |
| Database     | MongoDB Atlas                   |
| Media        | Cloudinary                      |
| Courier      | Pathao                          |
| Email        | SMTP via `net`/`tls`/`crypto` (mock in dev/tests) — Phase 11 |
| Deployment   | Vercel (separate frontend/backend deployments) |

## 3. Critical Principle: Backend/Frontend Independence

The backend is a **standalone REST API**. It MUST NOT depend on, or be coupled
to, the frontend. Never introduce dependencies on Next.js, React, Zustand,
Server Actions, Next.js middleware, frontend components, or frontend-specific
utilities. The backend must be capable of operating independently.

## 4. Authentication (frontend-owned) and Security Foundation

```
Frontend (Next.js)
        ↓
    Better Auth
        ↓
        JWT
        ↓
Backend JWT verification middleware  (authenticate → req.auth)
        ↓
Application user resolution  (resolveCurrentUser → req.user)
        ↓
    RBAC / authorization  (authorizeRoles)
        ↓
        controller
```

- Authentication is owned by the separate Next.js frontend (Better Auth).
- The backend MUST NOT implement its own authentication system. It does not
  create login/registration endpoints, sessions, or password handling.
- The backend receives JWTs and verifies them (via JWKS from Better Auth) and
  enforces authorization with RBAC.
- The backend keeps **two distinct identities** per request (ADR-0010/ADR-0011):
  - `req.auth` — the verified **authentication identity**
    (`{ authProviderId, email?, displayName? }`), produced by `authenticate`.
  - `req.user` — the **application identity** (`{ id, authProviderId, email,
    displayName, phone, role, status }`), produced by `resolveCurrentUser` from
    the MongoDB `User` record. `role` here is the AUTHORITATIVE role for
    authorization — the JWT's `role` claim is never trusted.

### 4.1 JWT verification (`authenticate` middleware)

- Implemented (Phase 02) in `src/middlewares/authenticate.js`. Production uses
  the default verifier built in `src/integrations/auth/` from the centralized
  configuration.
- Tokens arrive via the `Authorization: Bearer <token>` header. Missing or
  malformed headers and any verification failure return `401 UNAUTHORIZED`
  with message `"Authentication required"` (see `docs/api-contract.md`).
- Verification is **cryptographic only** (`jose`): signatures are checked
  against the Better Auth JWKS via `createRemoteJWKSet` (built-in caching and
  key rotation); the algorithm is restricted to the configured allowlist
  (default `RS256`) to prevent algorithm-confusion; issuer, audience, and
  expiry/`nbf` are validated; a bounded clock tolerance (default 30 s) absorbs
  skew.
- The verified payload is mapped to a **normalized authentication identity**
  on `req.auth` (`src/integrations/auth/identity.js` → `mapAuthClaims`): only
  explicitly trusted claims are copied (`authProviderId` from the subject,
  `email`, `displayName`). The `role` claim is deliberately dropped — the
  application role lives in the MongoDB `User` record. Tokens missing a user id
  are rejected. Client-supplied roles in headers, query strings, or bodies are
  NEVER trusted.
- Tokens are never logged and never echoed in responses; verification failures
  log nothing sensitive.

### 4.2 Application user resolution (`resolveCurrentUser` middleware)

- Implemented (Phase 03) in `src/middlewares/resolveCurrentUser.js`. Always
  composed AFTER `authenticate` and BEFORE `authorizeRoles`:
  `authenticate → resolveCurrentUser → authorizeRoles(...) → controller`.
- Resolves the application identity for the verified `req.auth` via the users
  module's `UserService.resolveAuthenticatedUser` (lookup by `authProviderId`).
  A missing user is auto-provisioned as `CUSTOMER/ACTIVE` when
  `AUTO_PROVISION_CUSTOMERS=true` (the default); otherwise the request fails
  with `403 "User account not found"`. Auto-provisioning NEVER creates
  ADMIN/STAFF from JWT claims.
- Enforces account status: only `ACTIVE` accounts are admitted. `SUSPENDED` →
  `403 "Account is suspended"`; `DISABLED` → `403 "Account is disabled"`.
- Sets `req.user` to the application identity whose `role` drives
  authorization. Running `resolveCurrentUser` without a prior `req.auth` is
  defensive: `401`.

### 4.3 RBAC enforcement (`authorizeRoles` middleware)

- Implemented (Phase 02) in `src/middlewares/authorizeRoles.js`. Composed AFTER
  `authenticate` and `resolveCurrentUser`:
  `authenticate → resolveCurrentUser → authorizeRoles(...) → controller`.
- Reads the role from `req.user.role` (the application record) — never from the
  JWT, headers, query, or body.
- When the resolved role is not allowed → `403 FORBIDDEN` with message
  `"You do not have permission to perform this action"`.
- Ownership (e.g., "a customer may only access their own order") is enforced
  **inside the domain services** (Phase 07 implements it for the cart and order
  modules: every customer cart/order query filters by the authenticated
  customer id, and cross-customer reads resolve as 404, never 403, to avoid
  leaking resource existence). The middleware itself stays purely role-based.

### 4.4 Configuration

- `BETTER_AUTH_JWKS_URL` is REQUIRED in production (fail fast), optional in
  development/test (all authenticated endpoints then return 401).
- `BETTER_AUTH_ISSUER` / `BETTER_AUTH_AUDIENCE` are optional and enforced only
  when set.
- `BETTER_AUTH_ALGORITHMS` (comma-separated, default `RS256`) is the signed
  algorithm allowlist.
- `BETTER_AUTH_CLOCK_TOLERANCE_SECONDS` (default `30`) is the clock-skew leeway.
- `AUTO_PROVISION_CUSTOMERS` (default `true`, Phase 03) controls whether an
  unknown authenticated identity is provisioned as a `CUSTOMER` application
  user on first access.
- **PENDING:** Exact Better Auth values (JWKS URL, issuer, audience) must be
  confirmed with the frontend team before real token verification can be
  validated end-to-end.

## 5. Authorization Roles

- `ADMIN` — full access.
- `STAFF` — limited operational access.
- `CUSTOMER` — access scoped to the authenticated customer's own resources.

Roles are stored on the application `User` record (Phase 03) and resolved from
MongoDB, NOT from the JWT (ADR-0011). Enforcement is via
`authorizeRoles` after `resolveCurrentUser` (see section 4). Detailed
permission matrix: see `docs/rbac-matrix.md`.

## 6. Repository Structure

```
taqwa-backend/
│
├── src/
│   ├── app.js                 # Express app assembly
│   ├── server.js              # Entry point (connect DB → start HTTP server)
│   ├── config/
│   │   ├── index.js           # Centralized environment configuration
│   │   └── database.js        # MongoDB/Mongoose connection module
│   ├── constants/             # Shared constants (API paths, roles, error codes)
│   ├── routes/                # Top-level route registration (API version + groups)
│   ├── middlewares/           # Cross-cutting middleware (auth, rbac, errors, ...)
│   ├── modules/
│   │   ├── base/              # Shared building blocks (base.repository.js)
│   │   ├── notifications/     # Notification orchestration + email templates (Phase 11)
│   │   └── ...                # Feature/domain modules (one folder per domain)
│   ├── integrations/          # External provider adapters (Pathao, Cloudinary, email)
│   │   ├── auth/              # JWT verification + identity mapping (Better Auth JWKS)
│   │   ├── email/             # Email provider abstraction: mock + SMTP (Phase 11)
│   ├── utils/                 # Shared helpers
│   └── docs/                  # Developer notes co-located with code
│
├── tests/
├── docs/                      # Persistent architecture/design context
├── .env                       # Local secrets (gitignored)
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

Empty directories are intentionally preserved with `.gitkeep`.

## 7. Layered Dependency Flow

```
Route
  ↓
Middleware
  ↓
Controller
  ↓
Service
  ↓
Repository
  ↓
Model
  ↓
MongoDB
```

Rules:

- Controllers are thin: parse/validate request input, delegate to a service,
  serialize responses.
- Business logic lives in services.
- Database access stays in repositories (where repository abstraction is used).
- Controllers/services MUST NOT talk directly to MongoDB, Pathao, Cloudinary,
  or email providers.

## 8. Database Layer (MongoDB + Mongoose)

- **Persistence:** MongoDB Atlas accessed through Mongoose (ODM). Mongoose
  bundles the MongoDB driver; no separate driver dependency is used.
- **Connection module:** `src/config/database.js` owns the single default
  connection and exposes `connectDatabase()`, `disconnectDatabase()`,
  `getDatabaseState()`, and `isDatabaseConnected()`. Uses the current Mongoose
  API only (no deprecated options).
- **Startup sequence:**

```
Load configuration
      ↓
Initialize application
      ↓
Connect MongoDB
      ↓
Start HTTP server
```

- **Fail fast:** the HTTP server never starts if the database connection is
  required and fails. A missing `MONGODB_URI` or unreachable database produces
  a clear error and a non-zero process exit. No retries, no fake/default
  credentials, no hardcoded databases.
- **Graceful shutdown:**

```
Receive shutdown signal (SIGINT/SIGTERM)
      ↓
Stop accepting new HTTP requests
      ↓
Close HTTP server
      ↓
Close MongoDB connection
      ↓
Exit process
```

- **Connection behavior:** `bufferCommands` is disabled so queries fail fast
  when the database is unavailable; a bounded `serverSelectionTimeoutMS`
  prevents hanging; connection events are logged; credentials/hosts are
  redacted from logs and error messages.
- **Transactions:** MongoDB sessions/transactions are reserved for
  multi-collection operations that must commit atomically. Phase 05 added
  `withTransaction(work)` in `src/config/database.js` (throws clearly when
  Mongo is not connected) and uses it for **product create + initial variants**
  and **product PATCH variant replacement** — product and variant writes commit
  or roll back together. Phase 06 (inventory) uses the SAME helper for every
  stock mutation: the inventory change, any reservation status transition, and
  the immutable ledger movement append commit or roll back together.
  Repositories accept an optional `session` option and pass it to Mongoose
  (`create(data, { session })`, `updateById(id, update, { session })`). The
  transaction utility is generic; future phases (e.g., order creation + stock
  reservation) reuse it rather than duplicating transaction logic.
- **Phase 07 checkout** runs **one** `withTransaction` that loads the
  customer's cart, validates the live catalog, computes price snapshots,
  reserves ONLINE stock per line (via the Phase 06 reservation machinery), and
  creates the Order + embedded OrderItems atomically — the order cannot exist
  without its reservations, and the cart is cleared in the same commit.
- **Concurrency:** Phase 06 stock mutations are **atomic conditional updates**
  in the repository (`findOneAndUpdate` with a guard condition such as
  `$expr: { $gte: [{ $subtract: ['$onlineQuantity', '$reservedQuantity'] }, qty] }`)
  — never read-check-update — so concurrent operations cannot oversell or lose
  updates. Reservation release/consume/expire use an atomic status transition
  as their conflict point; a loser re-classifies idempotently.
- **Phase 08 payments** follow the same atomic-transition pattern: payment
  verify/reject are `conditionalTransition(id, fromStatus, update)` guarded on
  the current status, so concurrent reviews cannot double-apply (ADR-0016).
  Proof uploads happen **outside** the transaction (the media adapter has no
  session concept); the payment document's create/resubmission commits inside
  `withTransaction`, and a DB failure after a successful upload triggers a
  **best-effort media delete** so no orphan proof files are left behind.
- **Phase 10 return completion** runs **one** `withTransaction` per completed
  return: the atomic `APPROVED → COMPLETED` conditional transition, the ONLINE
  restock of every returned line (`restockOnlineInTransaction`, one
  `RETURN_RESTOCK` ledger movement per line), the refund auto-create at PENDING
  (`createRefundInTransaction`, server-derived amount from the return's
  immutable item snapshots), and the `refundId` write-back all commit or roll
  back together. The conditional transition is the conflict point, so two
  concurrent completes can never double-restock or double-refund. Every
  return/refund status change (approve/reject/cancel/complete/process/void) is
  a `conditionalTransition` guarded on the current status (ADR-0018).
- **Indexing philosophy:** indexes belong to the model/domain that owns the
  query pattern and must be justified by expected access patterns. No
  speculative business indexes.
- **Naming conventions:** `camelCase` JavaScript/Mongoose fields; `timestamps:
  true` by default; Mongoose `ObjectId` for internal references; no unnecessary
  abbreviations.
- **Repository pattern:** persistence operations live in repositories.
  `src/modules/base/base.repository.js` provides a minimal reusable base
  (findById/findOne/findMany/create/updateById/deleteById/count). Repositories
  MUST NOT make business decisions, read HTTP requests, send responses, handle
  authentication, or call external APIs.
- **Error handling:** raw Mongoose errors are never exposed to API consumers.
  Future domain modules map database errors to domain-specific error codes.

## 9. External Integration Flow

```
Service
  ↓
Integration / Adapter
  ↓
External Provider
```

Example:

```
OrderService
  ↓
CourierService
  ↓
PathaoAdapter
  ↓
Pathao API
```

```
PaymentService
  ↓
MediaService (interface)
  ↓
CloudinaryAdapter
  ↓
Cloudinary API
```

- Business logic talks to a **courier abstraction**, never directly to Pathao.
- Business logic talks to a **media abstraction** (ADR-0016,
  `src/integrations/media/media.interface.js`), never directly to Cloudinary.
  The interface exposes `uploadMedia({ buffer, mimetype, publicId })` /
  `deleteMedia({ publicId })` (and `isConfigured()`); the Cloudinary adapter
  (`src/integrations/media/cloudinary/`) is the only place the Cloudinary SDK/
  REST details live. Proof files are validated (type, magic bytes, size) in the
  domain **before** reaching the media layer, and the persisted proof is always
  the **safe media object** `{ provider, publicId, secureUrl, resourceType,
  format }` — never a raw URL. When media is not configured the payment module
  is disabled (501) rather than failing half-way.
- Secrets remain backend-only (env vars / deployment secrets).

## 10. Feature-Based Modules

Planned modules (`src/modules/`):

```
users
customers
categories
products
  └── variants      (ProductVariant: subdomain of products)
inventory
cart
orders
payments
courier
returns
refunds
reviews
expenses
analytics
notifications
auditLogs
settings
```

Each module owns its controllers, services, repositories, and models for its
domain. Shared `modules/base/` infrastructure landed in Phase 01; the `users`
module (application identity) landed in Phase 03; the `categories` module
(catalog taxonomy) landed in Phase 04; the `products` module (Product +
ProductVariant, with per-product measurement guides) landed in Phase 05; the
`inventory` module (per-variant stock, immutable movement ledger,
reservations) landed in Phase 06; the `cart` module (per-customer draft) and
the `orders` module (checkout, order/orderItem snapshots, order state machine,
staff/admin order operations) landed in Phase 07; the `payments` module
(customer multipart proof submission, payment/payment-method models, STAFF/
ADMIN verify/reject) landed in Phase 08; the `courier` module (Pathao
consignment dispatch, webhook signature verification, status reconciliation,
idempotent cancel) landed in Phase 09 (ADR-0017); the `returns` and `refunds`
modules (customer return requests with idempotency + item snapshots, STAFF/
ADMIN approve/reject/cancel/complete, and refund process/void) landed in
Phase 10 (ADR-0018); the `notifications` module (Notification audit records,
NotificationService orchestration, event-type template registry) and the `email`
integration (EmailProvider abstraction: in-memory mock + dependency-free SMTP
client, ADR-0004/ADR-0019) landed in Phase 11; the `reviews` module (public
`APPROVED`-only product reviews with a read-time rating summary, CUSTOMER
submission that always creates `PENDING` reviews, and ADMIN-only atomic
approve/reject moderation) landed in Phase 12. The remaining business
modules (customers, expenses, analytics, auditLogs, settings) are not
implemented yet.

## 11. API Convention

- Version prefix: `/api/v1`
- Namespaced groups:

```
/api/v1/public/*
/api/v1/customer/*
/api/v1/admin/*
/api/v1/staff/*
/api/v1/webhooks/*
```

- Implemented in Phase 00: `GET /api/v1/health`.
- Implemented in Phase 02: the authentication/RBAC security foundation.
- Implemented in Phase 03: `GET /api/v1/me` (protected application profile).
- Implemented in Phase 04: `/api/v1/categories` — public catalog reads
  (`GET /`, `GET /:id`, `GET /slug/:slug`, ACTIVE categories only) and
  ADMIN-only management (`POST /`, `PATCH /:id`). Category slugs are normalized
  through a single `slugify`; duplicates are rejected or de-duplicated; soft
  deactivation replaces deletion (ADR-0012). Category image fields are plain
  http(s) URLs — Cloudinary remains a planned integration.
- Implemented in Phase 05: `/api/v1/products` — public storefront catalog
  (ACTIVE products only) with allowlisted filters/sorts and safe pagination
  (`GET /`, `GET /:id`, `GET /slug/:slug`), STAFF+ADMIN product creation
  (`POST /`) and ADMIN-only updates (`PATCH /:id`, including atomic variant
  replacement and soft deactivation via `{ isActive: false }` — no DELETE).
  Product + initial variants commit inside one MongoDB transaction;
  purchase-price fields are ADMIN-only in responses (the resolved application
  `role`, never the JWT); SKUs are immutable after creation; measurement
  guides must match variant sizes.
- Implemented in Phase 06: `/api/v1/inventory` — **ADMIN-only** stock control
  per variant (`src/modules/inventory/`): initialize a variant's stock
  (`POST /initialize`, one inventory per variant), physical stock commands
  (`POST /stock-in`, `POST /stock-out`, `POST /transfer`, `POST /adjust`),
  reservations (`POST /reservations`, `POST /reservations/:id/{release,
  consume, expire}`), and reads (`GET /`, `GET /low-stock`, `GET /:productVariantId`,
  `GET /:productVariantId/movements`, `GET /reservations`, `GET /reservations/:id`).
  Every mutation runs in ONE MongoDB transaction and appends an IMMUTABLE
  `InventoryMovement` ledger record in the same commit; stock updates are
  atomic conditional updates (never read-check-update), so concurrent
  reservations cannot oversell. Stock levels are non-negative integers,
  `availableOnlineQuantity = onlineQuantity - reservedQuantity` is derived
  (never stored), and there is NO generic PATCH/DELETE — corrections are new
  movements. Reservations follow `ACTIVE → RELEASED | CONSUMED | EXPIRED`
  (terminal) with generic `referenceType`/`referenceId` for the Orders phase;
  resolution is idempotent. Inventory never duplicates catalog data
  (it references `ProductVariant._id`).
- Implemented in Phase 07: `/api/v1/cart` and `/api/v1/orders` — the
  customer-facing cart and checkout lifecycle, plus `/api/v1/admin/orders`
  for staff. `GET /cart`, `POST /cart/items`, `PATCH /cart/items/:id`,
  `DELETE /cart/items/:id`, and `DELETE /cart` are server-side (prices,
  discounts, and fees are never stored in the cart). `POST /orders/checkout`
  is **idempotent** (`Idempotency-Key` header, unique `{customerId,
  idempotencyKey}` index), recomputes all money server-side, reserves ONLINE
  stock per order line inside the checkout transaction, and returns the
  created order. Customer endpoints (`GET /orders`, `GET /orders/:id`,
  `POST /orders/:id/cancel`) are strictly customer-scoped (cross-customer
  reads → 404). Staff/ADMIN endpoints (`POST /orders/:id/confirm`,
  `POST /orders/:id/process`, `POST /orders/:id/reject`,
  `GET /admin/orders`, `GET /admin/orders/:id`) drive the order state machine.
  All money is integer minor units; order items are immutable embedded
  snapshots; no payment, courier, or fulfillment work happens in this phase.
- Implemented in Phase 08: `/api/v1/orders/:orderId/payment`,
  `/api/v1/payment-methods`, `/api/v1/admin/payments`, and
  `/api/v1/admin/payment-methods` — the manual payment system
  (`src/modules/payments/`, ADR-0016). Customers submit a bank-transfer proof
  as **multipart/form-data** (hand-rolled strict parser, no dependency) under
  an `Idempotency-Key`; the service validates eligibility (own order, MANUAL,
  PENDING/CONFIRMED), enforces the **exact-amount** policy against the order's
  `grandTotalMinorUnits`, uploads the file through the **media abstraction**
  (Cloudinary adapter), and persists the safe media object on the payment.
  STAFF/ADMIN list and verify/reject via **atomic conditional transitions**
  (`SUBMITTED → VERIFIED | REJECTED`, idempotent in target state); a rejected
  payment is resubmitted in place. Payment methods are ADMIN-managed
  (soft deactivation only, unique `code`); customers see ACTIVE methods only.
  **Verify never auto-confirms the order** — the payment service never mutates
  the Order document.
- Future customer, staff, and admin groups MUST compose
  `authenticate → resolveCurrentUser → authorizeRoles(...)` as defined in
  section 4. No business endpoint may read a role from the request body,
  query, or headers, and no endpoint may trust a JWT role claim.

Full contract: see `docs/api-contract.md`.

## 12. Response Convention

Success:

```json
{
  "success": true,
  "message": "Operation successful",
  "data": {}
}
```

Error:

```json
{
  "success": false,
  "message": "Human readable message",
  "error": {
    "code": "ERROR_CODE"
  }
}
```

## 13. Coding Standards

General:

- Keep modules small and focused; follow single responsibility.
- Avoid unnecessary abstraction and premature optimization.
- Avoid circular dependencies.
- Do not duplicate business logic; prefer reusable services/utilities.
- Keep controllers thin.
- Keep database access inside repositories where repository abstraction is used.
- Keep external APIs behind integrations/adapters.

JavaScript:

- Modern JavaScript supported by the selected Node.js runtime
  (`engines.node >= 20.12.0`).
- **CommonJS** module system throughout the backend. Do not mix CommonJS and
  ESM arbitrarily.

## 14. Configuration

- All environment access goes through `src/config/index.js` (centralized config).
  Do not scatter `process.env.X` through the codebase.
- `.env` is loaded at startup via Node's built-in `process.loadEnvFile()`
  (already-set environment variables always win over the file).
- `.env.example` documents every variable; `.env` is gitignored.
- `MONGODB_URI` is REQUIRED (Phase 01+). Validation throws in production
  (fail fast), warns in development, and is silent in tests. Running the server
  without it always fails with a clear error. `MONGODB_SERVER_SELECTION_TIMEOUT_MS`
  optionally bounds the startup connection timeout (default 10000 ms).
- `BETTER_AUTH_JWKS_URL` is REQUIRED in production (Phase 02+); `issuer`,
  `audience`, algorithm allowlist, and clock tolerance are configured via the
  `BETTER_AUTH_*` variables (see `.env.example`). Missing JWKS URL in
  development/test only disables authentication (all protected routes return
  401), it does not block the server from running.
- `AUTO_PROVISION_CUSTOMERS` (Phase 03+, default `true`) controls application
  user auto-provisioning for unknown authenticated identities.
- Cloudinary (media) remains a planned integration; Pathao (Phase 09) and email
  (Phase 11) are implemented with their phases' validation tightened.

## 15. Planned / Not Yet Implemented

The database infrastructure (Phase 01), the JWT verification / request identity
/ RBAC enforcement security foundation (Phase 02), the application User
domain with the protected `/me` endpoint (Phase 03), the Category taxonomy
module with public catalog reads + ADMIN-only management (Phase 04), the
Product + ProductVariant catalog module with measurement guides, atomic
create, purchase-price privacy, and ADMIN/STAFF permissions (Phase 05), the
Inventory module with per-variant stock, an immutable movement ledger, and
the reservation lifecycle (Phase 06), the Cart + Order & checkout lifecycle
with customer-scoped orders and staff/admin order operations (Phase 07), the
manual Payment + PaymentMethod module with customer multipart proof
submission and STAFF/ADMIN verify/reject (Phase 08), the Courier module
(Pathao dispatch, webhook signature verification, status reconciliation,
idempotent cancel — Phase 09, ADR-0017), and the Returns + Refunds modules
(customer return requests, item snapshots, idempotent/duplicate prevention,
STAFF/ADMIN approve/reject/cancel/complete with restock + server-derived
refund in one transaction, refund process/void — Phase 10, ADR-0018), and the
Notification + Email infrastructure (best-effort transactional email via a
provider-agnostic EmailProvider abstraction with in-memory mock and
dependency-free SMTP providers, NotificationService orchestration, durable
Notification audit records with a `QUEUED → SENT | FAILED | SKIPPED` machine,
within-window deduplication, and wired order/payment events — Phase 11,
ADR-0019) are implemented. Product Reviews (public `APPROVED`-only reads with a
read-time rating summary, CUSTOMER submission always creating `PENDING`
reviews, and ADMIN-only atomic approve/reject moderation with terminal
outcomes — Phase 12) are implemented. The following business domains are intentionally NOT implemented
and belong to later phases: **online payment gateways / webhooks / automatic
verification** (payment is deliberately manual-proof + COD only — the payment
state machine has no gateway or webhook surface), **order-level return
states** (the `RETURN_*` states on the Order stay reserved and unreachable —
returns live in their own SEPARATE machine, ADR-0018), **fulfillment**
(shipping a confirmed order is a future action — reservations are only
released on cancel/reject, never auto-expired, and consumed at a future
fulfillment step), customers (profile extension), analytics, expenses,
admin/staff management APIs, and the remaining business models/schemas.
Courier (SHIPMENT_DISPATCHED / ORDER_DELIVERED), return (RETURN_*), and refund
(REFUND_*) notification events are DECLARED with templates but not yet wired to
any business trigger.
Reservations are referenced from orders via `referenceType: 'ORDER'` /
`referenceId: orderId`.

See `docs/business-rules.md` and `docs/database-schema.md` for planned domain
details, and `docs/decisions/` for the recorded architecture decisions.
