// Today — the glance-at-your-phone screen. Was the dose confirmed, when is the
// next call, and is anything still owed by the retry sweeper.

import { api } from '../api.js';
import {
  node, esc, badge, toast, confirmAction,
  formatWhen, relative, prettyTime, zoneAbbrev, describeDays,
  outcomeLabel, outcomeKind, kindLabel,
} from '../ui.js';
import { refresh } from '../app.js';

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
      ${anyDisabled ? 'Every schedule is currently disabled — nobody will be called.' : 'Add a schedule to get started.'}
    </div>`;
  }

  const next = upcoming[0];
  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">Next call — ${esc(next.name)}</div>
        <div class="small muted">${esc(next.contact?.name || 'no contact')} · ${esc(prettyTime(next.timeOfDay))} ${esc(zoneAbbrev(next.timezone))}</div>
      </div>
      <div class="card-actions"><span class="small">${esc(relative(next.nextRunAt))}</span></div>
    </div>
    <div class="small muted" style="margin-top:.5rem">
      ${esc(formatWhen(next.nextRunAt, timeZone))} · ${esc(describeDays(next.daysOfWeek))}
    </div>
  </div>`;
}

function attemptLine(row, timeZone) {
  return `<div class="attempt">
    <div class="attempt-head">
      <span class="attempt-when">${esc(formatWhen(row.startedAt, timeZone, { withDate: false }))}</span>
      <strong class="small">${esc(kindLabel(row.kind))}</strong>
      <span class="small muted">${esc(row.dose)}${row.attempt > 1 ? ` · try ${row.attempt}` : ''}</span>
      ${badge(outcomeLabel(row.outcome), outcomeKind(row.outcome))}
    </div>
  </div>`;
}

export async function renderToday(context) {
  const timeZone = context.account.timezone;

  const [{ schedules }, { callHistory }] = await Promise.all([
    api.schedules.list(),
    api.history.list({ limit: 50 }),
  ]);

  const since  = startOfTodayIn(timeZone);
  const today  = callHistory.filter((r) => new Date(r.startedAt) >= since);
  const queued = callHistory.filter((r) => r.nextRetryAt);

  // Only reminder calls answer "did she take it" — escalation steps are about
  // the caregiver, and counting them here would double-count one missed dose.
  const reminders = today.filter((r) => r.kind === 'REMINDER_CALL');
  const confirmed = reminders.filter((r) => r.outcome === 'CONFIRMED');

  const el = node(`
    <h1>Today</h1>
    <p class="sub">${esc(new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'long', month: 'long', day: 'numeric',
    }).format(new Date()))} · times shown in ${esc(zoneAbbrev(timeZone))}</p>

    ${nextUp(schedules, timeZone)}

    ${queued.length ? `<div class="banner banner-warn">
      ${queued.length} item${queued.length === 1 ? '' : 's'} still queued — the sweeper will act
      ${esc(relative(queued[0].nextRetryAt))}.
    </div>` : ''}

    <h2>Doses today</h2>
    ${reminders.length === 0
      ? '<p class="empty">No calls placed yet today.</p>'
      : `<p class="small muted" style="margin:-.25rem 0 .75rem">
           ${confirmed.length} of ${reminders.length} call${reminders.length === 1 ? '' : 's'} confirmed
         </p>
         ${today.map((row) => attemptLine(row, timeZone)).join('')}`}

    <h2>Place a call now</h2>
    <p class="small muted" style="margin:-.25rem 0 .75rem">
      Uses the schedule's contact, message and escalation settings.
      ${context.account.isAdmin
        ? '<strong>Test</strong> rings TEST_PHONE_NUMBER instead — but escalation still goes to the real caregiver.'
        : ''}
    </p>
    <div class="button-row">
      <button class="primary" data-call="morning" data-target="grandma">Call — morning</button>
      <button class="primary" data-call="evening" data-target="grandma">Call — evening</button>
      ${context.account.isAdmin ? `
        <button data-call="morning" data-target="test">Test — morning</button>
        <button data-call="evening" data-target="test">Test — evening</button>
      ` : ''}
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
