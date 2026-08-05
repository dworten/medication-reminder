// Schedules — the screen that decides when a phone actually rings.
//
// Everything here is one form away from changing a real call, so the editor
// spells out consequences rather than presenting bare fields: what "disabled"
// means, who gets alerted, how long the retry gap is.

import { api } from '../api.js';
import {
  node, esc, badge, toast, confirmAction, readForm,
  showFieldErrors, clearFieldErrors,
  prettyTime, zoneAbbrev, describeDays, dayLongName, dayName,
  formatWhen, relative,
} from '../ui.js';
import { refresh } from '../app.js';

const COMMON_ZONES = [
  'America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'UTC',
];

// `dose` is derived from the time rather than chosen. It was a redundant
// question — a 9:20 AM schedule is obviously the morning one — but the column
// is not cosmetic: it travels in the webhook query string, picks the goodbye
// line ("have a good rest of your day" vs "have a good night"), names the dose
// in the caregiver's alert, and is what History filters on. So the control is
// gone and the value is computed, not dropped.
const doseFor = (timeOfDay) => (Number(String(timeOfDay).slice(0, 2)) < 12 ? 'morning' : 'evening');

const GOODBYE = {
  morning: 'Have a good rest of your day.',
  evening: 'Have a good night.',
};

function escalationSummary(schedule) {
  const to = schedule.escalationContact?.name;
  if (!to) return 'No escalation contact — <strong>nobody is alerted</strong>';

  const steps = [];
  if (schedule.escalateWithCall) steps.push('call');
  if (schedule.escalateWithSms)  steps.push('text');
  if (!steps.length) return '<strong>Nobody is alerted</strong> — both escalation steps are off';

  // Both steps always run — acknowledging the call no longer suppresses the
  // text — so this reads "call and text", not "call then text unless…".
  return `${steps.join(' and ')} ${esc(to)}`;
}

function card(schedule, timeZone) {
  const off = !schedule.enabled;

  return `<article class="card ${off ? 'is-off' : ''}" data-id="${esc(schedule.id)}">
    <div class="card-head">
      <div>
        <div class="card-title">
          ${esc(schedule.name)}
          ${off ? badge('Disabled', 'off') : ''}
        </div>
        <div class="small muted">
          ${esc(prettyTime(schedule.timeOfDay))} ${esc(zoneAbbrev(schedule.timezone))} ·
          ${esc(describeDays(schedule.daysOfWeek))}
        </div>
      </div>
      <div class="card-actions">
        <button class="small" data-act="toggle">${off ? 'Enable' : 'Disable'}</button>
        <button class="small" data-act="edit">Edit</button>
      </div>
    </div>

    <dl class="rows">
      <div class="row"><dt>Calls</dt><dd>${esc(schedule.contact?.name || '—')} · ${esc(schedule.contact?.phone || '')}</dd></div>
      <div class="row"><dt>Says</dt><dd>${esc(schedule.message?.name || 'Built-in default wording')}</dd></div>
      <div class="row"><dt>If no answer</dt><dd>${schedule.maxAttempts} attempt${schedule.maxAttempts === 1 ? '' : 's'}, ${schedule.retryDelayMinutes} min apart</dd></div>
      <div class="row"><dt>Then</dt><dd>${escalationSummary(schedule)}</dd></div>
      <div class="row"><dt>Next</dt><dd>${
        off
          ? '<span class="muted">Disabled — no calls</span>'
          : schedule.nextRunAt
            ? `${esc(formatWhen(schedule.nextRunAt, timeZone))} <span class="muted">(${esc(relative(schedule.nextRunAt))})</span>`
            : '<span class="muted">never — check the days and time</span>'
      }</dd></div>
    </dl>
  </article>`;
}

function dayPicker(selected) {
  const chosen = new Set(selected || []);
  return `<div class="days">${[0, 1, 2, 3, 4, 5, 6].map((d) => `
    <input type="checkbox" id="day-${d}" data-group="days" value="${d}" ${chosen.has(d) ? 'checked' : ''}>
    <label for="day-${d}" title="${esc(dayLongName(d))}">${esc(dayName(d))}</label>
  `).join('')}</div>`;
}

