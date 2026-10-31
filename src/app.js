'use strict';

const express = require('express');
const routes = require('./routes');
const cors = require('./middlewares/cors');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');
const { connectDatabase } = require('./config/database');

const app = express();

app.disable('x-powered-by');

app.use(cors());

// On Vercel the app is served as a serverless function (see api/index.js and
// vercel.json): lazily connect MongoDB before handling the first request,
// cache the connection across warm invocations, and let Mongoose reconnect
// automatically. Guarded by the VERCEL env var (always set by the platform) so
// local development and the test suite — which boot this app with no database —
// are unaffected.
if (process.env.VERCEL === '1') {
  let dbReady = null;
  app.use(async (req, res, next) => {
    if (!dbReady) {
      dbReady = connectDatabase().catch((err) => {
        dbReady = null;
        throw err;
      });
    }
    try {
      await dbReady;
      return next();
    } catch (err) {
      return next(err);
    }
  });
}

app.use(express.json());

app.use(routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
