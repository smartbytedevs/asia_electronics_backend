# ADR-0002: Authentication Owned by the Frontend; Backend Verifies JWT Only

## Status

Accepted

## Date

2026-08-08

## Context

The Next.js frontend already authenticates users with Better Auth and issues
JWTs. Building a second, independent authentication system in the backend would
duplicate identity handling, risk inconsistent sessions, and contradict the
existing frontend investment.

## Decision

The backend implements **no authentication system of its own**: no login or
registration endpoints, no password handling, no sessions. It only **verifies
JWTs** issued by the frontend's Better Auth (via JWKS) and then enforces
authorization with RBAC.

Flow: `Frontend → Better Auth → JWT → Backend JWT verification → RBAC`.

## Consequences

- Single source of truth for identity lives in the frontend/Better Auth.
- Backend auth middleware must be implemented to verify JWT signatures/claims
  (JWKS URL, issuer, audience) — exact values are pending confirmation from the
  frontend implementation.
- Backend-owned staff/admin accounts may still exist for internal management,
  but their authentication session also relies on the same JWT flow.
