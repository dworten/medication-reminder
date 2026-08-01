'use strict';

const config = require('./config');
const logger = require('./logger');

const accountRepo     = require('./data/accounts');
const scheduleRepo    = require('./data/schedules');
const callHistoryRepo = require('./data/callHistory');

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

// Per-schedule settings win; the env values remain as the fallback for calls
// with no schedule behind them (a manual /trigger) and for anything that
// arrives without context.
function resolveSettings(schedule) {
  const fallbackDelayMinutes = Math.round(config.retryDelayMs / 60000);
  return {
    maxAttempts:  schedule?.maxAttempts       ?? config.maxCallAttempts,
    maxReprompts: schedule?.maxReprompts      ?? config.maxReprompts,
    retryDelayMs: (schedule?.retryDelayMinutes ?? fallbackDelayMinutes) * 60 * 1000,
  };
}

// options:
//   to             explicit destination, overrides the schedule's contact
//   schedule       a schedule row WITH relations (contact, message, escalation)
//   callHistoryId  an existing row to attach to, for retries
//   accountId      used when there is no schedule to take it from
async function initiateCall(dose, attempt, options = {}) {
  const schedule = options.schedule || null;
  const settings = resolveSettings(schedule);

  const to = options.to
    || (schedule && schedule.contact && schedule.contact.phone)
    || config.grandmaPhone;

  // Open the history row before dialling, so a call that throws still leaves a
  // trace. Failure here is logged and ignored: bookkeeping must never be the
  // reason a medication reminder does not go out.
  let callHistoryId = options.callHistoryId || null;
  if (!callHistoryId) {
    const accountId = options.accountId
      || (schedule && schedule.accountId)
      || await _defaultAccountId();

    if (accountId) {
      const row = await callHistoryRepo.startAttempt({
        accountId,
        scheduleId: schedule ? schedule.id : null,
        contactId:  schedule && schedule.contact ? schedule.contact.id : null,
        dose,
        attempt,
      });
      callHistoryId = row ? row.id : null;
    } else {
      logger.warn('No account found — call will be placed but not recorded', { dose, attempt });
    }
  }

  if (config.mockMode) {
    const mock = require('./mockMode');
    return mock.runMockCall(dose, attempt, { settings, to });
  }

  return _realCall(dose, attempt, { to, schedule, callHistoryId, settings });
}

async function _defaultAccountId() {
  try {
    const account = await accountRepo.getDefault();
    return account ? account.id : null;
  } catch (err) {
    logger.error('Could not load default account', { error: err.message });
    return null;
  }
}

// Webhook URLs carry dose and attempt exactly as they always have. Everything
// else is appended and optional, so a call placed before a deploy still
// completes correctly against the new code, and every handler falls back to the
// env defaults when a parameter is absent.
//
// maxReprompts rides along in the URL rather than being looked up per webhook:
// /webhook/response is inside a live call with the caller waiting, and a
// database round trip there would be both slow and one more thing that can
// fail mid-call.
function _webhookUrls({ dose, attempt, schedule, callHistoryId, settings }) {
  const params = new URLSearchParams();
  params.set('dose', dose);
  params.set('attempt', String(attempt));
  if (schedule)      params.set('sched', schedule.id);
  if (callHistoryId) params.set('ch', callHistoryId);
  params.set('mr', String(settings.maxReprompts));

  const qs = params.toString();
  return {
    callUrl:   `${config.baseUrl}/webhook/initial?${qs}`,
    statusUrl: `${config.baseUrl}/webhook/status?${qs}`,
  };
}

async function _realCall(dose, attempt, ctx) {
  const { to, callHistoryId } = ctx;

  if (!to) {
    await callHistoryRepo.recordOutcome(callHistoryId, 'FAILED', {
      errorMessage: 'no destination phone number',
    });
    throw new Error('No destination phone number set — check the schedule\'s contact, or GRANDMA_PHONE_NUMBER / TEST_PHONE_NUMBER in .env');
  }

  const client = _twilioClient();
  const { callUrl, statusUrl } = _webhookUrls({ dose, attempt, ...ctx });

  logger.call('Placing call', { dose, attempt, to, scheduleId: ctx.schedule?.id, callHistoryId });

  try {
    const call = await client.calls.create({
      to,
      from:                 config.twilioFromNumber,
      url:                  callUrl,
      statusCallback:       statusUrl,
      statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });

    logger.call('Call placed', { sid: call.sid, dose, attempt });
    await callHistoryRepo.attachCallSid(callHistoryId, call.sid);
    return call.sid;
  } catch (err) {
    await callHistoryRepo.recordOutcome(callHistoryId, 'FAILED', { errorMessage: err.message });
    throw err;
  }
}

