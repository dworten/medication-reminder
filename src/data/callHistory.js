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

// ─── Durable work queue (Stage 3) ────────────────────────────────────────────
//
// A call_history row with next_retry_at set IS the pending work item. There is
// no separate queue table and no in-memory timer, so a redeploy or a crash
// loses nothing: the intent is in Postgres and the sweeper finds it again.
//
// Unlike the best-effort writers above, everything below THROWS on failure.
// The sweeper's correctness depends on these, and swallowing an error here
// would drop a retry silently — the exact failure this stage exists to remove.

const SWEEP_INCLUDE = {
  schedule: { include: { contact: true, escalationContact: true, message: true } },
  contact:  true,
};

// Marks this row as owing a retry at `at`. Clearing retry_claimed_at matters:
// a row that was claimed for an earlier piece of work must be claimable again.
async function scheduleRetry(id, at) {
  return db.getClient().callHistory.update({
    where: { id },
    data:  { nextRetryAt: at, retryClaimedAt: null },
  });
}

// Work is due when next_retry_at has passed AND nobody holds a live claim.
//
// The stale-claim clause is what makes a crash recoverable. A process that dies
// between claiming a row and finishing it would otherwise leave that retry
// claimed forever — silently dropped, which is precisely what this stage is
// meant to prevent. After staleMs the claim lapses and the work is picked up
// again.
function _dueWhere(now, staleMs) {
  return {
    nextRetryAt: { lte: now },
    OR: [
      { retryClaimedAt: null },
      { retryClaimedAt: { lt: new Date(now.getTime() - staleMs) } },
    ],
  };
}

async function findDueWork(now, staleMs, limit = 25) {
  return db.getClient().callHistory.findMany({
    where:   _dueWhere(now, staleMs),
    include: SWEEP_INCLUDE,
    orderBy: { nextRetryAt: 'asc' },
    take:    limit,
  });
}

// Same conditional-UPDATE trick the scheduler uses: exactly one caller can win,
// so two sweeps can never fire the same retry twice.
async function claimWork(id, now, staleMs) {
  const result = await db.getClient().callHistory.updateMany({
    where: { id, ..._dueWhere(now, staleMs) },
    data:  { retryClaimedAt: now },
  });
  return result.count === 1;
}

// Clearing next_retry_at is what marks the work finished. Until this runs the
// item stays in the queue, so the failure mode is a repeat rather than a loss.
async function completeWork(id) {
  return db.getClient().callHistory.update({
    where: { id },
    data:  { nextRetryAt: null },
  });
}

// Releases a claim without completing, so the next sweep retries it promptly
// instead of waiting out the stale window.
async function releaseClaim(id) {
  return db.getClient().callHistory.update({
    where: { id },
    data:  { retryClaimedAt: null },
  });
}

// Idempotency guard for the crash-after-dial window: if the process died
// between Twilio accepting a call and the database recording it, the stale
// claim would re-fire that same attempt. Checking whether the attempt already
// exists turns that duplicate call into a no-op.
async function hasAttempt({ scheduleId, dose, attempt, since }) {
  if (!scheduleId) return false;
  const found = await db.getClient().callHistory.findFirst({
    where: { scheduleId, dose, attempt, kind: 'REMINDER_CALL', startedAt: { gte: since } },
    select: { id: true },
  });
  return Boolean(found);
}

// Escalations are queued, not sent inline, so a crash between "attempts
// exhausted" and "SMS sent" cannot lose the alert. The caller kicks the sweeper
// immediately afterwards, so in the normal case it still goes out at once.
//
// `reason` rides in error_message — it is the row's "why", and giving it a
// dedicated column would not earn its migration.
async function enqueueEscalation({ accountId, scheduleId, contactId, dose, kind, reason, dueAt }) {
  return db.getClient().callHistory.create({
    data: {
      accountId,
      scheduleId:   scheduleId || null,
      contactId:    contactId  || null,
      dose,
      kind,
      attempt:      1,
      outcome:      'PENDING',
      errorMessage: reason,
      nextRetryAt:  dueAt || new Date(),
    },
  });
}

async function countPendingWork() {
  return db.getClient().callHistory.count({ where: { nextRetryAt: { not: null } } });
}

module.exports = {
  startAttempt, attachCallSid, recordOutcome, closeIfPending, findById, recentForSchedule,
  scheduleRetry, findDueWork, claimWork, completeWork, releaseClaim, hasAttempt,
  enqueueEscalation, countPendingWork, SWEEP_INCLUDE,
};
