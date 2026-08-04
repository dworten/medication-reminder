'use strict';

// The API, as a router.
//
// Deliberately a router rather than changes to app.js. app.js owns the process
// — it starts the scheduler and the sweeper and serves the live Twilio webhooks
// — and mounting this is a single line there. It also means the tests can mount
// the whole API on a throwaway express app without starting a cron job.

const express = require('express');

const authRouter        = require('./auth');
const contactsRouter    = require('./contacts');
const messagesRouter    = require('./messages');
const schedulesRouter   = require('./schedules');
const callHistoryRouter = require('./callHistory');
const { errorHandler, ApiError } = require('./errors');

const { requireAuth } = authRouter;

function apiRouter() {
  const router = express.Router();

  // Responses here are JSON and account-specific. Caching either would be a
  // browser or proxy holding one account's data.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Unauthenticated by necessity: logging in is how you become authenticated.
  // /me is inside authRouter behind its own requireAuth.
  router.use('/', authRouter);

  // Everything past this point requires a session.
  router.use('/contacts',     requireAuth, contactsRouter);
  router.use('/messages',     requireAuth, messagesRouter);
  router.use('/schedules',    requireAuth, schedulesRouter);
  router.use('/call-history', requireAuth, callHistoryRouter);

  // An unknown /api path is a 404 in JSON, not the HTML express would otherwise
  // produce — a frontend parsing this should never get a surprise content type.
  router.use((_req, _res, next) => next(new ApiError(404, 'No such endpoint')));

  router.use(errorHandler);

  return router;
}

module.exports = apiRouter;
