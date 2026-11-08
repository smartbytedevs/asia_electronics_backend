'use strict';

const mongoose = require('mongoose');
const config = require('./index');

/**
 * Database connection module.
 *
 * Owns the single Mongoose default connection lifecycle:
 *   connectDatabase()   — connect to MongoDB Atlas via centralized config
 *   disconnectDatabase()— close the connection (idempotent)
 *   getDatabaseState()  — safe public connection state string
 *   isDatabaseConnected()
 *
 * Design notes:
 * - Uses the CURRENT Mongoose API only (no deprecated options).
 * - `bufferCommands` is disabled: in a request/response API, queries must fail
 *   fast when the database is unavailable instead of buffering and hanging.
 * - Connection errors are logged with the URI/credentials redacted.
 * - The default connection is reused; `connectDatabase` never creates a second
 *   connection while one is active.
 */

const CONNECTION_STATES = Object.freeze({
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
});

/**
 * Removes connection details from a message so credentials and hosts never
 * leak into logs or error messages. Redacts the full URI, its authority
 * (user:pass@host:port) and the host portion independently, because Mongoose
 * errors often surface only the host or host:port.
 */
function redactUri(message) {
  const uri = config.db.uri;
  if (!uri || typeof message !== 'string') {
    return message;
  }

  let result = message.split(uri).join('[REDACTED]');

  const schemeMatch = uri.match(/^(mongodb(\+srv)?:\/\/)/i);
  if (schemeMatch) {
    const rest = uri.slice(schemeMatch[0].length);
    const slash = rest.indexOf('/');
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const at = authority.indexOf('@');
    const credentials = at === -1 ? null : authority.slice(0, at + 1);
    const hostPart = at === -1 ? authority : authority.slice(at + 1);

    result = result.split(authority).join('[REDACTED]');
    if (hostPart !== authority) {
      result = result.split(hostPart).join('[REDACTED]');
    }
    if (credentials) {
      result = result.split(credentials).join('[REDACTED]@');
    }
  }

  return result;
}

function setupConnectionListeners() {
  const conn = mongoose.connection;

  if (conn.listenerCount('connected') > 0) {
    return;
  }

  conn.on('connected', () => {
    console.log('[asia-electronics] MongoDB connection established');
  });

  conn.on('reconnected', () => {
    console.log('[asia-electronics] MongoDB connection re-established');
  });

  conn.on('disconnected', () => {
    console.log('[asia-electronics] MongoDB disconnected');
  });

  conn.on('error', (err) => {
    console.error(`[asia-electronics] MongoDB connection error: ${redactUri(err && err.message)}`);
  });
}

let connectPromise = null;

/**
 * Ensures there is a live MongoDB connection.
 *
 * This is intentionally called before every serverless request instead of
 * caching a single resolved promise forever. A cached "ready" promise is
 * exactly how a warm Vercel instance kept reporting itself connected after
 * the underlying connection had dropped. Concurrent callers share the
 * in-flight attempt, but every request re-checks the actual readyState.
 *
 * Fails fast with a clear, redacted error when the URI is missing or the
 * database cannot be reached within the bounded timeouts.
 */
async function ensureDatabaseConnection() {
  if (!config.db.uri) {
    throw new Error(
      'MONGODB_URI is not configured. Add it to .env (see .env.example).'
    );
  }

  if (isDatabaseConnected()) {
    return mongoose.connection;
  }

  if (connectPromise) {
    return connectPromise;
  }

  mongoose.set('bufferCommands', false);
  setupConnectionListeners();

  connectPromise = (async () => {
    try {
      await mongoose.connect(config.db.uri, {
        serverSelectionTimeoutMS: config.db.serverSelectionTimeoutMs,
        connectTimeoutMS: config.db.connectTimeoutMs,
        socketTimeoutMS: config.db.socketTimeoutMs,
        waitQueueTimeoutMS: config.db.waitQueueTimeoutMs,
        maxPoolSize: config.db.maxPoolSize,
        minPoolSize: config.db.minPoolSize,
        maxIdleTimeMS: config.db.maxIdleTimeMs,
        autoIndex: config.db.autoIndex,
      });
    } catch (err) {
      const clean = new Error(
        `MongoDB connection failed: ${redactUri(err && err.message)}`
      );
      clean.cause = err;
      throw clean;
    }

    return mongoose.connection;
  })().finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

/**
 * Backwards-compatible alias for the startup path.
 */
async function connectDatabase() {
  return ensureDatabaseConnection();
}

/**
 * Closes the MongoDB connection. Safe to call when already disconnected.
 */
async function disconnectDatabase() {
  connectPromise = null;
  if (mongoose.connection.readyState === 0) {
    return;
  }
  await mongoose.disconnect();
}

/**
 * Public connection state: one of
 * 'connected' | 'connecting' | 'disconnecting' | 'disconnected' | 'uninitialized'.
 */
function getDatabaseState() {
  const state = mongoose.connection.readyState;
  return CONNECTION_STATES[state] || 'unknown';
}

function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * Runs `work(session)` inside a MongoDB transaction on the default connection.
 *
 * - Starts a session + transaction, calls `work`, commits on success, aborts on
 *   error, and always ends the session.
 * - `work` receives the session and MUST pass it to repository/model calls via
 *   the `{ session }` options (repositories forward options to Mongoose).
 * - Used for multi-document atomic operations such as product + initial
 *   variants creation (see ADR-0013). Services receive this helper as an
 *   injectable dependency so tests can substitute a no-op transaction.
 *
 * Requires a live connection; throws if the database is unavailable.
 */
async function withTransaction(work) {
  if (!isDatabaseConnected()) {
    throw new Error(
      'Cannot start a transaction: MongoDB is not connected (withTransaction).'
    );
  }
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    try {
      await session.abortTransaction();
    } catch (abortErr) {
      // Preserve the original error; an abort failure is logged only.
      console.error(`[asia-electronics] Transaction abort failed: ${redactUri(abortErr && abortErr.message)}`);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  connectDatabase,
  ensureDatabaseConnection,
  disconnectDatabase,
  getDatabaseState,
  isDatabaseConnected,
  withTransaction,
};
