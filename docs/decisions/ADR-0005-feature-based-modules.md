# ADR-0005: Feature/Domain-Based Module Organization

## Status

Accepted

## Date

2026-08-08

## Context

Layering controllers/services/repositories at the top level would scatter each
domain's files across unrelated folders and make domains hard to navigate.

## Decision

The backend is organized into feature/domain modules under `src/modules/`:

```
users, customers, categories, products, inventory, payments, orders,
courier, expenses, analytics, notifications, auditLogs, settings
```

Each module owns its routes, controllers, services, repositories, and models.
Cross-cutting concerns (auth, RBAC, error handling) live in `src/middlewares/`;
external provider adapters live in `src/integrations/`.

## Consequences

- High cohesion per domain; clear ownership.
- Domains can be developed and reviewed independently.
- Risk of cross-module coupling; mitigated by routing all access through each
  module's service/repository boundary.