// Loads the schedule behind an in-flight call. Returns null when the call has
// no schedule (a manual trigger) or the database is unavailable — callers fall
// back to the env settings rather than failing the call.
async function loadScheduleContext(scheduleId) {
  if (!scheduleId) return null;
  try {
    return await scheduleRepo.getById(scheduleId);
  } catch (err) {
    logger.error('Could not load schedule for in-flight call', { scheduleId, error: err.message });
    return null;
  }
}

// Triggered by Twilio status callback when a call goes unanswered.
// ctx carries { scheduleId, callHistoryId } parsed from the webhook URL.
async function handleNoAnswer(dose, attempt, ctx = {}) {
  const schedule = await loadScheduleContext(ctx.scheduleId);
  const settings = resolveSettings(schedule);

  logger.call('No answer / failed', { dose, attempt, maxAttempts: settings.maxAttempts });

  await callHistoryRepo.recordOutcome(ctx.callHistoryId, ctx.outcome || 'NO_ANSWER');

  if (attempt < settings.maxAttempts) {
    const next  = attempt + 1;
    const dueAt = new Date(Date.now() + settings.retryDelayMs);

    // Persisted, not a setTimeout. The old in-memory timer lived only in this
    // process, so a Railway deploy inside the retry window dropped the retry
    // and the missed-dose SMS that should have followed — silently. Writing
    // next_retry_at means a restart costs a minute of delay, not the dose.
    const persisted = await _persistRetry(ctx.callHistoryId, dueAt, { dose, nextAttempt: next });

    if (persisted) {
      logger.call('Retry persisted', {
        dose, nextAttempt: next, dueAt: dueAt.toISOString(), callHistoryId: ctx.callHistoryId,
      });
    } else {
      // Deliberately no in-memory fallback: reintroducing a timer here would
      // bring back the very failure this replaced, and worse, could double-call
      // if the write actually landed. Escalate instead — a caregiver alert is
      // strictly better than a retry nobody knows was lost.
      logger.error('RETRY LOST — could not persist next_retry_at; escalating instead', {
        dose, nextAttempt: next, callHistoryId: ctx.callHistoryId,
      });
      await escalate(dose, 'retry could not be scheduled (database unavailable)', schedule, ctx);
    }
  } else {
    await escalate(dose, `no answer after all ${settings.maxAttempts} attempts`, schedule, ctx);
  }
}

// The sweeper depends on this write, so it gets more than one shot at it before
// we conclude the retry is unrecoverable.
async function _persistRetry(callHistoryId, dueAt, meta, tries = 3) {
  if (!callHistoryId) {
    logger.error('No call_history row to attach a retry to — the database was unreachable when this call was placed', meta);
    return false;
  }

  for (let i = 1; i <= tries; i++) {
    try {
      await callHistoryRepo.scheduleRetry(callHistoryId, dueAt);
      return true;
    } catch (err) {
      logger.error(`Could not persist retry (attempt ${i}/${tries})`, { error: err.message, ...meta });
      if (i < tries) await new Promise(r => setTimeout(r, 300 * i));
    }
  }
  return false;
}

// Triggered by twimlHandler when max reprompts are exhausted inside an
// answered call.
async function handleNeverConfirmed(dose, attempt, ctx = {}) {
  const schedule = await loadScheduleContext(ctx.scheduleId);

  logger.call('Answered but never confirmed', { dose, attempt });

  await callHistoryRepo.recordOutcome(ctx.callHistoryId, 'NOT_CONFIRMED', {
    repromptCount: ctx.repromptCount,
  });

  await escalate(dose, 'answered but never confirmed medication taken', schedule, ctx);
}

