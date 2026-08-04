'use strict';

// Server-side input validation.
//
// These rules deliberately mirror the database's CHECK constraints and the
// call path's expectations. The database is still the last word — it has to be,
// since the seed and Prisma Studio write to it directly — but a constraint
// violation is a 500-shaped event, and "daysOfWeek must contain between 1 and 7
// unique days" is what the caller actually needs to read.
//
// Every function collects ALL the problems with a payload before throwing, so a
// form gets one round trip instead of one per bad field.

const { badRequest } = require('./errors');

// E.164: a plus, a non-zero country digit, then 7 to 14 more. Twilio rejects
// anything else outright, so a number that fails here is a call that would
// never have connected.
const E164 = /^\+[1-9]\d{7,14}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const CONTACT_ROLES = new Set(['RECIPIENT', 'CAREGIVER', 'BOTH']);
const MESSAGE_KINDS = new Set(['TTS', 'AUDIO']);
// The call path keys off this string: it travels in the webhook query string and
// picks the goodbye line in twimlHandler. A third value would flow all the way
// to a live call before anything noticed.
const DOSES = new Set(['morning', 'evening']);

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    // Throws RangeError on anything the ICU database does not know. A plain
    // string check would happily accept "US/Central-ish" and fail at 9:20.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// How a validator reports a problem.
//
// It cannot be "returns a string": most of these fields ARE strings, so a
// successful phone number and an error message would be indistinguishable — and
// every valid string would be read as a rejection. A wrapper type makes the two
// impossible to confuse.
class Invalid {
  constructor(message) { this.message = message; }
}

const invalid = (message) => new Invalid(message);

// Collects field errors, then throws once.
class Check {
  constructor(body, { partial = false } = {}) {
    this.body    = body || {};
    this.partial = partial;
    this.errors  = {};
    this.data    = {};
  }

  // present() distinguishes "not supplied" from "supplied as null/empty", which
  // is the whole difference between PATCH and PUT semantics.
  present(field) {
    return Object.prototype.hasOwnProperty.call(this.body, field);
  }

  field(name, { required = false, optional = false } = {}, validator) {
    if (!this.present(name)) {
      // On a partial update an absent field means "leave it alone".
      if (required && !this.partial) this.errors[name] = 'is required';
      return this;
    }

    const raw = this.body[name];

    if (raw === null || raw === undefined || raw === '') {
      if (optional) { this.data[name] = null; return this; }
      this.errors[name] = 'is required';
      return this;
    }

    const result = validator(raw);
    if (result instanceof Invalid) this.errors[name] = result.message;
    else this.data[name] = result;

    return this;
  }

  done() {
    if (Object.keys(this.errors).length) {
      throw badRequest('Validation failed', this.errors);
    }
    return this.data;
  }
}

// ─── Shared field validators ─────────────────────────────────────────────────

const str = (max, label = 'must be a string') => (v) => {
  if (typeof v !== 'string') return invalid(label);
  const trimmed = v.trim();
  if (!trimmed) return invalid('must not be blank');
  if (trimmed.length > max) return invalid(`must be ${max} characters or fewer`);
  return trimmed;
};

const phone = (v) => {
  if (typeof v !== 'string') return invalid('must be a string');
  const trimmed = v.trim();
  if (!E164.test(trimmed)) {
    return invalid('must be E.164 format — a plus, country code and number, e.g. +15125550123');
  }
  return trimmed;
};

const bool = (v) => (typeof v === 'boolean' ? v : invalid('must be true or false'));

const intIn = (min, max) => (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) return invalid('must be a whole number');
  if (n < min || n > max) return invalid(`must be between ${min} and ${max}`);
  return n;
};

const oneOf = (allowed, label) => (v) =>
  (allowed.has(v) ? v : invalid(`must be one of: ${[...allowed].join(', ')} (${label})`));

const timeOfDay = (v) => {
  if (typeof v !== 'string' || !HHMM.test(v.trim())) {
    return invalid('must be a 24-hour time, HH:MM — e.g. 09:20 or 21:20');
  }
  return v.trim();
};

const timezone = (v) =>
  (isValidTimezone(v) ? v.trim() : invalid('must be an IANA timezone name, e.g. America/Chicago'));

// Mirrors the schedules_days_of_week_check constraint exactly: 1 to 7 entries,
// each 0–6, no duplicates. An empty array is the case that constraint was added
// for — a schedule that looks enabled and can never match a day.
const daysOfWeek = (v) => {
  if (!Array.isArray(v)) return invalid('must be an array of day numbers, 0 (Sunday) to 6 (Saturday)');
  if (v.length < 1 || v.length > 7) return invalid('must contain between 1 and 7 days');

  const days = [];
  for (const entry of v) {
    const n = typeof entry === 'number' ? entry : Number(entry);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      return invalid('each day must be a whole number 0 (Sunday) to 6 (Saturday)');
    }
    if (days.includes(n)) return invalid('must not repeat a day');
    days.push(n);
  }
  return days.sort((a, b) => a - b);
};

