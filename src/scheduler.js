'use strict';

// Database-driven scheduler.
//
// Replaces the two fixed MORNING_CRON / EVENING_CRON jobs with a single tick
// every minute that asks the database what is due. Adding, moving or disabling
// a call is now a row change that takes effect within a minute — no redeploy,
// and eventually no shell at all once Phase 3's UI exists.
//
// The Sunday-morning skip that used to be an `if` in this file is now just
// days_of_week on the row.
//
// Duplicate calls are the failure mode that matters here, so the ordering is
// deliberate: evaluate → claim → call. The claim is a conditional UPDATE that
// only one caller can win (see data/schedules.claimForFire).

const cron   = require('node-cron');
const config = require('./config');
const logger = require('./logger');
const db     = require('./db');

const scheduleRepo  = require('./data/schedules');
const scheduleMatch = require('./scheduleMatch');

const TICK_CRON = '* * * * *';

let _task       = null;
let _ticking    = false;
let _warnedNoDb = false;

// A schedule with data that fails closed (bad timezone, malformed time, empty
// days) is skipped by evaluate() silently, once a minute, forever. Warn about
// it loudly — but not 1440 times a day: once per schedule per interval, and a
// row that gets fixed drops out so a later regression warns afresh.
const _brokenWarnedAt = new Map(); // scheduleId → last warned (ms)
const BROKEN_WARN_INTERVAL_MS = 6 * 60 * 60 * 1000;

function _warnAboutBroken(schedules, now) {
  for (const schedule of schedules) {
    const reason = scheduleMatch.brokenReason(schedule);
    if (!reason) {
      _brokenWarnedAt.delete(schedule.id);
      continue;
    }

    const last = _brokenWarnedAt.get(schedule.id) || 0;
    if (now.getTime() - last < BROKEN_WARN_INTERVAL_MS) continue;
    _brokenWarnedAt.set(schedule.id, now.getTime());

    logger.error('Schedule can NEVER fire — its data fails closed and it is silently skipped every minute', {
      scheduleId: schedule.id, name: schedule.name, reason,
      hint: 'this row was edited outside the app or restored from a backup; the API would have refused it',
    });
  }
}

// The claim window must exceed the grace window, or a catch-up tick would
// re-fire a call that already went out. One extra minute covers a tick that
// straddles the boundary.
function claimWindowMs() {
  return (config.scheduleGraceMinutes + 1) * 60 * 1000;
}

async function tick(now = new Date()) {
  // Overlap guard. A tick that runs long (a slow Twilio call) must not have the
  // next minute's tick start underneath it — the claim would still prevent a
  // duplicate call, but this keeps the logs honest and the DB quiet.
  if (_ticking) {
    logger.warn('Scheduler tick still running, skipping this minute');
    return;
  }
  _ticking = true;

  try {
    if (!db.isConfigured()) {
      if (!_warnedNoDb) {
        logger.error('Scheduler idle — DATABASE_URL is not set, so no schedules can be loaded');
        _warnedNoDb = true;
      }
      return;
    }

    let schedules;
    try {
      schedules = await scheduleRepo.listEnabled();
    } catch (err) {
      // Transient database trouble. Log and wait for the next tick rather than
      // crashing the process: the next minute may well succeed, and a crash
      // would take the webhook routes down with it.
      logger.error('Scheduler could not load schedules', { error: err.message });
      return;
    }

    _warnAboutBroken(schedules, now);

    const due = scheduleMatch.findDue(schedules, now, config.scheduleGraceMinutes);
    if (!due.length) return;

    for (const { schedule, verdict } of due) {
      try {
        const claimed = await scheduleRepo.claimForFire(schedule.id, now, claimWindowMs());

        if (!claimed) {
          logger.info('Schedule already fired for this occurrence, skipping', {
            scheduleId: schedule.id, name: schedule.name, localTime: verdict.localTime,
          });
          continue;
        }

        await _fire(schedule, verdict);
      } catch (err) {
        // One schedule failing must not stop the others — the evening call
        // should still go out if the morning one blew up.
        logger.error('Schedule failed to fire', {
          scheduleId: schedule.id, name: schedule.name, error: err.message,
        });
      }
    }
  } finally {
    _ticking = false;
  }
}

async function _fire(schedule, verdict) {
  const callManager = require('./callManager');

  logger.info('Schedule fired', {
    scheduleId:  schedule.id,
    name:        schedule.name,
    dose:        schedule.dose,
    localTime:   verdict.localTime,
    timezone:    schedule.timezone,
    minutesLate: verdict.minutesLate,
    contact:     schedule.contact ? schedule.contact.name : '(none)',
  });

  if (!schedule.contact) {
    // The FK makes this impossible in practice; log loudly rather than throw a
    // null-property error that would read as a code bug.
    logger.error('Schedule has no contact — cannot place call', { scheduleId: schedule.id });
    return;
  }

  await callManager.initiateCall(schedule.dose, 1, { schedule });
}

function start() {
  _task = cron.schedule(TICK_CRON, () => {
    tick().catch(err => logger.error('Scheduler tick threw', { error: err.message }));
  }, { timezone: 'UTC' });

  logger.info('Scheduler running', {
    tick:         TICK_CRON,
    source:       'database',
    graceMinutes: config.scheduleGraceMinutes,
  });
}

// Called on SIGTERM so a deploy doesn't fire a call mid-shutdown.
function stop() {
  if (!_task) return;
  try {
    _task.stop();
  } catch (err) {
    logger.warn('Failed to stop scheduler', { error: err.message });
  }
  _task = null;
}

module.exports = { start, stop, tick };
