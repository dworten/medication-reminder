'use strict';

// Decides whether a schedule is due right now. Pure functions, no database and
// no clock of their own — `now` is always passed in — so every branch below is
// testable against fixed instants, including the DST transitions that a live
// test would have to wait months for.

// Prisma gives days_of_week as 0 = Sunday .. 6 = Saturday, matching
// Date#getDay() and Intl's ordering.
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// "09:20" → 560 minutes past local midnight. Returns null if malformed; the
// database CHECK constraint should make that impossible, but a null here fails
// closed (no call) rather than throwing and killing the whole tick.
function parseTimeOfDay(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || '');
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Wall-clock reading of `date` in `timeZone`. Intl resolves the IANA database,
// so DST is handled for us: at 9:20 AM Central this returns 560 whether the
// offset is CST or CDT that day.
//
// hourCycle 'h23' matters — with hour12:false some ICU versions report midnight
// as hour 24, which would put local midnight at minute 1440 instead of 0.
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday:   'short',
    hour:      '2-digit',
    minute:    '2-digit',
  });

  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;

  const hour   = Number(parts.hour);
  const minute = Number(parts.minute);

  return {
    weekday: WEEKDAY_INDEX[parts.weekday],
    minutes: hour * 60 + minute,
    hhmm:    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

// Why a grace window rather than an exact minute match:
//
// The old node-cron setup fired on an exact tick, so if the container happened
// to be restarting during that minute — a Railway deploy, a crash loop — the
// dose was simply missed with nothing to notice it. Accepting a call up to
// `graceMinutes` late turns "missed entirely" into "a few minutes late", which
// for a medication reminder is plainly the better failure.
//
// The window does not wrap past local midnight. A schedule within graceMinutes
// of 00:00 loses its catch-up across the date boundary, because reaching back
// over midnight risks firing against the previous day's day-of-week set. The
// 9:20 schedules are nowhere near that edge.
function evaluate(schedule, now, graceMinutes) {
  const target = parseTimeOfDay(schedule.timeOfDay);
  if (target === null) {
    return { due: false, reason: 'invalid timeOfDay' };
  }

  let local;
  try {
    local = localParts(now, schedule.timezone);
  } catch (err) {
    // An unknown IANA name throws RangeError. Skip this schedule rather than
    // let one bad row stop every other schedule from firing.
    return { due: false, reason: `invalid timezone "${schedule.timezone}"` };
  }

  const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
  if (!days.includes(local.weekday)) {
    return { due: false, reason: 'day not selected', localTime: local.hhmm, weekday: local.weekday };
  }

  const minutesLate = local.minutes - target;
  if (minutesLate < 0 || minutesLate > graceMinutes) {
    return { due: false, reason: 'outside window', localTime: local.hhmm, minutesLate };
  }

  return { due: true, localTime: local.hhmm, minutesLate };
}

function findDue(schedules, now, graceMinutes) {
  const due = [];
  for (const schedule of schedules) {
    const verdict = evaluate(schedule, now, graceMinutes);
    if (verdict.due) due.push({ schedule, verdict });
  }
  return due;
}

module.exports = { parseTimeOfDay, localParts, evaluate, findDue, WEEKDAY_INDEX };
