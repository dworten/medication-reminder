'use strict';

// Database-backed retry sweeper.
//
// Replaces the in-memory setTimeout that used to hold a pending retry. That
// timer lived only in the process: a Railway deploy inside the five-minute
// retry window took the retry with it, and the missed-dose SMS that should have
// followed never happened — silently, with nothing in the logs to notice.
//
// Now the intent is a row in call_history with next_retry_at set. This sweeper
// runs every minute, claims what is due, and does it. A restart mid-window
// costs at most a minute of delay.
//
// Three kinds of work share the mechanism:
//   REMINDER_CALL    + next_retry_at → place the next attempt
//   ESCALATION_CALL  + next_retry_at → ring the fallback contact
//   ESCALATION_SMS   + next_retry_at → text the fallback contact
//
// The last two are the Stage 4 chain. Each step is its own row, so the queue
// needed no new machinery to carry it — an escalation call is just another due
// item, and the SMS that follows it is another one behind that.
//
// Ordering is claim → do → complete. Completing (clearing next_retry_at) is
// last on purpose: if the process dies mid-flight the item stays queued, so the
// failure mode is a repeat rather than a loss. Repeats are then suppressed by
// the idempotency check in _fireRetry, which is why this does not double-call.

const cron   = require('node-cron');
const config = require('./config');
const logger = require('./logger');
const db     = require('./db');

const callHistoryRepo = require('./data/callHistory');

const SWEEP_CRON = '* * * * *';

let _task     = null;
let _sweeping = false;

function staleClaimMs() {
  return config.retryStaleClaimMinutes * 60 * 1000;
}

async function _fireRetry(row, now) {
  const callManager = require('./callManager');

  const nextAttempt = row.attempt + 1;

  // Was this retry already placed by a run that died before it could record the
  // fact? If so the call went out and re-firing would ring her twice.
  //
  // Asked of this attempt's own children, so the answer is exact. The previous
  // version matched on (schedule, dose, attempt) inside a six-hour window, which
  // suppressed the retry whenever two test calls were placed in one morning —
  // the second call's retry found the first call's attempt-2 row and skipped.
  const already = await callHistoryRepo.findChildByKind(row.id, 'REMINDER_CALL');

  if (already) {
    logger.warn('Retry already placed by an earlier run, skipping', {
      callHistoryId: row.id, dose: row.dose, attempt: nextAttempt,
    });
    return;
  }

  logger.call('Sweeper firing retry', {
    callHistoryId: row.id, dose: row.dose, attempt: nextAttempt,
    scheduleId: row.scheduleId,
  });

  await callManager.initiateCall(row.dose, nextAttempt, {
    schedule: row.schedule || null,
    // Links the new attempt to this one. That link IS the idempotency check
    // above, and (parent_id, kind) is UNIQUE, so even two sweeps racing can
    // only produce one retry.
    parentId: row.id,
    // The number the previous attempt actually rang, not the contact's current
    // one. A retry has to reach the same phone the sequence started on, or a
    // /trigger?target=test call rings the test phone and then jumps to the real
    // contact. Falls back to the contact for rows written before to_phone
    // existed, and for anything queued without a destination.
    to:       row.toPhone || (row.contact ? row.contact.phone : undefined),
  });
}

async function _sendEscalation(row) {
  const callManager = require('./callManager');

  logger.call('Sweeper sending escalation', {
    callHistoryId: row.id, kind: row.kind, dose: row.dose,
  });

  await callManager.deliverEscalation(row);
}

async function _placeEscalationCall(row) {
  const callManager = require('./callManager');

  logger.call('Sweeper placing escalation call', {
    callHistoryId: row.id, dose: row.dose,
  });

  await callManager.deliverEscalationCall(row);
}

async function _handle(row, now) {
  if (row.kind === 'REMINDER_CALL')   return _fireRetry(row, now);
  if (row.kind === 'ESCALATION_CALL') return _placeEscalationCall(row);
  return _sendEscalation(row);
}