const httpsUrl = (v) => {
  if (typeof v !== 'string') return invalid('must be a string');
  let parsed;
  try { parsed = new URL(v.trim()); } catch { return invalid('must be a valid URL'); }
  // Twilio will not fetch audio over plain http from a public URL.
  if (parsed.protocol !== 'https:') return invalid('must be an https URL');
  return parsed.toString();
};

// ─── Resource validators ─────────────────────────────────────────────────────

function contactInput(body, opts) {
  return new Check(body, opts)
    .field('name',  { required: true }, str(120))
    .field('phone', { required: true }, phone)
    .field('notes', { optional: true }, str(1000))
    .field('role',  {}, oneOf(CONTACT_ROLES, 'role'))
    .field('isActive', {}, bool)
    .done();
}

// A message must be usable by the call path: TTS with nothing to say, or AUDIO
// with nothing to play, is a row that silently falls back to the built-in
// prompt. Rejecting it here is the difference between a caught mistake and a
// custom message that never plays.
function messageInput(body, opts = {}) {
  const data = new Check(body, opts)
    .field('name',     { required: true }, str(120))
    .field('kind',     {}, oneOf(MESSAGE_KINDS, 'kind'))
    .field('ttsText',  { optional: true }, str(1500))
    .field('audioUrl', { optional: true }, httpsUrl)
    .field('voice',    { optional: true }, str(60))
    .field('language', { optional: true }, str(20))
    .field('isDefault', {}, bool)
    .done();

  const kind = data.kind || (opts.existing && opts.existing.kind) || 'TTS';
  const tts   = data.ttsText  !== undefined ? data.ttsText  : opts.existing && opts.existing.ttsText;
  const audio = data.audioUrl !== undefined ? data.audioUrl : opts.existing && opts.existing.audioUrl;

  if (kind === 'TTS'   && !tts)   throw badRequest('Validation failed', { ttsText:  'is required when kind is TTS' });
  if (kind === 'AUDIO' && !audio) throw badRequest('Validation failed', { audioUrl: 'is required when kind is AUDIO' });

  return data;
}

function scheduleInput(body, opts) {
  return new Check(body, opts)
    .field('name',       { required: true }, str(120))
    .field('dose',       { required: true }, oneOf(DOSES, 'dose'))
    .field('timeOfDay',  { required: true }, timeOfDay)
    .field('daysOfWeek', { required: true }, daysOfWeek)
    .field('timezone',   {}, timezone)
    .field('contactId',  { required: true }, str(64))
    .field('messageId',  { optional: true }, str(64))
    .field('enabled',    {}, bool)
    // Escalation. The ack window's bounds match its CHECK constraint: below 1
    // the follow-up SMS would be due the instant the call is placed, so
    // acknowledging could never suppress it.
    .field('maxAttempts',          {}, intIn(1, 10))
    .field('retryDelayMinutes',    {}, intIn(1, 120))
    .field('maxReprompts',         {}, intIn(0, 10))
    .field('escalationContactId',  { optional: true }, str(64))
    .field('escalateWithCall',     {}, bool)
    .field('escalateWithSms',      {}, bool)
    .field('escalationAckMinutes', {}, intIn(1, 60))
    .done();
}

// Query parameters arrive as strings, so these parse as well as check.
function callHistoryQuery(query = {}) {
  const errors = {};
  const out    = { limit: 50, offset: 0 };

  if (query.limit !== undefined) {
    const n = Number(query.limit);
    // Capped so a caller cannot ask for the entire table in one request.
    if (!Number.isInteger(n) || n < 1 || n > 200) errors.limit = 'must be a whole number between 1 and 200';
    else out.limit = n;
  }

  if (query.offset !== undefined) {
    const n = Number(query.offset);
    if (!Number.isInteger(n) || n < 0) errors.offset = 'must be a whole number, 0 or more';
    else out.offset = n;
  }

  for (const key of ['from', 'to']) {
    if (query[key] === undefined || query[key] === '') continue;
    const d = new Date(query[key]);
    if (Number.isNaN(d.getTime())) errors[key] = 'must be a date, e.g. 2026-08-01 or 2026-08-01T09:20:00Z';
    else out[key] = d;
  }

  if (out.from && out.to && out.from > out.to) {
    errors.from = 'must be on or before "to"';
  }

  if (query.contactId) out.contactId = String(query.contactId);
  if (query.dose) {
    if (!DOSES.has(query.dose)) errors.dose = `must be one of: ${[...DOSES].join(', ')}`;
    else out.dose = query.dose;
  }

  if (Object.keys(errors).length) throw badRequest('Validation failed', errors);
  return out;
}

module.exports = {
  contactInput, messageInput, scheduleInput, callHistoryQuery,
  isValidTimezone, E164, HHMM,
};
