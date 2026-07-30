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
    return;
  }

  const client = _twilioClient();
  const msg    = await client.messages.create({ to, from: config.twilioFromNumber, body });
  logger.call('SMS sent', { sid: msg.sid, to });
}

module.exports = { send };
