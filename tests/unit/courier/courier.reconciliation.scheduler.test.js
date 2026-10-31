'use strict';

process.env.NODE_ENV = 'test';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const {
  CourierReconciliationScheduler,
  createReconciliationScheduler,
  RECONCILE_INTERVAL_MIN_MS,
} = require('../../../src/modules/courier/courier.reconciliation.scheduler');

const INTERVAL = 1000;

/**
 * Deterministic courier-service stub. `behavior` receives the 1-based call
 * index and may return a value/promise or throw (a synchronous throw inside the
 * async method becomes a rejection, which is what a real provider error is).
 */
function createServiceStub(behavior) {
  const calls = [];
  const stub = {
    calls,
    reconcileActiveShipments: async () => {
      const index = calls.length + 1;
      calls.push(index);
      if (behavior) {
        return behavior(index);
      }
      return { scanned: 0, updated: 0, failed: 0 };
    },
  };
  return stub;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Runs a test body with mock setInterval/clearInterval, resetting after. */
function withMockTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

test('createReconciliationScheduler returns null when disabled (does not start)', () => {
  const service = createServiceStub();
  const scheduler = createReconciliationScheduler({
    courierService: service,
    config: { courier: { reconcileEnabled: false, reconcileIntervalMs: INTERVAL } },
  });
  assert.equal(scheduler, null);
});

test('createReconciliationScheduler returns an instance when enabled', () => {
  const service = createServiceStub();
  const scheduler = createReconciliationScheduler({
    courierService: service,
    config: { courier: { reconcileEnabled: true, reconcileIntervalMs: INTERVAL } },
  });
  assert.ok(scheduler instanceof CourierReconciliationScheduler);
  assert.equal(scheduler.intervalMs, INTERVAL);
});

test('createReconciliationScheduler rejects a missing config', () => {
  assert.throws(() => createReconciliationScheduler({ courierService: createServiceStub() }), /config/);
});

test('constructor rejects unsafe intervals (0, negative, below floor, non-integer, NaN)', () => {
  const service = createServiceStub();
  for (const intervalMs of [0, -5, 999, 1000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new CourierReconciliationScheduler({ courierService: service, intervalMs }),
      /intervalMs/,
      `intervalMs=${intervalMs} must be rejected`
    );
  }
  assert.doesNotThrow(
    () => new CourierReconciliationScheduler({ courierService: service, intervalMs: INTERVAL })
  );
  assert.equal(RECONCILE_INTERVAL_MIN_MS, 1000, 'the documented floor is 1000ms');
});

test('start() runs reconciliation immediately and then on the interval', withMockTimers(async () => {
  const service = createServiceStub();
  const scheduler = new CourierReconciliationScheduler({
    courierService: service,
    intervalMs: INTERVAL,
  });

  assert.equal(scheduler.started, false);
  assert.equal(scheduler.start(), true, 'first start returns true');
  assert.equal(scheduler.started, true);
  assert.equal(service.calls.length, 1, 'immediate first run');
  await flush();

  mock.timers.tick(INTERVAL);
  assert.equal(service.calls.length, 2, 'interval run after INTERVAL');
  await flush();

  mock.timers.tick(INTERVAL);
  assert.equal(service.calls.length, 3, 'keeps running on subsequent intervals');
}));

test('start() does not start twice (no duplicate timer)', withMockTimers(async () => {
  const service = createServiceStub();
  const scheduler = new CourierReconciliationScheduler({
    courierService: service,
    intervalMs: INTERVAL,
  });

  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false, 'second start is refused');
  assert.equal(service.calls.length, 1, 'only one immediate run');
  await flush();

  mock.timers.tick(INTERVAL);
  assert.equal(service.calls.length, 2, 'a single interval fired once');
}));

