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
export function zoneAbbrev(timeZone, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value || timeZone;
  } catch {
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

// How each call_history outcome should read and colour. CONFIRMED and SENT are
// the only two that mean the system did its job.
const OUTCOMES = {
  CONFIRMED:     { label: 'Confirmed',      kind: 'ok'   },
  SENT:          { label: 'Alert sent',     kind: 'ok'   },
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

const KINDS = {
  REMINDER_CALL:   'Call',
  ESCALATION_CALL: 'Caregiver call',
  ESCALATION_SMS:  'Caregiver text',
};
export const kindLabel = (kind) => KINDS[kind] || kind;

// ── Forms ──────────────────────────────────────────────────────────────────

// Paints the API's per-field errors onto the form that produced them, so the
// message appears under the input it is about. Returns whether anything matched
// — if not, the caller falls back to a banner rather than failing silently.
export function showFieldErrors(form, details) {
  clearFieldErrors(form);
  if (!details || typeof details !== 'object') return false;

  let shown = false;
  for (const [name, message] of Object.entries(details)) {
    const input = form.elements[name];
    if (!input) continue;

    const wrapper = input.closest('.field') || input.parentElement;
    wrapper.classList.add('invalid');

    const note = document.createElement('p');
    note.className = 'field-error';
    note.textContent = typeof message === 'string' ? message : JSON.stringify(message);
    input.insertAdjacentElement('afterend', note);
    shown = true;
  }
  return shown;
}

export function clearFieldErrors(form) {
  $$('.field-error', form).forEach((el) => el.remove());
  $$('.invalid', form).forEach((el) => el.classList.remove('invalid'));
}

// Reads a form into a plain object. Checkboxes become booleans, number inputs
// become numbers, and blank optional text becomes null so the API clears the
// field rather than storing an empty string.
export function readForm(form, { numbers = [], booleans = [], nullable = [] } = {}) {
  const data = {};

  for (const element of form.elements) {
    if (!element.name || element.disabled) continue;
    if (element.type === 'checkbox' && element.dataset.group) continue;

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
