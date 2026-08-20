'use strict';

// The alerts about failed alerts.
//
// Every worst case in this system — a retry that could not be persisted, an
// escalation that could not be queued or sent, an alert text the carrier
// refused, a schedule configured to tell nobody — used to terminate in a
// logger.error, and the logs are read by nobody at 9:20 PM. This module gives
// those events a path to a human's phone.
//
// Channels: 'call' (default), 'sms', or 'both'. A voice call is the default on
// purpose — one of the events this reports is "SMS is not being delivered",
// and an alert that rides the broken channel arrives never. The call carries
// its TwiML inline in the API request, so it depends on neither BASE_URL nor
// any webhook — the exact things whose failure it exists to report.
//
// Recursion is designed out rather than hoped away: a failed send falls back
// to the other channel, and the failure of BOTH is logged as ADMIN ALERT LOST
// and stops there. notify() never throws and the call path never awaits it.
//
// The storm guard is in memory, keyed by event name. Honest for this
// deployment (railway.json pins one replica); a redeploy resets it, which at
// worst repeats one alert. Suppressed repeats are counted and the count rides
// on the next alert through, so "it happened 14 more times" is not lost.

const config = require('./config');
const logger = require('./logger');

function _twilioClient() {
  const twilio = require('twilio');

  if (config.twilioApiKeySid || config.twilioApiKeySecret) {
    if (!config.twilioAccountSid || !config.twilioApiKeySid || !config.twilioApiKeySecret) {
      throw new Error('Twilio API Key auth not set — check TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET in .env');
    }
    return twilio(config.twilioApiKeySid, config.twilioApiKeySecret, {
      accountSid: config.twilioAccountSid,
    });
  }

  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    throw new Error('Twilio credentials not set — check TWILIO_ACCOUNT_SID plus TWILIO_API_KEY_SID/TWILIO_API_KEY_SECRET, or legacy TWILIO_AUTH_TOKEN, in .env');
  }
  return twilio(config.twilioAccountSid, config.twilioAuthToken);
}

// ─── Storm guard ─────────────────────────────────────────────────────────────

const RECENT = new Map(); // event name → { lastSentAt, suppressed }

function _cooldownMs() {
  return config.adminAlertCooldownMinutes * 60 * 1000;
}

// For tests, and for nothing else.
function resetCooldowns() {
  RECENT.clear();
}

// ─── Delivery ────────────────────────────────────────────────────────────────

// The message body doubles as TwiML text, so it has to be XML-safe. Error
// messages routinely carry angle brackets and ampersands.
function _xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Spoken twice with a pause: the first sentence of an unexpected robocall is
// routinely missed, and there is no "press 1 to repeat" without a webhook.
function _spokenTwiml(body) {
  const safe = _xmlEscape(body);
  return `<Response><Say>${safe}</Say><Pause length="1"/><Say>${safe}</Say><Hangup/></Response>`;
}

// The two outbound edges, called through module.exports so tests can intercept
// or fail either one — the same pattern as callManager's dial seams.
async function sendAlertSms(to, body) {
  return require('./smsAlert').send(to, body);
}

async function placeAlertCall(to, twiml) {
  return _twilioClient().calls.create({ to, from: config.twilioFromNumber, twiml });
}

// Sends on the configured channel, falling back to the other on failure.
// Throws only when every channel has failed.
async function _deliver(body, event) {
  const to = config.adminAlertPhone;

  if (config.mockMode) {
    logger.call('Mock: admin alert (no Twilio request made)', { to, channel: config.adminAlertChannel, body });
    return;
  }

  const bySms  = () => module.exports.sendAlertSms(to, body);
  const byCall = () => module.exports.placeAlertCall(to, _spokenTwiml(body));

  if (config.adminAlertChannel === 'both') {
    const results = await Promise.allSettled([byCall(), bySms()]);
    const failed  = results.filter((r) => r.status === 'rejected');
    for (const r of failed) {
      logger.error('Admin alert channel failed', { event, error: r.reason.message });
    }
    if (failed.length === results.length) throw new Error('both channels failed');
    return;
  }

  const [primary, fallback, primaryName, fallbackName] =
    config.adminAlertChannel === 'sms'
      ? [bySms, byCall, 'SMS', 'call']
      : [byCall, bySms, 'call', 'SMS'];

  try {
    await primary();
  } catch (err) {
    // The recursion case: the alert channel is the thing that is broken.
    // Cross over rather than give up — if this fails too, the throw lands in
    // notify()'s catch and becomes ADMIN ALERT LOST.
    logger.error(`Admin alert ${primaryName} failed — trying ${fallbackName} instead`, {
      event, error: err.message,
    });
    await fallback();
  }
}

// ─── The one entry point the call path uses ──────────────────────────────────

