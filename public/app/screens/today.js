// Today — the dashboard. Was the dose confirmed, when is the next call, is
// anything still owed by the retry sweeper, and how has the last fortnight
// actually gone.

import { api } from '../api.js';
import {
  node, esc, toast, confirmAction,
  formatWhen, relative, prettyTime, zoneAbbrev, describeDays,
  outcomeBadge, outcomeKind, kindLabel,
} from '../ui.js';
import { refresh } from '../app.js';
import { DAYS, adherence, adherenceCard } from './adherence.js';

// Midnight in the account's timezone, as a UTC instant. "Today" has to mean her
// day — reading this from another timezone should not show yesterday's calls.
function startOfTodayIn(timeZone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);

  const get = (type) => Number(parts.find((p) => p.type === type).value);
  // Approximate the offset from the current instant, which is exact except
  // across a DST change in the last few hours — close enough for a day filter.
  const naive  = Date.UTC(get('year'), get('month') - 1, get('day'));
  const probe  = new Date(naive);
  const shown  = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' }).format(probe);
  const offset = Number(shown) * 3600000;

  return new Date(naive + (offset > 12 * 3600000 ? offset - 24 * 3600000 : offset));
}

function nextUp(schedules, timeZone) {
  const upcoming = schedules
    .filter((s) => s.enabled && s.nextRunAt)
    .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));

  if (!upcoming.length) {
    const anyDisabled = schedules.some((s) => !s.enabled);
    return `<div class="banner banner-warn">
      No calls are scheduled.
      ${anyDisabled ? 'Every event schedule is currently disabled — nobody will be called.' : 'Add an event schedule to get started.'}
    </div>`;
  }

  const next = upcoming[0];
  return `<article class="card stat-card">
    <p class="card-eyebrow">Next call</p>
    <p class="stat-value">${esc(prettyTime(next.timeOfDay))} <span class="stat-unit">${esc(zoneAbbrev(next.timezone))}</span></p>
    <p class="stat-label">${esc(formatWhen(next.nextRunAt, timeZone))} · <strong>${esc(relative(next.nextRunAt))}</strong></p>
    <dl class="rows">
      <div class="row"><dt>Event Schedule</dt><dd>${esc(next.name)} · ${esc(describeDays(next.daysOfWeek))}</dd></div>
      <div class="row"><dt>Calls</dt><dd>${esc(next.contact?.name || 'no contact')}</dd></div>
    </dl>
  </article>`;
}

// The summary sits above the individual attempts: the question this screen
// exists to answer is "did she take them", not "list every call".
function doseSummary(reminders, confirmed) {
  const missed = reminders.filter((r) =>
    ['NOT_CONFIRMED', 'NO_ANSWER', 'BUSY', 'FAILED'].includes(r.outcome)).length;

  let pill = '<span class="pill pill-off">Nothing yet</span>';
  if (reminders.length && confirmed === reminders.length) pill = '<span class="pill pill-ok">All confirmed</span>';
  else if (missed) pill = `<span class="pill pill-bad">${missed} missed</span>`;
  else if (reminders.length) pill = '<span class="pill pill-warn">In progress</span>';

  return `<article class="card stat-card">
    <p class="card-eyebrow">Doses today</p>
    <p class="stat-value">${confirmed} <span class="stat-unit">of ${reminders.length}</span></p>
    <p class="stat-label">reminder call${reminders.length === 1 ? '' : 's'} confirmed</p>
    <p class="stat-pill">${pill}</p>
  </article>`;
}

function attemptLine(row, timeZone) {
  return `<article class="attempt attempt-root attempt-${outcomeKind(row.outcome)}">
    <div class="attempt-head">
      <span class="attempt-when">${esc(formatWhen(row.startedAt, timeZone, { withDate: false }))}</span>
      <strong class="attempt-kind">${esc(kindLabel(row.kind))}</strong>
      <span class="small muted">${esc(row.dose)}${row.attempt > 1 ? ` · try ${row.attempt}` : ''}</span>
      ${outcomeBadge(row.outcome)}
    </div>
  </article>`;
}

