// Small DOM and formatting helpers shared by the screens.

// Every screen builds markup from template literals, so anything originating
// from the database — a contact's name, a message body, an error from Twilio —
// goes through this first. Without it a contact called
// `<img onerror=...>` would execute.
export const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export const $  = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Builds a detached element from markup. Screens return one of these; the shell
// swaps it in, so a half-built screen is never on screen.
export function node(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

// ── Feedback ───────────────────────────────────────────────────────────────

let toastTimer = null;

export function toast(message, kind) {
  const el = $('#toast');
  el.textContent = message;
  el.className = kind === 'bad' ? 'show bad' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'bad' ? 6000 : 3000);
}

// ── Dates and times ────────────────────────────────────────────────────────

const DAY_NAMES  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const dayName     = (n) => DAY_NAMES[n] ?? '?';
export const dayLongName = (n) => DAY_LONG[n] ?? '?';

// "Mon–Sat", "Every day", "Sun & Wed" — a run of consecutive days reads better
// collapsed, and the Mon–Sat pattern is the one actually in use here.
export function describeDays(days) {
  const sorted = [...(days || [])].sort((a, b) => a - b);
  if (sorted.length === 0) return 'never';
  if (sorted.length === 7) return 'Every day';

  const runs = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && day === last[last.length - 1] + 1) last.push(day);
    else runs.push([day]);
  }

  return runs
    .map((run) => (run.length >= 3 ? `${dayName(run[0])}–${dayName(run[run.length - 1])}` : run.map(dayName).join(', ')))
    .join(', ');
}

