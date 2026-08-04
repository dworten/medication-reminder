'use strict';

// One error shape for the whole API, and one place that decides which database
// failures are the caller's fault.
//
// The database carries real CHECK constraints and unique indexes — an empty
// days_of_week, a second default message, a duplicate phone. Left alone those
// surface as 500s, which tells the caller "the server is broken" when the truth
// is "that input is not allowed". Everything below exists to keep that
// distinction honest.

const logger = require('../logger');

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name    = 'ApiError';
    this.status  = status;
    this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, message, details);
const notFound   = (message = 'Not found') => new ApiError(404, message);
const conflict   = (message, details) => new ApiError(409, message, details);

// Express 4 does not catch a rejected promise from a handler — it hangs the
// request instead. Every async route is wrapped in this.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Field names as the API speaks them, for messages built from constraint names.
const CONSTRAINT_MESSAGES = {
  schedules_days_of_week_check:
    'daysOfWeek must contain between 1 and 7 unique days, each 0 (Sunday) to 6 (Saturday)',
  schedules_escalation_ack_minutes_check:
    'escalationAckMinutes must be between 1 and 60',
};

function fromPrisma(err) {
  // Unique violation. Which columns clashed is the difference between "that
  // failed" and "that phone number is already a contact".
  //
  // meta.target is not always populated — Prisma 7's driver adapters leave it
  // undefined and put the columns in the message instead — so both are read.
  // Relying on meta alone silently degraded every unique violation to the
  // generic wording.
  if (err.code === 'P2002') {
    const meta   = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : (err.meta?.target || '');
    const fields = `${meta} ${err.message || ''}`;

    if (fields.includes('is_default')) {
      return conflict('Another message is already the default for this account', { field: 'isDefault' });
    }
    if (fields.includes('phone')) {
      return conflict('A contact with that phone number already exists', { field: 'phone' });
    }
    if (fields.includes('parent_id')) {
      return conflict('That escalation step has already been queued');
    }
    return conflict('That value is already taken', { fields: meta || undefined });
  }

  // Foreign key violation. On this schema that means either a referenced row
  // does not exist, or a RESTRICT is refusing a delete — deleting a contact a
  // schedule still calls, most likely.
  if (err.code === 'P2003') {
    return conflict(
      'That record is still referenced by something else, or refers to a record that does not exist',
      { field: err.meta?.field_name }
    );
  }

  // Prisma could not find the row it was told to act on.
  if (err.code === 'P2025') return notFound();

  // CHECK constraints have no Prisma error code — they arrive as a raw Postgres
  // error, wrapped differently depending on the driver adapter. Matching the
  // text is unlovely but it is the only handle on them, and letting a CHECK
  // become a 500 is exactly the outcome this file exists to prevent.
  const message = String(err.message || '');
  const check   = message.match(/violates check constraint "([^"]+)"/)
               || message.match(/check constraint `([^`]+)`/);

  if (check) {
    const name = check[1];
    return badRequest(CONSTRAINT_MESSAGES[name] || `Input rejected by database constraint ${name}`);
  }

  return null;
}

function errorHandler(err, req, res, _next) {
  const api = err instanceof ApiError ? err : fromPrisma(err);

  if (api) {
    // 4xx is the caller being told something; only log it at debug volume.
    if (api.status >= 500) {
      logger.error('API error', { path: req.originalUrl, error: api.message });
    }
    return res.status(api.status).json({
      error: api.message,
      ...(api.details && { details: api.details }),
    });
  }

  // Anything unrecognised is ours. Log it in full, tell the caller nothing —
  // a stack trace or a raw database message in a response body is a gift to
  // whoever is probing.
  logger.error('Unhandled API error', {
    path:  req.originalUrl,
    error: err.message,
    stack: err.stack,
  });
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { ApiError, badRequest, notFound, conflict, asyncHandler, errorHandler, fromPrisma };
