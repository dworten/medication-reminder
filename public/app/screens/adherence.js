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

// One dose on one day, resolved against the attempts recorded for it. Six
// states: confirmed, missed, pending, nocall (expected but never attempted),
// upcoming (today, not yet), none (not scheduled). The card collapses them to
// a share per day; History is where the individual outcomes are readable.
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

  // Per day, collapsed across doses — what the sparkline draws. One bar per day
  // is the whole chart; the dose-level detail lives in History, which is where
  // you go when a bar looks wrong.
  const daily = days.map((day, index) => {
    const states = rows.map((row) => row.cells[index].state);
    const due = states.filter((s) => s !== 'none' && s !== 'upcoming').length;
    return {
      day,
      due,
      confirmed: states.filter((s) => s === 'confirmed').length,
      missed:    states.filter((s) => s === 'missed' || s === 'nocall').length,
      pending:   states.filter((s) => s === 'pending').length,
    };
  });

  return { days, rows, daily, confirmed, counted, truncated };
}

const dayLabel = (day) => day.label.replace(/^\w+day, /, '');

// The card is a stat tile: the rate is the point, and the sparkline underneath
// is context for it. An earlier version drew a cell per dose per day — 28 cells
// and a five-item legend to say one number, which is the classic way a chart
// misses what it is for.
//
// Height carries the meaning, so a reader who cannot separate the two hues
// still sees which days dipped. Colour is the second encoding, and the pair is
// blue/red rather than green/red: green against red is ΔE 7.6 under
// deuteranopia, which is the floor band, while blue against red is 19.
export function adherenceCard(data) {
  const { daily, confirmed, counted, truncated } = data;
  const rate = counted ? Math.round((confirmed / counted) * 100) : null;

  const withMisses = daily.filter((d) => d.missed > 0).length;

  const bars = daily.map((entry) => {
    const { day, due, missed } = entry;

    // Nothing was due, or nothing is due yet: a low tick, so an empty day is
    // visibly empty rather than an absent bar that reads as zero.
    if (!due) {
      return `<span class="spark-slot"><span class="spark-bar is-idle" title="${esc(dayLabel(day))} — nothing due"></span></span>`;
    }

    // A day where nothing was confirmed still gets a stub: a bar of height zero
    // is invisible, and an invisible failure is the worst kind.
    const share  = Math.round((entry.confirmed / due) * 100);
    const height = Math.max(share, 8);
    const detail = `${entry.confirmed} of ${due} confirmed${missed ? `, ${missed} missed` : ''}`;

    return `<span class="spark-slot"><span
      class="spark-bar${missed ? ' is-missed' : ''}${day.isToday ? ' is-today' : ''}"
      style="height:${height}%"
      title="${esc(dayLabel(day))} — ${esc(detail)}"></span></span>`;
  }).join('');

  const summary = rate === null
    ? `No doses were due in the last ${DAYS} days.`
    : `${rate}% of doses confirmed over the last ${DAYS} days` +
      `${withMisses ? `, with a missed dose on ${withMisses} day${withMisses === 1 ? '' : 's'}` : ', none missed'}.`;

  // The numbers behind the bars, for a screen reader and for anyone who wants
  // the values rather than the shape.
  const table = daily.map((entry) =>
    `<tr><th scope="row">${esc(dayLabel(entry.day))}</th>
      <td>${entry.due ? `${entry.confirmed} of ${entry.due}` : 'none due'}</td></tr>`).join('');

  return `<article class="card stat-card adherence">
    <p class="card-eyebrow">Last ${DAYS} days</p>
    <p class="stat-value">${rate === null ? '—' : `${rate}%`} <span class="stat-unit">confirmed</span></p>
    <p class="stat-label">${confirmed} of ${counted} dose${counted === 1 ? '' : 's'} she was due</p>

    <figure class="spark" role="img" aria-label="${esc(summary)}">
      <span class="spark-bars">${bars}</span>
      <figcaption class="spark-axis">
        <span>${esc(dayLabel(daily[0].day))}</span>
        <span>Today</span>
      </figcaption>
    </figure>

    <details class="spark-detail">
      <summary>Day by day</summary>
      <table><tbody>${table}</tbody></table>
      <p class="small muted">
        Which doses were due is read from your schedules as they are set today, so
        Sunday mornings are not counted as missed.
        ${truncated ? '<strong>Older attempts were trimmed by the API page limit, so the rate covers only what is shown.</strong>' : ''}
      </p>
    </details>
  </article>`;
}

