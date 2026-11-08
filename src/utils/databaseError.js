'use strict';

const UNAVAILABLE_NAMES = new Set([
  'MongooseServerSelectionError',
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoTopologyClosedError',
  'MongoNotConnectedError',
  'MongoTimeoutError',
  'MongooseTimeoutError',
  'PoolClearedError',
]);

const TIMEOUT_NAMES = new Set([
  'MongoNetworkTimeoutError',
  'MongoTimeoutError',
  'MongooseTimeoutError',
]);

const UNAVAILABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
]);

const UNAVAILABLE_MESSAGES = [
  'server selection timed out',
  'could not connect to any servers',
  'topology is closed',
  'not connected',
  'buffering timed out',
  'connection was disconnected',
  'connection closed',
  'connection reset',
  'network timeout',
];

function errorName(err) {
  return err && typeof err.name === 'string' ? err.name : '';
}

function errorCode(err) {
  return err && typeof err.code === 'string' ? err.code : '';
}

function hasRetryableLabel(err) {
  if (!err || !err.errorLabelSet || typeof err.errorLabelSet.has !== 'function') {
    return false;
  }
  return (
    err.errorLabelSet.has('RetryableError') ||
    err.errorLabelSet.has('SystemOverloadedError') ||
    err.errorLabelSet.has('ResetPool')
  );
}

function classifyDatabaseError(err) {
  if (!err) {
    return null;
  }

  const name = errorName(err);
  const code = errorCode(err);
  const message = String(err.message || '').toLowerCase();

  const isTimeout =
    TIMEOUT_NAMES.has(name) ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    message.includes('timed out');

  const isUnavailable =
    UNAVAILABLE_NAMES.has(name) ||
    UNAVAILABLE_CODES.has(code) ||
    hasRetryableLabel(err) ||
    UNAVAILABLE_MESSAGES.some((fragment) => message.includes(fragment));

  if (!isUnavailable && !isTimeout) {
    return null;
  }

  return isTimeout
    ? { statusCode: 504, code: 'DATABASE_TIMEOUT' }
    : { statusCode: 503, code: 'DATABASE_UNAVAILABLE' };
}

module.exports = { classifyDatabaseError };
