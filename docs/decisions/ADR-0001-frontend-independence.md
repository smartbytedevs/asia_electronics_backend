# ADR-0001: Backend is a Frontend-Independent REST API

## Status

Accepted

## Date

2026-08-08

## Context

Taqwa ships a Next.js frontend and a separate Node.js backend. To keep the
backend deployable, testable, and evolvable on its own, it must not be coupled
to frontend technology or frontend-specific code.

## Decision

The backend is a standalone REST API. It MUST NOT depend on Next.js, React,
Zustand, Server Actions, Next.js middleware, frontend components, or
frontend-specific utilities. All cross-system communication happens over HTTP
(REST/JSON).

## Consequences

- Backend can be developed, deployed, and scaled independently of the frontend.
- No shared code packages between frontend and backend.
- Any cross-cutting concerns (CORS origins, JWT claims) are configured via
  environment/deployment settings rather than shared code.
