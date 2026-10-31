# ADR-0004: External Integrations Behind Adapters

## Status

Accepted

## Date

2026-08-08

## Context

Taqwa integrates with external providers (Pathao courier, Cloudinary, email
provider). Calling vendor APIs directly from business services couples the
domain to vendor contracts and makes changes/testing painful.

## Decision

External providers are reached only through integration adapters:

```
Service → Integration / Adapter → External Provider
```

Example:

```
OrderService → CourierService → PathaoAdapter → Pathao API
```

Business logic depends on a courier abstraction, never directly on Pathao.

## Consequences

- Provider-specific details (auth, payloads, retries) live in one adapter each.
- Provider changes or swap-outs affect only the adapter.
- Secrets used by adapters remain backend-only (env/deployment secrets).
