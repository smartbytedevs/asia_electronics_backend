# ADR-0019: Notification & Email Infrastructure

## Status

Accepted

## Date

2026-08-09

## Context

Phase 11 wires transactional customer notifications onto the established order
(Phase 07, ADR-0015), payment (Phase 08, ADR-0016), courier (Phase 09,
ADR-0017), and return/refund (Phase 10, ADR-0018) lifecycles. Today that means
one channel — **transactional email** — but the same questions would apply to
SMS or push later.

Before writing code, the following questions had to be answered:

- **Provider abstraction.** Business services must not depend on SMTP directly
  (ADR-0004: integrations behind adapters). How is an email provider chosen and
  swapped (mock in dev/tests, SMTP in production)?
- **Dependency policy.** The repository has zero runtime dependencies beyond the
  MongoDB/Express/JWT stack. Does the SMTP client add a dependency (nodemailer,
  etc.) or stay on Node built-ins?
- **Failure isolation.** A notification is a side effect of a successful
  business transaction. A send failure, a provider outage, or a template bug
  must never roll back or fail the order/payment operation that triggered it.
  What is the audit record when delivery is best-effort?
- **State machine.** Notifications are durable documents with a lifecycle
  (`QUEUED → SENT | FAILED | SKIPPED`). What are the exact states, who
  transitions them, and how do retries behave without a worker today?
- **Deduplication.** Business idempotency (Idempotency-Key) already prevents
  duplicate order/payment/return operations, but a notification can still be
  triggered more than once for the same entity. How is that guarded?
- **Event/template coverage.** Which lifecycle events actually emit today, and
  which event types + templates exist but are not yet triggered?
- **Security.** Notification payloads travel to a template engine and email
  body; JWT/token material, credentials, and raw user input must never leak.

## Decision

### Provider-agnostic EmailProvider interface

- `src/integrations/email/email.interface.js` defines the contract every
  provider satisfies: `sendEmail({ to, subject, html, text })` → a resolved
  `{ provider, messageId }` or a rejected `EmailProviderError`.
- `src/integrations/email/index.js` is the factory: `createEmailProvider(
  config.email)` selects **`smtp`** (production) or **`mock`** (default —
  deterministic in-memory service for development and tests).
- The returned object always satisfies the interface, so callers depend on the
  abstraction only (ADR-0004). No business service ever imports the SMTP client.

### Dependency-free SMTP client

- `src/integrations/email/smtp/smtp.client.js` implements RFC 5321 SMTP using
  only Node built-ins (`net`, `tls`, `crypto`): connect → EHLO → opportunistic
  STARTTLS → AUTH PLAIN (when a user is configured) → MAIL FROM → RCPT TO →
  DATA → QUIT. One client instance is created per message.
- Messages are `multipart/alternative` (text + html) with a random boundary,
  header-injection-safe (CR/LF stripped from the subject/headers), and
  dot-stuffed per RFC 5321 §4.5.2.
- `smtp.provider.js` validates `EMAIL_HOST`/`EMAIL_FROM` at **first send** and
  signals `NOT_CONFIGURED` rather than failing application boot (per the
  provider interface contract, validation is deferred to send time).

### Mock provider for development/tests

- `src/integrations/email/email.mock.js` records every send in memory
  (`sent`, `calls.sends`) and can be made to fail deterministically
  (`failNextSendWith(err)`), keeping tests offline, fast, and deterministic.

### NotificationService owns orchestration

- `src/modules/notifications/notification.service.js` (`NotificationService`)
  owns the whole pipeline: enabled/disabled switch → event-type lookup in the
  template registry → recipient resolution (user must exist and have an email)
  → within-window dedupe → template render → persist the `Notification` at
  `QUEUED` → best-effort send → mark `SENT`/`FAILED`/`SKIPPED`.
- `createMaybeNotify(notificationService)` is the canonical "side effect that
  must never fail the primary operation" wrapper (same shape as
  `AdminOrderService.maybeAutoDispatch`): a missing service is a no-op, and any
  error (including `NotificationError`) is logged and swallowed.