test('stop() clears the interval and stops invocation; stop is idempotent', withMockTimers(async () => {
  const service = createServiceStub();
  const scheduler = new CourierReconciliationScheduler({
    courierService: service,
    intervalMs: INTERVAL,
    runImmediately: false,
  });

  scheduler.start();
  mock.timers.tick(INTERVAL);
  assert.equal(service.calls.length, 1);

  assert.equal(await scheduler.stop(), true, 'first stop returns true');
  assert.equal(scheduler.started, false);

  mock.timers.tick(INTERVAL * 3);
  assert.equal(service.calls.length, 1, 'no runs after stop');

  assert.equal(await scheduler.stop(), false, 'second stop returns false');
}));

test('stop() awaits an in-flight reconciliation run', withMockTimers(async () => {
  const gate = deferred();
  const service = createServiceStub(() => gate.promise);
  const scheduler = new CourierReconciliationScheduler({
    courierService: service,
    intervalMs: INTERVAL,
  });

  scheduler.start();
  assert.equal(service.calls.length, 1);
  assert.equal(scheduler.inFlight, true);

  const stopping = scheduler.stop();
  assert.equal(scheduler.inFlight, true, 'in-flight run still pending during stop');

  gate.resolve({ scanned: 1, updated: 1, failed: 0 });
  await stopping;
  assert.equal(scheduler.inFlight, false, 'in-flight run settled before stop resolves');
  mock.timers.tick(INTERVAL);
  assert.equal(service.calls.length, 1, 'no new run scheduled after stop');
}));

test('a reconciliation failure is reported and does not kill the scheduler', withMockTimers(async () => {
  const errors = [];
  const service = createServiceStub((call) => {
    if (call === 1) {
      throw new Error('Pathao timeout');
    }
    return { scanned: 0, updated: 0, failed: 0 };
  });
  const scheduler = new CourierReconciliationScheduler({
    courierService: service,
    intervalMs: INTERVAL,
    onError: (err) => errors.push(err),
  });

  scheduler.start();
  await flush();
  assert.equal(errors.length, 1, 'first-run failure reached onError');
  assert.equal(errors[0].message, 'Pathao timeout');
  assert.equal(scheduler.started, true, 'scheduler survives the failure');

  mock.timers.tick(INTERVAL);
  await flush();
  assert.equal(service.calls.length, 2, 'next interval still runs');
  assert.equal(errors.length, 1, 'second run succeeded, no new error');
}));

test('overlapping reconciliation runs are prevented (in-flight guard)', withMockTimers(async () => {
  const gate = deferred();
  const service = createServiceStub(() => gate.promise);
  const scheduler = new CourierReconciliationScheduler({
    courierService: service,
    intervalMs: INTERVAL,
  });

  scheduler.start();
  assert.equal(service.calls.length, 1);

  mock.timers.tick(INTERVAL);
  mock.timers.tick(INTERVAL);
  assert.equal(service.calls.length, 1, 'no concurrent run while the first is in flight');

  gate.resolve({ scanned: 1, updated: 1, failed: 0 });
  await flush();
  assert.equal(scheduler.inFlight, false);

  mock.timers.tick(INTERVAL);
  assert.equal(service.calls.length, 2, 'runs resume after the in-flight pass settles');
}));

test('the interval configuration is respected exactly', withMockTimers(async () => {
  const service = createServiceStub();
  const scheduler = new CourierReconciliationScheduler({
    courierService: service,
    intervalMs: INTERVAL,
    runImmediately: false,
  });

  scheduler.start();
  assert.equal(service.calls.length, 0, 'no immediate run when runImmediately=false');

  mock.timers.tick(INTERVAL - 1);
  assert.equal(service.calls.length, 0, 'nothing before INTERVAL elapses');

  mock.timers.tick(1);
  assert.equal(service.calls.length, 1, 'runs exactly at INTERVAL');
  await flush();

  mock.timers.tick(INTERVAL);
  assert.equal(service.calls.length, 2, 'runs at the next INTERVAL boundary');
}));
