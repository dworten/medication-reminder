'use strict';

module.exports = {
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
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  // Feature flags
  mockMode: process.env.MOCK_MODE === 'true',

  // Retry / flow settings
  maxCallAttempts: parseInt(process.env.MAX_CALL_ATTEMPTS    || '3',  10),
  retryDelayMs:    parseInt(process.env.RETRY_DELAY_MINUTES  || '5',  10) * 60 * 1000,
  maxReprompts:    parseInt(process.env.MAX_REPROMPTS        || '3',  10),
};
