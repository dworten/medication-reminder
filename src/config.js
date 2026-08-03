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
  //
  // MORNING_CRON / EVENING_CRON are gone: call times now live in the schedules
  // table, each row carrying its own timezone and days-of-week. TIMEZONE below
  // is only a default for new records and for formatting timestamps in alerts.
  timezone: process.env.TIMEZONE || 'America/Chicago',

  // How late a schedule may still fire. The old exact-minute cron silently
  // missed a dose entirely if the container was restarting during that one
  // minute; this turns that into a call a few minutes late instead.
  scheduleGraceMinutes: parseInt(process.env.SCHEDULE_GRACE_MINUTES || '5', 10),

  // Database
  // Railway injects this from the Postgres service reference variable. Not yet
  // required to boot: through Stage 1 nothing in the call path reads it, so a
  // missing or unreachable database must not stop calls going out. Stage 2
  // makes it mandatory, because by then the schedules live in it.
  databaseUrl: process.env.DATABASE_URL || '',

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

  // Retry / flow settings.
  //
  // These are now FALLBACKS, not the source of truth. A call placed from a
  // schedule uses that schedule's own max_attempts / retry_delay_minutes /
  // max_reprompts. These values apply when there is no schedule behind the
  // call (a manual /trigger), and when a webhook arrives without the settings
  // encoded in its URL — an in-flight call from before a deploy, for instance.
  maxCallAttempts: parseInt(process.env.MAX_CALL_ATTEMPTS    || '3',  10),
  retryDelayMs:    parseInt(process.env.RETRY_DELAY_MINUTES  || '5',  10) * 60 * 1000,
  maxReprompts:    parseInt(process.env.MAX_REPROMPTS        || '3',  10),

  // Retry sweeper.
  //
  // How long a sweeper's claim on a queued item stays valid. If a process dies
  // holding a claim, the item is stuck until this lapses — so it must be long
  // enough that a slow-but-alive call is never stolen, and short enough that a
  // crash does not delay a retry past usefulness.
  retryStaleClaimMinutes: parseInt(process.env.RETRY_STALE_CLAIM_MINUTES || '10', 10),

  // Abandon queued work older than this. A reminder call placed six hours late
  // is not a reminder, it is a confusing phone call at the wrong time of day —
  // and without a ceiling a permanently failing item would be retried forever.
  retryGiveUpHours: parseInt(process.env.RETRY_GIVE_UP_HOURS || '6', 10),

  // Escalation chain fallbacks.
  //
  // Like the retry settings above, these apply only when no schedule sits behind
  // the escalation. A schedule's own escalate_with_call / escalate_with_sms /
  // escalation_ack_minutes always win. The defaults reproduce the behaviour this
  // app has always had: text the caregiver, don't call him.
  escalateWithCall:     process.env.ESCALATE_WITH_CALL === 'true',
  escalateWithSms:      process.env.ESCALATE_WITH_SMS !== 'false',
  escalationAckMinutes: parseInt(process.env.ESCALATION_ACK_MINUTES || '3', 10),
};

// Fail loudly at boot rather than at 9:20 PM when a call silently can't be placed.
// Returns a list of problems; empty means good to go.
function validate() {
  const problems = [];

  // The schedules now live in Postgres, so an unset DATABASE_URL means no call
  // will ever fire. That is a deploy misconfiguration worth refusing to start
  // over — unlike the database being temporarily *unreachable*, which the
  // scheduler retries every minute and which must not stop the webhook routes
  // from serving calls that are already in flight.
  if (!config.databaseUrl) {
    problems.push('DATABASE_URL is not set — schedules live in the database, so no calls could fire');
  }

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
