# Taqwa Backend — Notification State Machine

Status: **Implemented (Phase 11, ADR-0019); machine defined in
`src/modules/notifications/notification.state-machine.js`**

A `Notification` is the durable audit record of ONE best-effort customer-facing
message (today: transactional email). It is created by business services at real
domain events and updated in place as the email provider accepts or rejects it.
Delivery **never changes the outcome** of the business operation that triggered
it.

## 1. States

| State | Kind | Meaning |
| ----- | ---- | ------- |
| `QUEUED` | entry (mutable) | Record persisted; a send attempt is about to happen. This is the retry safety net — the row exists BEFORE the send, so a crash between create and mark leaves a retryable record. |
| `SENT` | **terminal** | Email accepted by the provider (`deliveredAt`, `provider`, `providerRef` set). No further transitions. |
| `FAILED` | mutable | Provider/transport error. `lastError` + `lastAttemptAt` recorded; retryable. |
| `SKIPPED` | **terminal** | No email provider configured (marked `SKIPPED`). No further transitions. |

## 2. Transitions

Allowed transitions (source of truth: `VALID_TRANSITIONS` in
`notification.state-machine.js`):

```
 QUEUED ──────► SENT      (provider accepted the message; TERMINAL)
 QUEUED ──────► FAILED    (provider/transport error; retryable)
 QUEUED ──────► SKIPPED   (no email provider configured; TERMINAL)
 FAILED ──────► QUEUED    (retry — reserved for a future retry worker)
 FAILED ──────► SKIPPED   (abandoned after persistent failure)
```

| From | To | Performed by | When |
| ---- | -- | ------------ | ---- |
| — | `QUEUED` | `NotificationService.notify` | Creates the record at the domain event (entry state). |
| `QUEUED` | `SENT` | `NotificationService` → `notificationRepository.markSent` | After `emailService.sendEmail` resolves successfully. |
| `QUEUED` | `FAILED` | `NotificationService` → `notificationRepository.markFailed` | When `emailService.sendEmail` throws (provider/transport/render-side failure). |
| `QUEUED` | `SKIPPED` | `NotificationService` → `notificationRepository.markSkipped` | When no email service is configured. |
| `FAILED` | `QUEUED` | (none today) | Reserved for a future retry worker. |
| `FAILED` | `SKIPPED` | (none today) | Reserved for future abandonment logic. |

No transition exists from `SENT` or `SKIPPED` (terminal).

## 3. Retry / failure behavior

- A `FAILED` notification records `lastError = { code, message }` (message
  truncated to 500 chars), `lastAttemptAt`, and increments `attempts` via
  `markFailed`.
- `FAILED → QUEUED` is a **valid but unused** transition — there is **no retry
  worker / job queue** in Phase 11. Failed notifications remain in the
  collection as retryable rows; a future worker would scan them via the
  `{ status: 1, lastAttemptAt: 1 }` index (oldest first).
- A `SENT` notification records `deliveredAt`, `provider`, `providerRef`
  (provider message-id), clears `lastError`, and increments `attempts` via
  `markSent`.
- There is no exponential backoff, no max-attempts policy, and no TTL; those are
  future worker concerns.

## 4. Deduplication behavior

- Before creating a record, `NotificationService.notify` checks for an existing
  notification with the same `{ recipient, eventType, entityRef }` created after
  `now − dedupeWindowMs` (`findRecentDuplicate`; default window 1 hour).
- If one exists, the notification is **skipped entirely** (nothing persisted).
- The check is **window-based, not durable event idempotency** — a duplicate
  outside the window is sent again. Business-level idempotency
  (`Idempotency-Key`) prevents most duplicate triggers at the source.
- Backed by the `{ recipient: 1, eventType: 1, entityRef: 1, createdAt: -1 }`
  index.

## 5. Relationship between `NotificationService` and the repository

- **`NotificationService`** (`notification.service.js`) owns the orchestration:
  enabled/disabled switch → event-type lookup → recipient resolution (user must
  exist and have an email, else nothing is persisted) → dedupe check → template
  render → `create` at `QUEUED` → best-effort send → `markSent`/`markFailed`/
  `markSkipped`.
- **`notificationRepository`** (`notification.repository.js`) performs database
  operations only: `create`, `findRecentDuplicate`, and the three `mark*`
  methods (guarded `findByIdAndUpdate` with `new: true, runValidators: true`).
- Business services never call the repository — they call
  `createMaybeNotify(notificationService).maybeNotify({ userId, eventType, data })`
  after their own transaction commits.

## 6. Repository-level transition guards

**There are NONE.** The `canTransition` helper in
`notification.state-machine.js` is defined as the single source of truth, but
`notification.repository.js` does NOT import or apply it. The `mark*` methods
are atomic field updates that do not inspect the current status against
`VALID_TRANSITIONS`.

In practice the `QUEUED → SENT | FAILED | SKIPPED` path is enforced by the
`NotificationService` call sequence (a notification is only marked after its own
send attempt), but a future retry worker MUST add status preconditions (or apply
`canTransition`) to avoid double-marking — the repository will not do it for you.
This is documented as an accepted limitation in ADR-0019.
