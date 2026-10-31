# Taqwa Backend — RBAC Matrix

Status: **Enforcement implemented (Phase 02); authoritative application roles established (Phase 03); categories matrix finalized (Phase 04); products matrix finalized (Phase 05); inventory matrix finalized (Phase 06); cart + orders matrix finalized (Phase 07); payments + payment-methods matrix finalized (Phase 08); returns + refunds matrix finalized (Phase 10); notifications implemented (Phase 11) as an internal infrastructure module; admin customers + notifications read surface finalized (Phase 15)**

## 1. Roles

| Role       | Scope |
| ---------- | ----- |
| `ADMIN`    | Full administrative access to all backend resources. |
| `STAFF`    | Limited operational access (e.g., order processing, catalog upkeep) as granted per module. |
| `CUSTOMER` | Access scoped to the authenticated customer's own resources (own orders, own profile, etc.). |

Roles are defined once in `src/constants/index.js` (`ROLES`). All middleware
and authorization logic reference this single source.

## 2. Principles

- **CUSTOMER** requests are scoped by the authenticated customer identity; a
  customer can never read or mutate another customer's resources.
- **STAFF** access is granted by role, applied per module/action, and is more
  restricted than ADMIN.
- **ADMIN** is the only role able to manage staff/users, settings, and other
  sensitive administrative areas.
- Sensitive administrative actions are auditable (see `docs/business-rules.md`).
- The **application role lives in the MongoDB `User` record**, never in the JWT
  (ADR-0011). A role claim on a token is informational at best and is ignored
  for authorization.

## 3. Enforcement Point

The backend enforces authorization **after JWT verification and application
user resolution**:

```
authenticate → resolveCurrentUser → authorizeRoles(...) → controller
```

- `authenticate` (`src/middlewares/authenticate.js`) verifies the JWT
  cryptographically and builds the normalized AUTHENTICATION identity on
  `req.auth` (`{ authProviderId, email?, displayName? }`). The `role` claim is
  deliberately dropped. Failure → `401 UNAUTHORIZED`.
- `resolveCurrentUser` (`src/middlewares/resolveCurrentUser.js`) resolves the
  APPLICATION identity on `req.user` from the MongoDB `User` record, enforcing
  account status (`ACTIVE` only). Missing user → 403, or auto-provisioned as
  `CUSTOMER` when enabled. A role supplied in a header, query string, or
  request body is never trusted.
- `authorizeRoles(...)` (`src/middlewares/authorizeRoles.js`) reads
  `req.user.role` (the application record) and grants access only to the listed
  roles. Authenticated but not allowed → `403 FORBIDDEN`.
- Ownership checks (a customer may only touch their own order/cart) are
  enforced **inside the domain services** (Phase 07 implements this for the
  cart and order modules): every customer cart/order query filters by the
  authenticated customer id, and cross-customer order reads resolve as
  **404 `ORDER_NOT_FOUND`** (never 403) to avoid leaking resource existence.

Route groups (see `docs/api-contract.md`) map to roles:

| Route group     | Allowed roles |
| --------------- | ------------- |
| `/api/v1/public/*`   | Unauthenticated (public) |
| `/api/v1/customer/*` | `CUSTOMER` |
| `/api/v1/staff/*`    | `ADMIN`, `STAFF` |
| `/api/v1/admin/*`    | `ADMIN` |
| `/api/v1/webhooks/*` | Service-to-service (signed/authenticated by provider) |

## 4. Security Rules (binding)

1. Role-based access is enforced by `authorizeRoles` after `authenticate` and
   `resolveCurrentUser`; the three must never be reordered or used
   independently for protected routes.
2. The application role comes exclusively from the MongoDB `User` record via
   `resolveCurrentUser`. Untrusted inputs (`req.body.role`, `req.query.role`,
   `X-Role` / custom role headers) are ignored for authorization, as is any
   JWT `role` claim. Tests prove these cannot escalate privileges.
3. Tokens with a missing user id are rejected (401) — an identity that cannot
   be trusted is never partially accepted. Accounts that are not `ACTIVE`
   (`SUSPENDED`/`DISABLED`) are rejected with 403.
