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
async function startAttempt({ accountId, scheduleId, contactId, dose, attempt, toPhone, parentId, kind = 'REMINDER_CALL' }) {
  return _try('startAttempt', (p) =>
    p.callHistory.create({
      data: {
        accountId,
        scheduleId: scheduleId || null,
        contactId:  contactId  || null,
        toPhone:    toPhone    || null,
        parentId:   parentId   || null,
        dose,
        attempt,
        kind,
        outcome: 'PENDING',
      },
    })
  );
}

// Where an escalation actually went. Unlike a reminder call the destination is
// only known at delivery time, so it is recorded then rather than at creation.
async function recordDestination(id, toPhone) {
  if (!id || !toPhone) return null;
  return _try('recordDestination', (p) =>
    p.callHistory.update({ where: { id }, data: { toPhone } })
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
async function closeIfPending(id, outcome, extra = {}) {
  if (!id) return null;
  return _try('closeIfPending', async (p) => {
    const result = await p.callHistory.updateMany({
      where: { id, outcome: 'PENDING' },
      data:  {
        outcome,
        completedAt: new Date(),
        ...(extra.errorMessage !== undefined && { errorMessage: extra.errorMessage }),
      },
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

// Idempotency for retries is the parent link, not a heuristic — see
// findChildByKind. A retry is a REMINDER_CALL child of the attempt that spawned
// it, so "has this retry already gone out?" is an exact question with an exact
// answer, and (parent_id, kind) being UNIQUE means two sweeps cannot both win.
//
// This replaced a match on (schedule, dose, attempt) within a six-hour window.
// That held for a real twice-daily schedule, where the same attempt number
// cannot recur inside six hours, but silently suppressed the retry whenever two
// manual test calls were placed in one morning: the second call's retry found
// the first call's attempt-2 row and concluded it had already dialled.

// Escalations are queued, not sent inline, so a crash between "attempts
// exhausted" and "SMS sent" cannot lose the alert. The caller kicks the sweeper
// immediately afterwards, so in the normal case it still goes out at once.
//
// `reason` rides in error_message — it is the row's "why", and giving it a
// dedicated column would not earn its migration.
async function enqueueEscalation({ accountId, scheduleId, contactId, dose, kind, reason, dueAt, parentId }) {
  return db.getClient().callHistory.create({
    data: {
      accountId,
      scheduleId:   scheduleId || null,
      contactId:    contactId  || null,
      parentId:     parentId   || null,
      dose,
      kind,
      attempt:      1,
      outcome:      'PENDING',
      errorMessage: reason,
      nextRetryAt:  dueAt || new Date(),
    },
  });
}

// ─── Escalation chain (Stage 4) ──────────────────────────────────────────────
//
// Each step is a row pointing at the step that caused it. That link is what
// makes the chain auditable, and it doubles as the idempotency key: a step is
// only queued if its parent does not already have one of that kind.

// The guard against a repeated step. The sweeper's contract is "a crash leaves
// work queued, so it may run twice" — without this, running the escalation-call
// step twice would queue a second follow-up SMS each time.
async function findChildByKind(parentId, kind) {
  if (!parentId) return null;
  return db.getClient().callHistory.findFirst({
    where:   { parentId, kind },
    orderBy: { startedAt: 'asc' },
  });
}

// Whether anything at all hangs off this row, whatever its kind. The sweeper
// asks this of a retry child that failed at creation: a redial or an
// escalation under it means its recovery is alive, and rerunning the failure
// ladder would act twice.
async function hasAnyChild(parentId) {
  if (!parentId) return false;
  const count = await db.getClient().callHistory.count({ where: { parentId } });
  return count > 0;
}

// The watchdog's feed: rows the call path has forgotten. Still PENDING, not
// sitting in the retry queue (a queued row is the sweeper's business, and its
// give-up ceiling already bounds it), and old enough that any legitimate call
// would long since have resolved. These are the rows whose Twilio status
// callback never arrived — and with no next_retry_at, nothing else can ever
// see them. Throws like the rest of the queue functions: the watchdog's
// correctness depends on this read. Relations ride along so the admin alert
// can name the schedule and the person instead of quoting a UUID.
async function findStalePending(cutoff, limit = 25) {
  return db.getClient().callHistory.findMany({
    where:   { outcome: 'PENDING', nextRetryAt: null, startedAt: { lt: cutoff } },
    include: SWEEP_INCLUDE,
    orderBy: { startedAt: 'asc' },
    take:    limit,
  });
}

// The row behind a Twilio SID, for the delivery-failure alert: the callback
// carries only the SID, and "which schedule, which person" has to come from
// here. Best-effort — an alert with less context still beats no alert.
async function findBySid(callSid) {
  if (!callSid) return null;
  return _try('findBySid', (p) =>
    p.callHistory.findFirst({
      where:   { callSid },
      include: { schedule: { select: { id: true, name: true } }, contact: true },
    })
  );
}

// The day's story in one query, for the heartbeat. Counts by kind and outcome;
// the composition into a sentence lives with the heartbeat, not here.
async function summarizeSince(since) {
  const groups = await db.getClient().callHistory.groupBy({
    by:     ['kind', 'outcome'],
    where:  { startedAt: { gte: since } },
    _count: { _all: true },
  });
  return groups.map((g) => ({ kind: g.kind, outcome: g.outcome, count: g._count._all }));
}

// The whole chain from one row down, oldest first. Read-only — for `npm run
// db:history` today and the Phase 3 API later.
async function chainFrom(rootId) {
  return _try('chainFrom', async (p) => {
    const out  = [];
    let   ids  = [rootId];

    // Depth is 3 in practice (reminder → call → SMS); the bound is a guard
    // against a cycle turning a bad row into an infinite loop.
    for (let depth = 0; depth < 5 && ids.length; depth++) {
      const rows = await p.callHistory.findMany({
        where:   { parentId: { in: ids } },
        include: { contact: true },
        orderBy: { startedAt: 'asc' },
      });
      out.push(...rows);
      ids = rows.map(r => r.id);
    }
    return out;
  });
}

// Pulls queued work forward to now.
//
// The escalation SMS is queued due immediately, so this is normally a no-op.
// It earns its place on one case: a row queued by an older deploy with an
// acknowledgement window still in the future, in flight when that window was
// removed.
async function makeDueNow(id, now = new Date()) {
  if (!id) return false;
  const result = await db.getClient().callHistory.updateMany({
    where: { id, outcome: 'PENDING', nextRetryAt: { not: null } },
    data:  { nextRetryAt: now, retryClaimedAt: null },
  });
  return result.count === 1;
}

// A carrier's verdict on a text, arriving minutes after it was handed over.
//
// Looked up by SID rather than by row id because that is all the callback
// carries — Twilio knows nothing about call_history. Returns false when no row
// matches, which is normal rather than an error: verification codes are sent
// through the same Twilio number and have no call_history row at all.
//
// The outcome filter makes this forward-only. Twilio can deliver callbacks out
// of order and will retry ones it thinks failed, so without it a late `sent`
// could overwrite a `FAILED` that had already been recorded — turning the
// discovery that an alert went missing back into a report that it was fine.
// PENDING is included because a status can beat the SENT write in a race.
async function recordDeliveryOutcome(callSid, outcome, { errorCode, errorMessage } = {}) {
  if (!callSid) return false;

  const result = await db.getClient().callHistory.updateMany({
    where: {
      callSid,
      outcome: { in: ['PENDING', 'SENT'] },
    },
    data: {
      outcome,
      completedAt: new Date(),
      ...(errorMessage && { errorMessage }),
    },
  });

  if (result.count && errorCode) {
    logger.warn('Message reported as not delivered', { callSid, outcome, errorCode });
  }
  return result.count > 0;
}

// Cheap re-read of a row's current state, for the narrow window between the
// sweeper claiming a follow-up SMS and delivering it.
async function currentOutcome(id) {
  if (!id) return null;
  const row = await db.getClient().callHistory.findUnique({
    where:  { id },
    select: { outcome: true },
  });
  return row ? row.outcome : null;
}

// ─── Account-scoped reads for the API (Phase 3) ──────────────────────────────
//
// Read-only by design: call_history is the record of what actually happened, so
// the API exposes no way to edit or delete it. Rows are written by the call
// path alone.

async function listForAccount(accountId, { limit = 50, offset = 0, from, to, contactId, dose } = {}) {
  const where = {
    accountId,
    ...(contactId && { contactId }),
    ...(dose && { dose }),
    ...((from || to) && {
      startedAt: {
        ...(from && { gte: from }),
        ...(to   && { lte: to }),
      },
    }),
  };

  const client = db.getClient();

  // Count and page in one round trip. The total is what lets a UI say "showing
  // 50 of 312" rather than guessing whether another page exists.
  const [total, rows] = await client.$transaction([
    client.callHistory.count({ where }),
    client.callHistory.findMany({
      where,
      include: { contact: true, schedule: { select: { id: true, name: true, dose: true } } },
      orderBy: { startedAt: 'desc' },
      take:    limit,
      skip:    offset,
    }),
  ]);

  return { total, rows, limit, offset };
}

async function countPendingWork() {
  return db.getClient().callHistory.count({ where: { nextRetryAt: { not: null } } });
}

module.exports = {
  startAttempt, attachCallSid, recordOutcome, closeIfPending, findById, recentForSchedule,
  scheduleRetry, findDueWork, claimWork, completeWork, releaseClaim,
  enqueueEscalation, countPendingWork, SWEEP_INCLUDE,
  findChildByKind, hasAnyChild, findStalePending, findBySid, summarizeSince,
  chainFrom, makeDueNow, currentOutcome,
  recordDestination, listForAccount, recordDeliveryOutcome,
};
