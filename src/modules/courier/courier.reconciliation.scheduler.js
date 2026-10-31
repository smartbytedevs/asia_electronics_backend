'use strict';

/**
 * Courier reconciliation scheduler (Phase 09, ADR-0017).
 *
 * Wraps `CourierService.reconcileActiveShipments()` in a controlled interval
 * loop. Responsibilities are intentionally limited to:
 *
 *   - start() / stop() lifecycle
 *   - duplicate-start / duplicate-stop guards
 *   - invoking the existing reconciliation service
 *   - preventing overlapping runs (in-flight guard, no job queue)
 *
 * The scheduler is EXPLICITLY started after the database connection and the
 * HTTP server are up (see src/server.js). It never creates a timer at module
 * scope. When `COURIER_RECONCILE_ENABLED=false` the factory returns `null` and
 * nothing runs at all.
 *
 * A failed run is logged (safe fields only) and the scheduler keeps ticking —
 * a reconciliation failure MUST NOT crash the process.
 */

const RECONCILE_INTERVAL_MIN_MS = 1000;

class CourierReconciliationScheduler {
  /**
   * @param {object} deps
   * @param {object} deps.courierService - service exposing
   *   `reconcileActiveShipments()` (the existing `CourierService`).
   * @param {number} deps.intervalMs - positive integer >= 1000 (ms).
   * @param {function} [deps.onError] - error reporter; defaults to a safe
   *   `console.error` of the message only (never tokens/secrets).
   * @param {boolean} [deps.runImmediately=true] - run once right after
   *   start(), then every intervalMs. The immediate pass picks up shipments
   *   that went stale while the process was down; the in-flight guard keeps it
   *   from overlapping the first interval tick.
   */
  constructor({ courierService, intervalMs, onError, runImmediately = true }) {
    if (!courierService || typeof courierService.reconcileActiveShipments !== 'function') {
      throw new Error(
        'CourierReconciliationScheduler requires a courierService with reconcileActiveShipments()'
      );
    }
    const ms = Number(intervalMs);
    if (!Number.isSafeInteger(ms) || ms < RECONCILE_INTERVAL_MIN_MS) {
      throw new Error(
        `CourierReconciliationScheduler requires intervalMs to be a positive integer ` +
          `of at least ${RECONCILE_INTERVAL_MIN_MS}ms`
      );
    }

    this.courierService = courierService;
    this.intervalMs = ms;
    this.onError =
      onError ||
      ((err) => {
        console.error(`[courier] reconciliation failed: ${err && err.message}`);
      });
    this.runImmediately = Boolean(runImmediately);

    this._timer = null;
    this._started = false;
    this._running = false;
    this._inFlight = null;
  }

  /** True while the scheduler has been started and not yet stopped. */
  get started() {
    return this._started;
  }

  /** True while a reconciliation run is currently executing. */
  get inFlight() {
    return this._running;
  }

  /**
   * Starts the interval loop. Safe to call once; a second call returns false
   * and does NOT create a second timer.
   *
   * @returns {boolean} true when started, false when already started.
   */
  start() {
    if (this._started) {
      return false;
    }
    this._started = true;

    if (this.runImmediately) {
      this._run();
    }

    this._timer = setInterval(() => {
      this._run();
    }, this.intervalMs);
    if (typeof this._timer.unref === 'function') {
      // Never keep the process alive on account of the interval alone.
      this._timer.unref();
    }

    return true;
  }

  /**
   * Stops the interval loop and awaits any in-flight run so the process never
   * disconnects MongoDB underneath an active reconciliation. Idempotent: a
   * second call returns false.
   *
   * @returns {Promise<boolean>} true when it stopped a running scheduler.
   */
  async stop() {
    if (!this._started) {
      return false;
    }
    this._started = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    const pending = this._inFlight;
    if (pending) {
      try {
        await pending;
      } catch {
        // Errors are already reported through onError inside _run.
      }
    }

    return true;
  }

  /**
   * Runs one reconciliation pass. If a pass is already running, this returns
   * the in-flight promise WITHOUT queueing another job (no unbounded queue).
   */
  _run() {
    if (this._running) {
      return this._inFlight;
    }

    this._running = true;
    this._inFlight = (async () => {
      try {
        await this.courierService.reconcileActiveShipments();
      } catch (err) {
        this.onError(err);
      } finally {
        this._running = false;
        this._inFlight = null;
      }
    })();
    return this._inFlight;
  }
}

/**
 * Factory used by the application lifecycle. Returns `null` (no scheduler)
 * unless reconciliation is enabled in the centralized config.
 *
 * @param {object} deps
 * @param {object} deps.courierService - the courier service.
 * @param {object} deps.config - the centralized config
 *   (`config.courier.reconcileEnabled`, `config.courier.reconcileIntervalMs`).
 * @param {function} [deps.onError]
 */
function createReconciliationScheduler({ courierService, config, onError }) {
  if (!config || !config.courier) {
    throw new Error('createReconciliationScheduler requires the centralized config');
  }
  if (!config.courier.reconcileEnabled) {
    return null;
  }
  return new CourierReconciliationScheduler({
    courierService,
    intervalMs: config.courier.reconcileIntervalMs,
    onError,
  });
}

module.exports = {
  CourierReconciliationScheduler,
  createReconciliationScheduler,
  RECONCILE_INTERVAL_MIN_MS,
};