4. Route factories should pass roles from `ROLES` constants. `authorizeRoles`
   throws at factory time on unknown role names (fail fast).
5. Future module-level grants refine this matrix per action; they may restrict
   further but never broaden beyond the route-group roles.
6. Auto-provisioning (when enabled) only ever creates `CUSTOMER/ACTIVE`
   application users — never `ADMIN`/`STAFF` from JWT claims.

## 5. Detailed Matrix

### 5.1 Categories (decided — Phase 04)

| Action | Endpoint | Public (no auth) | `CUSTOMER` | `STAFF` | `ADMIN` |
| ------ | -------- | ---------------- | ---------- | ------- | ------- |
| List active categories | `GET /api/v1/categories` | ✅ | ✅ | ✅ | ✅ |
| Get one active category | `GET /api/v1/categories/:id` | ✅ | ✅ | ✅ | ✅ |
| Get by slug | `GET /api/v1/categories/slug/:slug` | ✅ | ✅ | ✅ | ✅ |
| Create category | `POST /api/v1/categories` | ❌ | ❌ | ❌ | ✅ |
| Update/deactivate category | `PATCH /api/v1/categories/:id` | ❌ | ❌ | ❌ | ✅ |
| Delete category | *(no endpoint)* | ❌ | ❌ | ❌ | ❌ |

Notes:

- Management routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ADMIN)`; `CUSTOMER`/`STAFF` get `403 FORBIDDEN`.
- Public reads expose ACTIVE categories only; deactivation is not deletion
  (ADR-0012), so there is no DELETE action in the matrix.
- A JWT `role` claim cannot elevate a `CUSTOMER`/`STAFF` to create or update
  categories — the stored application role is authoritative (proven by tests).

### 5.2 Products (decided — Phase 05)

Product + variant catalog. Public reads are unauthenticated; creation is
STAFF+ADMIN; updates (incl. variant replacement and deactivation) are
ADMIN-only. **Purchase-price fields are an ADMIN-only privilege**: they are
accepted on create, stored, and serialized only when the caller's application
role is `ADMIN` (defense in depth — the STAFF create route never receives
`purchasePrice` in its response, and the PATCH route is ADMIN-only).

| Action | Endpoint | Public (no auth) | `CUSTOMER` | `STAFF` | `ADMIN` |
| ------ | -------- | ---------------- | ---------- | ------- | ------- |
| List active products | `GET /api/v1/products` | ✅ | ✅ | ✅ | ✅ |
| Get one active product | `GET /api/v1/products/:id` | ✅ | ✅ | ✅ | ✅ |
| Get by slug | `GET /api/v1/products/slug/:slug` | ✅ | ✅ | ✅ | ✅ |
| Create product (+ variants) | `POST /api/v1/products` | ❌ | ❌ | ✅ | ✅ |
| Update product / replace variants / deactivate | `PATCH /api/v1/products/:id` | ❌ | ❌ | ❌ | ✅ |
| Delete product | *(no endpoint)* | ❌ | ❌ | ❌ | ❌ |

Notes:

- Management routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(...)`; `POST` allows `(ADMIN, STAFF)`, `PATCH` allows `(ADMIN)`.
- Public reads expose ACTIVE products only; deactivation is not deletion, so
  there is no DELETE action in the matrix.
- A JWT `role` claim cannot elevate a `CUSTOMER` to create products — the
  stored application role is authoritative (proven by tests).
- The service re-checks purchase-price visibility from `req.user.role` passed
  through the controller; even if a non-ADMIN reached the service, purchase
  price would not be serialized.

### 5.3 Inventory (decided — Phase 06)

Per-variant stock control: initialization, physical stock commands, the
immutable movement ledger, and the reservation lifecycle (ADR-0014). **Every
inventory endpoint is ADMIN-only** — stock control is a sensitive
administrative capability. STAFF cannot even read inventory; CUSTOMER can never
reserve via the backend. The acting user (`performedBy`/`createdBy`) is always
`req.user.id`; there is no generic inventory PATCH and no DELETE.

