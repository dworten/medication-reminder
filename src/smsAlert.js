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

// Where Twilio should report this message's fate.
//
// Returns nothing at all unless the base URL is public https. Twilio rejects a
// statusCallback it considers unreachable, and rejecting the whole message
// because of a bookkeeping parameter would mean a missed-dose alert not going
// out for the sake of knowing whether it went out. This module's rule is the
// same as call_history's: the alert wins, always.
function statusCallbackParam() {
  if (!config.baseUrl.startsWith('https://')) {
    logger.warn('No SMS delivery receipts — BASE_URL is not public https', {
      baseUrl: config.baseUrl,
      effect:  'an undelivered alert text will not be recorded as failed',
    });
    return {};
  }

  return {
    statusCallback: `${config.baseUrl}/webhook/sms-status`,
  };
}

async function send(to, body) {
  logger.call('SMS alert', { to, mode: config.mockMode ? 'mock' : 'real', body });

  if (config.mockMode) {
    const w    = 58;
    const line = '─'.repeat(w);
    const pad  = (s) => `│ ${s.padEnd(w - 2)} │`;
    const wrap = (text, maxLen) => {
      const words = text.split(' ');
      const lines = [];
      let cur = '';
      for (const word of words) {
        if ((cur + (cur ? ' ' : '') + word).length > maxLen) { lines.push(cur); cur = word; }
        else { cur += (cur ? ' ' : '') + word; }
      }
      if (cur) lines.push(cur);
      return lines;
    };

    console.log('\n┌' + line + '┐');
    console.log(pad('📲  MOCK SMS ALERT'));
    console.log('├' + line + '┤');
    console.log(pad(`To:  ${to}`));
    for (const ln of wrap(body, w - 2)) console.log(pad(ln));
    console.log('└' + line + '┘\n');
    return null;
  }

  const client = _twilioClient();

  const msg = await client.messages.create({
    to,
    from: config.twilioFromNumber,
    body,
    ...statusCallbackParam(),
  });

  // Deliberately no longer "SMS sent". Twilio has ACCEPTED this message; whether
  // it reaches a handset is decided later by the carrier and reported to
  // /webhook/sms-status. Saying "sent" here is what made a week of undelivered
  // alerts look like a week of delivered ones.
  logger.call('SMS accepted by Twilio (delivery not yet confirmed)', { sid: msg.sid, to });

  // Returned so the escalation's call_history row can record the Message SID —
  // both to search Twilio's logs by, and because it is the only handle the
  // delivery receipt will arrive with.
  return msg.sid;
}

module.exports = { send, statusCallbackParam };
