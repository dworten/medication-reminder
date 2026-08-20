// Schedules — the screen that decides when a phone actually rings.
//
// Everything here is one form away from changing a real call, so the editor
// spells out consequences rather than presenting bare fields: what "disabled"
// means, who gets alerted, how long the retry gap is.

import { api } from '../api.js';
import {
  node, esc, toast, confirmAction, readForm,
  showFieldErrors, clearFieldErrors,
  prettyTime, zoneAbbrev, describeDays, dayLongName, dayName,
  formatWhen, relative,
} from '../ui.js';
import { refresh } from '../app.js';
import { TZ_CITIES, cityLabel, zoneCity, zoneFromLabel } from '../timezones.js';

// Where a brand-new schedule starts. Every existing schedule carries its own
// zone; this only decides the first one.
const DEFAULT_ZONE = 'America/Chicago';

// `dose` is derived from the time rather than chosen. It was a redundant
// question — a 9:20 AM schedule is obviously the morning one — but the column
// is not cosmetic: it travels in the webhook query string, picks the goodbye
// line ("have a good rest of your day" vs "have a good night"), names the dose
// in the caregiver's alert, and is what History filters on. So the control is
// gone and the value is computed, not dropped.
const doseFor = (timeOfDay) => (Number(String(timeOfDay).slice(0, 2)) < 12 ? 'morning' : 'evening');

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

// Status is carried three ways — an icon, the word, and the card's own styling
// — so "is this one actually going to ring?" never depends on telling one
// colour from another.
const ICON_ACTIVE = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm3.7 5.9-4.2 4.8a.9.9 0 0 1-1.3.05L3.9 8.5a.9.9 0 1 1 1.2-1.3l1.6 1.5 3.6-4.1a.9.9 0 0 1 1.4 1.2Z"/></svg>';
const ICON_INACTIVE = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0ZM7 11a.9.9 0 0 1-1.8 0V5a.9.9 0 1 1 1.8 0v6Zm3.8 0a.9.9 0 0 1-1.8 0V5a.9.9 0 1 1 1.8 0v6Z"/></svg>';

// Inactive is red, not grey. Grey reads as "nothing to see here", which is the
// opposite of the truth: an inactive schedule is the one state on this screen
// that means a dose can be missed. It keeps its own icon and word alongside the
// colour, so the distinction survives greyscale and colour blindness.
const statusPill = (off) => (off
  ? `<span class="pill pill-bad">${ICON_INACTIVE} Inactive</span>`
  : `<span class="pill pill-ok">${ICON_ACTIVE} Active</span>`);

function card(schedule, timeZone) {
  const off = !schedule.enabled;

  return `<article class="card schedule ${off ? 'is-off' : ''}" data-id="${esc(schedule.id)}">
    <div class="schedule-head">
      <div class="schedule-clock">
        <strong class="schedule-time">${esc(prettyTime(schedule.timeOfDay))}</strong>
        <span class="schedule-zone">${esc(zoneAbbrev(schedule.timezone))}</span>
      </div>
      <div class="schedule-id">
        <h2 class="schedule-name">${esc(schedule.name)}</h2>
        <p class="schedule-days">${esc(describeDays(schedule.daysOfWeek))}</p>
        ${statusPill(off)}
      </div>
    </div>

    <div class="schedule-body">
      <dl class="rows">
        <div class="row"><dt>Calls</dt><dd>${esc(schedule.contact?.name || '—')} · ${esc(schedule.contact?.phone || '')}</dd></div>
        <div class="row"><dt>Says</dt><dd>${esc(schedule.message?.name || 'Default')}</dd></div>
        <div class="row"><dt>If no answer</dt><dd>${schedule.maxAttempts} attempt${schedule.maxAttempts === 1 ? '' : 's'}, ${schedule.retryDelayMinutes} min apart</dd></div>
        <div class="row"><dt>Then</dt><dd>${escalationSummary(schedule)}</dd></div>
      </dl>
    </div>

    <dl class="schedule-foot">
      <dt>Next call</dt>
      <dd>${
        off
          ? '<span class="muted">None — inactive</span>'
          : schedule.nextRunAt
            ? `${esc(formatWhen(schedule.nextRunAt, timeZone))} <span class="muted">(${esc(relative(schedule.nextRunAt))})</span>`
            : '<span class="muted">never — check the days and time</span>'
      }</dd>
    </dl>

    <div class="card-actions">
      <button class="small" data-act="edit">Edit</button>
      <button class="small" data-act="toggle">${off ? 'Enable' : 'Disable'}</button>
    </div>
  </article>`;
}