| Action | Endpoint | Public (no auth) | `CUSTOMER` | `STAFF` | `ADMIN` |
| ------ | -------- | ---------------- | ---------- | ------- | ------- |
| List inventory | `GET /api/v1/inventory` | ❌ | ❌ | ❌ | ✅ |
| Low/out-of-stock | `GET /api/v1/inventory/low-stock` | ❌ | ❌ | ❌ | ✅ |
| One inventory | `GET /api/v1/inventory/:productVariantId` | ❌ | ❌ | ❌ | ✅ |
| Variant ledger | `GET /api/v1/inventory/:productVariantId/movements` | ❌ | ❌ | ❌ | ✅ |
| Initialize | `POST /api/v1/inventory/initialize` | ❌ | ❌ | ❌ | ✅ |
| Stock-in | `POST /api/v1/inventory/stock-in` | ❌ | ❌ | ❌ | ✅ |
| Stock-out | `POST /api/v1/inventory/stock-out` | ❌ | ❌ | ❌ | ✅ |
| Transfer | `POST /api/v1/inventory/transfer` | ❌ | ❌ | ❌ | ✅ |
| Adjust | `POST /api/v1/inventory/adjust` | ❌ | ❌ | ❌ | ✅ |
| Create reservation | `POST /api/v1/inventory/reservations` | ❌ | ❌ | ❌ | ✅ |
| Release / consume / expire | `POST /api/v1/inventory/reservations/:id/{release,consume,expire}` | ❌ | ❌ | ❌ | ✅ |
| List reservations | `GET /api/v1/inventory/reservations` | ❌ | ❌ | ❌ | ✅ |
| One reservation | `GET /api/v1/inventory/reservations/:id` | ❌ | ❌ | ❌ | ✅ |
| Generic inventory update / delete | *(no endpoint)* | ❌ | ❌ | ❌ | ❌ |

Notes:

- All routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.ADMIN)`; STAFF and CUSTOMER get `403 FORBIDDEN`.
- A JWT `role` claim, `X-Role` header, `?role=ADMIN` query, or body `role`
  cannot elevate a STAFF/CUSTOMER — the stored application role is
  authoritative (proven by integration tests for every path).
- The orders phase (future) will consume reservations for customers; the
  customer-facing reservation surface is NOT part of this phase.

### 5.4 Cart & Orders (decided — Phase 07)

Server-side customer cart and the order lifecycle (ADR-0015). Customer cart and
order routes are **`CUSTOMER`-scoped** — the service operates on the resources
of `req.user.id`, so the matrix row for `/api/v1/cart` and `/api/v1/orders` is
"own only" for customers (a customer is denied from reading/mutating another
customer's cart/order via the ownership layer, surfaced as 404). Staff/admin
order operations (`/api/v1/admin/orders`) allow **`ADMIN` and `STAFF`**.
Powers that do not exist in Phase 07 (payment capture, shipment, returns) have
no endpoint and no row.

| Action | Endpoint | Public (no auth) | `CUSTOMER` | `STAFF` | `ADMIN` |
| ------ | -------- | ---------------- | ---------- | ------- | ------- |
| Get my cart | `GET /api/v1/cart` | ❌ | ✅ (own) | ❌ | ❌ |
| Add cart item | `POST /api/v1/cart/items` | ❌ | ✅ (own) | ❌ | ❌ |
| Update cart item qty | `PATCH /api/v1/cart/items/:id` | ❌ | ✅ (own) | ❌ | ❌ |
| Remove cart item | `DELETE /api/v1/cart/items/:id` | ❌ | ✅ (own) | ❌ | ❌ |
| Clear cart | `DELETE /api/v1/cart` | ❌ | ✅ (own) | ❌ | ❌ |
| Checkout | `POST /api/v1/orders/checkout` | ❌ | ✅ (own) | ❌ | ❌ |
| My order history | `GET /api/v1/orders` | ❌ | ✅ (own) | ❌ | ❌ |
| One of my orders | `GET /api/v1/orders/:id` | ❌ | ✅ (own) | ❌ | ❌ |
| Cancel my order | `POST /api/v1/orders/:id/cancel` | ❌ | ✅ (own) | ❌ | ❌ |
| List orders | `GET /api/v1/admin/orders` | ❌ | ❌ | ✅ | ✅ |
| One order | `GET /api/v1/admin/orders/:id` | ❌ | ❌ | ✅ | ✅ |
| Confirm order | `POST /api/v1/admin/orders/:id/confirm` | ❌ | ❌ | ✅ | ✅ |
| Process order | `POST /api/v1/admin/orders/:id/process` | ❌ | ❌ | ✅ | ✅ |
| Reject order | `POST /api/v1/admin/orders/:id/reject` | ❌ | ❌ | ✅ | ✅ |
| Delete order / edit totals / edit items | *(no endpoint)* | ❌ | ❌ | ❌ | ❌ |

Notes:

- Customer routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.CUSTOMER)`; the ownership layer (customer id filtering
  inside the service) applies on top of the role check.
