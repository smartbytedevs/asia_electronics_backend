# Taqwa Backend — Phase 10 Final Report: Returns & Refunds

Date: 2026-08-09 · Status: **Complete** · ADR: [ADR-0018](./decisions/ADR-0018-returns-and-refunds.md)

## Verification

- `npm test` (`node --test`): **752 tests, 751 pass, 0 fail, 1 skipped**.
- The app (`src/app`) and both module entry points (`return.routes.js`,
  `refund.routes.js`) require cleanly.

## Scope delivered

Two new feature modules implementing the customer return + refund lifecycle on
top of the Phase 07/08/09 foundation:

- `src/modules/returns/` — return request service, separate state machine,
  per-item snapshot validation, submission idempotency, atomic transitions,
  one completion transaction (restock + refund).
- `src/modules/refunds/` — server-derived refund record, terminal
  PENDING → PROCESSED | VOIDED machine, ADMIN/STAFF-only surface.

New routes (mounted in `src/routes/index.js`):

- Customer: `POST/GET /api/v1/orders/:orderId/returns[/:id]`,
  `POST /api/v1/orders/:orderId/returns/:id/cancel`.
- Admin: `GET /api/v1/admin/returns[/:id]`, `POST /api/v1/admin/returns/:id/`
  `approve` | `reject` | `complete` | `cancel`.
- Admin: `GET /api/v1/admin/refunds[/:id]`, `POST /api/v1/admin/refunds/:id/`
  `process` | `void`.

## Latent bugs fixed in source (all regression-tested)

| # | File | Bug | Fix |
| - | ---- | --- | --- |
| 1 | `refunds/refund.repository.js` | `findOne`/`findMany`/`count` were arrow functions — `this.buildQuery` threw at runtime | method shorthand |
| 2 | `refunds/refund.model.js` | `refundNumber` regex rejected the generator's `RFD-YYYYMMDD-XXXXXX` (legacy `RFD-XXXXXX` pattern) | regex matches generator format |
| 3 | `refunds/refund.model.js` | `amount` had no integer validator (only money field in the codebase without one) | standard `isInteger` validator |
| 4 | `refunds/refund.model.js` | list-filter indexes referenced NON-EXISTENT `orderId`/`customerId` fields (the repository filters `order`/`customer`) | indexes on `order` + `customer`; regression test asserts no phantom indexes |
| 5 | `refunds/refund.serializer.js` | dates serialized as raw `Date` objects | ISO-8601 strings via `toISO` |
| 6 | `refunds/refund.validation.js` | `assertObjectId` threw the wrong code | `INVALID_RETURN`/`INVALID_REFUND` codes |
| 7 | `returns/return.validation.js` | duplicate-item error used a generic code | `RETURN_ITEM_DUPLICATE` |

## Tests added

86 unit tests across 11 files (43 returns + 43 refunds), plus shared in-memory
stubs that emulate the real repositories (duplicate-key errors, atomic
`conditionalTransition`, `$in`/`$gte` filter matching):

- `tests/unit/returns/` — repository (3), serializer (4), service (20),
  state machine (5), validation (11).
- `tests/unit/refunds/` — model (8), repository (5), serializer (4), service
  (16), state machine (5), validation (6).
- `tests/helpers/return-stubs.js`, `tests/helpers/refund-stubs.js`.

## Documentation

New:

- `docs/return-state-machine.md`, `docs/refund-state-machine.md`.
- `docs/decisions/ADR-0018-returns-and-refunds.md`.

Updated:

- `README.md`, `docs/architecture.md`, `docs/business-rules.md` (§14 Returns &
  Refunds; planned-table rows for Returns + Courier now **Finalized**),
  `docs/database-schema.md` (entities table; §4.12 `Return`, §4.13 `Refund`
  schemas + indexes), `docs/api-contract.md` (14 new error codes; Returns and
  Refunds endpoint sections; §7 planned-groups rows moved to Implemented),
  `docs/rbac-matrix.md` (§5.6 Returns & Refunds matrix; status summary),
  `docs/order-state-machine.md` (returns now a separate machine),
  `docs/inventory-state-machine.md` (`RETURN_RESTOCK` movement row),
  `docs/payment-state-machine.md` (status), `docs/decisions/template.md`
  (ADR-0017 + ADR-0018 rows).

## Open follow-ups (accepted, not blocking)

1. **`processRefund` does not enforce the "linked return COMPLETED" guard.**
   `REFUND_RETURN_NOT_COMPLETED`/`returnNotCompleted()` are defined but
   uninvoked (guaranteed by construction — refunds are only auto-created at
   return completion). Enforcing it requires injecting a `returnRepository`
   into `RefundService` (constructor + routes + tests). The misleading service
   comment has been corrected to document the gap.
2. **Concurrent same-quantity availability race.** Two simultaneous submissions
   with DIFFERENT idempotency keys overlapping a quantity can both pass the
   check before either commits (no atomic claim document). Same-key replays
   remain blocked by the unique `{ orderId, idempotencyKey }` index. Documented
   in the return state machine and ADR-0018.
3. **Refunds have no customer-facing read surface** (admin only). A customer
   sees their return's `refundId`, not the refund record — deferred by design.

## Session note

During this session several files created earlier reverted to an earlier state
(e.g. `refund.model.js` lost its list-filter indexes, `refund.model.test.js`
lost its regression test, and `return-state-machine.md` /
`refund-state-machine.md` / `ADR-0018` vanished from disk). All were detected
by cross-checking `git status` against the report and were recreated/re-applied
and re-verified (suite back to 752 tests). This report is the single source of
truth for what Phase 10 delivered.
