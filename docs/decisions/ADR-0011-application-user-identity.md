# ADR-0011: Application User Identity (Authoritative Roles + Account Status)

## Status

Accepted

## Date

2026-08-08

## Context

ADR-0002/ADR-0010 established that the backend is a resource server: it
verifies JWTs issued by the frontend's Better Auth and never stores
credentials. ADR-0010 initially mapped verified claims directly to `req.user`
including a `role` claim.

Phase 03 introduces the first business-facing capability (`GET /api/v1/me`) and
needs a persistent, authoritative notion of who the caller is as an
*application user*:

- A JWT `role` claim is minted by the frontend and is not authoritative for
  backend authorization. Anyone able to mint (or compromise) a token could
  escalate, and Better Auth has no notion of our internal STAFF/ADMIN
  assignments.
- Authorization decisions require a stable, backend-managed role that survives
  token rotation and can be changed without re-issuing tokens.
- Accounts need a lifecycle beyond the token's validity (suspend/disable an
  employee or customer).
- The backend must remain free of credentials: no password hashes, sessions,
  refresh tokens, or Better Auth secret management.

## Decision

Introduce an **application User domain** in MongoDB, fully separated from the
authentication (JWT) identity.

### Two identities per request

- `req.auth` — authentication identity `{ authProviderId, email?, displayName? }`,
  produced by `authenticate` from verified token claims only. The `role` claim
  is deliberately dropped (`mapAuthClaims` never copies it).
- `req.user` — application identity `{ id, authProviderId, email, displayName,
  phone, role, status }`, produced by `resolveCurrentUser` from the MongoDB
  `User` record. `role` here is **authoritative** for authorization.

Request flow: `authenticate → resolveCurrentUser → authorizeRoles(...) →
controller`.

### Single `User` collection

One collection (`src/modules/users/user.model.js`) holds customers, staff, and
admins, joined to the frontend identity by a unique, immutable
`authProviderId`. No separate `Customer`/`StaffUser`/`AdminUser` collections;
`CustomerProfile` remains a documented future extension.

### Role and status

- `role` enum: `CUSTOMER`, `STAFF`, `ADMIN` (default `CUSTOMER`).
- `status` enum: `ACTIVE`, `SUSPENDED`, `DISABLED` (default `ACTIVE`).
- Only `ACTIVE` accounts are admitted; `SUSPENDED`/`DISABLED` → `403` from
  `resolveCurrentUser`. Session revocation stays a frontend/Better Auth concern.

### Provisioning, not registration

- Auto-provisioning (`AUTO_PROVISION_CUSTOMERS`, default `true`) creates a
  `CUSTOMER/ACTIVE` user for a verified identity on first access. It **never**
  creates `ADMIN`/`STAFF` from JWT claims.
- With provisioning disabled, an unknown identity → `403 "User account not
  found"`.
- There is NO backend user-registration or admin-creation endpoint
  (`POST /users`, `POST /admin/register` do not exist).

### Credential-free schema

The `User` schema stores no password, hash, session, refresh token, or
authentication secret. The backend remains a resource server.

## Consequences

- Roles can be assigned/revoked server-side (STAFF/ADMIN) without touching the
  frontend or re-issuing tokens, and JWT role claims cannot escalate
  privileges — proven by tests.
- Accounts can be suspended/disabled independently of token lifetime.
- The `authProviderId` join key is the only coupling to Better Auth; if the
  frontend changes token claim names, only `mapAuthClaims`
  (`src/integrations/auth/identity.js`) changes.
- One User collection keeps resolution simple; richer customer/staff fields
  belong to future extension collections.
- A database lookup runs on every authenticated request (by unique
  `authProviderId`); acceptable for this phase and justified by the query
  pattern.
- Real Better Auth claim-name confirmation is still pending; the identity
  mapper and test fixtures isolate that uncertainty.