function dayPicker(selected) {
  const chosen = new Set(selected || []);
  return `<div class="days">${[0, 1, 2, 3, 4, 5, 6].map((d) => `
    <input type="checkbox" id="day-${d}" data-group="days" value="${d}" ${chosen.has(d) ? 'checked' : ''}>
    <label for="day-${d}" title="${esc(dayLongName(d))}">${esc(dayName(d))}</label>
  `).join('')}</div>`;
}

// Note for future edits: this function is one long template literal, so a
// backtick anywhere inside it — including in a comment — ends the string and
// breaks the module. Explanations go here, above it.
function form(schedule, contacts, messages) {
  const s = schedule || {
    name: '', dose: 'morning', timeOfDay: '09:20', daysOfWeek: [1, 2, 3, 4, 5, 6],
    timezone: DEFAULT_ZONE, maxAttempts: 2, retryDelayMinutes: 3, maxReprompts: 3,
    escalateWithCall: true, escalateWithSms: true, escalationAckMinutes: 3,
    contactId: contacts[0]?.id || '', messageId: '', escalationContactId: '',
  };

  const options = (list, selected, blank) =>
    (blank ? `<option value="">${esc(blank)}</option>` : '') +
    list.map((item) => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>
      ${esc(item.name)}${item.phone ? ` — ${esc(item.phone)}` : ''}
    </option>`).join('');

  // Voice Typed Messages only. Recordings are excluded by design (Phase 2), and
  // a Text Message is for sending, not speaking. Nothing filtered out can be
  // invisible: every message's card on the Messages screen carries its kind as
  // a tag, so a row that this picker declines to offer still says what it is
  // and why it lives elsewhere.
  const speakable = messages.filter((m) => m.kind === 'TTS');

  // The account's default row, not an empty value. Leaving messageId blank
  // would send the call path to its own hardcoded wording, and editing the
  // Default message would then quietly not apply to this schedule.
  const fallback = speakable.find((m) => m.isDefault);
  const chosenMessage = s.messageId || fallback?.id || '';

  const messageOptions = (list, selected) =>
    // Only when there is no default row to fall back on — otherwise every
    // schedule points at a real, editable message.
    (list.some((m) => m.isDefault) ? '' : '<option value="">Default wording</option>') +
    list.map((item) => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>
      ${esc(item.name)}${item.isDefault ? ' (Default)' : ''}
    </option>`).join('');

  return `<form id="schedule-form" class="panel" novalidate>
    <h2 class="panel-title">${schedule ? 'Edit Event Schedule' : 'New Event Schedule'}</h2>
    <p class="sub" style="margin-bottom:1.5rem">Every field here changes when a real phone rings.</p>

    <div class="form-grid">
      <div class="field"><label for="f-name">Event Label</label>
        <input id="f-name" name="name" type="text" value="${esc(s.name)}" placeholder="Morning meds" required></div>

      <div class="field"><label for="f-contact">Primary Recipient <span class="hint">(Person to receive call or text)</span></label>
        <select id="f-contact" name="contactId" required>${options(contacts, s.contactId)}</select></div>

      <div class="field span-2"><label>Days</label>${dayPicker(s.daysOfWeek)}</div>

      <div class="field"><label for="f-zone-city">Timezone <span class="hint">— type a city</span></label>
        <input id="f-zone-city" name="timezoneCity" type="text" list="tz-cities"
               value="${esc(zoneCity(s.timezone))}" placeholder="Dallas" autocomplete="off" required>
        <input id="f-zone" name="timezone" type="hidden" value="${esc(s.timezone)}">
        <datalist id="tz-cities">
          ${TZ_CITIES.map((entry) => `<option value="${esc(cityLabel(entry))}"></option>`).join('')}
        </datalist></div>

      <div class="field"><label for="f-time">Time <span class="hint">— 24-hour, in the timezone beside it</span></label>
        <input id="f-time" name="timeOfDay" type="time" value="${esc(s.timeOfDay)}" required></div>

      <div class="field span-2"><label for="f-message">Initial Message to Primary Recipient</label>
        <select id="f-message" name="messageId">${messageOptions(speakable, chosenMessage)}</select></div>
    </div>

    <h2>If Primary Recipient doesn't answer</h2>

    <div class="form-grid">
      <div class="field"><label for="f-attempts">Total attempts <span class="hint">— including the first call before alerting Backup Contact</span></label>
        <input id="f-attempts" name="maxAttempts" type="number" min="1" max="10" value="${esc(s.maxAttempts)}"></div>

      <div class="field"><label for="f-delay">Minutes between attempts</label>
        <input id="f-delay" name="retryDelayMinutes" type="number" min="1" max="120" value="${esc(s.retryDelayMinutes)}"></div>
    </div>

    <h2>Backup Contact List</h2>

    <div class="field"><label for="f-escalation">Backup Contact</label>
      <select id="f-escalation" name="escalationContactId">${options(contacts, s.escalationContactId, '— none —')}</select></div>

    <div class="checkline">
      <input id="f-call" name="escalateWithCall" type="checkbox" ${s.escalateWithCall ? 'checked' : ''}>
      <label for="f-call">Call them (they press 1 to acknowledge)</label>
    </div>
    <div class="checkline">
      <input id="f-sms" name="escalateWithSms" type="checkbox" ${s.escalateWithSms ? 'checked' : ''}>
      <label for="f-sms">Text them</label>
    </div>

    <details class="advanced">
      <summary>Advanced</summary>
      <div class="form-grid">
        <div class="field"><label for="f-reprompts">Re-asks within one answered call</label>
          <input id="f-reprompts" name="maxReprompts" type="number" min="0" max="10" value="${esc(s.maxReprompts)}"></div>
      </div>
    </details>

    <div class="button-row">
      <button type="submit" class="primary">${schedule ? 'Save changes' : 'Create event schedule'}</button>
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
    return node(`<h1>Event Schedules</h1>
      <div class="banner banner-warn">Add a contact first — an event schedule needs someone to call.</div>`);
  }

  const anyEnabled = schedules.some((s) => s.enabled);

  const el = node(`
    <div class="page-head">
      <div>
        <h1>Event Schedules</h1>
      </div>
      <div class="button-row"><button class="primary" data-act="new">New Event</button></div>
    </div>
    ${schedules.length && !anyEnabled
      ? '<div class="banner banner-bad"><span><strong>Every event schedule is inactive.</strong> No reminder calls will be placed.</span></div>'
      : ''}
    <div id="list" class="schedule-grid">
      ${schedules.length
        ? schedules.map((s) => card(s, timeZone)).join('')
        : '<p class="empty">No event schedules yet.</p>'}
    </div>
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

    // The box shows a city; the hidden field carries the IANA zone that is
    // actually stored. Kept in step as it is typed rather than only on submit,
    // so picking a suggestion and pressing Enter cannot save a stale zone.
    const zoneCityInput = formEl.querySelector('#f-zone-city');
    const zoneInput     = formEl.querySelector('#f-zone');
    const syncZone = () => {
      const zone = zoneFromLabel(zoneCityInput.value);
      if (zone) zoneInput.value = zone;
      return zone;
    };
    zoneCityInput.addEventListener('input', syncZone);
    zoneCityInput.addEventListener('change', syncZone);

    formEl.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      if (!confirmAction(`Delete "${schedule.name}"? Calls already placed stay in the history.`)) return;
      try {
        await api.schedules.remove(schedule.id);
        toast('Event schedule deleted');
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

      // Refuse rather than guess. A city that resolves to nothing would
      // otherwise fall through to whatever zone was last in the hidden field,
      // which is how a schedule silently starts calling an hour out.
      const zone = syncZone();
      if (!zone) {
        showFieldErrors(formEl, { timezoneCity: 'Pick a city from the list' });
        toast('Check the highlighted fields', 'bad');
        return;
      }
      data.timezone = zone;
      delete data.timezoneCity;  // the label; only the zone is stored

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
        toast(schedule ? 'Event schedule saved' : 'Event schedule created');
        await refresh();
      } catch (err) {
        submit.disabled = false;
        // The API rejects the field it was sent — `timezone` — but that input is
        // hidden, so its message would attach to something nobody can see or
        // focus. Move it onto the city box the reader is actually looking at.
        const details = { ...err.details };
        if (details.timezone) {
          details.timezoneCity = details.timezone;
          delete details.timezone;
        }
        // Field-level errors land on their inputs; anything else gets a toast,
        // so a validation failure is never silent.
        if (!showFieldErrors(formEl, details)) toast(err.message, 'bad');
        else toast('Check the highlighted fields', 'bad');
      }
    });

    // The CSS reduced-motion block cannot reach a scroll asked for in script,
    // so the preference is read here too.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    formEl.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
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
        toast(turningOff ? 'Event schedule disabled' : 'Event schedule enabled');
        await refresh();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    });
  }

  return el;
}