- Business services inject an optional `notificationService` and call
  `maybeNotify({ userId, eventType, data })` AFTER their own transaction has
  committed. They call the abstraction, never SMTP directly.

### Composition point

- `src/modules/notifications/notification.routes.js` is the composition point:
  it binds the central config to a default `NotificationService` (default mock
  email provider) and exports `defaultNotificationService`, `defaultEmailService`,
  `NotificationService`, and `createMaybeNotify` for business modules and tests.
  Module load is connection-free; only DB operations happen at request time.

## Notification lifecycle

The notification state machine is documented in
`docs/notification-state-machine.md`. In short:

```
QUEUED → SENT      (provider accepted the message; TERMINAL)
QUEUED → FAILED    (provider/transport error; retryable → QUEUED)
QUEUED → SKIPPED   (no email provider configured; TERMINAL)
FAILED → QUEUED    (retry — reserved for a future retry worker)
FAILED → SKIPPED   (abandoned)
```

- `QUEUED` is the **entry state**: the record is persisted BEFORE the send
  attempt, so a crash between create and mark leaves a retryable row.
- **Transition enforcement is service-level.** `notification.state-machine.js`
  defines `VALID_TRANSITIONS`/`canTransition` as the single source of truth,
  and the repository's `markSent`/`markFailed`/`markSkipped` are guarded
  conditional `findByIdAndUpdate` operations, but the repository does NOT
  import/apply `canTransition`. The `QUEUED → SENT | FAILED | SKIPPED` path is
  enforced by `NotificationService`'s call sequence.

## Event architecture

`NOTIFICATION_EVENT_TYPES` (`src/modules/notifications/notification.constants.js`)
declares **17 event types** across 5 categories (`order`, `payment`, `courier`,
`return`, `refund`). The template registry (`src/modules/notifications/templates/index.js`)
maps each event type to `{ key, category, render({ customer, data }) }` →
`{ subject, html, text }`. All 17 templates exist and render.

### Currently wired events (Phase 11 — actually emitted)

| Event | Triggered by |
| ----- | ------------ |
| `ORDER_PLACED` | `order.service.js` checkout (skipped on idempotent retries) |
| `ORDER_CONFIRMED` | `adminOrder.service.js` confirm |
| `ORDER_PROCESSING` | `adminOrder.service.js` process |
| `ORDER_REJECTED` | `adminOrder.service.js` reject |
| `ORDER_CANCELLED` | `order.service.js` cancel |
| `PAYMENT_SUBMITTED` | `payment.service.js` submit (new submission and resubmission) |
| `PAYMENT_VERIFIED` | `payment.service.js` verify |
| `PAYMENT_REJECTED` | `payment.service.js` reject |

### Declared + templated but NOT yet triggered (future phases)

`SHIPMENT_DISPATCHED`, `ORDER_DELIVERED` (courier — ADR-0017), `RETURN_REQUESTED`,
`RETURN_APPROVED`, `RETURN_REJECTED`, `RETURN_COMPLETED`, `RETURN_CANCELLED`
(returns — ADR-0018), `REFUND_PROCESSED`, `REFUND_VOIDED` (refunds — ADR-0018).

These event types and templates are **reserved**: no business service currently
emits them, and they MUST NOT be described as implemented triggers. They are the
ready-to-wire surface for future phases.

## Security

- **No JWT/token data in payloads.** Business services build sanitized safe
  subsets (`entityRef`, `orderNumber`, `transactionReference`,
  `amountMinorUnits`, `note`, …) — never tokens, credentials, or provider
  internals.
- **No SMTP credentials in logs/responses.** The SMTP client never logs the
  `AUTH PLAIN` token or password; `lastError` records only a machine code and a
  message slice (≤ 500 chars). Connection errors carry no credentials.
- **HTML escaping.** Templates escape every user-controlled value
  (`escapeHtml`) before interpolation; the shared email shell
  (`templates/base.js`) escapes the greeting, title, and subject too.
