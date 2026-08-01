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
    const next     = attempt + 1;
    const delaySec = settings.retryDelayMs / 1000;
    logger.call('Retry scheduled', { dose, nextAttempt: next, delaySeconds: delaySec });

    // Still an in-memory timer at this stage — Stage 3 replaces it with the
    // database-backed sweeper, which is what makes a retry survive a restart.
    setTimeout(async () => {
      try {
        await initiateCall(dose, next, { schedule });
      } catch (err) {
        logger.error('Retry call failed', { error: err.message, dose, attempt: next });
        if (next >= settings.maxAttempts) {
          await _escalate(dose, 'call failure on final retry', schedule);
        }
      }
    }, settings.retryDelayMs);
  } else {
    await _escalate(dose, `no answer after all ${settings.maxAttempts} attempts`, schedule);
  }
}

// Triggered by twimlHandler when max reprompts are exhausted inside an
// answered call.
async function handleNeverConfirmed(dose, attempt, ctx = {}) {
  const schedule = await loadScheduleContext(ctx.scheduleId);

  logger.call('Answered but never confirmed', { dose, attempt });

  await callHistoryRepo.recordOutcome(ctx.callHistoryId, 'NOT_CONFIRMED', {
    repromptCount: ctx.repromptCount,
  });

  await _escalate(dose, 'answered but never confirmed medication taken', schedule);
}

// Stage 4 generalises this into a configurable chain (fallback call, then SMS)
// driven by the schedule's escalation columns. For now it keeps today's
// behaviour, but sources the number from the schedule's escalation contact when
// there is one.
async function _escalate(dose, reason, schedule = null) {
  const smsAlert = require('./smsAlert');

  const to = (schedule && schedule.escalationContact && schedule.escalationContact.phone)
    || config.caregiverPhone;

  if (!to) {
    logger.error('Cannot escalate — no escalation contact and no CAREGIVER_PHONE_NUMBER', { dose, reason });
    return;
  }

  const timezone = (schedule && schedule.timezone) || config.timezone;
  const timeStr  = new Date().toLocaleString('en-US', { timeZone: timezone });
  const body     = `MEDICATION ALERT: Could not confirm ${dose} dose taken as of ${timeStr}. (${reason})`;

  await smsAlert.send(to, body);
}

module.exports = {
  initiateCall,
  handleNoAnswer,
  handleNeverConfirmed,
  resolveSettings,
  loadScheduleContext,
};
