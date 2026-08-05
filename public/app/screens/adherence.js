// Adherence: how the last fortnight actually went.
//
// Kept out of today.js because it is the only part of that screen with real
// logic in it — deciding which doses were due, and what each one came to. It
// imports nothing that touches the DOM, so it can be exercised on its own.

import { esc } from '../ui.js';

// ── Adherence over the last fortnight ──────────────────────────────────────
//
// The honest version of "how is she doing" needs to know which doses were
// *expected*, not just which calls happened. Sunday morning has no call
// because that schedule runs Mon–Sat, and a dashboard that painted it red
// would be crying wolf about a gap that is deliberate.
//
// Expectation is read from each enabled schedule's own days, which means it
// describes the schedules as they are configured NOW. Change a schedule's days
// and the past re-reads under the new rules; the card says so rather than
// implying it kept a historical record.

export const DAYS = 14;

// 'YYYY-MM-DD' for an instant, in her timezone. en-CA formats that way natively.
const dayKeyOf = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date);

// The 14 day-keys ending today. Built by calendar arithmetic on a UTC anchor
// rather than by subtracting 86,400,000ms from "now" repeatedly: across a DST
// change that subtraction can repeat or skip a day, and a duplicated column
// reads as a bug.
function recentDays(timeZone) {
  const [year, month, day] = dayKeyOf(new Date(), timeZone).split('-').map(Number);
  const anchor = Date.UTC(year, month - 1, day);

  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const at = new Date(anchor - i * 86400000);
    days.push({
      key:     at.toISOString().slice(0, 10),
      weekday: at.getUTCDay(),
      number:  at.getUTCDate(),
      isToday: i === 0,
      label:   new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(at),
    });
  }
  return days;
}

const CELL = {
  confirmed: { glyph: '✓', kind: 'ok',   text: 'Confirmed' },
  missed:    { glyph: '✗', kind: 'bad',  text: 'Not confirmed' },
  pending:   { glyph: '◷', kind: 'warn', text: 'In progress' },
  nocall:    { glyph: '!', kind: 'warn', text: 'No call was placed' },
  upcoming:  { glyph: '○', kind: 'idle', text: 'Still to come' },
  none:      { glyph: '·', kind: 'idle', text: 'Not scheduled' },
};

// One dose on one day, resolved against the attempts recorded for it.
function cellState(expected, attempts, isToday) {
  if (!expected) return 'none';
  if (attempts.some((r) => r.outcome === 'CONFIRMED')) return 'confirmed';
  if (attempts.some((r) => r.outcome === 'PENDING' || r.nextRetryAt)) return 'pending';
  if (attempts.length) return 'missed';
  // Nothing was recorded at all. Today that just means it has not happened
  // yet; on a past day it means the call never went out, which is a different
  // failure from her not answering and is worth its own mark.
  return isToday ? 'upcoming' : 'nocall';
}

export function adherence(schedules, history, timeZone, truncated) {
  const days = recentDays(timeZone);
  const doses = ['morning', 'evening'];

  // Which doses each weekday expects, from the enabled schedules.
  const expected = new Map();
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    for (const weekday of schedule.daysOfWeek || []) {
      expected.set(`${weekday}:${schedule.dose}`, true);
    }
  }

  // Reminder calls only. Escalation steps are about the caregiver; counting
  // them would let one missed dose look like several events.
  const byCell = new Map();
  for (const row of history) {
    if (row.kind !== 'REMINDER_CALL') continue;
    const key = `${dayKeyOf(new Date(row.startedAt), timeZone)}:${row.dose}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(row);
  }

  let confirmed = 0;
  let counted = 0;

  const rows = doses.map((dose) => ({
    dose,
    cells: days.map((day) => {
      const state = cellState(
        expected.has(`${day.weekday}:${dose}`),
        byCell.get(`${day.key}:${dose}`) || [],
        day.isToday
      );
      // The rate is about doses that have had their chance: a dose still to
      // come today is not a failure, and an unscheduled slot is not a dose.
      if (state !== 'none' && state !== 'upcoming') {
        counted++;
        if (state === 'confirmed') confirmed++;
      }
      return { day, state };
    }),
  }));

  return { days, rows, confirmed, counted, truncated };
}

export function adherenceCard(data) {
  const { days, rows, confirmed, counted, truncated } = data;
  const rate = counted ? Math.round((confirmed / counted) * 100) : null;

  const header = days.map((day) =>
    `<th scope="col" class="${day.isToday ? 'is-today' : ''}">
      <abbr title="${esc(day.label)}">
        <span class="col-day">${'SMTWTFS'[day.weekday]}</span>
        <span class="col-num">${day.number}</span>
      </abbr>
    </th>`).join('');

  const body = rows.map((row) => `<tr>
    <th scope="row">${row.dose === 'morning' ? 'Morning' : 'Evening'}</th>
    ${row.cells.map(({ day, state }) => {
      const cell = CELL[state];
      return `<td class="cell cell-${cell.kind}${day.isToday ? ' is-today' : ''}">
        <span aria-hidden="true">${cell.glyph}</span>
        <span class="sr-only">${esc(cell.text)}</span>
      </td>`;
    }).join('')}
  </tr>`).join('');

  const legend = ['confirmed', 'missed', 'pending', 'nocall', 'none']
    .map((state) => `<li><span class="cell cell-${CELL[state].kind}" aria-hidden="true">${CELL[state].glyph}</span>${esc(CELL[state].text)}</li>`)
    .join('');

  return `<article class="card adherence">
    <div class="adherence-head">
      <div>
        <p class="card-eyebrow">Last ${DAYS} days</p>
        <p class="stat-value">${rate === null ? '—' : `${rate}%`} <span class="stat-unit">confirmed</span></p>
        <p class="stat-label">${confirmed} of ${counted} dose${counted === 1 ? '' : 's'} she was due</p>
      </div>
      <ul class="legend">${legend}</ul>
    </div>

    <div class="adherence-scroll">
      <table class="adherence-table">
        <caption class="sr-only">Each dose over the last ${DAYS} days, by outcome</caption>
        <thead><tr><td></td>${header}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>

    <p class="small muted adherence-note">
      Which doses were due is read from your schedules as they are set today, so
      Sunday mornings show as not scheduled rather than missed.
      ${truncated ? '<strong>Older attempts were trimmed by the API page limit, so the rate covers only what is shown.</strong>' : ''}
    </p>
  </article>`;
}