// Queues an escalation rather than sending it inline.
//
// Sending inline meant a crash between "attempts exhausted" and "SMS sent" lost
// the alert with nothing to recover it. Writing the row first makes the alert
// durable; the sweeper is then kicked immediately, so in the normal case it
// still goes out within a second rather than waiting for the next tick.
//
// Stage 4 turns this into a configurable chain (fallback call, then SMS) driven
// by the schedule's escalation columns. The queue mechanism is already the
// right shape for it: each step becomes its own row.
async function escalate(dose, reason, schedule = null, ctx = {}) {
  const accountId = (schedule && schedule.accountId) || await _defaultAccountId();

  if (!accountId) {
    logger.error('Cannot queue escalation — no account; sending inline as a last resort', { dose, reason });
    return _sendEscalationInline(dose, reason, schedule);
  }

  try {
    const row = await callHistoryRepo.enqueueEscalation({
      accountId,
      scheduleId: schedule ? schedule.id : (ctx.scheduleId || null),
      contactId:  schedule && schedule.escalationContact ? schedule.escalationContact.id : null,
      dose,
      kind:   'ESCALATION_SMS',
      reason,
      dueAt:  new Date(),
    });

    logger.call('Escalation queued', { callHistoryId: row.id, dose, reason });

    // Kick the sweeper so the alert does not wait out the tick interval.
    // Fire-and-forget: if this fails the next tick picks the row up anyway,
    // which is the entire point of queueing it first.
    setImmediate(() => {
      require('./retrySweeper').runOnce().catch(err =>
        logger.error('Immediate escalation sweep failed (the next tick will retry)', { error: err.message })
      );
    });
  } catch (err) {
    logger.error('Could not queue escalation, sending inline instead', { error: err.message, dose, reason });

    // Last line of defence. If this fails too the alert is genuinely gone, and
    // that deserves its own unmistakable log line rather than surfacing as a
    // generic handler error three frames up — this is the case where a missed
    // dose goes unnoticed by anyone.
    try {
      await _sendEscalationInline(dose, reason, schedule);
    } catch (sendErr) {
      logger.error('ESCALATION LOST — could not queue it and could not send it', {
        dose,
        reason,
        queueError: err.message,
        sendError:  sendErr.message,
      });
    }
  }
}

function _escalationBody(dose, reason, timezone) {
  const timeStr = new Date().toLocaleString('en-US', { timeZone: timezone || config.timezone });
  return `MEDICATION ALERT: Could not confirm ${dose} dose taken as of ${timeStr}. (${reason})`;
}

// Last resort when the row could not be written at all. Not durable — but an
// alert attempted is better than no alert.
async function _sendEscalationInline(dose, reason, schedule) {
  const smsAlert = require('./smsAlert');

  const to = (schedule && schedule.escalationContact && schedule.escalationContact.phone)
    || config.caregiverPhone;

  if (!to) {
    logger.error('Cannot escalate — no escalation contact and no CAREGIVER_PHONE_NUMBER', { dose, reason });
    return;
  }

  await smsAlert.send(to, _escalationBody(dose, reason, schedule && schedule.timezone));
}

// Called by the sweeper for a queued escalation row. Throwing here is
// meaningful: the sweeper releases the claim and tries again next minute.
async function deliverEscalation(row) {
  const smsAlert = require('./smsAlert');
  const schedule = row.schedule || null;

  const to = (row.contact && row.contact.phone)
    || (schedule && schedule.escalationContact && schedule.escalationContact.phone)
    || config.caregiverPhone;

  if (!to) {
    // Unfixable by retrying — record it and let the sweeper close the item out
    // rather than looping on it forever.
    await callHistoryRepo.recordOutcome(row.id, 'FAILED', {
      errorMessage: `${row.errorMessage} | no escalation destination configured`,
    });
    logger.error('Escalation has nowhere to go — set an escalation contact or CAREGIVER_PHONE_NUMBER', {
      callHistoryId: row.id, dose: row.dose,
    });
    return;
  }

  const body = _escalationBody(row.dose, row.errorMessage || 'unconfirmed dose', schedule && schedule.timezone);
  const sid  = await smsAlert.send(to, body);

  await callHistoryRepo.recordOutcome(row.id, 'SENT');
  if (sid) await callHistoryRepo.attachCallSid(row.id, sid);

  logger.call('Escalation delivered', { callHistoryId: row.id, to, dose: row.dose });
}

module.exports = {
  initiateCall,
  handleNoAnswer,
  handleNeverConfirmed,
  escalate,
  deliverEscalation,
  resolveSettings,
  loadScheduleContext,
};