- Staff/admin order routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.ADMIN, ROLES.STAFF)`. The acting staff/admin id
  (`performedBy`) is always `req.user.id`; body `performedBy`/`role` are
  rejected.
- A JWT `role` claim, `X-Role` header, `?role=` query, or body `role` cannot
  elevate a CUSTOMER into order operations or a STAFF beyond its grants — the
  stored application role is authoritative (proven by integration tests).
- The customer-facing `/api/v1/orders` group is CUSTOMER-only; a STAFF/ADMIN
  reaching it is denied (403) and must use `/api/v1/admin/orders`.

### 5.5 Payments & Payment Methods (decided — Phase 08)

Manual-payment capture (ADR-0016). The customer can list ACTIVE payment methods
and submit a manual-payment proof for their **own** order; a customer is denied
from reading or submitting against another customer's order via the ownership
layer (surfaced as `404 PAYMENT_NOT_FOUND`). Payment review (verify/reject) is
`ADMIN`+`STAFF`; payment-method management (create/update/soft-deactivate) is
**`ADMIN`-only** — STAFF may review payments but never manage methods. There is
no gateway capture, no auto-verify, and no payment DELETE.

| Action | Endpoint | Public (no auth) | `CUSTOMER` | `STAFF` | `ADMIN` |
| ------ | -------- | ---------------- | ---------- | ------- | ------- |
| List active payment methods | `GET /api/v1/payment-methods` | ✅ | ✅ | ✅ | ✅ |
| My payment for an order | `GET /api/v1/orders/:orderId/payment` | ❌ | ✅ (own) | ❌ | ❌ |
| Submit payment (multipart proof) | `POST /api/v1/orders/:orderId/payment` | ❌ | ✅ (own) | ❌ | ❌ |
| List payments | `GET /api/v1/admin/payments` | ❌ | ❌ | ✅ | ✅ |
| One payment | `GET /api/v1/admin/payments/:id` | ❌ | ❌ | ✅ | ✅ |
| Verify payment | `POST /api/v1/admin/payments/:id/verify` | ❌ | ❌ | ✅ | ✅ |
| Reject payment | `POST /api/v1/admin/payments/:id/reject` | ❌ | ❌ | ✅ | ✅ |
| Create payment method | `POST /api/v1/admin/payment-methods` | ❌ | ❌ | ❌ | ✅ |
| Update / deactivate payment method | `PATCH /api/v1/admin/payment-methods/:id` | ❌ | ❌ | ❌ | ✅ |
| Delete payment / payment method | *(no endpoint — soft deactivate only)* | ❌ | ❌ | ❌ | ❌ |

Notes:

- `GET /api/v1/payment-methods` is **public** (no auth chain; CHUNK 14A) and
  returns ACTIVE methods for every role — customers authenticate only when they
  actually need to submit a payment or place an order.
- Customer routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.CUSTOMER)`; the ownership layer (customer id filtering
  inside `PaymentService`) applies on top. Cross-customer payment reads and
  submissions resolve as **404 `PAYMENT_NOT_FOUND`** (never 403).
