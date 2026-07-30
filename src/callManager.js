'use strict';

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

async function initiateCall(dose, attempt, options = {}) {
  if (config.mockMode) {
    const mock = require('./mockMode');
    return mock.runMockCall(dose, attempt);
  }
  return _realCall(dose, attempt, options);
}

async function _realCall(dose, attempt, options = {}) {
  const to = options.to || config.grandmaPhone;

  if (!to) {
    throw new Error('No destination phone number set — check GRANDMA_PHONE_NUMBER or TEST_PHONE_NUMBER in .env');
  }

  const client = _twilioClient();

  const callUrl   = `${config.baseUrl}/webhook/initial?dose=${dose}&attempt=${attempt}`;
  const statusUrl = `${config.baseUrl}/webhook/status?dose=${dose}&attempt=${attempt}`;

  logger.call('Placing call', { dose, attempt, to });

  const call = await client.calls.create({
    to,
    from:                 config.twilioFromNumber,
    url:                  callUrl,
    statusCallback:       statusUrl,
    statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST',
  });

  logger.call('Call placed', { sid: call.sid, dose, attempt });
  return call.sid;
}

// Triggered by Twilio status callback when call goes unanswered
async function handleNoAnswer(dose, attempt) {
  logger.call('No answer / failed', { dose, attempt, maxAttempts: config.maxCallAttempts });

  if (attempt < config.maxCallAttempts) {
    const next     = attempt + 1;
    const delaySec = config.retryDelayMs / 1000;
    logger.call(`Retry scheduled`, { dose, nextAttempt: next, delaySeconds: delaySec });

    setTimeout(async () => {
      try {
        await initiateCall(dose, next);
      } catch (err) {
        logger.error('Retry call failed', { error: err.message, dose, attempt: next });
        if (next >= config.maxCallAttempts) {
          await _escalate(dose, 'call failure on final retry');
        }
      }
    }, config.retryDelayMs);
  } else {
    await _escalate(dose, `no answer after all ${config.maxCallAttempts} attempts`);
  }
}

// Triggered by twimlHandler when max reprompts exhausted inside an answered call
async function handleNeverConfirmed(dose, attempt) {
  logger.call('Answered but never confirmed', { dose, attempt });
  await _escalate(dose, 'answered but never confirmed medication taken');
}

async function _escalate(dose, reason) {
  const smsAlert = require('./smsAlert');
  const timeStr  = new Date().toLocaleString('en-US', { timeZone: config.timezone });
  const body     = `MEDICATION ALERT: Could not confirm ${dose} dose taken as of ${timeStr}. (${reason})`;
  await smsAlert.send(config.caregiverPhone, body);
}

module.exports = { initiateCall, handleNoAnswer, handleNeverConfirmed };
