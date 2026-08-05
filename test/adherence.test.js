'use strict';
// The adherence strip's arithmetic, checked without a browser.
//
// This is the only part of the dashboard that can be quietly wrong: a bad cell
// does not throw, it just tells you she took her pills when she did not, or
// accuses her of missing a dose that was never scheduled. The Sunday case is
// the one that matters most — the morning schedule runs Mon–Sat on purpose, and
// painting that gap red would train you to ignore the colour that means "she
// actually missed one".
//
// No database and no network.

const path = require('path');
const { pathToFileURL } = require('url');
const { check, section, summary } = require('./helpers');

const MODULE = pathToFileURL(
  path.join(__dirname, '..', 'public', 'app', 'screens', 'adherence.js')
).href;

const TZ = 'America/Chicago';

// Her real setup: morning Mon–Sat, evening every day.
const SCHEDULES = [
  { enabled: true, dose: 'morning', daysOfWeek: [1, 2, 3, 4, 5, 6] },
  { enabled: true, dose: 'evening', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
];

// 15:20Z is 10:20 in Chicago and 23:20Z is 18:20, so both sit inside the same
// calendar day whichever side of UTC midnight the zone is on. Building rows
// from a day key rather than from "N days ago" keeps these cases from
// depending on which weekday the suite happens to run.
const row = (key, dose, outcome, extra) => Object.assign({
  kind:      'REMINDER_CALL',
  dose,
  outcome,
  startedAt: `${key}T${dose === 'morning' ? '15' : '23'}:20:00Z`,
}, extra || {});

const cellFor = (result, dose, key) =>
  result.rows.find((r) => r.dose === dose).cells.find((c) => c.day.key === key).state;

(async () => {
  const { adherence, adherenceCard, DAYS } = await import(MODULE);

  const window = adherence(SCHEDULES, [], TZ, false);
  const pastMorning = window.days.find((d) => !d.isToday && d.weekday !== 0).key;
  const pastEvening = window.days.find((d) => !d.isToday).key;

  // ─── The window itself ───────────────────────────────────────────────────

  section('the fortnight is built correctly');

  check(`covers ${DAYS} days`, window.days.length, DAYS);
  check('one row per dose', window.rows.length, 2);
  check('every row spans the window', window.rows.every((r) => r.cells.length === DAYS), true);

  // Built by calendar arithmetic rather than by subtracting 24h repeatedly: a
  // DST change would otherwise repeat or skip a day.
  const keys = window.days.map((d) => d.key);
  check('no duplicate days across a DST change', new Set(keys).size, DAYS);

  let consecutive = true;
  for (let i = 1; i < keys.length; i++) {
    const gap = (Date.parse(`${keys[i]}T00:00:00Z`) - Date.parse(`${keys[i - 1]}T00:00:00Z`)) / 86400000;
    if (gap !== 1) consecutive = false;
  }
  check('days are consecutive', consecutive, true);
  check('weekday matches the date', window.days.every((d) =>
    d.weekday === new Date(`${d.key}T00:00:00Z`).getUTCDay()), true);

  // ─── The Sunday rule ─────────────────────────────────────────────────────

  section('a deliberate gap is not a missed dose');

  const sundays = window.days.filter((d) => d.weekday === 0);
  check('the window contains a Sunday', sundays.length > 0, true);
  check('Sunday morning reads as not scheduled', sundays.every((d) =>
    cellFor(window, 'morning', d.key) === 'none'), true);

  const pastSundays = sundays.filter((d) => !d.isToday).length;
  const pastDays    = window.days.filter((d) => !d.isToday).length;
  check('Sunday mornings stay out of the rate', window.counted, pastDays * 2 - pastSundays);

  check('a disabled schedule expects nothing', adherence(
    SCHEDULES.map((s) => Object.assign({}, s, { enabled: false })), [], TZ, false).counted, 0);

  // ─── What each cell resolves to ──────────────────────────────────────────

  section('each dose resolves to the right outcome');

  check('a confirmation reads as confirmed',
    cellFor(adherence(SCHEDULES, [row(pastMorning, 'morning', 'CONFIRMED')], TZ, false), 'morning', pastMorning),
    'confirmed');

  check('attempts with no confirmation read as missed',
    cellFor(adherence(SCHEDULES, [
      row(pastEvening, 'evening', 'NO_ANSWER'),
      row(pastEvening, 'evening', 'NOT_CONFIRMED'),
    ], TZ, false), 'evening', pastEvening),
    'missed');

  // She answered on the second try. That is a taken dose, not a half-miss.
  check('one confirmation among several attempts wins',
    cellFor(adherence(SCHEDULES, [
      row(pastEvening, 'evening', 'NO_ANSWER'),
      row(pastEvening, 'evening', 'CONFIRMED'),
    ], TZ, false), 'evening', pastEvening),
    'confirmed');

  check('a queued retry is in progress, not missed',
    cellFor(adherence(SCHEDULES, [
      row(pastMorning, 'morning', 'NO_ANSWER', { nextRetryAt: new Date().toISOString() }),
    ], TZ, false), 'morning', pastMorning),
    'pending');

  // Escalation is about the caregiver. Counting it would let one missed dose
  // look like several events.
  check('escalation rows are not doses',
    cellFor(adherence(SCHEDULES, [
      row(pastEvening, 'evening', 'SENT', { kind: 'ESCALATION_SMS' }),
    ], TZ, false), 'evening', pastEvening),
    'nocall');

  const today = window.days.find((d) => d.isToday).key;
  check('today with nothing yet is still to come', cellFor(window, 'evening', today), 'upcoming');

  // ─── What the card says ──────────────────────────────────────────────────

  section('the card reports honestly');

  check('no rate rather than 0% when nothing is due',
    adherenceCard(adherence([], [], TZ, false)).includes('—'), true);
  check('a trimmed page is disclosed',
    adherenceCard(adherence(SCHEDULES, [], TZ, true)).includes('page limit'), true);
  check('an untrimmed page says nothing about limits',
    adherenceCard(adherence(SCHEDULES, [], TZ, false)).includes('page limit'), false);

  const html = adherenceCard(adherence(SCHEDULES, [row(pastMorning, 'morning', 'CONFIRMED')], TZ, false));
  const open  = (html.match(/<(article|figure|figcaption|details|summary|table|tbody|tr|td|th|p|span)\b/g) || []).length;
  const close = (html.match(/<\/(article|figure|figcaption|details|summary|table|tbody|tr|td|th|p|span)>/g) || []).length;
  check('card markup is balanced', open, close);
  check('one bar per day', (html.match(/class="spark-slot"/g) || []).length, DAYS);
  check('one table row per day', (html.match(/<tr>/g) || []).length, DAYS);

  // Height carries the meaning; colour is the second encoding. A reader who
  // cannot separate the hues still sees which days dipped.
  section('the sparkline does not lean on colour');

  const missDay = window.days.find((d) => !d.isToday && d.weekday !== 0).key;
  const missed = adherenceCard(adherence(SCHEDULES, [
    row(missDay, 'morning', 'NO_ANSWER'),
    row(missDay, 'evening', 'CONFIRMED'),
  ], TZ, false));
  check('a day with a miss draws a shorter bar', /style="height:50%"/.test(missed), true);
  check('and marks it', missed.includes('is-missed'), true);

  // A bar of height zero is invisible, and an invisible failure is the worst
  // kind, so a wholly missed day still gets a stub.
  const allMissed = adherenceCard(adherence(SCHEDULES, [
    row(missDay, 'morning', 'NO_ANSWER'),
    row(missDay, 'evening', 'NO_ANSWER'),
  ], TZ, false));
  check('a wholly missed day is still visible', /style="height:8%"/.test(allMissed), true);

  check('the chart carries a text alternative', /role="img" aria-label="[^"]+"/.test(html), true);
  check('and the numbers behind it', html.includes('Day by day'), true);

  process.exitCode = summary() ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
