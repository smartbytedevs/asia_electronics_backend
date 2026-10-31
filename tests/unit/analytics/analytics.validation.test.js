'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveAnalyticsRange } = require('../../../src/modules/analytics/analytics.validation');
const { ERROR_CODES } = require('../../../src/constants');
const { ANALYTICS_LIMITS } = require('../../../src/modules/analytics/analytics.constants');

const DAY_MS = 24 * 60 * 60 * 1000;

function assertInvalidRange(fn) {
  assert.throws(fn, (err) => err.statusCode === 400 && err.code === ERROR_CODES.INVALID_ANALYTICS_RANGE);
}

test('no params defaults to the trailing DEFAULT_RANGE_DAYS window', () => {
  const before = Date.now();
  const { start, end } = resolveAnalyticsRange({});
  assert.ok(start.getTime() <= end.getTime());
  assert.ok(end.getTime() >= before, 'end defaults to now');
  const spanDays = (end.getTime() - start.getTime()) / DAY_MS;
  assert.ok(
    Math.round(spanDays) === ANALYTICS_LIMITS.DEFAULT_RANGE_DAYS,
    `window should be ~${ANALYTICS_LIMITS.DEFAULT_RANGE_DAYS} days`
  );
});

test('explicit dateFrom/dateTo are parsed and preserved', () => {
  const { start, end } = resolveAnalyticsRange({ dateFrom: '2026-08-01', dateTo: '2026-08-15' });
  assert.equal(start.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(end.toISOString().slice(0, 10), '2026-08-15');
});

test('dateFrom alone keeps end at now', () => {
  const { start, end } = resolveAnalyticsRange({ dateFrom: '2026-08-01' });
  assert.equal(start.toISOString().slice(0, 10), '2026-08-01');
  assert.ok(end.getTime() <= Date.now() + 1000);
});

test('dateTo alone anchors a trailing window', () => {
  const { start, end } = resolveAnalyticsRange({ dateTo: '2026-08-15' });
  assert.equal(end.toISOString().slice(0, 10), '2026-08-15');
  const spanDays = (end.getTime() - start.getTime()) / DAY_MS;
  assert.ok(Math.round(spanDays) === ANALYTICS_LIMITS.DEFAULT_RANGE_DAYS);
});

test('dateFrom after dateTo is rejected', () => {
  assertInvalidRange(() => resolveAnalyticsRange({ dateFrom: '2026-08-15', dateTo: '2026-08-01' }));
});

test('malformed or non-string dates are rejected', () => {
  assertInvalidRange(() => resolveAnalyticsRange({ dateFrom: 'not-a-date' }));
  assertInvalidRange(() => resolveAnalyticsRange({ dateTo: 'banana' }));
  assertInvalidRange(() => resolveAnalyticsRange({ dateFrom: 5 }));
  assertInvalidRange(() => resolveAnalyticsRange({ dateTo: {} }));
});
