# Taqwa Backend — API Contract

Status: **Conventions established (Phase 00); auth conventions implemented (Phase 02); `/me` implemented (Phase 03); categories endpoints implemented (Phase 04); products endpoints implemented (Phase 05); inventory endpoints implemented (Phase 06); cart + orders + admin orders endpoints implemented (Phase 07); payments + payment-methods endpoints implemented (Phase 08); remaining endpoint contracts Planned**

## 1. Base Path & Versioning

- All API routes are prefixed with `/api/v1`.
- The version prefix is fixed for a released major version; breaking changes
  introduce a new major version.

## 2. Route Namespaces

| Namespace | Purpose | Auth |
| --------- | ------- | ---- |
| `/api/v1/public/*`   | Public/catalog-facing endpoints | Unauthenticated |
| `/api/v1/customer/*` | Customer self-service (own resources) | JWT (`CUSTOMER`) |
| `/api/v1/staff/*`    | Staff operational endpoints | JWT (`ADMIN`, `STAFF`) |
| `/api/v1/admin/*`    | Administrative endpoints | JWT (`ADMIN`) |
| `/api/v1/webhooks/*` | Provider webhooks (e.g., courier status) | Provider-signed |

## 3. Authentication

- The backend is a **resource server**: it does not log users in. Clients
  authenticate with a JWT issued by the frontend's Better Auth, sent as:
  `Authorization: Bearer <token>`.
- **Customer authentication is optional** (CHUNK 14A). Storefront reads are
  public (no token): catalog (products/categories), product reviews
  (APPROVED-only), and payment methods. Authenticated customers additionally
  get their own resources (cart, orders, `/me`); guest **checkout is not
  supported** — `POST /api/v1/orders/checkout` still requires a CUSTOMER token.
- Every protected route composes `authenticate` → `resolveCurrentUser` →
  `authorizeRoles(...)` (see `docs/architecture.md` §4). Two identities are
  used per request:
  - `req.auth` — the authentication identity `{ authProviderId, email?,
    displayName? }` from verified token claims.
  - `req.user` — the application identity `{ id, authProviderId, email,
    displayName, phone, role, status }` from the MongoDB `User` record.
- The application **role is read from `req.user.role`** (the database), never
  from the JWT, request body, query string, or headers. `X-Role`, `role`
  query/body fields, and similar inputs are ignored.

### 3.1 Auth and user-account errors

| Status | `error.code` | `message` | When |
| ------ | ------------ | --------- | ---- |
| `401`  | `UNAUTHORIZED` | `Authentication required` | Missing/malformed/expired/invalid token, or a token that cannot map to a trusted identity. |
| `403`  | `FORBIDDEN` | `You do not have permission to perform this action` | Authenticated but the role is not allowed for the route. |
| `403`  | `FORBIDDEN` | `User account not found` | Authenticated but no application user exists and auto-provisioning is disabled. |
| `403`  | `FORBIDDEN` | `Account is suspended` | Authenticated but the application account status is `SUSPENDED`. |
| `403`  | `FORBIDDEN` | `Account is disabled` | Authenticated but the application account status is `DISABLED`. |

Auth responses use the standard error envelope; tokens are never echoed or
logged.

## 4. Response Envelope

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

## 5. Error Codes

The code list is intentionally minimal and grows with each phase. Do not invent
codes ahead of need.

