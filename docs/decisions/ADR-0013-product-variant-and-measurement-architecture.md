# ADR-0013: Product & Variant Catalog — Measurement Guides, Atomic Create, Purchase-Price Privacy

## Status

Accepted

## Date

2026-08-08

## Context

Phase 05 introduces the first commerce-facing catalog capability: **products**
with **variants** on top of the Phase 04 category taxonomy. The business scope
includes inventory, orders, payments, and carts, but none of those exist yet,
and the backend must keep its security foundation (authoritative application
roles from MongoDB, verified JWTs) intact. Several architectural questions had
to be answered so later phases do not rewrite the catalog:

- **Money representation.** Taka (৳) prices appear as `1,500.00`. Floats
  corrupt money (0.1 + 0.2). Order snapshots and analytics must never recompute
  from floats.
- **How discount prices are represented.** Storing a pre-computed "effective
  price" duplicates source data and drifts; recomputing everywhere duplicates
  logic. Price must have ONE source of truth and ONE computation point.
- **Purchase cost privacy.** The business records a cost price per product.
  Customers, and even staff-facing storefront responses, must never see it.
  RBAC alone (route-level) is not enough if a future route leaks.
- **Variants + initial product atomicity.** A product with no variants is
  meaningless, yet product and variant documents live in two collections. A
  crash between inserts leaves a broken catalog.
- **Variant identity & uniqueness.** SKUs must be globally unique and stable for
  future inventory/order references; the same attribute set must not repeat per
  product. Variants need an immutable identity that is not a human-editable
  field.
- **Soft-deactivate vs. delete.** Future orders will snapshot variant identity;
  physical deletes would orphan them.
- **Measurement guides.** The storefront shows per-product measurement tables
  (e.g., abaya lengths). Measurement guides are now **image-only** (`{ imageUrl
  }`, image uploaded through the media system); the earlier structured table
  format is tolerated on existing records.
- **Uploads.** Products need images but Cloudinary is still a planned,
  unbuilt integration.

## Decision

Introduce a **Product module** (`src/modules/products/`) with a **ProductVariant
subdomain** (`src/modules/products/variants/`) and per-product measurement
guides. No inventory, orders, payments, cart, or Cloudinary in this phase.

### Money: integer minor units (paisa)

- All prices (`sellingPrice`, `purchasePrice`, `sellingPriceOverride`,
  `purchasePriceOverride`) are **integers in minor units** (paisa): `৳1,500.00
  = 150000`. Range `1 .. 100,000,000`.
- No float price math anywhere. Discounts are integer-percent or integer-fixed;
  effective prices are computed with integer arithmetic.

### Pricing: single source + central effective price

- `Product.sellingPrice` is the base; `ProductVariant.sellingPriceOverride`
  overrides it for a variant when set.
- `discount` is a product-level `{ type: 'percentage'|'fixed', value }`.
- `effectiveSellingPrice` is computed **once, centrally, in the serializer**
  from the base/override and discount. It is **never stored**. All serializers
  (public, admin, card, variant) call the same `computeEffectiveSellingPrice`.
- Percentage discounts are 1–99; a fixed discount cannot exceed the selling
  price; the effective price can never go below `0`.

### Purchase-price privacy: ADMIN-only serialization

- `purchasePrice` / `purchasePriceOverride` are accepted on writes and stored,
  but serialized **only in ADMIN responses** (`PURCHASE_ACL = ['ADMIN']`).
- The visibility decision uses the **resolved application `User.role`** passed
  from the controller (`req.user.role`) — never JWT claims, headers, query, or
  body. The PATCH route is ADMIN-only as well, so defense is layered.
- Public list/detail and STAFF create responses are guaranteed free of
  purchase-cost fields (covered by unit and integration tests, including a
  raw-string scan for the word "purchase").

### Variants: atomic create, immutable SKU, canonical attributes

- Variants are **optional** on create (`variants: []` or omitted); when
  provided, the product + initial variants commit in **one MongoDB transaction**
  (`withTransaction` from `src/config/database.js`, session passed through every
  repository call).
  PATCH variant replacement is also transactional.