// The time field carries a #dose-hint paragraph rather than a dose control.
// The value is derived (see doseFor) but still shown, because it is audible: it
// decides the goodbye line, and silently changing what she hears is worse than
// a sentence saying so.
//
// Note for future edits: this function is one long template literal, so a
// backtick anywhere inside it — including in a comment — ends the string and
// breaks the module. Explanations go here, above it.
function form(schedule, contacts, messages) {
  const s = schedule || {
    name: '', dose: 'morning', timeOfDay: '09:20', daysOfWeek: [1, 2, 3, 4, 5, 6],
    timezone: COMMON_ZONES[0], maxAttempts: 2, retryDelayMinutes: 3, maxReprompts: 3,
    escalateWithCall: true, escalateWithSms: true, escalationAckMinutes: 3,
    contactId: contacts[0]?.id || '', messageId: '', escalationContactId: '',
  };

  const options = (list, selected, blank) =>
    (blank ? `<option value="">${esc(blank)}</option>` : '') +
    list.map((item) => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>
      ${esc(item.name)}${item.phone ? ` — ${esc(item.phone)}` : ''}
    </option>`).join('');

  const zones = [...new Set([s.timezone, ...COMMON_ZONES])];

  return `<form id="schedule-form" novalidate>
    <h2 style="margin-top:0">${schedule ? 'Edit schedule' : 'New schedule'}</h2>

    <div class="field"><label for="f-name">Name</label>
      <input id="f-name" name="name" type="text" value="${esc(s.name)}" placeholder="Morning meds" required></div>

    <div class="field"><label for="f-time">Time <span class="hint">— 24-hour, in the timezone below</span></label>
      <input id="f-time" name="timeOfDay" type="time" value="${esc(s.timeOfDay)}" required>
      <p class="small muted" id="dose-hint" style="margin:-.625rem 0 .875rem"></p>
    </div>

    <div class="field"><label>Days</label>${dayPicker(s.daysOfWeek)}</div>

    <div class="field"><label for="f-zone">Timezone</label>
      <select id="f-zone" name="timezone">
        ${zones.map((z) => `<option value="${esc(z)}" ${z === s.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}
      </select></div>

    <div class="field"><label for="f-contact">Who to call</label>
      <select id="f-contact" name="contactId" required>${options(contacts, s.contactId)}</select></div>

    <div class="field"><label for="f-message">What to say</label>
      <select id="f-message" name="messageId">${options(messages, s.messageId, 'Built-in default wording')}</select></div>

    <h2>If she doesn't answer</h2>

    <div class="field"><label for="f-attempts">Total attempts <span class="hint">— counting the first call</span></label>
      <input id="f-attempts" name="maxAttempts" type="number" min="1" max="10" value="${esc(s.maxAttempts)}"></div>

    <div class="field"><label for="f-delay">Minutes between attempts</label>
      <input id="f-delay" name="retryDelayMinutes" type="number" min="1" max="120" value="${esc(s.retryDelayMinutes)}"></div>

    <div class="field"><label for="f-reprompts">Re-asks within one answered call</label>
      <input id="f-reprompts" name="maxReprompts" type="number" min="0" max="10" value="${esc(s.maxReprompts)}"></div>

    <h2>Then alert someone</h2>

    <div class="field"><label for="f-escalation">Fallback contact</label>
      <select id="f-escalation" name="escalationContactId">${options(contacts, s.escalationContactId, '— none —')}</select></div>

    <div class="checkline">
      <input id="f-call" name="escalateWithCall" type="checkbox" ${s.escalateWithCall ? 'checked' : ''}>
      <label for="f-call">Call them (they press 1 to acknowledge)</label>
    </div>
    <div class="checkline">
      <input id="f-sms" name="escalateWithSms" type="checkbox" ${s.escalateWithSms ? 'checked' : ''}>
      <label for="f-sms">Text them</label>
    </div>

    <p class="small muted">
      With both on they get a call and a text, every time — pressing 1 is recorded
      but no longer stops the text. The text is queued the moment the call is placed,
      so it still arrives if this app restarts mid-chain.
    </p>

    <div class="button-row">
      <button type="submit" class="primary">${schedule ? 'Save changes' : 'Create schedule'}</button>
      <button type="button" data-act="cancel">Cancel</button>
      <span class="spacer"></span>
      ${schedule ? '<button type="button" class="danger" data-act="delete">Delete</button>' : ''}
    </div>
  </form>`;
}

export async function renderSchedules(context) {
  const timeZone = context.account.timezone;

  const [{ schedules }, { contacts }, { messages }] = await Promise.all([
    api.schedules.list(), api.contacts.list(), api.messages.list(),
  ]);

  if (!contacts.length) {
    return node(`<h1>Schedules</h1>
      <div class="banner banner-warn">Add a contact first — a schedule needs someone to call.</div>`);
  }

  const anyEnabled = schedules.some((s) => s.enabled);

  const el = node(`
    <h1>Schedules</h1>
    <p class="sub">When she gets called, and what happens if she doesn't answer.</p>
    ${schedules.length && !anyEnabled
      ? '<div class="banner banner-bad">Every schedule is disabled. No reminder calls will be placed.</div>'
      : ''}
    <div id="list">
      ${schedules.length
        ? schedules.map((s) => card(s, timeZone)).join('')
        : '<p class="empty">No schedules yet.</p>'}
    </div>
    <div class="button-row"><button class="primary" data-act="new">New schedule</button></div>
    <div id="editor"></div>
  `);

  const list   = el.querySelector('#list');
  const editor = el.querySelector('#editor');

  function closeEditor() {
    editor.innerHTML = '';
    list.style.display = '';
    el.querySelector('[data-act="new"]').style.display = '';
  }

  function openEditor(schedule) {
    // The form replaces the list rather than sitting under it: on a phone an
    // editor below a list of cards is mostly scrolling.
    list.style.display = 'none';
    el.querySelector('[data-act="new"]').style.display = 'none';
    editor.innerHTML = form(schedule, contacts, messages);

    const formEl = editor.querySelector('#schedule-form');
    formEl.querySelector('[data-act="cancel"]').addEventListener('click', closeEditor);

    // Keep the derived dose visible as the time is changed, so moving a
    // schedule across noon does not quietly change what she hears at the end of
    // the call.
    const timeInput = formEl.querySelector('#f-time');
    const doseHint  = formEl.querySelector('#dose-hint');
    const syncDose = () => {
      const dose = doseFor(timeInput.value);
      doseHint.textContent = `Counts as the ${dose} dose — she'll hear “${GOODBYE[dose]}”`;
    };
    timeInput.addEventListener('input', syncDose);
    syncDose();

    formEl.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      if (!confirmAction(`Delete "${schedule.name}"? Calls already placed stay in the history.`)) return;
      try {
        await api.schedules.remove(schedule.id);
        toast('Schedule deleted');
        await refresh();
      } catch (err) { toast(err.message, 'bad'); }
    });

    formEl.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(formEl);

      const data = readForm(formEl, {
        numbers:  ['maxAttempts', 'retryDelayMinutes', 'maxReprompts'],
        nullable: ['messageId', 'escalationContactId'],
      });
      // The day toggles are checkboxes outside the name-based read, so they are
      // gathered separately into the array the API expects.
      data.daysOfWeek = [...formEl.querySelectorAll('[data-group="days"]:checked')].map((i) => Number(i.value));
      // Derived, not asked for. Still sent because the API requires it on
      // create and the call path reads it on every call.
      data.dose = doseFor(data.timeOfDay);

      const submit = formEl.querySelector('[type="submit"]');
      submit.disabled = true;

      try {
        if (schedule) await api.schedules.update(schedule.id, data);
        else          await api.schedules.create(data);
        toast(schedule ? 'Schedule saved' : 'Schedule created');
        await refresh();
      } catch (err) {
        submit.disabled = false;
        // Field-level errors land on their inputs; anything else gets a toast,
        // so a validation failure is never silent.
        if (!showFieldErrors(formEl, err.details)) toast(err.message, 'bad');
        else toast('Check the highlighted fields', 'bad');
      }
    });

    formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  el.querySelector('[data-act="new"]').addEventListener('click', () => openEditor(null));

  for (const article of el.querySelectorAll('.card[data-id]')) {
    const schedule = schedules.find((s) => s.id === article.dataset.id);

    article.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(schedule));

    article.querySelector('[data-act="toggle"]').addEventListener('click', async (event) => {
      const turningOff = schedule.enabled;
      // Disabling stops her being called at all, which is the one change here
      // that can silently cause a missed dose. Say so.
      if (turningOff && !confirmAction(`Disable "${schedule.name}"? No reminder calls will be placed until it is re-enabled.`)) return;

      event.target.disabled = true;
      try {
        await api.schedules.setEnabled(schedule.id, !schedule.enabled);
        toast(turningOff ? 'Schedule disabled' : 'Schedule enabled');
        await refresh();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    });
  }

  return el;
}
