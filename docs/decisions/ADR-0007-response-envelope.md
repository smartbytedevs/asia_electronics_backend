# ADR-0007: Standard Success/Error Response Envelopes

## Status

Accepted

## Date

2026-08-08

## Context

Consistent response shapes make the API predictable for the frontend and for
other consumers, and simplify error handling.

## Decision

All API responses use a standard envelope.

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

Server errors never leak internal details; they are logged server-side.

## Consequences

- Predictable client handling of success vs. failure.
- Machine-readable error codes enable frontend mapping.
- The error-code registry starts minimal (Phase 00) and grows per phase; codes
  are not invented ahead of need.
