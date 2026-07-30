'use strict';

// Resolve the public base URL Twilio will call back on.
//
// Locally this is ngrok (or localhost in mock mode). On Railway it is the
// service's public domain. Railway injects RAILWAY_PUBLIC_DOMAIN automatically
// once a domain is generated, so the app works there even if BASE_URL is never
// set by hand — but an explicit BASE_URL always wins (e.g. a custom domain).
function resolveBaseUrl() {
  const explicit = (process.env.BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const railwayDomain = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railwayDomain) return `https://${railwayDomain.replace(/\/+$/, '')}`;

  return 'http://localhost:3000';
}

const config = {
  // Twilio credentials (required when MOCK_MODE=false)
  // Preferred: Standard API Key SID/Secret + Account SID.
  // Legacy TWILIO_AUTH_TOKEN is kept only as a fallback for older setups.
  twilioAccountSid:   process.env.TWILIO_ACCOUNT_SID     || '',
  twilioApiKeySid:    process.env.TWILIO_API_KEY_SID     || '',
  twilioApiKeySecret: process.env.TWILIO_API_KEY_SECRET  || '',
  twilioAuthToken:    process.env.TWILIO_AUTH_TOKEN      || '',
  twilioFromNumber:   process.env.TWILIO_PHONE_NUMBER    || '',

  // Phone numbers (E.164 format)
  grandmaPhone:   process.env.GRANDMA_PHONE_NUMBER   || '',
  caregiverPhone: process.env.CAREGIVER_PHONE_NUMBER || '',
  testPhone:      process.env.TEST_PHONE_NUMBER      || '',

  // Scheduling
  timezone:    process.env.TIMEZONE     || 'America/Chicago',
  morningCron: process.env.MORNING_CRON || '20 9 * * *',
  eveningCron: process.env.EVENING_CRON || '20 21 * * *',

  // Server
  port:    parseInt(process.env.PORT || '3000', 10),
  baseUrl: resolveBaseUrl(),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Feature flags
  mockMode: process.env.MOCK_MODE === 'true',

  // Security
  // Twilio signs every webhook request; validating that signature is what stops
  // a stranger who finds the public URL from driving the call/escalation flow.
  // The opt-out exists only for local debugging with curl.
  validateTwilioSignature: process.env.VALIDATE_TWILIO_SIGNATURE !== 'false',
  triggerSecret: process.env.TRIGGER_SECRET || '',

  // Retry / flow settings
  maxCallAttempts: parseInt(process.env.MAX_CALL_ATTEMPTS    || '3',  10),
  retryDelayMs:    parseInt(process.env.RETRY_DELAY_MINUTES  || '5',  10) * 60 * 1000,
  maxReprompts:    parseInt(process.env.MAX_REPROMPTS        || '3',  10),
};

// Fail loudly at boot rather than at 9:20 PM when a call silently can't be placed.
// Returns a list of problems; empty means good to go.
function validate() {
  const problems = [];

  if (config.mockMode) return problems;

  const hasApiKey    = config.twilioApiKeySid && config.twilioApiKeySecret;
  const hasAuthToken = Boolean(config.twilioAuthToken);

  if (!config.twilioAccountSid) {
    problems.push('TWILIO_ACCOUNT_SID is not set');
  }
  if (!hasApiKey && !hasAuthToken) {
    problems.push('No Twilio auth — set TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (preferred), or TWILIO_AUTH_TOKEN');
  }
  if (!config.twilioFromNumber) {
    problems.push('TWILIO_PHONE_NUMBER is not set');
  }
  if (!config.grandmaPhone) {
    problems.push('GRANDMA_PHONE_NUMBER is not set');
  }
  if (!config.caregiverPhone) {
    problems.push('CAREGIVER_PHONE_NUMBER is not set — missed-dose alerts would go nowhere');
  }
  if (!config.baseUrl.startsWith('https://')) {
    problems.push(`BASE_URL must be a public https URL for Twilio to reach the webhooks (resolved to "${config.baseUrl}")`);
  }

  // Signature validation needs the account's auth token — API keys can't verify
  // signatures, so an API-key-only setup has to opt out explicitly.
  if (config.validateTwilioSignature && !hasAuthToken) {
    problems.push('VALIDATE_TWILIO_SIGNATURE is on but TWILIO_AUTH_TOKEN is not set (signature checks need the account auth token)');
  }

  return problems;
}

module.exports = config;
module.exports.validate = validate;
