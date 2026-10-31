# ADR-0006: CommonJS Module System

## Status

Accepted

## Date

2026-08-08

## Context

The backend runs on Node.js (>= 20.12.0), which supports both CommonJS and ESM.
Mixing module systems creates confusion around `__dirname`, imports, and
package resolution.

## Decision

Use **CommonJS** (`require` / `module.exports`) throughout the backend unless a
compelling repository-level reason to change arises. `package.json` stays
CommonJS-default (no `"type": "module"`).

## Consequences

- Consistent, familiar syntax for the whole codebase.
- Native `require` of JSON/config works without flags.
- If ESM is ever adopted, it must be a deliberate, repository-wide decision
  recorded in a new ADR.
