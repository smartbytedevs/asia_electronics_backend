# Courier Shipment State Machine

Phase 09, ADR-0017. The authoritative transition table lives in
`src/modules/courier/courier.state-machine.js` (`VALID_TRANSITIONS`); services
derive their allowed-from sets from it, so the machine cannot drift.

## States

| Status | Meaning | Terminal |
| ------ | ------- | -------- |
| `PENDING` | Shipment created for the order; not yet accepted by the provider (or a previous submit attempt failed before any response). | no |
| `ACTIVE` | Provider accepted the order; `consignmentId` assigned; parcel in flight. | no |
| `DELIVERED` | Provider confirmed delivery. | **yes** |
| `CANCELLED` | Never dispatched (cancelled while `PENDING`/`FAILED`) or the provider confirmed cancellation. | **yes** |
| `FAILED` | Provider rejected/errored on submit; retryable (`retry`). | no |
| `CANCELLATION_FAILED` | The provider refused/errored on a cancel attempt for an in-flight parcel; retryable (`cancel`). | no |

## Transitions

| From | To | Trigger | Actor |
| ---- | -- | ------- | ----- |
| `PENDING` | `ACTIVE` | dispatch submit succeeds | staff/admin |
| `PENDING` | `FAILED` | dispatch submit rejected/errored | provider |
| `PENDING` | `CANCELLED` | cancel before dispatch (no provider call) | staff/admin, order-cancel hook |
| `FAILED` | `ACTIVE` | retry submit succeeds | staff/admin |
| `FAILED` | `CANCELLED` | cancel after failure (no provider call) | staff/admin, order-cancel hook |
| `ACTIVE` | `DELIVERED` | webhook / reconciliation confirmed delivery | provider (system) |
| `ACTIVE` | `CANCELLED` | provider confirmed cancellation | provider (system), staff/admin |
| `ACTIVE` | `CANCELLATION_FAILED` | provider refused/errored on cancel | provider |
| `CANCELLATION_FAILED` | `DELIVERED` | provider reported delivered meanwhile (webhook/poll) | provider (system) |
| `CANCELLATION_FAILED` | `CANCELLED` | retried cancel succeeded | staff/admin, order-cancel hook |

`DELIVERED` and `CANCELLED` have **no outgoing transitions**: nothing may leave
them, and duplicate deliveries/cancellations are idempotent no-ops.

## Conflict handling

Every transition is an **atomic conditional update** on the source status
(`transitionStatus` / `recordSubmission*` in
`courierShipment.repository.js`). If the shipment is no longer in the expected
source state (a concurrent webhook, poll, cancel, or dispatch won the race),
the update returns `null` and the caller re-reads and reports current state —
it never clobbers the winner.

## Provider status mapping (webhook + reconciliation)

Only confirmed terminal provider labels transition local state
(`pathao.mapper.mapProviderStatus`):

- `*delivered*` → `DELIVERED`
- `*cancelled*` → `CANCELLED`
- everything else (exceptions, returns, partial deliveries) → stays `ACTIVE`

Non-terminal provider updates on `ACTIVE`/`CANCELLATION_FAILED` shipments only
refresh the `providerStatus` snapshot (`touchProviderStatus`) — the local
lifecycle status is untouched.

## Concurrency notes

- One `CourierShipment` per order (unique `orderId`) — the DB-level dispatch
  guard. `consignmentId` and `merchantReference` are also unique (sparse) for
  webhook matching.
- Provider HTTP calls always happen **outside** any DB transaction.
- Concurrent submit calls are serialized per shipment by an in-process promise
  lock (`CourierService._inflightSubmits`). This prevents double-consignment in
  a single process. **Horizontal scaling:** a multi-instance deployment would
  need a distributed lock or an explicit `SUBMITTING` state — the guarded
  `recordSubmissionSuccess/Failure` (conditional on `PENDING`/`FAILED`) still
  prevents a stale instance from overwriting a newer state.
- A reconciliation scan never runs inside a transaction; per-shipment failures
  are absorbed and the last-fetch timestamp is bumped so the provider is not
  hammered.

## System actors

Webhook and reconciliation transitions are system-initiated and record
`by: null` in `statusHistory`. Actor-initiated transitions (dispatch, retry,
cancel, order-cancel hook) record the acting user id.

## Test coverage

The machine's reachability table is asserted in
`tests/unit/courier/courier.state-machine.test.js`; the full service flows
(dispatch/retry/cancel/webhook/reconcile/idempotency/races) are covered in
`tests/unit/courier/courier.service.test.js` using the mock provider and
in-memory repositories (see `tests/helpers/courier-stubs.js`).
