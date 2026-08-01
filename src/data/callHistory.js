'use strict';

// Writes to call_history.
//
// Every function here is best-effort by design: bookkeeping must never be the
// reason a medication call fails to go out. Callers get null (or false) on a
// database problem, log it, and carry on placing the call. Stage 3 tightens
// this for the retry sweeper specifically, where a lost write DOES cost a call
// and therefore has to be handled rather than shrugged off.

const db     = require('../db');
const logger = require('../logger');

async function _try(label, fn) {
  try {
    return await fn(db.getClient());
  } catch (err) {
    logger.error(`call_history ${label} failed`, { error: err.message });
    return null;
  }
}

// Opens a row the moment a call is attempted, before Twilio is contacted, so a
// call that throws still leaves evidence it was tried.
async function startAttempt({ accountId, scheduleId, contactId, dose, attempt, kind = 'REMINDER_CALL' }) {
  return _try('startAttempt', (p) =>
    p.callHistory.create({
      data: {
        accountId,
        scheduleId: scheduleId || null,
        contactId:  contactId  || null,
        dose,
        attempt,
        kind,
        outcome: 'PENDING',
      },
    })
  );
}

async function attachCallSid(id, callSid) {
  if (!id) return null;
  return _try('attachCallSid', (p) =>
    p.callHistory.update({ where: { id }, data: { callSid } })
  );
}

async function recordOutcome(id, outcome, extra = {}) {
  if (!id) return null;
  return _try('recordOutcome', (p) =>
    p.callHistory.update({
      where: { id },
      data: {
        outcome,
        completedAt: extra.completedAt || new Date(),
        ...(extra.repromptCount !== undefined && { repromptCount: extra.repromptCount }),
        ...(extra.errorMessage  !== undefined && { errorMessage:  extra.errorMessage  }),
      },
    })
  );
}

// Closes a row only if nothing has decided its fate yet.
//
// The PENDING guard is the whole point: Twilio's "completed" status can arrive
// either side of the /response webhook that recorded CONFIRMED, and an
// unguarded write would silently turn a confirmed dose into a missed one.
async function closeIfPending(id, outcome) {
  if (!id) return null;
  return _try('closeIfPending', async (p) => {
    const result = await p.callHistory.updateMany({
      where: { id, outcome: 'PENDING' },
      data:  { outcome, completedAt: new Date() },
    });
    return result.count === 1;
  });
}

async function findById(id) {
  if (!id) return null;
  return _try('findById', (p) =>
    p.callHistory.findUnique({ where: { id }, include: { schedule: true, contact: true } })
  );
}

async function recentForSchedule(scheduleId, take = 20) {
  return _try('recentForSchedule', (p) =>
    p.callHistory.findMany({
      where:   { scheduleId },
      orderBy: { startedAt: 'desc' },
      take,
    })
  );
}

module.exports = {
  startAttempt, attachCallSid, recordOutcome, closeIfPending, findById, recentForSchedule,
};
