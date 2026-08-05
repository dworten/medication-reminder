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

// ─── When does this schedule fire next? ──────────────────────────────────────
//
// Added for the UI, but deliberately here rather than in the browser. The
// alternative — recomputing "next 9:20 AM in America/Chicago, Mon–Sat" in
// client JavaScript — is the same DST-sensitive arithmetic written twice, and
// the failure it invites is the interface confidently displaying a time the
// scheduler disagrees with. One implementation, and it is the one that already
// decides whether to place the call.

// The calendar date as it reads in `timeZone`, which is not necessarily the
// UTC date — at 02:00 UTC it is still the previous day in Chicago.
function localYMD(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

// How far `timeZone` is from UTC at this particular instant. Derived by asking
// Intl to render the instant in that zone and reading the result back as if it
// were UTC; the difference is the offset. Doing it per-instant is what makes
// this correct across a DST boundary rather than only today.
function tzOffsetMs(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;

  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
                         Number(p.hour), Number(p.minute), Number(p.second));
  // Seconds resolution: the formatter has no milliseconds to report.
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

// The UTC instant at which the clock in `timeZone` reads this wall-clock time.
//
// Two passes on purpose. The first uses the offset in force at the naive guess;
// on a DST changeover that guess can land on the wrong side of the transition,
// so the offset is re-read at the corrected instant and applied again.
function wallClockToInstant(year, month, day, minutes, timeZone) {
  const naive = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);

  const first  = naive - tzOffsetMs(new Date(naive), timeZone);
  const second = naive - tzOffsetMs(new Date(first), timeZone);

  return new Date(second);
}

// The next instant this schedule is due, or null if it never is — no valid
// time, no days selected, an unknown timezone. A disabled schedule still
// reports its next run: the interface wants to say "would have been 9:20 AM".
//
// The horizon is 8 days so that a schedule running on a single weekday always
// resolves, whichever day it is asked on.
function nextRunAt(schedule, now, horizonDays = 8) {
  const target = parseTimeOfDay(schedule.timeOfDay);
  if (target === null) return null;

  const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
  if (!days.length) return null;

  let local, base;
  try {
    local = localParts(now, schedule.timezone);
    base  = localYMD(now, schedule.timezone);
  } catch {
    return null; // unknown IANA name — same fail-closed stance as evaluate()
  }

  for (let offset = 0; offset <= horizonDays; offset++) {
    const weekday = (local.weekday + offset) % 7;
    if (!days.includes(weekday)) continue;
    // Today only counts if the time has not already gone past.
    if (offset === 0 && local.minutes >= target) continue;

    // Date arithmetic in UTC on a date-only value, so adding a day never
    // stumbles over a DST-shortened one.
    const day = new Date(Date.UTC(base.year, base.month - 1, base.day));
    day.setUTCDate(day.getUTCDate() + offset);

    return wallClockToInstant(
      day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(),
      target, schedule.timezone
    );
  }

  return null;
}

function findDue(schedules, now, graceMinutes) {
  const due = [];
  for (const schedule of schedules) {
    const verdict = evaluate(schedule, now, graceMinutes);
    if (verdict.due) due.push({ schedule, verdict });
  }
  return due;
}

module.exports = {
  parseTimeOfDay, localParts, evaluate, findDue, WEEKDAY_INDEX,
  nextRunAt, localYMD, tzOffsetMs, wallClockToInstant,
};