- Payment review routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.ADMIN, ROLES.STAFF)`. The acting id (`performedBy`,
  `verifiedBy`, `rejectedBy`) is always `req.user.id`; body/query
  `status`/`verifiedBy`/`rejectedBy`/`performedBy`/`role` are rejected.
- Payment-method management routes compose `authorizeRoles(ROLES.ADMIN)` only —
  STAFF cannot create/update payment methods.
- Deactivation is always soft (`isActive: false`) because payments snapshot the
  method at submission time; customers only ever see ACTIVE methods.
- A JWT `role` claim, `X-Role` header, `?role=` query, or body `role` cannot
  elevate a CUSTOMER into payment review or a STAFF into payment-method
  management — the stored application role is authoritative (proven by tests).

### 5.6 Returns & Refunds (decided — Phase 10)

Customer return requests on the customer's **own** order (ADR-0018). The return
surface is `CUSTOMER`-scoped like orders/payments: the service always operates
on the resources of `req.user.id`, and cross-customer return reads resolve as
**404 `RETURN_NOT_FOUND`** (never 403). Return review (approve/reject/complete/
cancel) is `ADMIN`+`STAFF`; refunds (process/void) are `ADMIN`+`STAFF` with no
customer-facing surface at all. The acting id is always `req.user.id`; body/
query `customerId`/`status`/`approvedBy`/`performedBy`/`role` are rejected or
ignored. Restock + refund happen ONLY at return completion, in one transaction.

| Action | Endpoint | Public (no auth) | `CUSTOMER` | `STAFF` | `ADMIN` |
| ------ | -------- | ---------------- | ---------- | ------- | ------- |
| Create return request | `POST /api/v1/orders/:orderId/returns` | ❌ | ✅ (own) | ❌ | ❌ |
| My returns for an order | `GET /api/v1/orders/:orderId/returns` | ❌ | ✅ (own) | ❌ | ❌ |
| One of my returns | `GET /api/v1/orders/:orderId/returns/:id` | ❌ | ✅ (own) | ❌ | ❌ |
| Cancel my PENDING return | `POST /api/v1/orders/:orderId/returns/:id/cancel` | ❌ | ✅ (own, PENDING only) | ❌ | ❌ |
| List returns | `GET /api/v1/admin/returns` | ❌ | ❌ | ✅ | ✅ |
| One return (admin view) | `GET /api/v1/admin/returns/:id` | ❌ | ❌ | ✅ | ✅ |
| Approve return | `POST /api/v1/admin/returns/:id/approve` | ❌ | ❌ | ✅ | ✅ |
| Reject return | `POST /api/v1/admin/returns/:id/reject` | ❌ | ❌ | ✅ | ✅ |
| Complete return (restock + refund) | `POST /api/v1/admin/returns/:id/complete` | ❌ | ❌ | ✅ | ✅ |
| Cancel return (admin) | `POST /api/v1/admin/returns/:id/cancel` | ❌ | ❌ | ✅ | ✅ |
| List refunds | `GET /api/v1/admin/refunds` | ❌ | ❌ | ✅ | ✅ |
| One refund | `GET /api/v1/admin/refunds/:id` | ❌ | ❌ | ✅ | ✅ |
| Process refund | `POST /api/v1/admin/refunds/:id/process` | ❌ | ❌ | ✅ | ✅ |
| Void refund | `POST /api/v1/admin/refunds/:id/void` | ❌ | ❌ | ✅ | ✅ |
| Edit return items/amounts/status / delete | *(no endpoint — snapshots + state machine only)* | ❌ | ❌ | ❌ | ❌ |

Notes:

- Customer return routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.CUSTOMER)`; the ownership layer (customer id filtering
  inside `ReturnService`) applies on top. Cross-customer return reads resolve as
  **404 `RETURN_NOT_FOUND`** (never 403).
- Staff/admin return + refund routes compose `authenticate → resolveCurrentUser
  → authorizeRoles(ROLES.ADMIN, ROLES.STAFF)`. The acting id (`approvedBy`,
  `rejectedBy`, `completedBy`, `cancelledBy`, `processedBy`, `voidedBy`) is
  always `req.user.id`; body/query `customerId`/`status`/`performedBy`/`role`
  are rejected or ignored.
- A JWT `role` claim, `X-Role` header, `?role=` query, or body `role` cannot
  elevate a CUSTOMER into return review or a STAFF beyond its grants — the
  stored application role is authoritative.
- The customer cannot cancel an `APPROVED` (or later) return — only `PENDING`;
  later states require staff (admin cancel).

### 5.7 Reviews (decided — Phase 12)

