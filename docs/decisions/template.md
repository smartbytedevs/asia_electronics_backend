# ADR Template

## Status

[Accepted | Proposed | Superseded by ADR-XXXX]

## Date

YYYY-MM-DD

## Context

What is the architectural question and why does it matter? What constraints or
trade-offs are relevant?

## Decision

What was decided? Be specific enough that future phases can follow it.

## Consequences

Positive and negative implications of the decision.

---

## Recorded ADRs

| ADR | Title |
| --- | ----- |
| [ADR-0001](./ADR-0001-frontend-independence.md) | Backend is a frontend-independent REST API |
| [ADR-0002](./ADR-0002-frontend-owned-authentication.md) | Authentication owned by the frontend; backend verifies JWT only |
| [ADR-0003](./ADR-0003-layered-architecture.md) | Layered architecture Route → Middleware → Controller → Service → Repository → Model |
| [ADR-0004](./ADR-0004-integration-adapters.md) | External integrations behind adapters |
| [ADR-0005](./ADR-0005-feature-based-modules.md) | Feature/domain-based module organization |
| [ADR-0006](./ADR-0006-commonjs.md) | CommonJS module system |
| [ADR-0007](./ADR-0007-response-envelope.md) | Standard success/error response envelopes |
| [ADR-0008](./ADR-0008-api-versioning-namespaces.md) | API versioning and route namespaces |
| [ADR-0009](./ADR-0009-mongodb-mongoose-persistence.md) | MongoDB + Mongoose persistence layer |
| [ADR-0010](./ADR-0010-backend-resource-server-authentication.md) | Backend resource-server authentication: JWT verification + RBAC |
| [ADR-0011](./ADR-0011-application-user-identity.md) | Application user identity: authoritative roles + account status |
| [ADR-0012](./ADR-0012-category-taxonomy-and-soft-deactivation.md) | Category taxonomy: generic nodes + soft deactivation |
| [ADR-0013](./ADR-0013-product-variant-and-measurement-architecture.md) | Product & variant catalog: measurement guides, atomic create, purchase-price privacy |
| [ADR-0014](./ADR-0014-inventory-ledger-and-reservation-architecture.md) | Inventory, stock ledger & reservation foundation |
| [ADR-0015](./ADR-0015-order-checkout-lifecycle.md) | Order & checkout lifecycle: cart, checkout, reservations, order state machine |
| [ADR-0016](./ADR-0016-manual-payment-and-proof-verification.md) | Manual payment & proof verification: payment state machine, payment methods, media upload boundary |
| [ADR-0017](./ADR-0017-courier-integration.md) | Courier integration (Pathao): shipment state machine, webhook security, COD money handling |
| [ADR-0018](./ADR-0018-returns-and-refunds.md) | Returns & refunds: separate return machine, item snapshots, idempotency, single completion transaction, server-derived refunds |
| [ADR-0019](./ADR-0019-notification-and-email-infrastructure.md) | Notification & email infrastructure: provider abstraction, best-effort delivery, notification state machine, event/template registry, dedupe |
