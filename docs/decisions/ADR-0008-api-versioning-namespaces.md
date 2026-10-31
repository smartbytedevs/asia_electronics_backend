# ADR-0008: API Versioning and Route Namespaces

## Status

Accepted

## Date

2026-08-08

## Context

The API needs a stable versioning scheme and a way to express access level per
route so that authorization and documentation stay clear.

## Decision

- All routes are prefixed with `/api/v1`.
- Routes are grouped by audience/access level:

```
/api/v1/public/*
/api/v1/customer/*
/api/v1/admin/*
/api/v1/staff/*
/api/v1/webhooks/*
```

- Route groups map to RBAC roles (see `docs/rbac-matrix.md`).

## Consequences

- Versioning allows breaking changes behind a new major prefix.
- Namespaces map naturally to authorization middleware.
- `/api/v1/health` is the only business-agnostic route; business routes are
  added per module in later phases.