// "09:20" → "9:20 AM". The stored value is 24-hour; this is display only.
export function prettyTime(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!match) return hhmm || '—';
  const hour = Number(match[1]);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${match[2]} ${suffix}`;
}

// The short zone name — "CDT" — so a bare "9:20 AM" is never ambiguous about
// which clock it refers to.
// Rendered as an offset ("-5 GMT") rather than an abbreviation ("CDT").
//
// The offset is computed at render time from the zone, not stored, so a
// America/Chicago card reads "-5 GMT" through the summer and "-6 GMT" from
// November without anything being edited. That is the reason not to keep a
// literal string here: the number is only correct for half the year.
//
// Intl hands back "GMT-5", so the sign is moved to the front. The zero offset
// arrives as a bare "GMT" with no number at all, which would read as a
// different kind of value sitting beside cards that all carry a sign — so UTC
// is spelled "+0 GMT" rather than left alone.
export function zoneAbbrev(timeZone, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (!name) return timeZone;
    const offset = name === 'GMT' ? '+0' : name.replace('GMT', '');
    return `${offset} GMT`;
  } catch {
    // Also the landing spot for engines without 'shortOffset', which throw a
    // RangeError rather than degrading. The zone name is worse than an offset
    // but is never wrong.
    return timeZone;
  }
}

// Timestamps are rendered in the account's timezone rather than the browser's:
// "did she take her morning pills" is a question about her clock, and reading
// this from another timezone should not silently shift every time by hours.
export function formatWhen(value, timeZone, { withDate = true } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      ...(withDate && { month: 'short', day: 'numeric' }),
      hour: 'numeric', minute: '2-digit',
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

// "in 3 hours", "12 minutes ago". Used where the exact instant matters less
// than how far away it is.
export function relative(value) {
  if (!value) return '';
  const ms = new Date(value).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';

  const fmt   = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const mins  = Math.round(ms / 60000);
  const hours = Math.round(ms / 3600000);
  const days  = Math.round(ms / 86400000);

  if (Math.abs(mins)  < 60) return fmt.format(mins, 'minute');
  if (Math.abs(hours) < 24) return fmt.format(hours, 'hour');
  return fmt.format(days, 'day');
}

// ── Outcomes ───────────────────────────────────────────────────────────────

// How each call_history outcome should read and colour.
//
// SENT used to read "Alert sent" in green, and it was the most misleading thing
// on this screen: it means Twilio accepted the message, which is not the same as
// anyone receiving it. Eleven alerts showed that green tick while the carrier
// was rejecting every one of them.
//
// So SENT is now amber and says so — it is a message in flight, not a job done.
// DELIVERED is the green one, because a carrier receipt is the only evidence
// that a caregiver's phone actually buzzed.
const OUTCOMES = {
  CONFIRMED:     { label: 'Confirmed',      kind: 'ok'   },
  DELIVERED:     { label: 'Alert delivered', kind: 'ok'  },
  SENT:          { label: 'Alert sending',  kind: 'warn' },
  PENDING:       { label: 'In progress',    kind: 'warn' },
  NOT_CONFIRMED: { label: 'Not confirmed',  kind: 'bad'  },
  NO_ANSWER:     { label: 'No answer',      kind: 'bad'  },
  BUSY:          { label: 'Busy',           kind: 'bad'  },
  FAILED:        { label: 'Failed',         kind: 'bad'  },
  CANCELED:      { label: 'Cancelled',      kind: 'off'  },
};

export const outcomeLabel = (outcome) => OUTCOMES[outcome]?.label || outcome || 'Unknown';
export const outcomeKind  = (outcome) => OUTCOMES[outcome]?.kind  || 'off';

export const badge = (text, kind) => `<span class="badge badge-${kind}">${esc(text)}</span>`;

// An outcome badge carries three independent signals: a shape (the icon), a
// word, and a colour. "Confirmed" and "No answer" are still told apart with the
// colour turned off, printed in greyscale, or by someone who cannot see the
// difference between the green and the red.
const OUTCOME_ICON = {
  ok:   '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm3.7 5.9-4.2 4.8a.9.9 0 0 1-1.3.05L3.9 8.5a.9.9 0 1 1 1.2-1.3l1.6 1.5 3.6-4.1a.9.9 0 0 1 1.4 1.2Z"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm.9 7.6 2.4 1.4a.9.9 0 1 1-.9 1.6L7.6 9a.9.9 0 0 1-.5-.8V4a.9.9 0 1 1 1.8 0v3.6Z"/></svg>',
  bad:  '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm3 9.7a.9.9 0 1 1-1.3 1.3L8 9.3l-1.7 1.7A.9.9 0 0 1 5 9.7L6.7 8 5 6.3A.9.9 0 0 1 6.3 5L8 6.7 9.7 5A.9.9 0 0 1 11 6.3L9.3 8 11 9.7Z"/></svg>',
  off:  '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm3.1 8.9H4.9a.9.9 0 1 1 0-1.8h6.2a.9.9 0 1 1 0 1.8Z"/></svg>',
};

export function outcomeBadge(outcome) {
  const kind = outcomeKind(outcome);
  return `<span class="badge badge-${kind}">${OUTCOME_ICON[kind] || ''}${esc(outcomeLabel(outcome))}</span>`;
}

const KINDS = {
  REMINDER_CALL:   'Call',
  ESCALATION_CALL: 'Backup Contact call',
  ESCALATION_SMS:  'Backup Contact text',
};
export const kindLabel = (kind) => KINDS[kind] || kind;

// ── Forms ──────────────────────────────────────────────────────────────────

// Paints the API's per-field errors onto the form that produced them, so the
// message appears under the input it is about. Returns whether anything matched
// — if not, the caller falls back to a banner rather than failing silently.
export function showFieldErrors(form, details) {
  clearFieldErrors(form);
  if (!details || typeof details !== 'object') return false;

  let first = null;
  for (const [name, message] of Object.entries(details)) {
    const input = form.elements[name];
    if (!input) continue;

    const wrapper = input.closest('.field') || input.parentElement;
    wrapper.classList.add('invalid');

    const note = document.createElement('p');
    note.className = 'field-error';
    note.textContent = typeof message === 'string' ? message : JSON.stringify(message);

    // Tie the message to the input it is about, so a screen reader reads the
    // reason on landing in the field rather than announcing a bare "invalid".
    const id = `err-${input.id || name}`;
    note.id = id;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', id);

    input.insertAdjacentElement('afterend', note);
    if (!first) first = input;
  }

  // Land on the first problem instead of leaving it somewhere below the fold.
  first?.focus({ preventScroll: false });
  return Boolean(first);
}

export function clearFieldErrors(form) {
  $$('.field-error', form).forEach((el) => el.remove());
  $$('.invalid', form).forEach((el) => el.classList.remove('invalid'));
  $$('[aria-invalid]', form).forEach((el) => {
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
  });
}

// Reads a form into a plain object. Checkboxes become booleans, number inputs
// become numbers, and blank optional text becomes null so the API clears the
// field rather than storing an empty string.
export function readForm(form, { numbers = [], booleans = [], nullable = [] } = {}) {
  const data = {};

  for (const element of form.elements) {
    if (!element.name || element.disabled) continue;
    if (element.type === 'checkbox' && element.dataset.group) continue;

    // A radio group is several elements sharing one name, and only the checked
    // one means anything. Without this the loop keeps overwriting until the LAST
    // radio wins — which silently returns the wrong answer rather than failing,
    // and reads as if the control were simply being ignored.
    if (element.type === 'radio') {
      if (element.checked) data[element.name] = element.value;
      continue;
    }

    if (element.type === 'checkbox') { data[element.name] = element.checked; continue; }

    const value = element.value.trim();
    if (numbers.includes(element.name))  { data[element.name] = value === '' ? null : Number(value); continue; }
    if (booleans.includes(element.name)) { data[element.name] = value === 'true'; continue; }
    data[element.name] = value === '' && nullable.includes(element.name) ? null : value;
  }

  return data;
}

// Guards anything that cannot be undone. Deliberately native confirm(): a
// hand-built modal here would be more code and less trustworthy than the one
// the browser already ships.
export const confirmAction = (message) => window.confirm(message);
