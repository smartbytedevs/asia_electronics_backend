'use strict';

const express = require('express');
const routes = require('./routes');
const requestContext = require('./middlewares/requestContext');
const cors = require('./middlewares/cors');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');
const { ensureDatabaseConnection } = require('./config/database');

const app = express();

app.disable('x-powered-by');

app.use(requestContext);
app.use(cors());

// On Vercel the app is served as a serverless function (see api/index.js and
// vercel.json). Re-check/re-establish the MongoDB connection on every request
// instead of caching a resolved promise forever; a warm instance must recover
// after an Atlas/network drop. Guarded by the VERCEL env var so local
// development and the test suite, which boot this app with no database, are
// unaffected.
if (process.env.VERCEL === '1') {
  app.use(async (req, res, next) => {
    try {
      await ensureDatabaseConnection();
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