export async function renderToday(context) {
  const timeZone = context.account.timezone;

  // Two windows from the same endpoint: the recent slice the day view needs,
  // and a fortnight for the adherence strip. The fortnight is asked for at the
  // API's maximum page, which two doses a day stays well inside; if it ever
  // does fill up, the card says the rate is partial rather than under-reporting.
  const fortnightStart = new Date(Date.now() - DAYS * 86400000).toISOString();

  const [{ schedules }, { callHistory }, fortnight] = await Promise.all([
    api.schedules.list(),
    api.history.list({ limit: 50 }),
    api.history.list({ from: fortnightStart, limit: 200 }),
  ]);

  const since  = startOfTodayIn(timeZone);
  const today  = callHistory.filter((r) => new Date(r.startedAt) >= since);
  const queued = callHistory.filter((r) => r.nextRetryAt);

  // Only reminder calls answer "did she take it" — escalation steps are about
  // the caregiver, and counting them here would double-count one missed dose.
  const reminders = today.filter((r) => r.kind === 'REMINDER_CALL');
  const confirmed = reminders.filter((r) => r.outcome === 'CONFIRMED');

  const el = node(`
    <div class="page-head">
      <div>
        <h1>Today</h1>
        <p class="sub">${esc(new Intl.DateTimeFormat('en-US', {
          timeZone, weekday: 'long', month: 'long', day: 'numeric',
        }).format(new Date()))} · times shown in ${esc(zoneAbbrev(timeZone))}</p>
      </div>
    </div>

    <div class="today-grid">
      ${nextUp(schedules, timeZone)}
      ${doseSummary(reminders, confirmed.length)}
      ${adherenceCard(adherence(
        schedules,
        fortnight.callHistory,
        timeZone,
        fortnight.pagination.hasMore
      ))}
    </div>

    ${queued.length ? `<div class="banner banner-warn"><span>
      ${queued.length} item${queued.length === 1 ? '' : 's'} still queued — the sweeper will act
      ${esc(relative(queued[0].nextRetryAt))}.
    </span></div>` : ''}

    <h2>Every call today</h2>
    <div class="attempt-list">
      ${reminders.length === 0
        ? '<p class="empty">No calls placed yet today.</p>'
        : today.map((row) => attemptLine(row, timeZone)).join('')}
    </div>

    <h2>Place a call now</h2>
    <div class="panel">
      <p class="small muted" style="margin:0 0 1rem">
        Uses the schedule's contact, message and escalation settings.
        ${context.account.isAdmin
          ? '<strong>Test</strong> rings TEST_PHONE_NUMBER instead — but escalation still goes to the real caregiver.'
          : ''}
      </p>
      <div class="button-row" style="margin-top:0">
        <button class="primary" data-call="morning" data-target="grandma">Call — morning</button>
        <button class="primary" data-call="evening" data-target="grandma">Call — evening</button>
        ${context.account.isAdmin ? `
          <button data-call="morning" data-target="test">Test — morning</button>
          <button data-call="evening" data-target="test">Test — evening</button>
        ` : ''}
      </div>
    </div>
  `);

  for (const button of el.querySelectorAll('[data-call]')) {
    button.addEventListener('click', async () => {
      const dose   = button.dataset.call;
      const target = button.dataset.target;

      // This dials a real phone and costs real money, so it asks first — and
      // says plainly which number it is about to ring.
      const who = target === 'test' ? 'your test phone' : 'the recipient';
      if (!confirmAction(`Place a ${dose} call to ${who} now?`)) return;

      button.disabled = true;
      try {
        const result = await api.trigger(dose, target);
        toast(`Calling ${result.schedule?.contact || who}…`);
        // The attempt row is written before Twilio is contacted, so a moment is
        // enough for it to show up in the list.
        setTimeout(refresh, 1500);
      } catch (err) {
        toast(err.message, 'bad');
        button.disabled = false;
      }
    });
  }

  return el;
}
