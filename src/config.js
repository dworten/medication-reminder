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

  // Signs the session cookie. Without it a session id can be forged, which is
  // the whole of the authentication. Required in live mode — see validate();
  // in mock mode src/session.js falls back to a per-process random value, so
  // local runs work but logins do not survive a restart.
  sessionSecret:   process.env.SESSION_SECRET || '',
  sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS || '720', 10),

  // The one account allowed to reach this deployment's own phone numbers —
  // TEST_PHONE_NUMBER in particular, which is a real handset belonging to
  // whoever runs this, not a shared resource.
  //
  // Pinned to an email rather than "whichever account is oldest", which is what
  // it used to mean: that is implicit, and would silently move to a stranger's
  // account if the original were ever deleted. Left unset it falls back to the
  // oldest account, so an installation that never configures this still behaves
  // sensibly.
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),

  // Public signup.
  //
  // Every call and text any account schedules is placed on THIS deployment's
  // Twilio credentials and billed to its owner, so open registration is an open
  // tab. It is a switch rather than a constant precisely so it can be closed
  // from Railway's dashboard the moment that becomes a problem — no deploy, no
  // code change, effective on the next request.
  signupEnabled: process.env.SIGNUP_ENABLED !== 'false',

  // Shared by the signup form and `npm run set-password`, so the rule cannot
  // drift between the two ways an account gets a password.
  minPasswordLength: parseInt(process.env.MIN_PASSWORD_LENGTH || '12', 10),

  // Contact phone verification.
  //
  // Every one of these is an env override rather than a constant because they
  // are the dials you reach for when something is going wrong at 9pm — a code
  // that keeps expiring before an elderly recipient can read it back, or a
  // limit that needs tightening because someone found the endpoint. Changing
  // them from Railway takes effect on the next request; changing a constant
  // takes a deploy.
  //
  // The two send limits do different jobs. Per-number protects the person whose
  // phone would ring; per-account protects the Twilio bill, and it is the one
  // that actually bounds the damage — a per-number cap of 5 does nothing about
  // someone walking through a thousand different numbers.
  verificationCodeTtlMinutes:    parseInt(process.env.VERIFICATION_CODE_TTL_MINUTES     || '10', 10),
  verificationMaxChecks:         parseInt(process.env.VERIFICATION_MAX_CHECKS           || '5',  10),
  verificationMaxSendsPerNumber: parseInt(process.env.VERIFICATION_MAX_SENDS_PER_NUMBER || '5',  10),
  verificationMaxSendsPerAccount:parseInt(process.env.VERIFICATION_MAX_SENDS_PER_ACCOUNT|| '20', 10),
  verificationResendCooldownSec: parseInt(process.env.VERIFICATION_RESEND_COOLDOWN_SEC  || '60', 10),

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

  // Stale-PENDING watchdog.
  //
  // Everything after "call created" arrives by Twilio webhook. If callbacks
  // stop reaching this server — BASE_URL drift, a Twilio callback outage —
  // every call sits PENDING forever and the retry/escalation machinery never
  // engages. The watchdog treats a row still PENDING after this many minutes
  // as unresolved and runs the failure ladder on it.
  //
  // The floor is not negotiable downward: a threshold shorter than the longest
  // legitimate call would flag a call still in progress, and the queued redial
  // could then ring her after she confirmed. Calls here are bounded well under
  // ten minutes. 0 (or negative) disables the watchdog entirely.
  pendingWatchdogMinutes: (() => {
    const raw = parseInt(process.env.PENDING_WATCHDOG_MINUTES || '30', 10);
    return raw > 0 ? Math.max(raw, 10) : 0;
  })(),

  // Admin alerts — the alerts about failed alerts.
  //
  // The worst cases in this system (RETRY LOST, ESCALATION LOST, ALERT TEXT
  // NOT DELIVERED, NOBODY WILL BE ALERTED, CALL NEVER RESOLVED) end in a
  // logger.error, and nobody reads logs at 9:20 PM. When ADMIN_ALERT_PHONE is
  // set, those events also reach that phone. Unset, they stay log-only and the
  // app says so once at boot.
  //
  // The channel defaults to a voice call, not a text: one of the events being
  // reported is "SMS is not being delivered" (A2P 10DLC blocking), and an
  // alert that rides the broken channel arrives never. The call carries its
  // TwiML inline, so it works even when BASE_URL and the webhooks are wrong —
  // which is another of the events being reported. Either channel falls back
  // to the other on failure.
  adminAlertPhone: (process.env.ADMIN_ALERT_PHONE || '').trim(),
  adminAlertChannel: (() => {
    const raw = (process.env.ADMIN_ALERT_CHANNEL || 'call').trim().toLowerCase();
    return ['sms', 'call', 'both'].includes(raw) ? raw : 'call';
  })(),

  // Storm guard: the same event alerts at most once per this window; repeats
  // are counted and the count rides on the next alert through.
  adminAlertCooldownMinutes: parseInt(process.env.ADMIN_ALERT_COOLDOWN_MINUTES || '60', 10),

  // Daily heartbeat hour (0-23, in TIMEZONE above). One message a day saying
  // the system is alive and what it did, so silence stops being ambiguous.
  // Anything that does not parse as 0-23 disables it. Default: 8
  adminHeartbeatHour: (() => {
    const raw = process.env.ADMIN_HEARTBEAT_HOUR;
    if (raw === undefined || raw === '') return 8;
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  })(),

  // Answering-machine detection.
  //
  // Without it, voicemail counts as an answered call: the reminder plays into
  // the machine, then sits through every reprompt getting no input, which lands
  // on the "answered but never confirmed" branch and calls the caregiver about
  // a minute later — instead of simply trying her again.
  //
  // Twilio holds the TwiML request until it decides human or machine, so this
  // costs a small per-call fee and delays a human's greeting by a second or two.
  // It is a switch rather than a constant so it can be turned off from Railway
  // without a deploy if it ever misjudges a real person.
  machineDetection: process.env.MACHINE_DETECTION !== 'false',

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

  // A guessable session secret means a forgeable login, and the API it guards
  // can change who gets called and when. Refusing to boot is the right response
  // — a default value here would be a silent hole rather than a loud failure.
  if (!config.sessionSecret) {
    problems.push('SESSION_SECRET is not set — session cookies would be forgeable');
  } else if (config.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET is too short — use at least 32 characters');
  }

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