- `sku` is trimmed + uppercased, **globally unique**, and **immutable after
  creation** — a PATCH attempting a SKU change is rejected with `400
  INVALID_PRODUCT` ("SKU cannot be changed after creation").
- `attributes` is a dynamic object (e.g. `{ size: '52' }`). The **canonical
  sorted-key JSON `attributeKey`** is stored and unique per
  `{ productId, attributeKey }` — duplicate attribute sets are rejected
  (`VARIANT_DUPLICATE_ATTRIBUTES`). Service pre-checks run inside the
  transaction; the unique indexes (`sku`, `productId+attributeKey`) are the
  final consistency layer for concurrent races, and duplicate-key errors map to
  friendly codes.
- Variants are **soft-deactivated**, never deleted. A PATCH `variants` array is
  the **full replacement spec**: entries with `id` update, entries without
  `id` create, unreferenced existing variants are deactivated.

### Measurement guides: image-only, legacy-tolerant

- `measurementGuide = { imageUrl }` — an optional http(s) URL of the guide
  image, uploaded separately through the media system and stored with the
  product. Omitted/null guide means no guide.
- Legacy structured guides (`{ unit, fields[], sizes[] }`) are tolerated on
  **existing records only**: serialization preserves them, and the old
  size-consistency rule (`every sizes[].size` must equal a variant's
  `attributes.size`) still applies to those records. New writes accept only
  `imageUrl`; legacy fields → `400 INVALID_MEASUREMENT_GUIDE`.

### Access control

- Public reads (`GET /`, `GET /:id`, `GET /slug/:slug`): unauthenticated,
  ACTIVE products only; inactive products behave as not-found (404).
- `POST /api/v1/products`: `authenticate → resolveCurrentUser →
  authorizeRoles(ADMIN, STAFF)` — STAFF may create, but purchase-price fields
  stay out of their responses.
- `PATCH /api/v1/products/:id`: `authorizeRoles(ADMIN)` only. No DELETE —
  deactivation is `PATCH { "isActive": false }`.

### Validation & serialization safety

- Server-side allowlist validation rejects unknown/immutable/operator keys
  (`$set`, `_id`, `role`, `stock`, ...) on products and variants; variant
  entries reject `id` unless stripped by the service on the PATCH path.
- Public list query controls are allowlisted (filters `categoryId`, `featured`,
  `newArrival`, `bestDeal`; sorts `newest`, `priceAsc`, `priceDesc`,
  `featured`); page/limit are 1-indexed, default 20, max 100; unknown filter
  keys are ignored by the controller, unknown sorts are rejected.
- Responses expose string `id`, never `_id`/`__v`/`attributeKey`.
- `images` are plain http(s) URL strings; Cloudinary/multipart is a planned
  integration, not part of this phase.

## Consequences

### Positive

- Integer money eliminates float rounding in pricing, orders, and analytics.
- A single central `effectiveSellingPrice` keeps price/discount math correct
  across every response shape.
- Purchase-cost data is structurally impossible to leak through public/STAFF
  serializers — enforcement is in the serializer, not just the route.
- Product + variants commit atomically; no partial catalog can be created.
- Immutable SKUs and canonical `attributeKey` give future inventory/orders a
  stable reference key.
- Soft deactivation preserves historical references and matches the category
  archival rule.
- Measurement guides stay provably consistent with variant sizes.
- Validation rejects mass-assignment and operator injection on both entities.

### Negative / costs

- Two collections + transactions add write complexity and require sessions to
  be threaded through every repository call (bounded to the product service).
- Attribute canonicalization via sorted-key JSON introduces an internal field
  (`attributeKey`) that must never be serialized.
- SKU immutability means fixing a typo requires deactivating the variant and
  creating a new one (by design — references stay stable).
- Public listing intentionally omits variants/guides for grid performance,
  which is a documented trade-off (detail endpoints serve the full product).

### Not decided here

- Inventory, reservations, and stock live in a **later phase** and will
  reference `productVariantId` (see `docs/inventory-state-machine.md`).
- Orders/payments/cart, Cloudinary uploads, staff/admin management, and
  ownership checks remain future work.
- Exact Better Auth JWKS values remain pending frontend confirmation.
