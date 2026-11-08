'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../src/config/index.js');
const DATABASE_PATH = require.resolve('../src/config/database.js');

const ENV_KEYS = [
  'NODE_ENV',
  'MONGODB_URI',
  'MONGODB_SERVER_SELECTION_TIMEOUT_MS',
];

/**
 * Reloads the database module (and its config dependency) with a controlled
 * environment, then restores the original environment.
 */
function reloadDatabase(env) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  Object.assign(process.env, { NODE_ENV: 'test', ...env });
  delete require.cache[CONFIG_PATH];
  delete require.cache[DATABASE_PATH];
  try {
    return require('../src/config/database.js');
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

test('database module exposes a safe public API and connection state', async () => {
  const db = reloadDatabase({ MONGODB_URI: '' });
  assert.equal(typeof db.connectDatabase, 'function');
  assert.equal(typeof db.ensureDatabaseConnection, 'function');
  assert.equal(typeof db.disconnectDatabase, 'function');
  assert.equal(typeof db.getDatabaseState, 'function');
  assert.equal(typeof db.isDatabaseConnected, 'function');

  const state = db.getDatabaseState();
  assert.ok(
    ['connected', 'connecting', 'disconnecting', 'disconnected', 'uninitialized'].includes(
      state
    ),
    `state '${state}' is a known safe value`
  );
  assert.equal(db.isDatabaseConnected(), false);
});

test('connectDatabase throws a clear error when MONGODB_URI is missing', async () => {
  const db = reloadDatabase({ MONGODB_URI: '' });
  await assert.rejects(db.connectDatabase(), /MONGODB_URI/);
});

test('disconnectDatabase resolves safely when not connected', async () => {
  const db = reloadDatabase({ MONGODB_URI: '' });
  await db.disconnectDatabase();
});

test('connectDatabase fails fast with a redacted error when the database is unreachable', async () => {
  const db = reloadDatabase({
    MONGODB_URI: 'mongodb://127.0.0.1:59999/taqwa_test',
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: '2000',
  });

  await assert.rejects(db.connectDatabase(), (err) => {
    assert.match(err.message, /MongoDB connection failed/);
    assert.doesNotMatch(err.message, /mongodb:\/\//, 'no URI scheme leaks');
    assert.doesNotMatch(err.message, /59999/, 'no host/port leaks');
    return true;
  });
});