- **Provider credentials only through configuration** (`.env` /
  `.env.example`). The repo never commits credential values.
- **Notification payloads are sanitized snapshots** (`payload` is a `Mixed`
  field the callers fill with safe subsets) so a notification remains
  re-renderable and auditable without exposing secrets.

## Failure isolation

Notification delivery is **best-effort** and must never change the outcome of
the business operation that triggered it:

- Business services call `maybeNotify` AFTER their transaction has committed.
  The notification cannot roll back the transaction.
- `createMaybeNotify` catches every error (including render/unknown-event
  `NotificationError`s) and logs `[notifications] failed to notify` — the
  business operation proceeds.
- Provider failures are recorded on the Notification document
  (`status: FAILED` + `lastError`), not thrown to the caller.
- A missing provider marks the Notification `SKIPPED` (safe no-op); a missing
  service or disabled notifications is a no-op (`null`).

## Idempotency & deduplication

- **Business-level idempotency** is unchanged (checkout/payment/return
  `Idempotency-Key` + unique indexes). Idempotent retries short-circuit BEFORE
  any notification is emitted — no duplicate email on a retried request.
- **Notification dedupe** is a within-window guard: `NotificationService`
  skips when an identical `{ recipient, eventType, entityRef }` notification was
  created inside `dedupeWindowMs` (default 1 hour). Backed by the
  `{ recipient: 1, eventType: 1, entityRef: 1, createdAt: -1 }` index.
- Dedupe is **defense-in-depth** on top of the business services' own
  idempotency short-circuits, and it is **window-based, not a durable event
  idempotency system** (see limitations).

## Known limitations

- **Window-based dedupe.** A duplicate outside the dedupe window is sent again;
  dedupe is not a durable event-idempotency mechanism.
- **No durable event queue.** Notifications are created synchronously at the
  business event; there is no outbox/queue.
- **No retry worker / job queue.** `FAILED` notifications are recorded and
  remain retryable (`FAILED → QUEUED` is a valid, reserved transition) but no
  worker retries them today; a future retry worker can scan via the
  `{ status: 1, lastAttemptAt: 1 }` index.
- **State-machine transition enforcement is service-level.** The repository
  does not apply `canTransition`; enforcement relies on the
  `NotificationService` call sequence and guarded conditional updates.
- **SMTP error classification documentation was corrected** to match runtime
  behavior: transient 4xx replies and network/timeout/connection errors map to
  `PROVIDER_UNAVAILABLE` (retryable); permanent 5xx replies and malformed
  replies map to `PROVIDER_REJECTED`. No runtime behavior was changed.
- **No HTTP notification endpoints and no customer notification center.** The
  `Notification` collection is an audit/retry record; the serializer exists for
  a future inbox, but no routes expose it.

## Consequences

Positive:

- Business services are decoupled from the email provider (ADR-0004); SMTP can
  be replaced or extended (SMS/push) behind the same interface and factory.
- Zero new runtime dependencies — the SMTP client is Node built-ins only,
  consistent with the repository's dependency policy.
- Best-effort isolation is explicit and enforced by `createMaybeNotify`: a
  failed notification can never fail the order/payment operation.
- One audit record per message (`Notification`), re-renderable from its
  sanitized `payload`, with delivery/error metadata for troubleshooting.
- Deterministic, offline tests via the mock provider; the default config
  (`EMAIL_PROVIDER=mock`) is safe for development.
- A single template registry + shared email shell gives one brand voice and one
  escaping policy; the 9 reserved templates make future courier/return/refund
  triggers a wiring-only change.

Negative / accepted:

- Dedupe is window-based, not durable event idempotency; an out-of-window
  duplicate is possible (mitigated by business-level idempotency).
- `FAILED` notifications are not retried until a future retry worker exists.
- Repository-level transition enforcement is not implemented; a future worker
  must apply the documented machine when it adds retries.
- No customer-facing notification endpoints/inbox yet.
