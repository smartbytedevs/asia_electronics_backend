# ADR-0009: MongoDB + Mongoose Persistence Layer

## Status

Accepted

## Date

2026-08-08

## Context

Taqwa's approved stack selects MongoDB Atlas as the database and Mongoose as
the ODM. This ADR records the persistence decisions so future module phases
follow one consistent database design rather than making independent choices.

## Decision

### Why MongoDB

- The approved architecture requires MongoDB Atlas.
- The e-commerce domain (catalog variants, nested order snapshots, flexible
  analytics documents) fits MongoDB's document model.
- Document-level atomic operations and ACID multi-document transactions (when
  required) are supported on Atlas.

### Why Mongoose

- Mongoose provides schema validation, middleware/hooks, and a query API that
  keep models consistent across modules.
- Mongoose bundles the official MongoDB driver; no separate driver dependency
  is used.
- The project uses the current Mongoose API only (no deprecated options).

### Persistence separation

- Database access lives in repositories; business logic lives in services;
  controllers stay thin. The dependency flow is fixed:
  `Service → Repository → Mongoose Model → MongoDB`.
- A minimal base repository (`src/modules/base/base.repository.js`) standardizes
  common operations while allowing module-specific repositories to extend it or
  call their model directly for complex/transactional queries.

### Transactions

- MongoDB multi-document transactions are reserved for operations that span
  collections (e.g., order creation + stock reservation, cancellation +
  reservation release). No transaction utility is added prematurely; the
  foundation keeps sessions/transactions available.

### Indexing philosophy

- Indexes belong to the model/domain that owns the query pattern and must be
  justified by expected access patterns. No speculative or placeholder indexes
  are created.

## Consequences

- Consistent, predictable data access across all future modules.
- Mongoose validation reduces invalid-data bugs at the persistence boundary.
- Repositories must stay free of business logic, HTTP, and auth concerns.
- Future modules define schemas, indexes, and domain-specific error mapping
  (database errors are never exposed raw to API consumers).
