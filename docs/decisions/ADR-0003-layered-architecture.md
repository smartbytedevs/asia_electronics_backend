# ADR-0003: Layered Architecture

## Status

Accepted

## Date

2026-08-08

## Context

The backend must enforce a consistent separation of concerns so that routes
stay thin, business logic is centralized, data access is controlled, and
external providers stay isolated. Without a mandated flow, modules tend to
scatter business logic and vendor calls across handlers.

## Decision

Requests flow through fixed layers:

```
Route → Middleware → Controller → Service → Repository → Model → MongoDB
```

- Controllers parse/validate input and serialize responses.
- Services contain business logic.
- Repositories contain database access.
- Controllers/services MUST NOT talk directly to MongoDB or external providers.

## Consequences

- Clear responsibility boundaries; testable in isolation.
- Slight indirection cost for very small features; acceptable for this domain.
- Repository abstraction is applied where it adds value; trivial lookups may
  stay in services (avoid unnecessary abstraction).