Product reviews: public `APPROVED`-only reads, `CUSTOMER` submission (identity
ALWAYS from `req.user.id`, every review created `PENDING`), and **`ADMIN`-only**
moderation (approve/reject). Reviews do not exist without an ACTIVE product
(unknown/inactive product → `404` `PRODUCT_NOT_FOUND` on public and customer
surfaces). The acting moderator id is always `req.user.id`; body/query
`customerId`/`status`/`approvedBy`/`performedBy`/`role` are rejected or ignored.
Approve/reject is an atomic conditional transition guarded on the current
status; both outcomes are terminal (no moderation reversal).

| Action | Endpoint | Public (no auth) | `CUSTOMER` | `STAFF` | `ADMIN` |
| ------ | -------- | ---------------- | ---------- | ------- | ------- |
| List a product's APPROVED reviews + rating summary | `GET /api/v1/products/:productId/reviews` | ✅ | ✅ | ✅ | ✅ |
| Submit a review (created PENDING) | `POST /api/v1/products/:productId/reviews` | ❌ | ✅ | ❌ | ❌ |
| List reviews (moderation queue, status filter) | `GET /api/v1/admin/reviews` | ❌ | ❌ | ❌ | ✅ |
| One review (admin view) | `GET /api/v1/admin/reviews/:id` | ❌ | ❌ | ❌ | ✅ |
| Approve review | `POST /api/v1/admin/reviews/:id/approve` | ❌ | ❌ | ❌ | ✅ |
| Reject review | `POST /api/v1/admin/reviews/:id/reject` | ❌ | ❌ | ❌ | ✅ |
| Force a status / impersonate identity / edit or delete a review | *(no endpoint — server-derived PENDING + terminal moderation only)* | ❌ | ❌ | ❌ | ❌ |

Notes:

- The public read is intentionally unauthenticated — it mirrors the storefront
  catalog (ACTIVE products only) and returns only `APPROVED` reviews; PENDING/
  REJECTED reviews and `customerId` are never exposed by public/customer
  surfaces.
- Customer submission routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.CUSTOMER)`. The customer id and display-name snapshot
  come exclusively from `req.user`; the create-body allowlist rejects
  `customerId`/`status`/`approvedBy` and Mongo operators.
- Admin review routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.ADMIN)` — moderation is **ADMIN-only**, so `STAFF` gets
  `403` `FORBIDDEN` (unlike payments/returns, where STAFF may review).
- A JWT `role` claim, `X-Role` header, `?role=` query, or body `role` cannot
  elevate a CUSTOMER into moderation or a STAFF into an ADMIN grant — the
  stored application role is authoritative.
- There is deliberately **no purchase-verification rule** for reviews.

### 5.8 Admin Customers (decided — Phase 15)

ADMIN-only read surface over the existing application `User` collection:
list + detail of all application users (customers, plus any `STAFF`/`ADMIN`
accounts) with validated `role`/`status` filters. There are **no customer
mutation endpoints** in this phase — the surface only reads records the auth
flow or trusted provisioning created.

| Action | Endpoint | Public (no auth) | `CUSTOMER` | `STAFF` | `ADMIN` |
| ------ | -------- | ---------------- | ---------- | ------- | ------- |
| List users (role/status filter) | `GET /api/v1/admin/customers` | ❌ | ❌ | ❌ | ✅ |
| One user (admin view) | `GET /api/v1/admin/customers/:id` | ❌ | ❌ | ❌ | ✅ |
| Suspend/disable/edit/delete a customer | *(no endpoint — future work)* | ❌ | ❌ | ❌ | ❌ |

Notes:

- Routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.ADMIN)` — **ADMIN-only**, so `STAFF` gets `403`
  `FORBIDDEN` (consistent with reviews/analytics, not with payments/returns
  where STAFF may review).
- The admin serializer never exposes `authProviderId` — authentication
  identifiers stay inside the backend.
- Query `role`/`status` values are validated against the real `ROLES` /
  `ACCOUNT_STATUSES` enums; unknown values → `400` `INVALID_USER_ROLE` /
  `INVALID_USER_STATUS`.

### 5.9 Admin Notifications (decided — Phase 15)

ADMIN-only **read** surface over the internal notification audit trail
(Phase 11, ADR-0019). Delivery remains internal (`maybeNotify` after committed
business operations); the `Notification` document has no read/unread state, so
no mark-as-read, inbox, or management endpoints exist.

| Action | Endpoint | Public (no auth) | `CUSTOMER` | `STAFF` | `ADMIN` |
| ------ | -------- | ---------------- | ---------- | ------- | ------- |
| List notifications (status/eventType filter) | `GET /api/v1/admin/notifications` | ❌ | ❌ | ❌ | ✅ |
| One notification (admin view) | `GET /api/v1/admin/notifications/:id` | ❌ | ❌ | ❌ | ✅ |
| Send / retry / mark-read a notification | *(no endpoint — delivery is internal, no read state)* | ❌ | ❌ | ❌ | ❌ |

Notes:

- Routes compose `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.ADMIN)` — **ADMIN-only**; `STAFF`/`CUSTOMER` get `403`.
- Only the safe `toNotificationOutput` shape is serialized — the internal
  `payload` audit snapshot never leaves the backend; consumers correlate via
  `entityRef`.
- Query `status`/`eventType` values are validated against the real enums;
  unknown values → `400` `INVALID_NOTIFICATION_STATUS` /
  `INVALID_NOTIFICATION_EVENT_TYPE`.

### 5.10 Other modules

The per-module permission matrix for the remaining business modules will be
finalized as each module is implemented (Phase 11+). The route-group mapping in
§3 is the enforcement floor and is already exercised by automated tests
(`tests/unit/auth/`, `tests/integration/me.test.js`,
`tests/integration/categories.test.js`, `tests/integration/products.test.js`,
`tests/integration/inventory.test.js`, `tests/integration/cart.test.js`,
`tests/integration/orders.test.js`, `tests/integration/adminOrders.test.js`,
`tests/integration/payments.test.js`, `tests/unit/returns/`,
`tests/unit/refunds/`, `tests/unit/reviews/`,
`tests/integration/reviews.test.js`, `tests/integration/adminCustomers.test.js`,
`tests/integration/adminNotifications.test.js`).

Note: the courier module (Phase 09, ADR-0017) is implemented — ADMIN/STAFF
dispatch/retry/cancel/list shipments and CUSTOMER reads own tracking — but its
per-module matrix is tracked in `docs/courier-state-machine.md` +
`docs/api-contract.md`; it will be folded into this file if/when the courier
phase is fully documented here.

## 6. Status Summary

- Roles: **decided** (Phase 00), centralized in `src/constants/index.js`.
- JWT verification + authentication identity (`req.auth`): **implemented** (Phase 02).
- Application user resolution (`req.user`) + account status: **implemented** (Phase 03).
- Role enforcement (`authorizeRoles`): **implemented** (Phase 02/03).
- Categories permission matrix: **decided** (Phase 04).
- Products permission matrix (incl. purchase-price privacy): **decided** (Phase 05).
- Inventory permission matrix (ADMIN-only stock/reservations): **decided** (Phase 06).
- Cart & orders permission matrix (customer-scoped cart/orders + ADMIN/STAFF
  order operations): **decided** (Phase 07).
- Payments & payment-methods permission matrix (customer-scoped submission +
  ADMIN/STAFF review + ADMIN-only method management): **decided** (Phase 08).
- Returns & refunds permission matrix (customer-scoped return requests +
  ADMIN/STAFF review + ADMIN/STAFF refund processing): **decided** (Phase 10).
- Reviews permission matrix (public APPROVED reads + CUSTOMER submission +
  ADMIN-only moderation): **decided** (Phase 12).
- Admin customers permission matrix (ADMIN-only read list/detail): **decided**
  (Phase 15).
- Admin notifications permission matrix (ADMIN-only read audit surface):
  **decided** (Phase 15).
- Per-module permission matrix (remaining modules): **planned** (with each business module).
- Ownership checks (customer-scoped cart/orders): **implemented** (Phase 07, in
  the domain services; cross-customer order reads → 404).
- Ownership checks (customer-scoped payments): **implemented** (Phase 08, in
  `PaymentService`; cross-customer payment reads/submissions → 404).
- Ownership checks (customer-scoped returns): **implemented** (Phase 10, in
  `ReturnService`; cross-customer return reads → 404).
