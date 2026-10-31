# ADR-0010: Backend Resource-Server Authentication (JWT Verification + RBAC)

## Status

Accepted

## Date

2026-08-08

## Context

Per ADR-0002 the backend never authenticates users itself; it only verifies
JWTs issued by the frontend's Better Auth. Phase 02 must turn that principle
into a security foundation: verify tokens cryptographically, derive a trusted
request identity, and enforce role-based access — before any business module is
built.

Key constraints:

- The backend is a resource server. No login/registration/sessions/password
  handling.
- Verification must be cryptographic (signature + claims), never `jwt.decode`
  alone.
- Client-supplied roles (header/query/body) must be impossible to trust.
- `401` for authentication failures, `403` for authorization failures, with
  stable machine-readable error codes.
- Tokens must never be logged or echoed.
- Real Better Auth configuration (JWKS URL, issuer, audience) is still pending
  frontend confirmation, so everything must work behind an abstraction with
  deterministic test fixtures.

## Decision

### Library: `jose`

- Single, mature, actively maintained library (`jose` v6). Zero transitive
  dependencies, backed by the Web Crypto API available in the target runtime.
- `createRemoteJWKSet` provides JWKS fetching with built-in caching, cooldown,
  and key-rotation handling out of the box.
- `jwtVerify` validates signature, algorithm, issuer, audience, `exp`/`nbf`,
  and clock tolerance in one call, with typed error classes we map to stable
  internal reasons.

### Component layout

- `src/integrations/auth/jwtVerifier.js` — `createJwtVerifier({ jwksUrl | keys,
  issuer, audience, algorithms, clockTolerance })` returns an async `verify()`
  function. Remote JWKS mode for production; local `keys` mode for tests. All
  failures normalize to `JwtVerificationError` with a stable `reason`
  (`TOKEN_MALFORMED`, `TOKEN_EXPIRED`, `CLAIM_VALIDATION_FAILED`,
  `SIGNATURE_INVALID`, `ALGORITHM_NOT_ALLOWED`, ...). Messages never contain
  token/claim/key material.
- `src/integrations/auth/identity.js` — maps verified payload claims to the
  normalized `req.user = { id, role, email }`. Only explicitly trusted claims
  are copied. A token missing a user id or carrying an unknown role is
  rejected (401): a partially-trusted identity is never accepted.
- `src/integrations/auth/index.js` — builds the `defaultVerifier` from the
  centralized config and exports the reusable pieces.
- `src/middlewares/authenticate.js` — factory `authenticate(verifier?)`.
  Extracts `Authorization: Bearer <token>`, verifies, maps identity onto
  `req.user`. Any authentication problem → `401` with message
  `"Authentication required"`.
- `src/middlewares/authorizeRoles.js` — factory
  `authorizeRoles(...allowedRoles)`. Composed after `authenticate`. Unknown
  role at factory time throws (fail fast). Role not allowed → `403` with
  message `"You do not have permission to perform this action"`.

### Security posture

- Algorithm allowlist (`algorithms`, default `RS256`) prevents
  algorithm-confusion attacks.
- Issuer/audience are validated whenever configured; expiry/`nbf` and a bounded
  clock tolerance (default 30 s) are always applied.
- Role decisions use only `req.user.role`; header/query/body role values are
  never read for authorization.
- Ownership checks (e.g., customer-scoped resources) are a future behavioral
  layer in controllers/services, explicitly NOT part of this middleware.

### Configuration

- `BETTER_AUTH_JWKS_URL` required in production (fail fast), optional in
  dev/test (routes then reject all tokens with `401`).
- `BETTER_AUTH_ISSUER`, `BETTER_AUTH_AUDIENCE`, `BETTER_AUTH_ALGORITHMS`,
  `BETTER_AUTH_CLOCK_TOLERANCE_SECONDS` add validation knobs.
- Real values remain **pending frontend confirmation**; nothing is hardcoded
  or fabricated.

## Consequences

- Business modules (Phase 03+) compose `authenticate` +
  `authorizeRoles(...allowedRoles)` from constants; RBAC is consistent by
  construction.
- Security-critical behavior (malformed/expired/tampered/unknown-alg tokens,
  role matrix, spoofing attempts, identity normalization) is covered by
  automated tests using locally-generated JWKS fixtures — no live Better Auth
  needed for CI.
- Because real Better Auth values are unconfirmed, end-to-end verification
  against the frontend's actual JWKS is not yet possible; that remains a
  follow-up when the frontend provides the configuration.
- No business endpoints exist yet, so no production routes are exposed that
  depend on authentication in Phase 02.
