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
// The same tick also runs the stale-PENDING watchdog (see watchdogOnce): rows
// whose Twilio status callback never arrived, which the queue cannot see
// because a stuck row has no next_retry_at.
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
    // A child row is not, by itself, proof the phone rang. FAILED with no call
    // SID means Twilio refused the creation — the row was opened before
    // dialling and nothing ever went out. Every other state is a call that was
    // (or, on an ambiguous timeout, may have been) placed, and re-dialling
    // those risks ringing her twice, which stays the worse failure.
    const neverDialled = already.outcome === 'FAILED' && !already.callSid;

    if (!neverDialled) {
      logger.warn('Retry already placed by an earlier run, skipping', {
        callHistoryId: row.id, dose: row.dose, attempt: nextAttempt,
      });
      return;
    }

    // A dial that failed at creation queues its own recovery — a redial on the
    // child, or an escalation under it (see _realCall's failure path). Only a
    // crash between the FAILED write and that recovery leaves the child bare,
    // and treating it as "already placed" there is how a chain used to die
    // with one warn line and nobody alerted. Rerun the failure ladder on the
    // child instead: it redials within the attempt budget and escalates past
    // it, and escalate()'s own child check keeps a rerun from alerting twice.
    const recovered = already.nextRetryAt || (await callHistoryRepo.hasAnyChild(already.id));

    if (recovered) {
      logger.info('Retry child was never dialled; its recovery is already queued', {
        callHistoryId: row.id, childId: already.id,
      });
      return;
    }

    logger.warn('Retry child was never dialled and its recovery was lost — rerunning the failure ladder', {
      callHistoryId: row.id, childId: already.id, attempt: already.attempt,
    });
    await callManager.handleNoAnswer(row.dose, already.attempt, {
      scheduleId: row.scheduleId, callHistoryId: already.id, outcome: 'FAILED',
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

// ─── Stale-PENDING watchdog ──────────────────────────────────────────────────
//
// Everything after "call created" arrives by Twilio webhook: no-answer, busy,
// completed, the delivery receipt. If callbacks stop reaching this server —
// BASE_URL drift after a domain change, a Twilio callback outage — every call
// sits PENDING forever, no retry is persisted, no escalation fires, and the
// queue sees nothing because a stuck row has no next_retry_at. That is the
// mechanism by which a broken webhook URL runs for days looking quiet.
//
// This finds rows still PENDING well past when any legitimate call would have
// resolved and treats them as unresolved. Two shapes of stuck row, two
// treatments:
//
//   queued work that never ran (an escalation step with no SID, killed between
//   being queued and being delivered) → put back in the queue; the sweeper's
//   own give-up ceiling still bounds it.
//
//   a call placed (or mid-dial) whose fate never came back → flip it FAILED —
//   the honest available outcome for "we cannot say this succeeded" — and run
//   the same ladder a failed call takes: retry within the attempt budget,
//   escalate past it. The escalation SMS needs only the outbound API, so even
//   with inbound webhooks completely dark, the caregiver still hears.
async function watchdogOnce(now = new Date()) {
  if (!db.isConfigured()) return { flagged: 0 };

  const minutes = config.pendingWatchdogMinutes;
  if (!(minutes > 0)) return { flagged: 0 };

  const cutoff = new Date(now.getTime() - minutes * 60 * 1000);

  let stale;
  try {
    stale = await callHistoryRepo.findStalePending(cutoff);
  } catch (err) {
    logger.error('Watchdog could not load stale PENDING rows', { error: err.message });
    return { flagged: 0 };
  }
  if (!stale.length) return { flagged: 0 };

  const callManager = require('./callManager');
  let flagged = 0;

  for (const row of stale) {
    try {
      if (row.kind === 'ESCALATION_SMS' || (row.kind === 'ESCALATION_CALL' && !row.callSid)) {
        logger.error('QUEUED WORK WENT STALE — requeueing an escalation step that never ran', {
          callHistoryId: row.id, kind: row.kind, dose: row.dose,
          ageMinutes: Math.round((now - new Date(row.startedAt)) / 60000),
        });
        await callHistoryRepo.scheduleRetry(row.id, now);
        flagged++;
        continue;
      }

      // The conditional flip doubles as the claim: exactly one process wins
      // PENDING → FAILED, so two replicas cannot both run the ladder — and a
      // confirmation that lands in the same instant wins instead of losing.
      const won = await callHistoryRepo.closeIfPending(row.id, 'FAILED', {
        errorMessage: `no status callback within ${minutes} minutes — webhook loss or BASE_URL problem`,
      });
      if (!won) continue;

      // Distinct wording on purpose: this is how a callback-loss reads
      // differently from a normal no-answer in the logs.
      const ageMinutes = Math.round((now - new Date(row.startedAt)) / 60000);
      logger.error('CALL NEVER RESOLVED — no Twilio status callback arrived; treating the attempt as failed', {
        callHistoryId: row.id, kind: row.kind, dose: row.dose, attempt: row.attempt,
        callSid: row.callSid || '(none)',
        ageMinutes,
        hint: 'if this repeats, check BASE_URL and the Twilio console — status callbacks may not be reaching this server',
      });

      // This is the BASE_URL-drift failure mode running quietly, so it goes to
      // the admin too. The storm guard collapses a sweep full of stale rows
      // into one alert.
      require('./adminAlert').notify('CALL NEVER RESOLVED',
        `${row.schedule?.name || row.kind} (${row.dose}, attempt ${row.attempt}) to `
        + `${row.contact?.name || row.toPhone || 'unknown'} got no Twilio status callback in ${ageMinutes} minutes. `
        + 'Retrying/escalating it now — but check BASE_URL and Twilio webhooks; callbacks may not be reaching the server.');

      if (row.kind === 'ESCALATION_CALL') {
        // The follow-up SMS was queued before the call was dialled and is
        // delivered independently, so the alert has almost certainly gone out
        // already; this closes the call step and pulls the text forward if it
        // is somehow still waiting.
        const followUp = await callHistoryRepo.findChildByKind(row.id, 'ESCALATION_SMS');
        await callManager.handleEscalationCallEnded(row.dose, {
          callHistoryId: row.id, followUpId: followUp ? followUp.id : null,
        });
      } else {
        await callManager.handleNoAnswer(row.dose, row.attempt, {
          scheduleId: row.scheduleId, callHistoryId: row.id, outcome: 'FAILED',
        });
      }
      flagged++;
    } catch (err) {
      logger.error('Watchdog could not resolve a stale row', {
        callHistoryId: row.id, error: err.message,
      });
    }
  }

  return { flagged };
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

    const watched = await watchdogOnce(now);
    if (watched.flagged) logger.info('Watchdog acted on stale rows', watched);
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

module.exports = { start, stop, tick, runOnce, watchdogOnce };