// Work that has been stuck too long is abandoned rather than retried forever.
// Two reasons: a reminder placed six hours late is a confusing call at the
// wrong time of day rather than a reminder, and an item that can never succeed
// — a malformed phone number, a closed Twilio account — would otherwise be
// retried every minute indefinitely.
function _isExpired(row, now) {
  return (now.getTime() - new Date(row.startedAt).getTime()) > config.retryGiveUpHours * 60 * 60 * 1000;
}

async function _abandon(row, now) {
  const ageHours = ((now.getTime() - new Date(row.startedAt).getTime()) / 3600000).toFixed(1);

  logger.error('Abandoning queued work — too old to be useful', {
    callHistoryId: row.id, kind: row.kind, dose: row.dose,
    ageHours, giveUpHours: config.retryGiveUpHours,
  });

  await callHistoryRepo.recordOutcome(row.id, 'CANCELED', {
    errorMessage: `${row.errorMessage || ''} | abandoned after ${ageHours}h`.trim(),
  });
  await callHistoryRepo.completeWork(row.id);
}

// Exported so callManager can kick a sweep the instant it queues an escalation,
// rather than the alert waiting up to a minute for the next tick.
async function runOnce(now = new Date()) {
  if (!db.isConfigured()) return { claimed: 0, done: 0, failed: 0, abandoned: 0 };

  let due;
  try {
    due = await callHistoryRepo.findDueWork(now, staleClaimMs());
  } catch (err) {
    logger.error('Sweeper could not load due work', { error: err.message });
    return { claimed: 0, done: 0, failed: 0, abandoned: 0 };
  }

  if (!due.length) return { found: 0, claimed: 0, done: 0, failed: 0, abandoned: 0 };

  let claimed = 0, done = 0, failed = 0, abandoned = 0;
  const found = due.length;

  for (const row of due) {
    let won = false;
    try {
      won = await callHistoryRepo.claimWork(row.id, now, staleClaimMs());
    } catch (err) {
      logger.error('Sweeper claim failed', { callHistoryId: row.id, error: err.message });
      continue;
    }

    if (!won) continue;
    claimed++;

    try {
      if (_isExpired(row, now)) {
        await _abandon(row, now);
        abandoned++;
        continue;
      }

      await _handle(row, now);
      await callHistoryRepo.completeWork(row.id);
      done++;
    } catch (err) {
      failed++;
      logger.error('Sweeper work item failed', {
        callHistoryId: row.id, kind: row.kind, error: err.message,
      });

      // Hand it back rather than sitting on the claim, so the next sweep tries
      // again a minute from now instead of after the stale window.
      try {
        await callHistoryRepo.releaseClaim(row.id);
      } catch (releaseErr) {
        logger.error('Sweeper could not release claim', {
          callHistoryId: row.id, error: releaseErr.message,
        });
      }
    }
  }

  return { found, claimed, done, failed, abandoned };
}

async function tick(now = new Date()) {
  if (_sweeping) {
    logger.warn('Sweeper still running, skipping this minute');
    return;
  }
  _sweeping = true;

  try {
    const result = await runOnce(now);

    // Logged whenever there was anything to do, not only when something was
    // claimed. A sweep that sees due work and claims none is exactly the case
    // worth seeing in the logs — a live claim held elsewhere, or a tick that
    // silently did nothing — and it is invisible if only successes are logged.
    // Quiet sweeps stay quiet, so this does not add a line a minute.
    if (result.found) logger.info('Sweeper ran', result);
  } finally {
    _sweeping = false;
  }
}

function start() {
  _task = cron.schedule(SWEEP_CRON, () => {
    tick().catch(err => logger.error('Sweeper tick threw', { error: err.message }));
  }, { timezone: 'UTC' });

  logger.info('Retry sweeper running', {
    sweep:             SWEEP_CRON,
    staleClaimMinutes: config.retryStaleClaimMinutes,
  });
}

function stop() {
  if (!_task) return;
  try {
    _task.stop();
  } catch (err) {
    logger.warn('Failed to stop sweeper', { error: err.message });
  }
  _task = null;
}

module.exports = { start, stop, tick, runOnce };
