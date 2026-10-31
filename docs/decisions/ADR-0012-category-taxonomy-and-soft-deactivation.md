# ADR-0012: Category Taxonomy — Generic Nodes + Soft Deactivation

## Status

Accepted

## Date

2026-08-08

## Context

Phase 04 introduces the first catalog capability: **categories** (the Taqwa
storefront groups abayas, jewelry, baby dresses, girls' fashion, accessories).
The business domain list also includes products, variants, and inventory, but
those do not exist yet. Several architectural questions had to be answered up
front so that later phases do not need to rewrite the taxonomy layer:

- Are categories hard-coded product types (`ABAYA`, `JEWELRY`, `BABY_DRESS`) or
  generic database rows? Hard-coding couples the backend to the current store
  front, forces migrations every time a product line changes, and blocks
  admin-managed taxonomy.
- Are categories deleted or deactivated? Historical references (future orders,
  products) must survive catalog cleanups; physical deletes would orphan them.
- Who can read and who can mutate? Storefront reads must be public and
  unauthenticated; mutations are a sensitive administrative action.
- Does a client-supplied slug win, or is the slug always backend-derived?
  Slugs are user-facing URLs (`/categories/abayas`) and need a stable,
  collision-free contract.
- Categories need images, but Cloudinary is a planned, unbuilt integration.

## Decision

Introduce a **generic Category module** (`src/modules/categories/`), fully
decoupled from Product.

### Generic taxonomy, no hard-coded enums

- Categories are ordinary MongoDB documents (`Category` model) with
  `name`, `slug`, `description`, `image`, `isActive`, `sortOrder`. There are NO
  hard-coded `ABAYA`/`JEWELRY`/`BABY_DRESS` enum values.
- No Product/Variant/Inventory/Stock/Order/Payment model exists in this phase.
  The Category schema stores **no** product, variant, or stock fields.

### Soft deactivation, no deletion

- A category is **deactivated** (`isActive: false`), never hard-deleted.
- There is NO `DELETE /api/v1/categories/:id` endpoint and no cascading
  deletion. Deactivated categories stay stored so future products/orders can
  keep historical references, mirroring the product archival rule
  (`docs/business-rules.md` §1).
- Public catalog reads (`GET /api/v1/categories`, `/:id`, `/slug/:slug`)
  expose ACTIVE categories only; an inactive category behaves as not-found
  (404) on the storefront. Admin management can read/operate on any status.

### Access control

- Public reads: unauthenticated.
- Create/update/deactivate: `authenticate → resolveCurrentUser →
  authorizeRoles(ROLES.ADMIN)`. STAFF and CUSTOMER may NOT mutate categories.
  (CUSTOMER gets read access via the public endpoints.)

### Slug contract

- ONE `slugify` implementation lives in `category.constants.js` and is reused
  by the model setter and the service — never re-implemented elsewhere.
- A client-supplied slug is **respected but always normalized** through
  `slugify`. A normalized collision → `400 CATEGORY_SLUG_ALREADY_EXISTS`.
- A missing slug is derived from `name` and made unique with a deterministic
  numeric suffix (`baby-dresses`, `baby-dresses-2`, ...).
- Duplicate detection is layered: friendly service pre-checks + Mongoose
  unique indexes on `slug` and `name` + mapping of duplicate-key (11000)
  errors for concurrent races.

### Image is a URL string

- `image` is a plain http(s) URL string. There is NO Cloudinary SDK and NO
  multipart upload in this phase; the Cloudinary adapter remains a planned
  integration.

### Validation and PATCH semantics

- Server-side allowlist validation (`CATEGORY_FIELDS`) rejects unknown keys,
  immutable keys (`_id`, `createdAt`, ...), and Mongo operators (`$set`, ...)
  before anything reaches persistence (mass-assignment/operator-injection
  defense).
- Updates are PATCH-style: only provided fields change; omitted fields are
  preserved. Deactivation is simply `updateCategory(id, { isActive: false })`.
- Safe serialization: API responses expose `id`, `name`, `slug`,
  `description`, `image`, `isActive`, `sortOrder`, `createdAt`, `updatedAt` —
  never `_id`, `__v`, or Mongoose internals.

## Consequences

- The storefront can rename/reorganize taxonomy without redeploying code or
  migrating enums; admins manage categories through the API.
- Deactivated categories accumulate in the `Category` collection (accepted —
  the collection is small and history matters for future order/catalog joins).
- Inactive categories are invisible to the storefront, so a deactivated
  category cannot be linked to new products until reactivated.
- Product modeling (Phase 05+) references categories by ObjectId without
  changing this module.
- The unique `slug` index is the final consistency layer; concurrent duplicate
  creates surface as `400 CATEGORY_SLUG_ALREADY_EXISTS` /
  `CATEGORY_ALREADY_EXISTS` instead of raw database errors.
- No pagination was added to the public list (the catalog is small today);
  pagination may be layered on in the product phase without breaking this API.
