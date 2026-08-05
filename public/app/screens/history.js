// History — what actually happened.
//
// Escalation steps nest under the attempt that caused them, using parent_id, so
// "why did the caregiver get a text at 9:35" is one glance rather than a
// reconstruction from timestamps.

import { api } from '../api.js';
import {
  node, esc, badge, formatWhen, outcomeLabel, outcomeKind, kindLabel, toast,
} from '../ui.js';

const PAGE = 25;

// The API returns a flat list with parentId. Roots are the rows whose parent is
// not in this page — an escalation whose parent fell off the end still has to
// render rather than vanishing.
function nest(rows) {
  const byId     = new Map(rows.map((r) => [r.id, r]));
  const children = new Map();

  for (const row of rows) {
    if (row.parentId && byId.has(row.parentId)) {
      if (!children.has(row.parentId)) children.set(row.parentId, []);
      children.get(row.parentId).push(row);
    }
  }

  const roots = rows.filter((r) => !r.parentId || !byId.has(r.parentId));
  return { roots, children };
}

function attempt(row, children, timeZone, depth = 0) {
  const kids = children.get(row.id) || [];

  // Where it actually rang, when that differs from the contact on file — a
  // /trigger?target=test call would otherwise read as though it rang her.
  const redirected = row.toPhone && row.contact && row.toPhone !== row.contact.phone;
  const who = row.contact
    ? `${row.contact.name}${redirected ? ` → ${row.toPhone}` : ''}`
    : (row.toPhone || '—');

  return `<div class="attempt">
    <div class="attempt-head">
      <span class="attempt-when">${esc(formatWhen(row.startedAt, timeZone))}</span>
      <strong class="small">${esc(kindLabel(row.kind))}</strong>
      <span class="small muted">${esc(row.dose)}${row.attempt > 1 ? ` · try ${row.attempt}` : ''}</span>
      ${badge(outcomeLabel(row.outcome), outcomeKind(row.outcome))}
      ${redirected ? badge('redirected', 'warn') : ''}
    </div>
    <div class="small muted">
      ${esc(who)}
      ${row.repromptCount ? ` · ${row.repromptCount} re-ask${row.repromptCount === 1 ? '' : 's'}` : ''}
      ${row.nextRetryAt ? ` · <strong>queued</strong> for ${esc(formatWhen(row.nextRetryAt, timeZone))}` : ''}
    </div>
    ${row.errorMessage ? `<div class="small muted">“${esc(row.errorMessage)}”</div>` : ''}
    ${kids.map((kid) => attempt(kid, children, timeZone, depth + 1)).join('')}
  </div>`;
}

export async function renderHistory(context) {
  const timeZone = context.account.timezone;
  const { contacts } = await api.contacts.list();

  const state = { offset: 0, from: '', to: '', contactId: '', dose: '' };

  const el = node(`
    <h1>History</h1>
    <p class="sub">Every attempt, with escalation steps nested underneath. Read-only.</p>

    <div class="filters">
      <div><label for="h-from">From</label><input id="h-from" type="date"></div>
      <div><label for="h-to">To</label><input id="h-to" type="date"></div>
      <div><label for="h-contact">Contact</label>
        <select id="h-contact">
          <option value="">Anyone</option>
          ${contacts.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
        </select></div>
      <div><label for="h-dose">Dose</label>
        <select id="h-dose">
          <option value="">Both</option>
          <option value="morning">Morning</option>
          <option value="evening">Evening</option>
        </select></div>
    </div>

    <div id="results"><p class="loading">Loading…</p></div>
    <div class="button-row">
      <button id="prev" disabled>← Newer</button>
      <button id="next" disabled>Older →</button>
      <span class="spacer"></span>
      <span id="count" class="small muted"></span>
    </div>
  `);

  const results = el.querySelector('#results');
  const prev    = el.querySelector('#prev');
  const next    = el.querySelector('#next');
  const count   = el.querySelector('#count');

  async function load() {
    results.innerHTML = '<p class="loading">Loading…</p>';

    try {
      const { callHistory, pagination } = await api.history.list({
        limit:  PAGE,
        offset: state.offset,
        // A date input gives a bare date; the API parses it as midnight UTC.
        // "To" is pushed to the end of that day so a single-day filter includes it.
        from:      state.from || undefined,
        to:        state.to ? `${state.to}T23:59:59` : undefined,
        contactId: state.contactId || undefined,
        dose:      state.dose || undefined,
      });

      if (!callHistory.length) {
        results.innerHTML = '<p class="empty">Nothing matches those filters.</p>';
      } else {
        const { roots, children } = nest(callHistory);
        results.innerHTML = roots.map((row) => attempt(row, children, timeZone)).join('');
      }

      const shown = state.offset + callHistory.length;
      count.textContent = pagination.total
        ? `${state.offset + 1}–${shown} of ${pagination.total}`
        : '';
      prev.disabled = state.offset === 0;
      next.disabled = !pagination.hasMore;
    } catch (err) {
      results.innerHTML = `<div class="banner banner-bad">${esc(err.message)}</div>`;
      toast(err.message, 'bad');
    }
  }

  // Changing a filter resets to the first page — staying on page 4 of a
  // different result set shows an empty screen and looks like a bug.
  function onFilterChange() {
    state.from      = el.querySelector('#h-from').value;
    state.to        = el.querySelector('#h-to').value;
    state.contactId = el.querySelector('#h-contact').value;
    state.dose      = el.querySelector('#h-dose').value;
    state.offset    = 0;
    load();
  }

  for (const id of ['#h-from', '#h-to', '#h-contact', '#h-dose']) {
    el.querySelector(id).addEventListener('change', onFilterChange);
  }

  prev.addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE); load(); });
  next.addEventListener('click', () => { state.offset += PAGE; load(); });

  load();
  return el;
}