// Fire-and-forget by contract: never throws, never awaited by anything that
// places calls. `event` is the all-caps failure name and doubles as the storm
// guard key; `detail` says which schedule, which recipient, and what failed.
async function notify(event, detail, now = Date.now()) {
  try {
    // Not configured. The logger.error at the call site has already fired, so
    // this is quietly nothing rather than a second warning per event.
    if (!config.adminAlertPhone) return false;

    const entry = RECENT.get(event);
    if (entry && now - entry.lastSentAt < _cooldownMs()) {
      entry.suppressed++;
      logger.info('Admin alert suppressed (cooldown)', { event, suppressed: entry.suppressed });
      return false;
    }

    const suffix = entry && entry.suppressed
      ? ` (+${entry.suppressed} more since the last alert)`
      : '';
    RECENT.set(event, { lastSentAt: now, suppressed: 0 });

    const body = `MEDREMINDER ${event}: ${detail}${suffix}`;
    await _deliver(body, event);
    logger.info('Admin alerted', { event, channel: config.adminAlertChannel });
    return true;
  } catch (err) {
    // Deliberately no retry, no queue and no recursion: this is the floor.
    // One unmistakable line, and the storm-guard entry stands so the next
    // occurrence after the cooldown tries again.
    logger.error('ADMIN ALERT LOST — could not reach the admin on any channel', {
      event, error: err.message,
    });
    return false;
  }
}

// ─── Daily heartbeat ─────────────────────────────────────────────────────────

// One message a day saying the system is alive and what it did, so silence
// stops being ambiguous: after this exists, "no news" plus "no heartbeat"
// means the system is down, not idle.

function _plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function _summarize(rows) {
  if (!rows.length) return 'no calls';

  const count = (pred) => rows.filter(pred).reduce((n, r) => n + r.count, 0);

  const reminders = count((r) => r.kind === 'REMINDER_CALL');
  const confirmed = count((r) => r.kind === 'REMINDER_CALL' && r.outcome === 'CONFIRMED');
  const open      = count((r) => r.kind === 'REMINDER_CALL' && r.outcome === 'PENDING');
  const missed    = reminders - confirmed - open;
  const escalations = count((r) => r.kind !== 'REMINDER_CALL');
  const escFailed   = count((r) => r.kind === 'ESCALATION_SMS' && r.outcome === 'FAILED');

  let text = `${_plural(reminders, 'reminder call')}, ${confirmed} confirmed`;
  if (missed > 0) text += `, ${missed} not confirmed`;
  if (open > 0)   text += `, ${open} still open`;
  if (escalations) {
    text += `; ${_plural(escalations, 'escalation step')}`;
    if (escFailed) text += ` (${escFailed} NOT delivered)`;
  }
  return text;
}

async function heartbeat(now = new Date()) {
  if (!config.adminAlertPhone) return false;

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // A heartbeat that dies because the database is down would go silent at the
  // exact moment silence is most ambiguous. Report the failure instead.
  let summary;
  try {
    const repo = require('./data/callHistory');
    summary = _summarize(await repo.summarizeSince(since));
  } catch (err) {
    summary = `could not read the day's history (${err.message})`;
  }

  const body = `MEDREMINDER heartbeat — system alive. Last 24h: ${summary}.`;

  try {
    await _deliver(body, 'HEARTBEAT');
    logger.info('Heartbeat sent', { channel: config.adminAlertChannel });
    return true;
  } catch (err) {
    logger.error('ADMIN ALERT LOST — the daily heartbeat could not be delivered', { error: err.message });
    return false;
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let _task = null;

function start() {
  if (!config.adminAlertPhone) {
    logger.warn('ADMIN_ALERT_PHONE is not set — system failures will be visible only in the logs');
    return;
  }

  logger.info('Admin alerts on', {
    channel:         config.adminAlertChannel,
    cooldownMinutes: config.adminAlertCooldownMinutes,
    heartbeatHour:   config.adminHeartbeatHour === null ? 'off' : config.adminHeartbeatHour,
    timezone:        config.timezone,
  });

  if (config.adminHeartbeatHour === null) return;

  const cron = require('node-cron');
  _task = cron.schedule(`0 ${config.adminHeartbeatHour} * * *`, () => {
    heartbeat().catch((err) => logger.error('Heartbeat threw', { error: err.message }));
  }, { timezone: config.timezone });
}

function stop() {
  if (!_task) return;
  try {
    _task.stop();
  } catch (err) {
    logger.warn('Failed to stop heartbeat', { error: err.message });
  }
  _task = null;
}

module.exports = {
  notify, heartbeat, start, stop,
  sendAlertSms, placeAlertCall,
  resetCooldowns, _summarize,
};