| Code            | Meaning |
| --------------- | ------- |
| `NOT_FOUND`     | Route or resource not found. |
| `INTERNAL_ERROR`| Unexpected server error (details never leaked). |
| `BAD_REQUEST`   | Request validation failed. |
| `UNAUTHORIZED`  | Missing or invalid credentials (see §3.1). |
| `FORBIDDEN`     | Authenticated but not permitted (see §3.1). |
| `CATEGORY_NOT_FOUND` | Category not found (or an inactive category on a public read). |
| `CATEGORY_ALREADY_EXISTS` | A category with the same `name` already exists. |
| `CATEGORY_SLUG_ALREADY_EXISTS` | A category with the same `slug` already exists. |
| `INVALID_CATEGORY` | Category payload/id validation failed (unknown, immutable, or operator fields; malformed id; empty patch). |
| `PRODUCT_NOT_FOUND` | Product not found (or inactive on a public read). |
| `INVALID_PRODUCT` | Product payload/id validation failed (unknown/immutable/operator fields, malformed id, invalid filters/sort, SKU immutability violation, empty patch). |
| `PRODUCT_SLUG_ALREADY_EXISTS` | A product with the same `slug` already exists. |
| `INVALID_MEASUREMENT_GUIDE` | Measurement guide validation failed (unknown fields, duplicate field keys, size rows not matching variant sizes, missing measurements). |
| `VARIANT_NOT_FOUND` | Variant id referenced in a PATCH does not belong to the product. |
| `INVALID_VARIANT` | Variant payload validation failed (unknown/operator keys, malformed SKU/attributes/prices). |
| `VARIANT_SKU_ALREADY_EXISTS` | A variant with the same `sku` already exists. |
| `VARIANT_DUPLICATE_ATTRIBUTES` | A variant with the same attribute set already exists for the product. |
| `INVENTORY_NOT_FOUND` | No inventory record for the variant (or no reservation found). |
| `INVENTORY_ALREADY_EXISTS` | Inventory already initialized for this variant (a second initialize). |
| `INSUFFICIENT_STOCK` | OFFLINE shortfall on a stock-out / transfer / negative adjust. |
| `INSUFFICIENT_AVAILABLE_STOCK` | ONLINE shortfall respecting reserved stock (stock-out, online transfer source, reserve, online decrease adjust). |
| `INVALID_STOCK_QUANTITY` | Quantity validation failed (non-integer, zero, negative, or above the max). |
| `INVALID_STOCK_TRANSFER` | Invalid transfer (e.g. `fromLocation === toLocation`). |
| `INVALID_INVENTORY_OPERATION` | Inventory payload/route validation failed (unknown/operator fields, malformed id, bad pagination, invalid location, inactive variant, missing `performedBy`). |
| `NEGATIVE_STOCK_FORBIDDEN` | A decrease would drive a quantity below zero (OFFLINE negative adjust, release of a quantity not reserved). |
| `RESERVATION_NOT_FOUND` | Reservation id not found. |
| `RESERVATION_NOT_ACTIVE` | Release/consume on a reservation in the other terminal state. |
| `RESERVATION_EXPIRED` | Reservation is expired (or `expiresAt` not in the future on create). |
| `RESERVATION_CONFLICT` | An active reservation already exists for the same reference. |
| `CART_NOT_FOUND` | No cart exists for the customer (or the cart was fully checked out / no active cart to mutate). |
| `CART_EMPTY` | Checkout attempted with an empty (or already-checked-out) cart. |
| `INVALID_CART_ITEM` | Cart item payload/id validation failed (malformed id, unknown/operator fields, inactive variant/product, invalid quantity). |
| `CART_ITEM_LIMIT` | Adding an item would exceed the cart item limit (100). |
| `ORDER_NOT_FOUND` | Order not found (or — for customer-scoped reads — the order belongs to another customer). |
| `ORDER_INVALID_STATE` | The requested state transition is not allowed from the order's current status (incl. the reserved `SHIPPED`/`DELIVERED`/`RETURN_*` states). |
| `ORDER_CANCELLATION_NOT_ALLOWED` | Cancellation denied for the order's current status (only `PENDING`/`CONFIRMED` may be cancelled). |
| `ORDER_CONFIRMATION_NOT_ALLOWED` | Confirmation denied (order not `PENDING`). |
| `ORDER_PROCESSING_NOT_ALLOWED` | Processing denied (order not `CONFIRMED`). |
| `ORDER_REJECTION_NOT_ALLOWED` | Rejection denied (order not `PENDING`). |
| `ORDER_IDEMPOTENCY_CONFLICT` | A checkout retry with the same `Idempotency-Key` presented a conflicting order body. |
| `INVALID_DELIVERY_ADDRESS` | Delivery address validation failed (missing/invalid fields, unsupported `country`, operator injection). |
| `CHECKOUT_FAILED` | Checkout could not be completed (e.g. a reserved-state conflict after order creation; the transaction rolls back). |
| `ORDER_NUMBER_GENERATION_FAILED` | Order-number generation collided beyond the bounded retry limit. |
| `PAYMENT_NOT_FOUND` | Payment not found (or — for customer reads — the payment's order belongs to another customer). |
| `PAYMENT_ALREADY_SUBMITTED` | A payment for the order already exists in a non-terminal state. |
| `PAYMENT_ALREADY_VERIFIED` | The payment is already `VERIFIED` (terminal). |
| `PAYMENT_INVALID_STATE` | The requested review transition is not allowed from the payment's current status (e.g. reviewing a `REJECTED` payment, or a lost race). |
| `INVALID_PAYMENT` | Payment payload/id validation failed (malformed id, unknown/operator/immutable fields, empty patch). |
| `INVALID_PAYMENT_AMOUNT` | Submitted `amountMinorUnits` does not exactly equal the order's `grandTotalMinorUnits`. |
| `PAYMENT_ORDER_NOT_ELIGIBLE` | The order is not eligible for manual payment (not the customer's own, `paymentMethod` not `MANUAL`, or status not `PENDING`/`CONFIRMED`). |
| `PAYMENT_IDEMPOTENCY_CONFLICT` | A retry with the same `Idempotency-Key` presented a conflicting body, or the `transactionReference` is already used by another non-rejected payment. |
| `PAYMENT_PROOF_REQUIRED` | The multipart submission did not include a proof file. |
| `INVALID_PAYMENT_PROOF` | The proof file failed validation (unsupported type/magic bytes, wrong extension, oversized file, or a duplicate file field). |
| `PAYMENT_PROOF_UPLOAD_FAILED` | The media adapter could not store the proof (e.g. Cloudinary error). |
| `PAYMENT_METHOD_NOT_FOUND` | Payment method not found (or inactive on a customer-facing read). |
| `PAYMENT_METHOD_INACTIVE` | The referenced payment method is deactivated. |
| `INVALID_PAYMENT_METHOD` | Payment-method payload/id validation failed (malformed id, unknown/operator/immutable fields, empty patch). |
| `PAYMENT_METHOD_CODE_ALREADY_EXISTS` | A payment method with the same normalized `code` already exists. |
| `INVALID_PAYMENT_STATUS` | Admin payment list filter `status` is not a valid payment status. |
| `RETURN_NOT_FOUND` | Return not found (or — for customer-scoped reads — the return belongs to another customer / a different order). |
| `INVALID_RETURN` | Return payload/id validation failed (malformed id, unknown/operator fields, missing/oversized `reason`, `items` not an array, bad pagination). |
| `INVALID_RETURN_STATUS` | Admin return list filter `status` is not a valid return status. |
| `RETURN_NOT_ELIGIBLE` | The order is not eligible for a return (not the customer's own, status not `CONFIRMED`/`PROCESSING`, or `paymentMethod` not `MANUAL`/`COD`). |
| `RETURN_WINDOW_EXPIRED` | The return window (30 days from `order.createdAt`) has expired. |
| `RETURN_ITEM_NOT_FOUND` | One or more requested `orderItemId`s do not belong to the order. |
| `RETURN_QUANTITY_EXCEEDED` | Requested return quantity exceeds the still-returnable quantity (order quantity minus already-returned). |
| `RETURN_ITEM_DUPLICATE` | The same `orderItemId` appears more than once in the request `items`. |
| `RETURN_INVALID_STATE` | The requested transition is not allowed from the return's current status (e.g. cancelling an `APPROVED` return as the customer, or a lost race). |
| `RETURN_IDEMPOTENCY_CONFLICT` | A retry with the same `Idempotency-Key` presented a conflicting return body (different fingerprint). |
| `RETURN_NUMBER_GENERATION_FAILED` | Return-number generation collided beyond the bounded retry limit. |
| `REFUND_NOT_FOUND` | Refund not found. |
| `INVALID_REFUND` | Refund payload/id validation failed (malformed id, unknown/operator fields, bad pagination). |
| `INVALID_REFUND_STATUS` | Admin refund list filter `status` is not a valid refund status. |
| `REFUND_INVALID_STATE` | The requested transition is not allowed from the refund's current status (e.g. processing a `VOIDED` refund, or a lost race). |
| `REFUND_RETURN_NOT_COMPLETED` | A refund may only be processed once its linked return is `COMPLETED`. |
| `REFUND_NUMBER_GENERATION_FAILED` | Refund-number generation collided beyond the bounded retry limit. |
| `REVIEW_NOT_FOUND` | Review not found. |
| `INVALID_REVIEW` | Review payload/id validation failed (malformed id, unknown/operator/identity fields, invalid rating/comment, non-object body). |
| `REVIEW_INVALID_STATE` | The requested moderation transition is not allowed from the review's current status (e.g. approving a `REJECTED` review, or a lost race). |
| `INVALID_REVIEW_STATUS` | Admin review list filter `status` is not a valid review status. |

## 6. Implemented Endpoints

### `GET /api/v1/health` (Phase 01)

Liveness probe. No business logic. Reports the safe database connection state
without exposing internal connection details or credentials.

Response `200`:

```json
{
  "success": true,
  "message": "Taqwa API is healthy",
  "data": {
    "database": "connected"
  }
}
```

### `GET /api/v1/me` (Phase 03)

Returns the current authenticated application user's profile.

Auth: `Authorization: Bearer <token>`.

Chain: `authenticate → resolveCurrentUser → getMe`.

Response `200`:

```json
{
  "success": true,
  "message": "User profile retrieved successfully",
  "data": {
    "user": {
      "id": "507f1f77bcf86cd799439011",
      "email": "amina@example.com",
      "displayName": "Amina Rahman",
      "phone": "+8801712345678",
      "role": "CUSTOMER",
      "status": "ACTIVE"
    }
  }
}
```

Notes:

- `authProviderId`, `_id`, `__v`, and all internal fields are NEVER serialized
  (see `docs/architecture.md` §4.2).
- Unknown identities are auto-provisioned as `CUSTOMER/ACTIVE` when
  `AUTO_PROVISION_CUSTOMERS=true` (default), otherwise → `403 "User account not
  found"`.
- The user's `role` reflects the application record, never the token's `role`
  claim.

Errors: see §3.1 (`401` for missing/invalid token; `403` for account
not-found / suspended / disabled).

### Categories (Phase 04)

Category taxonomy for the storefront catalog (ADR-0012). Categories are generic
database rows (no hard-coded product-type enums). Public reads are
unauthenticated and expose **ACTIVE** categories only; management is
**ADMIN-only** (`authorizeRoles(ROLES.ADMIN)`); STAFF and CUSTOMER cannot
mutate categories.

#### `GET /api/v1/categories` — list active categories

Public (no auth). Deterministic ordering: `sortOrder ASC, createdAt ASC`.
No pagination in this phase.

Response `200`:

```json
{
  "success": true,
  "message": "Categories retrieved successfully",
  "data": {
    "categories": [
      {
        "id": "507f1f77bcf86cd799439020",
        "name": "Jewelry",
        "slug": "jewelry",
        "description": null,
        "image": null,
        "isActive": true,
        "sortOrder": 0,
        "createdAt": "2026-08-01T00:00:00.000Z",
        "updatedAt": "2026-08-01T00:00:00.000Z"
      }
    ]
  }
}
```

#### `GET /api/v1/categories/:id` — get one active category

Public (no auth). `:id` must be a 24-char hex ObjectId string.

- `200` — category found and active.
- `400` `INVALID_CATEGORY` — malformed id.
- `404` `CATEGORY_NOT_FOUND` — unknown id, or the category exists but is
  inactive (soft deactivation is invisible to the storefront).

#### `GET /api/v1/categories/slug/:slug` — get one active category by slug

Public (no auth). `:slug` is normalized through the single `slugify` (e.g.
`/slug/ABAYAS` resolves the slug `abayas`).

- `200` — category found and active.
- `404` `CATEGORY_NOT_FOUND` — unknown or inactive slug.

#### `POST /api/v1/categories` — create a category (ADMIN only)

Auth: `Authorization: Bearer <token>`. Chain: `authenticate →
resolveCurrentUser → authorizeRoles(ADMIN) → createCategory`.

Body fields (all optional except `name`; unknown/immutable/operator keys like
`$set`, `_id`, `createdAt`, `role` are rejected with `400 INVALID_CATEGORY`):

| Field         | Type      | Notes |
| ------------- | --------- | ----- |
| `name`        | `String`  | Required, trimmed, max 100 chars. Must be unique. |
| `slug`        | `String`  | Optional, max 120 chars. Normalized via `slugify`. A normalized collision → `400 CATEGORY_SLUG_ALREADY_EXISTS`. Omit to auto-derive from `name` (`baby-dresses`, `baby-dresses-2`, ...). |
| `description` | `String`  | Optional, max 1000 chars, or `null`. |
| `image`       | `String`  | Optional http(s) URL, max 500 chars, or `null`. No upload. |
| `isActive`    | `Boolean` | Optional, default `true`. |
| `sortOrder`   | `Number`  | Optional integer 0–9999, default `0`. |

Response `201` with the safe category representation (see `GET /:id`).
`isActive` and `sortOrder` default when omitted.

Errors:

- `401` — missing/invalid token (§3.1).
- `403` — authenticated but not `ADMIN` (`CUSTOMER`/`STAFF`), including when a
  JWT `role` claim tries to claim `ADMIN` (the stored application role wins).
- `400` `CATEGORY_ALREADY_EXISTS` — duplicate `name`.
- `400` `CATEGORY_SLUG_ALREADY_EXISTS` — explicit `slug` collision.
- `400` `INVALID_CATEGORY` — validation failures, unknown fields, operator
  injection.

#### `PATCH /api/v1/categories/:id` — update a category (ADMIN only)

Auth: `Authorization: Bearer <token>`. Chain: `authenticate →
resolveCurrentUser → authorizeRoles(ADMIN) → updateCategory`.

PATCH semantics: only provided fields change; omitted fields are preserved.
Deactivation is `PATCH { "isActive": false }` — there is **no DELETE endpoint**
(ADR-0012). Field validation is identical to `POST` (all fields optional here).
Immutable/unknown/operator keys and an empty body → `400 INVALID_CATEGORY`.
Deactivated categories become invisible to the public reads above.

Response `200` with the updated safe category.

Errors: `401`, `403`, `400` (as `POST`), plus `404` `CATEGORY_NOT_FOUND` for an
unknown id.

### Products (Phase 05)

Catalog products + variants. Public reads are unauthenticated and expose
**ACTIVE** products only. Product creation is **STAFF + ADMIN**; product
updates (incl. variant replacement and deactivation) are **ADMIN-only**.
`purchasePrice` / `purchasePriceOverride` are accepted on writes but are only
ever serialized in **ADMIN** responses — the public catalog, STAFF responses,
and CUSTOMER responses never contain them. Money is integer minor units
(paisa): `৳1,500.00 = 150000`. There is **no DELETE** — deactivation is
`PATCH { "isActive": false }`.

#### `GET /api/v1/products` — list active products (public)

Public (no auth). Paginated storefront cards. Only ACTIVE products; unknown
query keys are ignored. Query params:

| Param      | Type     | Notes |
| ---------- | -------- | ----- |
| `page`     | `Number` | 1-indexed, default `1`. Must be a positive integer. |
| `limit`    | `Number` | Default `20`, max `100`. |
| `categoryId` | `ObjectId` | Filter by active category. |
| `featured` / `newArrival` / `bestDeal` | `'true'`/`'false'` | Flag filters. |
| `sort`     | `String` | `newest` (default), `priceAsc`, `priceDesc`, `featured`. Unknown → `400 INVALID_PRODUCT`. |

Cards include no variants and no measurement guide (fast grid); use the detail
endpoints for the full product.

Response `200`:

```json
{
  "success": true,
  "message": "Products retrieved successfully",
  "data": {
    "products": [
      {
        "id": "507f1f77bcf86cd799439022",
        "name": "Premium Abaya",
        "slug": "premium-abaya",
        "category": { "id": "507f1f77bcf86cd799439020", "name": "Abayas", "slug": "abayas" },
        "image": { "url": "https://cdn.example.com/abaya.jpg", "altText": "Premium Abaya" },
        "sellingPrice": 150000,
        "discount": { "type": "percentage", "value": 10 },
        "effectiveSellingPrice": 135000,
        "featured": false,
        "newArrival": false,
        "bestDeal": false
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
  }
}
```

`effectiveSellingPrice` is computed centrally from `sellingPrice`/override and
`discount`; it is never stored. `purchasePrice` never appears here.

Errors: `400 INVALID_PRODUCT` — malformed `page`/`limit`/`sort`, invalid
`categoryId` (24-char hex ObjectId).

#### `GET /api/v1/products/:id` — get one active product (public)

Public (no auth). `:id` must be a 24-char hex ObjectId string. Full product:
fields + variants + measurement guide (when present) + `effectiveSellingPrice`
per variant. No `purchasePrice` fields anywhere.

- `200` — product found and active.
- `400` `INVALID_PRODUCT` — malformed id.
- `404` `PRODUCT_NOT_FOUND` — unknown or inactive product.

#### `GET /api/v1/products/slug/:slug` — get one active product by slug (public)

Public (no auth). `:slug` is normalized through the single `slugify`
(e.g. `/slug/PREMIUM ABAYA` resolves `premium-abaya`).

- `200` — product found and active.
- `404` `PRODUCT_NOT_FOUND` — unknown or inactive slug.

#### `POST /api/v1/products` — create product + initial variants (STAFF + ADMIN)

Auth: `Authorization: Bearer <token>`. Chain: `authenticate →
resolveCurrentUser → authorizeRoles(ADMIN, STAFF) → createProduct`.

The product and its initial variants (when provided) commit **atomically** in one
MongoDB transaction. Variants are **optional** — `variants: []` or an omitted
`variants` creates a product with no variants. Unknown/immutable/operator keys
(`$set`, `_id`, `createdAt`, `role`, `stock`, ...) → `400 INVALID_PRODUCT`.

Body fields:

| Field | Type | Notes |
| ----- | ---- | ----- |
| `name` | `String` | Required, trimmed, max 150 chars. |
| `categoryId` | `ObjectId` | Required. Must reference an **ACTIVE** category → else `400 INVALID_CATEGORY`. |
| `sellingPrice` | `Number` | Required, integer 1 – 100,000,000 (paisa). |
| `variants` | `Array` | Optional; may be omitted or `[]` (product without variants). Each entry: `{ sku, attributes?, sellingPriceOverride?, purchasePriceOverride? }`. `sku` trimmed+uppercased, globally unique → else `400 VARIANT_SKU_ALREADY_EXISTS`; duplicate attribute sets → `400 VARIANT_DUPLICATE_ATTRIBUTES`. |
| `slug` | `String` | Optional; normalized via `slugify`. Collision → `400 PRODUCT_SLUG_ALREADY_EXISTS`. Omit to derive from `name` (`premium-abaya`, `premium-abaya-2`, ...). |
| `description` | `String` | Optional, max 5000 chars. |
| `images` | `Array` | Optional, max 10 `{ url, altText }`; http(s) URLs only (no upload). |
| `purchasePrice` | `Number` | Optional (paisa). Stored; serialized in **ADMIN** responses only. |
| `discount` | `Object` | Optional `{ type: 'percentage'\|'fixed', value }`; percentage 1–99, fixed cannot exceed selling price. |
| `featured` / `newArrival` / `bestDeal` | `Boolean` | Optional, default `false`. |
| `measurementGuide` | `Object` | Optional image-only guide `{ imageUrl }` — an http(s) URL uploaded through the media system. Omit or `null` for no guide; an empty object also means no guide → else `400 INVALID_MEASUREMENT_GUIDE`. Legacy structured `{ unit, fields[], sizes[] }` payloads are **rejected** on write. |

Response `201` — the full product. `purchasePrice` appears **only** when the
caller is `ADMIN` (role from the stored application user, never the JWT).
STAFF responses are identical minus `purchasePrice`/`purchasePriceOverride`.

Errors: `401`; `403` (`CUSTOMER` denied; JWT `role` claim spoofing never
elevates); `400` `INVALID_CATEGORY` (inactive/unknown category),
`PRODUCT_SLUG_ALREADY_EXISTS`, `INVALID_MEASUREMENT_GUIDE`,
`VARIANT_SKU_ALREADY_EXISTS`, `VARIANT_DUPLICATE_ATTRIBUTES`,
`INVALID_PRODUCT`.

#### `PATCH /api/v1/products/:id` — update product + replace variants (ADMIN only)

Auth: `Authorization: Bearer <token>`. Chain: `authenticate →
resolveCurrentUser → authorizeRoles(ADMIN) → updateProduct`.

PATCH semantics: only provided fields change; omitted fields are preserved.
Deactivation is `PATCH { "isActive": false }` — no DELETE. Field validation is
identical to `POST` (all optional here); an empty patch → `400 INVALID_PRODUCT`.

`variants` (optional) is the **full replacement spec** for the product's
variant set, applied atomically in one transaction:

- entry **with** `id` → updates that existing variant (only fields present in
  the entry change).
- entry **without** `id` → creates a new variant.
- existing variant not referenced by any `id` → **deactivated** (never deleted).

Rules: SKU is **immutable** — a change attempt → `400 INVALID_PRODUCT` ("SKU
cannot be changed after creation"). Referencing an `id` that does not belong to
the product → `404 VARIANT_NOT_FOUND`. Duplicate SKU / duplicate attribute sets
→ `400` as in `POST`. A `measurementGuide` change follows the same image-only
rules as `POST` → `400 INVALID_MEASUREMENT_GUIDE`.

Response `200` — the updated full product. `purchasePrice`/`purchasePriceOverride`
in the ADMIN-only (the route is ADMIN-only by default, and the serializer
additionally gates on the application role).

Errors: `401`; `403` (`STAFF`/`CUSTOMER` denied); `404` `PRODUCT_NOT_FOUND` /
`VARIANT_NOT_FOUND`; `400` as in `POST` plus SKU-immutability.

### Inventory (Phase 06)

Per-variant stock control (`src/modules/inventory/`, ADR-0014). **ALL endpoints
are ADMIN-only** (`authenticate → resolveCurrentUser → authorizeRoles(ADMIN)`);
STAFF and CUSTOMER get 403, and JWT `role` claims / body / query / header role
spoofing never elevates. There is **no generic inventory PATCH and no DELETE**
— mutations are explicit business commands, and corrections are new ledger
movements. Every mutation runs in one MongoDB transaction and appends an
**immutable** `InventoryMovement`; the acting user (`performedBy`) always comes
from `req.user.id`, never from the body (body `performedBy`/`role`/`_id`/`$set`
are rejected). The inventory SUBJECT is either a **Simple Product** (`productId`
with `productVariantId: null`) or a **ProductVariant** (`productId` +
`productVariantId`); legacy clients may send `productVariantId` alone and the
service resolves the owning product. Every subject is backed by the ACTIVE
catalog — inventory never duplicates catalog data.

Money-style integers apply to quantities: non-negative integers, max
`1,000,000,000`. Derived values (never stored) are returned in every inventory
response: `availableOnlineQuantity = onlineQuantity - reservedQuantity`,
`totalPhysicalQuantity = onlineQuantity + offlineQuantity`, `isLowStock`,
`isOutOfStock`. Every serialized record carries `isInitialized: true`; the list
endpoint appends synthetic `isInitialized: false` rows for ACTIVE products
with no record (see `GET /api/v1/inventory`).

#### `POST /api/v1/inventory/initialize` — create inventory for a subject

Auth: `Authorization: Bearer <token>` (ADMIN). Chain: `authenticate →
resolveCurrentUser → authorizeRoles(ADMIN) → initializeInventory`.

Body fields:

| Field | Type | Notes |
| ----- | ---- | ----- |
| `productId` | `ObjectId` | **Required unless `productVariantId` is given.** For a Simple Product send `productId` with `productVariantId: null`. |
| `productVariantId` | `ObjectId` | Optional, defaults `null`. Must reference an **ACTIVE** variant → else `404 VARIANT_NOT_FOUND` / `400 INVALID_INVENTORY_OPERATION` (inactive). |
| `outletId` | `ObjectId` | Optional. Per-outlet stock; omitted = the central pool (`outletId: null`). |
| `onlineQuantity` | `Number` | Optional non-negative integer, default `0`. |
| `offlineQuantity` | `Number` | Optional non-negative integer, default `0`. |
| `lowStockThreshold` | `Number` | Optional non-negative integer, default `0`. |

The `INITIAL_STOCK` ledger is seeded ONLINE-first then OFFLINE, skipping zero
quantities. A second initialize for the same subject (same `productId` +
`productVariantId` + `outletId`) → `409 INVENTORY_ALREADY_EXISTS` (use
`stock-in` to add).

Response `201` with `data.inventory`. Errors: `401`; `403`; `400`
`INVALID_INVENTORY_OPERATION` (bad id, inactive variant, operator/unknown
fields) / `INVALID_STOCK_QUANTITY`; `404` `VARIANT_NOT_FOUND`; `409`
`INVENTORY_ALREADY_EXISTS`.

#### `POST /api/v1/inventory/stock-in` — physically add stock

Auth: ADMIN. Body: `productVariantId` (required), `location` (`ONLINE` |
`OFFLINE`, required), `quantity` (positive integer, required), `reason`
(optional, max 500). Unconditional atomic increase.

Response `200` with `data.inventory`. Errors: `401`; `403`; `400`
`INVALID_INVENTORY_OPERATION` / `INVALID_STOCK_QUANTITY`; `404`
`INVENTORY_NOT_FOUND` (no inventory record — initialize first).

#### `POST /api/v1/inventory/stock-out` — physically remove stock

Auth: ADMIN. Body: same shape as `stock-in`.

Atomic conditional decrease: `ONLINE` must keep `availableOnlineQuantity >=
quantity` (never dip below reserved) → else `409
INSUFFICIENT_AVAILABLE_STOCK`; `OFFLINE` must have the physical quantity → else
`409 INSUFFICIENT_STOCK`. Response `200` with `data.inventory`.

#### `POST /api/v1/inventory/transfer` — move stock between locations

Auth: ADMIN. Body: `productVariantId` (required), `fromLocation` /
`toLocation` (`ONLINE` | `OFFLINE`, must differ → else `400
INVALID_STOCK_TRANSFER`), `quantity` (positive integer), `reason` (optional).

Atomic conditional decrease from the source; an `ONLINE` source respects
reserved stock. Errors as `stock-out`. Response `200` with `data.inventory`.

#### `POST /api/v1/inventory/adjust` — correct a location by a signed delta

Auth: ADMIN. Body: `productVariantId` (required), `location` (required),
`quantity` (non-zero signed integer; positive = increase, negative = decrease),
`reason` (optional).

Negative `ONLINE` adjust respects reserved stock → `409
INSUFFICIENT_AVAILABLE_STOCK`; negative `OFFLINE` adjust below zero → `409
NEGATIVE_STOCK_FORBIDDEN`. The ledger records `ADJUSTMENT` with
`quantity = |delta|` and the direction in `fromLocation`/`toLocation`. Response
`200` with `data.inventory`.

#### `GET /api/v1/inventory` — list all inventory + Not-initialized products (ADMIN)

Paginated (`page` 1-indexed default `1`; `limit` default `20`, max `100`;
unknown pagination → `400 INVALID_INVENTORY_OPERATION`). Returns inventory
records first (newest first), then appends a synthetic "Not initialized" row
for every ACTIVE product that has no inventory record (no Simple-Product
record and no record for any of its ACTIVE variants) — so admins can spot and
initialize catalog products never set up. **Listing never creates records**:
an uninitialized row has `id: null`, `productVariantId: null`,
`isInitialized: false`, `productName` set, all quantities `0`, and
`createdAt`/`updatedAt` `null`. `pagination.total` counts both records and
synthetic rows. Response `200`:

```json
{
  "success": true,
  "message": "Inventory retrieved successfully",
  "data": {
    "inventory": [
      {
        "id": "507f1f77bcf86cd799439030",
        "productId": "507f1f77bcf86cd799439010",
        "productVariantId": "507f1f77bcf86cd799439011",
        "outletId": null,
        "isInitialized": true,
        "productName": null,
        "onlineQuantity": 20,
        "offlineQuantity": 10,
        "reservedQuantity": 5,
        "availableOnlineQuantity": 15,
        "totalPhysicalQuantity": 30,
        "isLowStock": false,
        "isOutOfStock": false,
        "lowStockThreshold": 5,
        "createdAt": "2026-08-08T00:00:00.000Z",
        "updatedAt": "2026-08-08T00:00:00.000Z"
      },
      {
        "id": null,
        "productId": "507f1f77bcf86cd799439012",
        "productVariantId": null,
        "outletId": null,
        "isInitialized": false,
        "productName": "Simple Hijab",
        "onlineQuantity": 0,
        "offlineQuantity": 0,
        "reservedQuantity": 0,
        "availableOnlineQuantity": 0,
        "totalPhysicalQuantity": 0,
        "isLowStock": true,
        "isOutOfStock": true,
        "lowStockThreshold": 0,
        "createdAt": null,
        "updatedAt": null
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 2, "totalPages": 1 }
  }
}
```

#### `GET /api/v1/inventory/low-stock` — low/out-of-stock items (ADMIN)

`availableOnlineQuantity <= lowStockThreshold` (i.e. `isLowStock`). Response
`200` with `data.inventory` (array). No pagination.

#### `GET /api/v1/inventory/:productVariantId` — one variant's inventory (ADMIN)

- `200` — `data.inventory` (shape above).
- `400` `INVALID_INVENTORY_OPERATION` — malformed id.
- `404` `INVENTORY_NOT_FOUND` — no inventory record.

#### `GET /api/v1/inventory/:productVariantId/movements` — variant ledger (ADMIN)

Paginated list of `InventoryMovement` records, newest first. The movement count
includes the `INITIAL_STOCK` seed. Response `200`:

```json
{
  "success": true,
  "message": "Inventory movements retrieved successfully",
  "data": {
    "movements": [
      {
        "id": "507f1f77bcf86cd799439031",
        "inventoryId": "507f1f77bcf86cd799439030",
        "productVariantId": "507f1f77bcf86cd799439011",
        "type": "STOCK_IN",
        "quantity": 10,
        "fromLocation": null,
        "toLocation": "ONLINE",
        "reason": "restock",
        "referenceType": null,
        "referenceId": null,
        "performedBy": "507f1f77bcf86cd799439001",
        "createdAt": "2026-08-08T00:00:00.000Z"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
  }
}
```

Errors: `400` malformed id; `404` `INVENTORY_NOT_FOUND`.

#### Reservations

Lifecycle `ACTIVE → RELEASED | CONSUMED | EXPIRED` (terminal). Reservations
use generic `referenceType`/`referenceId` (Orders arrive in a later phase; no
order identifiers are invented). Resolution is **idempotent**: release of
`RELEASED` and consume of `CONSUMED` are retry-safe no-ops (success);
release/consume of the other terminal state → `409 RESERVATION_NOT_ACTIVE`; an
expired ACTIVE reservation auto-expires then → `409 RESERVATION_EXPIRED`.

##### `POST /api/v1/inventory/reservations` — reserve ONLINE stock (ADMIN)

Body fields:

| Field | Type | Notes |
| ----- | ---- | ----- |
| `productVariantId` | `ObjectId` | **Required.** Must reference an **ACTIVE** variant with existing inventory. |
| `quantity` | `Number` | **Required**, positive integer. Must be ≤ `availableOnlineQuantity` → else `409 INSUFFICIENT_AVAILABLE_STOCK`. |
| `referenceType` | `String` | **Required**, non-empty, max 50. |
| `referenceId` | `String` | **Required**, non-empty, max 100. |
| `expiresAt` | `Date` | Optional ISO date, must be in the future → else `400 RESERVATION_EXPIRED`. |
| `metadata` | `Object` | Optional free-form; `$`-prefixed keys rejected. |

An active reservation for the same `(referenceType, referenceId)` → `409
RESERVATION_CONFLICT`. Response `201` with `data.reservation`.

##### `POST /api/v1/inventory/reservations/:id/release` — release (ADMIN)

Returns the reserved quantity to availability. Response `200` with `data =
{ reservation, inventory }` (`inventory` is `null` for idempotent retries).

##### `POST /api/v1/inventory/reservations/:id/consume` — consume (ADMIN)

Moves the reserved quantity physically out of ONLINE. Response `200` with
`data = { reservation, inventory }`.

##### `POST /api/v1/inventory/reservations/:id/expire` — expire (ADMIN)

Releases an ACTIVE reservation (`reason: "expired"`); terminal reservations
are a no-op. Response `200` with `data.reservation`.

##### `GET /api/v1/inventory/reservations` — list reservations (ADMIN)

Query params: `productVariantId` (optional ObjectId), `status` (optional one of
`ACTIVE`/`RELEASED`/`CONSUMED`/`EXPIRED` → else `400
INVALID_INVENTORY_OPERATION`), `page`, `limit`. Response `200` with
`data.reservations` + `data.pagination`.

##### `GET /api/v1/inventory/reservations/:id` — one reservation (ADMIN)

- `200` — `data.reservation`:

```json
{
  "id": "507f1f77bcf86cd799439032",
  "productVariantId": "507f1f77bcf86cd799439011",
  "quantity": 5,
  "status": "ACTIVE",
  "expiresAt": null,
  "referenceType": "ORDER",
  "referenceId": "ord-1234",
  "metadata": {},
  "createdBy": "507f1f77bcf86cd799439001",
  "resolvedAt": null,
  "resolvedBy": null,
  "createdAt": "2026-08-08T00:00:00.000Z",
  "updatedAt": "2026-08-08T00:00:00.000Z"
}
```

- `400` `INVALID_INVENTORY_OPERATION` — malformed id; `404`
  `RESERVATION_NOT_FOUND` — unknown id.

### Cart (Phase 07)

Server-side draft cart, **one per customer** (`src/modules/cart/`). All cart
endpoints require auth and are **customer-scoped**: the service always operates
on the cart of `req.user.id`; no cart body ever carries a customer id, user id,
prices, discounts, or fees (client money is never trusted). The cart stores
only `productVariantId` + `quantity`. Unknown/operator keys (`$set`, `_id`,
`customerId`, `userId`, `price`, ...) → `400 INVALID_CART_ITEM`.

Auth: `Authorization: Bearer <token>`. Chain: `authenticate →
resolveCurrentUser → cart*`.

#### `GET /api/v1/cart` — get my cart

Returns the customer's cart with **live** catalog + availability enrichment:
every line resolves its active product/variant; `priceMinorUnits` is the
current effective price and `availableOnlineQuantity` the current availability
(computed via the inventory module — both can change between cart reads; the
cart itself stores neither). An empty/absent cart returns `items: []`.

Response `200`:

```json
{
  "success": true,
  "message": "Cart retrieved successfully",
  "data": {
    "cart": {
      "id": "507f1f77bcf86cd799439040",
      "customerId": "507f1f77bcf86cd799439011",
      "items": [
        {
          "id": "507f1f77bcf86cd799439041",
          "productVariantId": "507f1f77bcf86cd799439012",
          "productId": "507f1f77bcf86cd799439013",
          "quantity": 2,
          "product": {
            "name": "Premium Abaya",
            "slug": "premium-abaya"
          },
          "variant": {
            "attributes": { "size": "52" },
            "sku": "ABY-52"
          },
          "priceMinorUnits": 135000,
          "availableOnlineQuantity": 15
        }
      ],
      "itemCount": 2,
      "itemsSubtotalMinorUnits": 270000,
      "isCheckedOut": false,
      "createdAt": "2026-08-08T00:00:00.000Z",
      "updatedAt": "2026-08-08T00:00:00.000Z"
    }
  }
}
```

#### `POST /api/v1/cart/items` — add an item (or bump quantity)

Body fields:

| Field | Type | Notes |
| ----- | ---- | ----- |
| `productVariantId` | `ObjectId` | **Required.** Must reference an **ACTIVE** variant of an **ACTIVE** product → else `404` `INVALID_CART_ITEM`. |
| `quantity` | `Number` | **Required**, positive integer ≤ `1,000,000,000` → else `400 INVALID_CART_ITEM`. |

Adding an already-present variant increments its quantity (new total must stay
within the quantity limit → `400 INVALID_CART_ITEM`). Adding a new line that
would push the cart past 100 items → `409 CART_ITEM_LIMIT`. Quantity is
validated at checkout too, so an over-limit cart can still be listed/cleared.

Response `200` with the enriched cart (above). Errors: `401`; `400`
`INVALID_CART_ITEM`; `409 CART_ITEM_LIMIT`; `404` `INVALID_CART_ITEM`
(inactive/unknown variant).

#### `PATCH /api/v1/cart/items/:id` — set an item's quantity

`:id` is the cart-item subdocument id. Body: `{ "quantity": 3 }` — required,
positive integer. The item must exist in the customer's cart → else `404
INVALID_CART_ITEM`. Response `200` with the enriched cart.

#### `DELETE /api/v1/cart/items/:id` — remove an item

Response `200` with the enriched cart. Unknown item id → `404
INVALID_CART_ITEM`.

#### `DELETE /api/v1/cart` — clear the cart

Clears all items (idempotent; an empty cart succeeds). Response `200`.

### Orders — customer (Phase 07)

Customer-facing order endpoints (`src/modules/orders/`). All are
customer-scoped: the service only ever reads/writes orders of `req.user.id`.
Cross-customer access to another customer's order → **404 `ORDER_NOT_FOUND`**
(never 403, to avoid leaking existence). All money is integer minor units and
server-derived. Order status machine, reserved states, and errors are
documented in `docs/order-state-machine.md`.

Auth: `Authorization: Bearer <token>`. Chain: `authenticate →
resolveCurrentUser → orders*`.

#### `POST /api/v1/orders/checkout` — create an order

Body fields (unknown/operator keys, client `totals`, `deliveryFee`,
`discount`, `orderNumber`, `status`, `userId`, `$set`, ... are rejected →
`400 INVALID_...`):

| Field | Type | Notes |
| ----- | ---- | ----- |
| `delivery` | `Object` | **Required.** `{ address: { fullName, phone, line1, line2?, city, area, district, postalCode, country }, zone? }`. `country` must be `BD` (else `400 INVALID_DELIVERY_ADDRESS`). `zone` (optional) is the customer-selected delivery-charge zone (`INSIDE_CHITTAGONG` / `OUTSIDE_CHITTAGONG`, validated → else `400 INVALID_ORDER`); when omitted the address-derived zone is used. `deliveryFeeMinorUnits` is server-derived and rejected if provided. |
| `notes` | `String` | Optional, max 1000 chars. |
| `paymentMethod` | `String` | Optional; `COD` or `MANUAL` (default `COD`). `CARD`/other values → `400 INVALID_ORDER`. A `MANUAL` order is later paid through the payments endpoints (§ Payments below). |

Headers: `Idempotency-Key` (**required** for checkout, non-empty, max 100
chars). A retry with the same key returns the original order; a conflicting
body under the same key → `409 ORDER_IDEMPOTENCY_CONFLICT`.

Server flow (one MongoDB transaction): load the cart → validate every line
against the live ACTIVE catalog → compute price snapshots (effective price via
`computeEffectiveSellingPrice`, never client values) → resolve `zone` (the
validated customer selection, falling back to `classifyDeliveryZone`) → reserve ONLINE stock per line
(`createReservationInTransaction`, bypassing the service-level single-reference
guard; the unique reference is `{referenceType: 'ORDER', referenceId:
orderId}`) → create the Order + embedded OrderItems + `statusHistory` →
`isCheckedOut: true` on the cart (items cleared in the same commit). Any
failure rolls everything back (no partial order, no leaked reservations).

Response `201`:

```json
{
  "success": true,
  "message": "Order created successfully",
  "data": {
    "order": {
      "id": "507f1f77bcf86cd799439050",
      "orderNumber": "TAQ-20260808-000001",
      "customerId": "507f1f77bcf86cd799439011",
      "status": "PENDING",
      "statusHistory": [
        { "status": "PENDING", "at": "2026-08-08T00:00:00.000Z", "by": "507f1f77bcf86cd799439011", "note": null }
      ],
      "totals": {
        "itemsSubtotalMinorUnits": 270000,
        "totalDiscountMinorUnits": 30000,
        "deliveryFeeMinorUnits": 8000,
        "grandTotalMinorUnits": 248000
      },
      "delivery": {
        "address": {
          "fullName": "Amina Rahman",
          "phone": "+8801712345678",
          "line1": "12 Chawk Bazar",
          "line2": null,
          "city": "Chattogram",
          "area": "Chawk Bazar",
          "district": "Chattogram",
          "postalCode": "4203",
          "country": "BD"
        },
        "zone": "INSIDE_CHITTAGONG",
        "deliveryFeeMinorUnits": 8000
      },
      "items": [
        {
          "id": "507f1f77bcf86cd799439051",
          "productId": "507f1f77bcf86cd799439013",
          "productVariantId": "507f1f77bcf86cd799439012",
          "productName": "Premium Abaya",
          "variantAttributes": { "size": "52" },
          "sku": "ABY-52",
          "quantity": 2,
          "unitPriceMinorUnits": 135000,
          "discountMinorUnits": 15000,
          "lineTotalMinorUnits": 270000
        }
      ],
      "paymentMethod": "COD",
      "notes": null,
      "createdAt": "2026-08-08T00:00:00.000Z",
      "updatedAt": "2026-08-08T00:00:00.000Z"
    }
  }
}
```

Errors: `401`; `400` `CART_EMPTY` (empty/checked-out cart),
`INVALID_CART_ITEM` (bad line/inactive catalog/missing `Idempotency-Key`),
`INVALID_DELIVERY_ADDRESS`; `404` `INVALID_CART_ITEM` (unknown/inactive
variant); `409` `INSUFFICIENT_AVAILABLE_STOCK` (a line cannot be reserved),
`ORDER_IDEMPOTENCY_CONFLICT` (same key, conflicting body); `500`
`CHECKOUT_FAILED` / `ORDER_NUMBER_GENERATION_FAILED` (rolled back).

#### `GET /api/v1/orders` — my order history

Customer-scoped; newest first. Query: `page`, `limit` (same conventions;
unknown pagination → `400 ORDER_NOT_FOUND`... use `400 BAD_REQUEST`/order code).
Response `200` with `data.orders` + `data.pagination`. Serialized orders expose
snapshots and totals but **no** reservation internals.

#### `GET /api/v1/orders/:id` — one of my orders

- `200` — `data.order`.
- `400` — malformed id (`ORDER_NOT_FOUND`).
- `404` `ORDER_NOT_FOUND` — unknown id, or the order belongs to another
  customer.

#### `POST /api/v1/orders/:id/cancel` — cancel a pending/confirmed order

Customer cancellation. Only `PENDING` / `CONFIRMED` may be cancelled → else
`409 ORDER_CANCELLATION_NOT_ALLOWED` (terminal orders, and `PROCESSING`+,
cannot be cancelled by the customer). Cancelling releases all ACTIVE
reservations for the order and appends a `CANCELLED` history entry, all in one
transaction. Response `200` with `data.order`.

### Admin / Staff Orders (Phase 07)

Mounted at `/api/v1/admin/orders` (`src/modules/orders/adminOrder.routes.js`).
Auth: `authenticate → resolveCurrentUser → authorizeRoles(ADMIN, STAFF)` for
list/detail/confirm/process/reject — both `ADMIN` and `STAFF` may operate on
orders in Phase 07 (ADR-0015). The acting staff/admin id always comes from
`req.user.id`; body `performedBy`/`role` are rejected.

State machine: `PENDING → CONFIRMED → PROCESSING` and `PENDING → REJECTED`
(staff), `PENDING|CONFIRMED → CANCELLED` (customer + admin). `SHIPPED` /
`DELIVERED` / `RETURN_REQUESTED` / `RETURNED` are reserved for future phases
(any attempt → `409 ORDER_INVALID_STATE`).

#### `GET /api/v1/admin/orders` — list orders

Query params: `page`, `limit`, `status` (one of the reachable statuses, else
`400 BAD_REQUEST`), `customerId` (optional ObjectId filter). Response `200`
with `data.orders` + `data.pagination`. Admin serialization includes the same
snapshot fields; reservation ids are exposed to admins for traceability.

#### `GET /api/v1/admin/orders/:id` — one order (ADMIN/STAFF)

- `200` — `data.order`.
- `400` — malformed id.
- `404` `ORDER_NOT_FOUND` — unknown id.

#### `POST /api/v1/admin/orders/:id/confirm` — confirm a PENDING order

Body: `note` (optional, max 500). `PENDING → CONFIRMED`. Appends history;
reservations stay ACTIVE (stock remains held until fulfillment). Errors: `401`;
`403` (`CUSTOMER`); `404` `ORDER_NOT_FOUND`; `409
ORDER_CONFIRMATION_NOT_ALLOWED` (not `PENDING`).

#### `POST /api/v1/admin/orders/:id/process` — move a CONFIRMED order to PROCESSING

Body: `note` (optional, max 500). `CONFIRMED → PROCESSING`. Errors: as
confirm, with `409 ORDER_PROCESSING_NOT_ALLOWED` (not `CONFIRMED`).

#### `POST /api/v1/admin/orders/:id/reject` — reject a PENDING order

Body: `note` (optional, max 500). `PENDING → REJECTED` (terminal). Releases all
ACTIVE reservations in the same transaction. Errors: `409
ORDER_REJECTION_NOT_ALLOWED` (not `PENDING`).

### Payments — customer (Phase 08)

Manual (bank transfer) payment proofs (`src/modules/payments/`, ADR-0016). The
payment lifecycle is **decoupled from the order lifecycle**:
`UNPAID → SUBMITTED → VERIFIED | REJECTED`, `REJECTED → SUBMITTED`;
`UNPAID` is never persisted (the record is created on first submission) and
there is exactly **one payment per order**. Reviewing a payment **never
auto-confirms the order** — the payment service never mutates the Order
document. `CARD`/other methods are rejected at order validation; only
`MANUAL` orders are payable here (cash-on-delivery has no proof step).

Auth: `Authorization: Bearer <token>`. Chain: `authenticate →
resolveCurrentUser → payments*`.

#### `GET /api/v1/orders/:orderId/payment` — get my order's payment

Customer-scoped: the service only reads the payment of `req.user.id`'s order.
Response `200`:

```json
{
  "success": true,
  "message": "Payment retrieved successfully",
  "data": {
    "payment": {
      "id": "507f1f77bcf86cd799439060",
      "orderId": "507f1f77bcf86cd799439050",
      "status": "SUBMITTED",
      "amountMinorUnits": 270000,
      "paymentMethod": {
        "code": "BANK_TRANSFER",
        "displayName": "Bank Transfer",
        "accountNumber": "xxxx-xxxx-xxxx-0001"
      },
      "transactionReference": "bkash-49382",
      "proof": {
        "provider": "cloudinary",
        "publicId": "payments/71e43b4f-....",
        "secureUrl": "https://res.cloudinary.com/.../payments/71e43b4f-....jpg",
        "resourceType": "image",
        "format": "jpg"
      },
      "createdAt": "2026-08-08T00:00:00.000Z",
      "updatedAt": "2026-08-08T00:00:00.000Z"
    }
  }
}
```

- `400` `PAYMENT_NOT_FOUND` — malformed `orderId`.
- `404` `PAYMENT_NOT_FOUND` — no payment yet, or the order belongs to another
  customer (existence never leaked). Reviewer identities are never exposed here
  (customer serialization hides `verifiedBy`/`rejectedBy`).

#### `POST /api/v1/orders/:orderId/payment` — submit a payment proof

`Content-Type: multipart/form-data` (the raw body is parsed by a strict
multipart parser — no third-party dependency). Headers: `Idempotency-Key`
(**required**, same conventions as checkout; a retry returns the original
result, a conflicting body → `409 PAYMENT_IDEMPOTENCY_CONFLICT`).

Multipart fields:

| Field | Type | Notes |
| ----- | ---- | ----- |
| `amountMinorUnits` | `String` | **Required** integer. Must **exactly** equal the order's server-computed `grandTotalMinorUnits` → else `400 INVALID_PAYMENT_AMOUNT`. |
| `paymentMethodId` | `String` | **Required** ObjectId of an **ACTIVE** payment method → else `400 PAYMENT_METHOD_NOT_FOUND` / `409 PAYMENT_METHOD_INACTIVE`. |
| `transactionReference` | `String` | **Required**, max 100. Reusing a reference already used by a **non-REJECTED** payment → `409 PAYMENT_IDEMPOTENCY_CONFLICT`; reusing it on the **same rejected** payment (resubmission) is allowed. |
| `proof` | `File` | **Required** image: JPEG/PNG/WEBP only (MIME + extension + magic bytes), file ≤ 2 MiB, body ≤ 4 MiB. |
| `note` | `String` | Optional, max 500. |
| `verificationMethod`/`verifiedBy`/`status`/`_id`/`$set`/... | — | Spoofed/operator fields are rejected (`400 INVALID_PAYMENT`). |

Eligibility: the order must be the customer's own, `paymentMethod === 'MANUAL'`,
and `status` `PENDING`/`CONFIRMED` → else `409 PAYMENT_ORDER_NOT_ELIGIBLE`.
Cross-customer → `404 PAYMENT_NOT_FOUND`.

Flow: validate + fingerprint → resolve the order (through the orders module
repository) → upload the proof to the media adapter (server-generated
`public_id = payments/<uuid>`; the persisted proof is the safe media object
`{ provider, publicId, secureUrl, resourceType, format }`) **outside** the DB
transaction → atomically create (first submission) or **mutate the same record**
(resubmission: replace proof, clear reviewer fields). A DB failure after
upload → best-effort delete of the uploaded media.

Response `201` (first submission) / `200` (resubmission) with `data.payment`.
Errors: `401`; `400` `INVALID_PAYMENT` / `INVALID_PAYMENT_AMOUNT` /
`INVALID_PAYMENT_PROOF` / `PAYMENT_PROOF_REQUIRED` / `PAYMENT_METHOD_NOT_FOUND`;
`404` `PAYMENT_NOT_FOUND` (foreign order); `409` `PAYMENT_ORDER_NOT_ELIGIBLE` /
`PAYMENT_IDEMPOTENCY_CONFLICT` / `PAYMENT_METHOD_INACTIVE`; `502`
`PAYMENT_PROOF_UPLOAD_FAILED` (media adapter error).

### Payment Methods — customer (Phase 08)

Customers only need a read of the **ACTIVE** methods to build the submit form.

Auth: **PUBLIC — no token required** (customer authentication is optional;
`authenticate → resolveCurrentUser` was removed from this read in CHUNK 14A).
Management writes remain ADMIN-only under `/api/v1/admin/payment-methods`.

#### `GET /api/v1/payment-methods` — list active payment methods

Customer-facing list; **ACTIVE only**, deterministic `sortOrder ASC, createdAt
ASC`. Response `200`:

```json
{
  "success": true,
  "message": "Payment methods retrieved successfully",
  "data": {
    "paymentMethods": [
      {
        "id": "507f1f77bcf86cd799439061",
        "code": "BANK_TRANSFER",
        "displayName": "Bank Transfer",
        "accountNumber": "xxxx-xxxx-xxxx-0001",
        "sortOrder": 0,
        "createdAt": "2026-08-08T00:00:00.000Z",
        "updatedAt": "2026-08-08T00:00:00.000Z"
      }
    ]
  }
}
```

`isActive` is `true` for everything here by construction. An inactive method
is invisible (never a 404 — it simply does not appear).

### Admin / Staff Payments (Phase 08)

Mounted at `/api/v1/admin/payments` (`src/modules/payments/adminPayment.routes.js`).
Auth: `authenticate → resolveCurrentUser → authorizeRoles(ADMIN, STAFF)` —
both `ADMIN` and `STAFF` may list and review payments in Phase 08. The acting
id (`verifiedBy`/`rejectedBy`) always comes from `req.user.id`; body fields
are rejected.

#### `GET /api/v1/admin/payments` — list payments

Query params: `page`, `limit` (same conventions), `status` (one of
`SUBMITTED`/`VERIFIED`/`REJECTED` → else `400 INVALID_PAYMENT_STATUS`),
`orderId` (optional ObjectId filter). Response `200` with `data.payments` +
`data.pagination`. Admin serialization **adds** `verifiedBy`/`rejectedBy`
(reviewer identities, for traceability).

#### `GET /api/v1/admin/payments/:id` — one payment

- `200` — `data.payment` (admin shape with reviewer ids).
- `400` — malformed id (`PAYMENT_NOT_FOUND`).
- `404` `PAYMENT_NOT_FOUND` — unknown id.

#### `POST /api/v1/admin/payments/:id/verify` — verify a SUBMITTED payment

Body: `note` (optional, max 500). `SUBMITTED → VERIFIED` (terminal). The
transition is an **atomic conditional update** (guarded on `SUBMITTED`), so
concurrent reviews cannot double-apply. Idempotent: verifying an already
`VERIFIED` payment succeeds.

Errors: `401`; `403` (`CUSTOMER`); `404` `PAYMENT_NOT_FOUND`; `409`
`PAYMENT_INVALID_STATE` (payment not `SUBMITTED` — e.g. `REJECTED`; or a lost
race). **Does not confirm the order.**

#### `POST /api/v1/admin/payments/:id/reject` — reject a SUBMITTED payment

Body: `note` (optional, max 500). `SUBMITTED → REJECTED`. The customer may then
resubmit (same record, fresh proof). Idempotent on `REJECTED`. Errors: as
verify, with `409 PAYMENT_INVALID_STATE` when not `SUBMITTED`.

### Admin Payment Methods (Phase 08)

Mounted at `/api/v1/admin/payment-methods` (`src/modules/payments/adminPaymentMethod.routes.js`).
Auth: `authenticate → resolveCurrentUser → authorizeRoles(ADMIN)` — **ADMIN
only**; STAFF/CUSTOMER → 403.

#### `POST /api/v1/admin/payment-methods` — create a payment method

Body fields (unknown/operator keys → `400 INVALID_PAYMENT_METHOD`):

| Field | Type | Notes |
| ----- | ---- | ----- |
| `code` | `String` | **Required**, `[A-Z0-9_]{1,50}`, normalized server-side. Duplicate normalized code → `409 PAYMENT_METHOD_CODE_ALREADY_EXISTS`. |
| `displayName` | `String` | **Required**, trimmed, max 100. |
| `accountNumber` | `String` | Optional, max 100 (or `null`). |
| `isActive` | `Boolean` | Optional, default `true`. |
| `sortOrder` | `Number` | Optional integer 0–9999, default `0`. |

Response `201` with `data.paymentMethod`. Errors: `401`; `403`; `400`
`INVALID_PAYMENT_METHOD`; `409` `PAYMENT_METHOD_CODE_ALREADY_EXISTS`.

#### `PATCH /api/v1/admin/payment-methods/:id` — update a payment method

PATCH semantics (only provided fields change). Deactivation is
`PATCH { "isActive": false }` — **no DELETE** (soft deactivation only, so
historical payments keep valid snapshots). `code` is **immutable** after
creation; unknown/immutable/operator keys and an empty patch → `400
INVALID_PAYMENT_METHOD`.

- `200` — `data.paymentMethod`.
- `404` `PAYMENT_METHOD_NOT_FOUND` — unknown id.
- `409` `PAYMENT_METHOD_CODE_ALREADY_EXISTS` — (not applicable; code immutable).

### Courier (Phase 09)

Mounted from `src/modules/courier/courier.routes.js` (ADR-0017). The courier
module wraps one `CourierShipment` per order with its own state machine
(`docs/courier-state-machine.md`): `PENDING → ACTIVE → DELIVERED`, with
`FAILED`/`CANCELLED`/`CANCELLATION_FAILED` off-shoots. All money is integer
minor units; provider errors are never leaked to clients.

#### `POST /api/v1/admin/orders/:orderId/courier/dispatch` — ADMIN/STAFF

Dispatch a `CONFIRMED` order to the courier. Body: `note` (optional, max 500;
unknown/operator keys → `400 INVALID_COURIER_REQUEST`). Creates the shipment
(one per order) and submits it to the provider.

- `201` — `data.shipment` (idempotent: re-dispatch while `ACTIVE`/
  `CANCELLATION_FAILED` returns the existing shipment without a second provider
  call).
- `404` `ORDER_NOT_FOUND`; `409` `COURIER_DISPATCH_NOT_ALLOWED` (order not
  `CONFIRMED`); `409` `COURIER_SHIPMENT_EXISTS` (terminal shipment already
  exists); `400` `COURIER_PROVIDER_REJECTED`; `503` `COURIER_PROVIDER_UNAVAILABLE` /
  `COURIER_PROVIDER_NOT_CONFIGURED`.
- On provider rejection/error the shipment is recorded `FAILED` and is
  retryable — no partial state.

#### `POST /api/v1/admin/shipments/:shipmentId/retry` — ADMIN/STAFF

Retry a `FAILED` dispatch. Body: `note` (optional). `200` with
`data.shipment` (now `ACTIVE`). Errors: `404` `COURIER_SHIPMENT_NOT_FOUND`;
`409` `COURIER_INVALID_STATE` (not `FAILED`); provider errors as above.

#### `POST /api/v1/admin/shipments/:shipmentId/cancel` — ADMIN/STAFF

Cancel a shipment. `PENDING`/`FAILED` cancel locally (provider never
contacted); `ACTIVE`/`CANCELLATION_FAILED` cancel via the provider. `200` with
`data.shipment`. Errors: `404`; `409` `COURIER_INVALID_STATE` (e.g. already
`DELIVERED`); `409` `COURIER_CANCEL_REJECTED` (shipment marked
`CANCELLATION_FAILED`, retryable).

#### `GET /api/v1/admin/shipments` — ADMIN/STAFF

List shipments. Query: `status` (one of `PENDING|ACTIVE|DELIVERED|CANCELLED|
FAILED|CANCELLATION_FAILED`), `orderId`, `page`, `limit`. `200` with
`data.shipments` + `data.pagination`. Errors: `400` `INVALID_COURIER_REQUEST`.

#### `GET /api/v1/admin/shipments/:shipmentId` — ADMIN/STAFF

Full shipment detail incl. `statusHistory`, `submission.lastError`, payload
snapshot, `providerStatus`, `fees`, `cancel`, `dispatch`. `404`
`COURIER_SHIPMENT_NOT_FOUND`.

#### `GET /api/v1/orders/:orderId/tracking` — CUSTOMER (own order)

Tracking for the caller's own order. Cross-customer reads resolve as
`404 ORDER_NOT_FOUND` (never 403, no existence leak). `200` with
`data.tracking` — `{ id, orderId, status, consignmentId, providerStatus,
deliveryFeeMinorUnits, updatedAt }`, or `null` when the order has not been
dispatched yet.

#### `POST /api/v1/webhooks/pathao` — public (Pathao → Taqwa)

Pathao posts delivery events (`consignment_id`, `merchant_order_id`,
`order_status`/`event`, `order_status_updated_at`) with the registered secret
in `X-Pathao-Signature`. Signature is verified constant-time and **fail-closed**
(missing/empty secret ⇒ `401 COURIER_WEBHOOK_INVALID_SIGNATURE`). Shipments are
matched by `consignmentId`, then `merchant_order_id` (order number). Unknown
shipments are acknowledged (`200`) and ignored. Terminal provider statuses
(`*delivered*`/`*cancelled*`) transition the shipment; other updates refresh
the provider snapshot only.

### Returns (Phase 10)

Mounted from `src/modules/returns/return.routes.js` (ADR-0018). Returns use a
**separate state machine** (`docs/return-state-machine.md`) decoupled from the
order machine — the return service never mutates the Order document and the
order-level `RETURN_REQUESTED`/`RETURNED` states stay reserved. Item prices are
IMMUTABLE snapshots taken from the order at request time; all money is integer
minor units. The customer surface is fully customer-scoped: cross-customer
access resolves as `404 RETURN_NOT_FOUND` (never 403).

#### `POST /api/v1/orders/:orderId/returns` — CUSTOMER (own order)

Submit a return request. Body `{ reason, items: [{ orderItemId, quantity }],
notes? }` (JSON) with a **required `Idempotency-Key` header** (same conventions
as checkout). Server-derived eligibility: own order, status `CONFIRMED`/
`PROCESSING`, within 30 days of `order.createdAt`, each item still fully or
partially returnable, no duplicate `orderItemId`.

- `201` — `data.return` created. A replay of the exact same body with the same
  key returns `200` with the ORIGINAL return (`data.return`) — no duplicate.
- `400` `INVALID_RETURN` | `RETURN_ITEM_DUPLICATE`; `409` `RETURN_NOT_ELIGIBLE`
  | `RETURN_WINDOW_EXPIRED` | `RETURN_ITEM_NOT_FOUND` |
  `RETURN_QUANTITY_EXCEEDED` | `RETURN_IDEMPOTENCY_CONFLICT`.
- `data.return` shape (customer view): `{ id, returnNumber, orderId, status,
  statusHistory, items, reason, notes, refundId, approvedAt, rejectedAt,
  cancelledAt, completedAt, createdAt, updatedAt }`.

#### `GET /api/v1/orders/:orderId/returns` — CUSTOMER (own order)

List the customer's returns for the order. Query: `page`, `limit`. `200` with
`data.returns` + `data.pagination`.

#### `GET /api/v1/orders/:orderId/returns/:returnId` — CUSTOMER (own order)

Return detail (customer view, no `customerId`/reviewer identities). `404`
`RETURN_NOT_FOUND`.

#### `POST /api/v1/orders/:orderId/returns/:returnId/cancel` — CUSTOMER (own order)

Cancel an own `PENDING` return. `PENDING → CANCELLED`; already-cancelled
returns idempotently resolve `200`. An `APPROVED` (or later) return → `409`
`RETURN_INVALID_STATE` (customer cancellation is `PENDING`-only; later states
need staff).

#### `GET /api/v1/admin/returns` — ADMIN/STAFF

List returns. Query (OPT-IN filters): `status` (`PENDING|APPROVED|REJECTED|
COMPLETED|CANCELLED`), `customerId`, `orderId`, `orderNumber`, `dateFrom`,
`dateTo`, `page`, `limit`. `200` with `data.returns` + `data.pagination`.
`400` `INVALID_RETURN` / `INVALID_RETURN_STATUS`. The admin view adds
`customerId` and the reviewer identities (`approvedBy`, `rejectedBy`,
`cancelledBy`, `completedBy`).

#### `GET /api/v1/admin/returns/:id` — ADMIN/STAFF

Full return detail (admin view). `404` `RETURN_NOT_FOUND`.

#### `POST /api/v1/admin/returns/:id/approve` — ADMIN/STAFF

`PENDING → APPROVED`. Already-`APPROVED` resolves idempotently `200`; any other
state → `409` `RETURN_INVALID_STATE`. `400` `INVALID_RETURN` (unknown fields).

#### `POST /api/v1/admin/returns/:id/reject` — ADMIN/STAFF

`PENDING → REJECTED` (terminal). Already-`REJECTED` resolves idempotently;
other states → `409` `RETURN_INVALID_STATE`.

#### `POST /api/v1/admin/returns/:id/complete` — ADMIN/STAFF

`APPROVED → COMPLETED` — the ONLY transition with side effects: restock
(`RETURN_RESTOCK` movement, online) + auto-creation of the `PENDING` refund
(server-derived amount from the snapshots) happen in ONE transaction. Already-
`COMPLETED` resolves idempotently (no double restock/refund); other states →
`409` `RETURN_INVALID_STATE`. Returns `data.return` with its `refundId` set.

#### `POST /api/v1/admin/returns/:id/cancel` — ADMIN/STAFF

`PENDING`/`APPROVED → CANCELLED` (no side effects exist before `COMPLETED`).
Already-`CANCELLED` resolves idempotently; `REJECTED`/`COMPLETED` → `409`
`RETURN_INVALID_STATE`.

### Refunds (Phase 10)

Mounted from `src/modules/refunds/refund.routes.js` (ADR-0018), ADMIN/STAFF
only. A refund is the financial record for a `COMPLETED` return — created
`PENDING` at return-completion with a server-derived amount, never mutated by
API input, and **never mutates the original Payment/Order documents**. State
machine: `PENDING → PROCESSED | VOIDED`, both terminal
(`docs/refund-state-machine.md`).

#### `GET /api/v1/admin/refunds` — ADMIN/STAFF

List refunds. Query (OPT-IN filters): `status` (`PENDING|PROCESSED|VOIDED`),
`orderId`, `returnId`, `customerId`, `refundNumber`, `dateFrom`, `dateTo`,
`page`, `limit`. `200` with `data.refunds` + `data.pagination`. `400`
`INVALID_REFUND` / `INVALID_REFUND_STATUS`.

#### `GET /api/v1/admin/refunds/:id` — ADMIN/STAFF

Refund detail: `{ id, refundNumber, return: { id, returnNumber, status },
order: { id, orderNumber }, paymentMethod, paymentId, amount, status, note,
processedBy, processedAt, voidedBy, voidedAt, customer, statusHistory,
createdAt, updatedAt }`. `404` `REFUND_NOT_FOUND`.

#### `POST /api/v1/admin/refunds/:id/process` — ADMIN/STAFF

`PENDING → PROCESSED`. Already-`PROCESSED` resolves idempotently; `VOIDED` →
`409` `REFUND_INVALID_STATE`. The refund is only processable once its linked
return is `COMPLETED` (guaranteed by construction — refunds are auto-created at
return-completion).

#### `POST /api/v1/admin/refunds/:id/void` — ADMIN/STAFF

`PENDING → VOIDED` (terminal). Already-`VOIDED` resolves idempotently;
`PROCESSED` → `409` `REFUND_INVALID_STATE`.

### Reviews (Phase 12)

Mounted from `src/modules/reviews/review.routes.js` +
`src/modules/reviews/adminReview.routes.js`. Product reviews: customers rate
and comment on a **product** (not an account), every submission starts
`PENDING`, and an `ADMIN` approves or rejects it. State machine:
`PENDING → APPROVED | REJECTED`, both terminal (no moderation reversal — see
`src/modules/reviews/review.state-machine.js`). There is deliberately **no
purchase-verification rule**. Only `APPROVED` reviews are ever exposed by the
public surface; the rating summary (average + per-rating breakdown) is computed
on read via a per-rating aggregation, never denormalized onto the Product.

Safety invariants:

- The customer identity ALWAYS comes from `req.user.id`; body `customerId`,
  `status`, `approvedBy`, `performedBy`, and Mongo operators (`$set`, ...) are
  rejected by the create-body allowlist.
- Public/customer reads ALWAYS filter `status: APPROVED` in the service —
  PENDING/REJECTED are never returned, and `customerId` never appears in public
  or customer responses.
- Approve/reject are **atomic conditional transitions** guarded on the current
  status, so concurrent moderation calls cannot double-apply; both outcomes are
  terminal, and acting on an already-target state is idempotent.

#### `GET /api/v1/products/:productId/reviews` — Public (no auth)

A product's APPROVED reviews (newest first) with a rating summary across ALL
approved reviews of the product. Query: `page`, `limit` (safe pagination).
`200` with `data.reviews` (each: `{ id, productId, customerDisplayName,
rating, comment, createdAt }`) + `data.summary` (`{ averageRating,
totalReviews, ratingBreakdown }`) + `data.pagination`. The product must exist
and be ACTIVE; unknown/inactive product → `404` `PRODUCT_NOT_FOUND`.

#### `POST /api/v1/products/:productId/reviews` — CUSTOMER

Submit a review. Body allowlist: `{ rating: 1–5 (required, integer),
comment: ≤2000 (optional) }`. The review is persisted `PENDING` with the
authenticated identity; `customerDisplayName` is snapshotted from the
authenticated user (capped at 100 chars), never from the body. `201` with
`data.review` (customer shape: `{ id, productId, rating, comment, status,
createdAt, updatedAt }`). Unknown/inactive product → `404`
`PRODUCT_NOT_FOUND`; spoofed identity/status/operator fields or invalid
rating/comment → `400` `INVALID_REVIEW`.

#### `GET /api/v1/admin/reviews` — ADMIN

List reviews (moderation queue). Query (OPT-IN filters): `status`
(`PENDING|APPROVED|REJECTED`), `productId`, `page`, `limit`. `200` with
`data.reviews` (admin shape: adds `customerId`, `approvedBy`/`approvedAt`,
`rejectedBy`/`rejectedAt`, `statusHistory`) + `data.pagination`. Invalid
`status` → `400` `INVALID_REVIEW_STATUS`.

#### `GET /api/v1/admin/reviews/:id` — ADMIN

Admin view of one review. `404` `REVIEW_NOT_FOUND`.

#### `POST /api/v1/admin/reviews/:id/approve` — ADMIN

`PENDING → APPROVED` (terminal). Body allowlist: `{ note: ≤500 (optional) }`.
Already-`APPROVED` resolves idempotently; `REJECTED` → `409`
`REVIEW_INVALID_STATE`. The acting id is always `req.user.id`.

#### `POST /api/v1/admin/reviews/:id/reject` — ADMIN

`PENDING → REJECTED` (terminal). Body allowlist: `{ note: ≤500 (optional) }`.
Already-`REJECTED` resolves idempotently; `APPROVED` → `409`
`REVIEW_INVALID_STATE`.

### Admin Customers (Phase 15)

Mounted from `src/modules/users/adminCustomer.routes.js`. ADMIN-only read
surface (list + detail) over the existing application `User` collection. There
are **no customer mutation endpoints** in this phase — no status changes, no
edits, no creation. The surface reads the same `User` records the auth flow
provisions (`CUSTOMER/ACTIVE`) plus any manually provisioned `STAFF`/`ADMIN`
accounts.

Safety invariants:

- ADMIN-only (`authenticate → resolveCurrentUser → authorizeRoles(ADMIN)`);
  anonymous → `401`, `CUSTOMER`/`STAFF` → `403` `FORBIDDEN`. The role is the
  stored application role — a JWT `role` claim can never elevate.
- The admin serializer (`user.serializer.js`) deliberately omits
  `authProviderId` (the immutable link to the Better Auth identity), so
  authentication identifiers never leave the backend.
- Query filters are validated against the real `ROLES`/`ACCOUNT_STATUSES`
  enums — an invented role/status value is rejected, never silently ignored.
- Pagination follows the standard `{ page, limit (default 20, cap 100) }`
  convention; list responses use the `{ page, limit, total, totalPages }`
  shape.

#### `GET /api/v1/admin/customers` — ADMIN

List application users (newest first). Query (OPT-IN filters): `role`
(`ADMIN|STAFF|CUSTOMER`), `status` (`ACTIVE|SUSPENDED|DISABLED`), `page`,
`limit`. `200` with `data.customers` (each: `{ id, email, displayName, phone,
role, status, createdAt, updatedAt }`) + `data.pagination`. Unknown `role` →
`400` `INVALID_USER_ROLE`; unknown `status` → `400` `INVALID_USER_STATUS`.

#### `GET /api/v1/admin/customers/:id` — ADMIN

Admin view of one application user (same safe shape as the list). Malformed id
→ `400` `INVALID_USER`; unknown id → `404` `USER_NOT_FOUND`.

### Admin Notifications (Phase 15)

Mounted from `src/modules/notifications/adminNotification.routes.js`. ADMIN-only
**read** surface over the internal notification audit trail (Phase 11,
ADR-0019). It adds HTTP reads to a module that was previously internal-only;
it does NOT change the notification architecture. Delivery is still triggered
internally by business services (`maybeNotify` after a committed operation);
the `Notification` document still has no read/unread state, so **no
mark-as-read / inbox endpoints exist and none are invented**.

Safety invariants:

- ADMIN-only (`authenticate → resolveCurrentUser → authorizeRoles(ADMIN)`);
  anonymous → `401`, `CUSTOMER`/`STAFF` → `403` `FORBIDDEN`.
- Only the safe `toNotificationOutput` shape is ever serialized — the internal
  `payload` audit snapshot (order/payment details) never leaves the backend;
  consumers correlate via `entityRef`.
- Query filters are validated against the real
  `NOTIFICATION_STATUS_VALUES` / `NOTIFICATION_EVENT_TYPE_VALUES` enums.
- The acting ADMIN never needs their id for read-only list/detail; no body is
  accepted.

#### `GET /api/v1/admin/notifications` — ADMIN

List notifications (newest first). Query (OPT-IN filters): `status`
(`QUEUED|SENT|FAILED|SKIPPED`), `eventType` (one of the Phase 11 event types),
`page`, `limit`. `200` with `data.notifications` (each: `{ id, recipient,
channel, eventType, templateKey, entityRef, status, attempts, lastAttemptAt,
lastError, provider, providerRef, deliveredAt, createdAt, updatedAt }`) +
`data.pagination`. Unknown `status` → `400` `INVALID_NOTIFICATION_STATUS`;
unknown `eventType` → `400` `INVALID_NOTIFICATION_EVENT_TYPE`.

#### `GET /api/v1/admin/notifications/:id` — ADMIN

Admin view of one notification (same safe shape as the list). Malformed id →
`400` `INVALID_NOTIFICATION`; unknown id → `404` `NOTIFICATION_NOT_FOUND`.

## 7. Planned Endpoint Groups

**Planned — to be finalized per module in their implementing phases.**

| Domain | Routes | Phase |
| ------ | ------ | ----- |
| Customers | `/api/v1/admin/customers*` | **Implemented (Phase 15)** — ADMIN-only read list + detail, see the Admin Customers section above |
| Orders | `/api/v1/admin/orders*`, `/api/v1/customer/orders*` | **Implemented (Phase 07)** — see the Orders sections above |
| Payments | `/api/v1/admin/payments*`, `/api/v1/payment-methods`, `/api/v1/orders/:orderId/payment` | **Implemented (Phase 08)** — see the Payments sections above (webhooks remain Phase XX) |
| Returns | `/api/v1/orders/:orderId/returns*`, `/api/v1/admin/returns*` | **Implemented (Phase 10)** — see the Returns section above |
| Refunds | `/api/v1/admin/refunds*` | **Implemented (Phase 10)** — see the Refunds section above |
| Reviews | `GET/POST /api/v1/products/:productId/reviews`, `/api/v1/admin/reviews*` | **Implemented (Phase 12)** — see the Reviews section above |
| Expenses | `/api/v1/admin/expenses*` | Phase XX |
| Analytics | `/api/v1/admin/analytics*` | Phase XX |
| Staff/admin management | `/api/v1/admin/users*` | Phase XX |
| Courier | `/api/v1/admin/orders/:orderId/courier/*`, `/api/v1/admin/shipments*`, `/api/v1/orders/:orderId/tracking`, `/api/v1/webhooks/pathao` | **Implemented (Phase 09)** — see the Courier section above |
| Notifications | `/api/v1/admin/notifications*` (ADMIN read-only audit surface) | **Implemented (Phase 15)** — see the Admin Notifications section above; delivery remains internal (Phase 11) |
| Settings / audit logs | `/api/v1/admin/settings*`, `/api/v1/admin/audit-logs*` | Phase XX |

The inventory group is **implemented (Phase 06)** at `/api/v1/inventory` — all
endpoints ADMIN-only (see the Inventory section above).

The cart group is **implemented (Phase 07)** at `/api/v1/cart` (customer, own
cart) and the order groups at `/api/v1/orders` (customer, own orders) +
`/api/v1/admin/orders` (ADMIN/STAFF order operations) — see the Cart and Orders
sections above.

The payments groups are **implemented (Phase 08)** at
`/api/v1/orders/:orderId/payment` + `/api/v1/payment-methods` (customer) and
`/api/v1/admin/payments` + `/api/v1/admin/payment-methods` (ADMIN/STAFF) — see
the Payments sections above. Webhook-based payment confirmation remains planned.

The returns and refunds groups are **implemented (Phase 10, ADR-0018)** at
`/api/v1/orders/:orderId/returns` (customer, own returns) and
`/api/v1/admin/returns` + `/api/v1/admin/refunds` (ADMIN/STAFF) — see the
Returns / Refunds sections above. Order-level `RETURN_REQUESTED` / `RETURNED`
states remain reserved for a future fulfillment phase; the return lifecycle is
a separate document state machine.

The reviews group is **implemented (Phase 12)** at
`/api/v1/products/:productId/reviews` (public APPROVED reads + CUSTOMER
submission) and `/api/v1/admin/reviews` (ADMIN-only moderation) — see the
Reviews section above.

Notifications/email (Phase 11, ADR-0019) is an **internal infrastructure
module** whose delivery is triggered internally by business services
(`maybeNotify` after a committed order/payment operation) and delivered through
the configurable email provider (mock in development/tests, SMTP in
production). Since Phase 15 there IS a read-only ADMIN audit surface at
`/api/v1/admin/notifications` (list + detail; see the Admin Notifications
section above), but there is **no customer notification-management endpoint and
no customer notification center** — the `Notification` document has no
read/unread state, so no mark-as-read or inbox endpoints exist. The
`Notification` collection remains an audit/retry record; a customer-facing
inbox is future work.

Each protected group mounts with `authenticate` + `resolveCurrentUser` + the
route-group roles from `docs/rbac-matrix.md`. Exact paths, parameters,
request/response shapes, and pagination conventions are to be defined in each
implementing phase — do not fabricate them now.

## 8. Conventions

- JSON request bodies via `Content-Type: application/json`.
- Server errors return generic messages; details go to server logs only.
- CORS: **Planned** — to be configured when the frontend origin is known
  (frontend/backend are separate deployments).
