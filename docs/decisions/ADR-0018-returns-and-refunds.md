# ADR-0018: Returns & Refunds

## Status

Accepted

## Date

2026-08-09

## Context

Phase 10 wires customer returns and the resulting refunds onto the Phase 07/08
order and payment lifecycle (ADR-0015, ADR-0016). A customer receives an order
and, within the return window, wants to return part or all of it for a refund.

The order state machine (ADR-0015) deliberately **reserves** the `RETURN_*`
statuses (`RETURN_REQUESTED` / `RETURNED`) for a future post-fulfillment phase.
Before writing code, the following questions had to be answered:

- **Machine placement.** Does the return lifecycle live INSIDE the order machine
  (activating the reserved `RETURN_*` states), or is it a SEPARATE state machine
  over its own document?
- **Money integrity.** Refund amounts must be integer minor units (paisa,
  ADR-0013/ADR-0015). What price does the refund use — live catalog prices, the
  order's item snapshots, or a new snapshot at request time? Are delivery fees
  refundable? Can a customer edit an amount?
- **Duplicate prevention.** A double-clicked submit, a network retry, or two
  tabs must not create two returns or claim an item's quantity twice. Can two
  DIFFERENT requests (different idempotency keys) overlap on the same quantity?
- **Inventory.** Returned goods go back into ONLINE stock. Restocking must not
  overshoot (restock past a soft-deactivated variant), must be ledgered as an
  immutable movement, and must happen exactly once.
- **Concurrency.** Two staff completing the same return at once must not
  double-restock or double-refund.
- **Refund → payment relationship.** Does a refund mutate the original Payment
  document? Does COD get a "refund"? Is a refund money actually sent somewhere,
  or is it an accounting record a human acts on?
- **RBAC.** Who may submit (customer, own order only), and who may
  approve/reject/cancel/complete/process/void?

## Decision

### Returns are a SEPARATE state machine on their own document

`Return` is its own collection (`src/modules/returns/return.model.js`) with a
dedicated machine (`docs/return-state-machine.md`). The return service **never
mutates the Order document** and the order-level `RETURN_REQUESTED`/`RETURNED`
statuses stay reserved and unreachable. Reasons:

- The return has richer fields than an order status could carry (per-item
  quantities, a reason, reviewer identities, an idempotency key, a refund link).
- A customer may submit multiple DISTINCT returns for the same order over the
  window; embedding that in one order status is a poor fit.
- The order machine stays closed; no `ORDER_INVALID_STATE` bloat from return
  concerns, and the two machines cannot drift.

### Refund amounts are SERVER-DERIVED from immutable snapshots

- Refund amount = Σ (item `unitPriceMinorUnits` − `discountMinorUnits`) ×
  returned quantity, computed from the return's **embedded item snapshots**
  (copied from the order items at request time). **No delivery-fee refunds.**
- The client NEVER supplies an amount; there is no amount input and no
  edit-amount endpoint. This preserves ADR-0015's "client never trusted for
  money" invariant.
- The refund **never mutates** the original `Payment` or `Order` documents. It
  is an accounting record (`refunds` collection) created at `PENDING` and
  processed/voided by staff/admin. For `MANUAL` orders it snapshots the verified
  payment id; for `COD` the `paymentId` is `null`.

### Duplicate prevention (submission replay-safety)

- `Idempotency-Key` header is required for submission (same conventions as
  checkout, ADR-0015). The unique compound index
  `{ orderId: 1, idempotencyKey: 1 }` makes a retried submit return the original
  return; a conflicting body → `409 RETURN_IDEMPOTENCY_CONFLICT`.
- Per-item availability is computed as `orderItem.quantity` minus the quantity
  claimed by `PENDING`/`APPROVED`/`COMPLETED` returns, so an item can be
  partially returned across multiple returns.
- **Documented limitation:** two CONCURRENT submissions with DIFFERENT keys
  overlapping the same quantity can both pass the check before either commits
  (no atomic claim document). This is accepted for Phase 10; the unique index
  still blocks same-key replays.

### Completion is the ONLY side-effect transaction

- `PENDING → APPROVED → COMPLETED` is the happy path. **Only** the
  `APPROVED → COMPLETED` transition has side effects, applied in ONE MongoDB
  transaction: conditional transition → per-line ONLINE restock
  (`RETURN_RESTOCK` movement, `inventory.service.restockOnlineInTransaction`) →
  auto-create the `PENDING` refund (`refund.service.createRefundInTransaction`)
  → persist `refundId` on the return.
- The transaction's conflict point is the conditional `APPROVED → COMPLETED`
  transition, so two concurrent completes cannot double-restock/refund.
- Restock goes ONLINE (returned goods are sellable), never offline, and does
  NOT require an ACTIVE variant.

### Refunds are a tiny terminal machine

`PENDING → PROCESSED | VOIDED`, both terminal, staff/admin only
(`docs/refund-state-machine.md`). No customer-facing refund surface.

### RBAC

- Customer (own order only): submit, list/detail own returns, cancel own
  `PENDING` return. Cross-customer reads → `404 RETURN_NOT_FOUND` (never 403).
- Staff/admin: approve / reject / cancel (PENDING/APPROVED) / complete
  (APPROVED), and process / void refunds. Acting ids always `req.user.id`.

## Consequences

Positive:

- Order machine untouched and still closed; no return concerns leak into it.
- Money is fully server-derived and auditable (immutable snapshots + a refund
  record with `statusHistory`); the "never trust the client" invariant holds.
- Idempotent submission + unique index make double-submit and replay safe.
- Restock and refund are atomic with the COMPLETED transition — no partial
  side effects and no way to restock/refund twice.
- Customer identity, role, and ownership are enforced in the service layer,
  consistent with ADR-0011 and the Phase 07/08 ownership pattern.

Negative / accepted:

- The concurrent-different-key availability race is accepted (documented in
  both `docs/return-state-machine.md` and `return.service.js`). A future phase
  may add an atomic claim document if the risk materializes.
- A refund is an accounting record; actually moving money back to the customer
  is out of scope (no gateway integration exists — ADR-0016 manual capture).
- There is currently no direct customer visibility of refund records (admin
  surface only); a customer sees their return's `refundId`, not the refund
  itself.
- `processRefund` does NOT yet enforce "linked return COMPLETED" in code —
  the guard (`REFUND_RETURN_NOT_COMPLETED`) is defined but uninvoked; it is
  guaranteed by construction (refunds are only auto-created at completion) and
  documented as an open follow-up in the phase report.
