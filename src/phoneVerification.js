'use strict';

// Proving a phone number belongs to whoever is adding it.
//
// Deliberately its own module rather than anything inside callManager. That file
// is the reminder path — the calls that actually get placed at 9:20 — and it is
// the part of this system that must not break. Verification borrows the Twilio
// client and nothing else; no function in the call flow is touched, called, or
// reshaped by anything here.
//
// Two rules the rest of the code depends on:
//
//   1. The plaintext code exists only inside sendCode(), for the length of one
//      request. What is stored is a bcrypt hash. There is deliberately no way to
//      read a code back — which is also why the voice call carries its TwiML
//      inline rather than pointing Twilio at a webhook that would have to look
//      one up.
//
//   2. Rate limits are counted from the database, not from a Map. An in-memory
//      counter resets on redeploy, which would turn "5 texts per hour" into
//      "5 texts per redeploy" on an endpoint that spends real money.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const config = require('./config');
const logger = require('./logger');
const repo   = require('./data/contactVerifications');

// Matches auth.js. A 6-digit code is only 10^6 candidates, so the cost factor is
// what stands between a leaked table and every outstanding code — at cost 12
// that is days of work per code, against a code that lives ten minutes and is
// burned after five wrong guesses.
const BCRYPT_ROUNDS = 12;

// ─── The code ────────────────────────────────────────────────────────────────

// crypto.randomInt, not Math.random. Math.random is seeded from something an
// attacker can often infer, and a predictable verification code is not a
// verification code.
function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

const hashCode = (code) => bcrypt.hash(code, BCRYPT_ROUNDS);

// A real hash of something nobody knows, compared against when there is no row
// to compare with. Without it a missing or expired verification returns in a
// microsecond while a wrong code takes ~250ms, which tells a caller which
// verification ids are real.
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.rHNSGGDIHNsm3jOZLwXBBhVzZfRDGDW';

async function compareCode(code, hash) {
  return bcrypt.compare(String(code), hash || DUMMY_HASH);
}

// ─── Rate limiting ───────────────────────────────────────────────────────────

// Why this endpoint needs limits at all: every send costs the account owner
// money on THIS deployment's Twilio credentials, and it accepts an arbitrary
// destination number. Unlimited, it is a free SMS gateway pointed at anyone,
// billed to whoever runs this.
//
// Returns null when the send is allowed, or { message, retryAfterSeconds } when
// it is not. Not a thrown error: the caller turns this into a 429 with the
// codebase's error shape, and this module has no opinion about HTTP.
async function checkSendAllowed(accountId, phone) {
  const now       = new Date();
  const hourAgo   = new Date(now.getTime() - 60 * 60 * 1000);

  // Cheapest and most specific first: a double-clicked button is the common
  // case, and it should not consume one of the hourly allowance.
  const last = await repo.lastSendTo(accountId, phone);
  if (last) {
    const elapsedSec = Math.floor((now - last.createdAt) / 1000);
    if (elapsedSec < config.verificationResendCooldownSec) {
      const wait = config.verificationResendCooldownSec - elapsedSec;
      return {
        message: `Wait ${wait} more second${wait === 1 ? '' : 's'} before requesting another code.`,
        retryAfterSeconds: wait,
      };
    }
  }

  const toNumber = await repo.countSince(accountId, hourAgo, { phone });
  if (toNumber >= config.verificationMaxSendsPerNumber) {
    return {
      message: `Too many codes sent to that number. Try again in an hour.`,
      retryAfterSeconds: 3600,
    };
  }

  // The ceiling that actually bounds the bill. Per-number limits protect the
  // person whose phone rings; this protects the person who pays for it.
  const byAccount = await repo.countSince(accountId, hourAgo);
  if (byAccount >= config.verificationMaxSendsPerAccount) {
    return {
      message: 'Too many verification codes requested. Try again in an hour.',
      retryAfterSeconds: 3600,
    };
  }

  return null;
}

// ─── Delivery ────────────────────────────────────────────────────────────────

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

const smsBody = (code) =>
  `${code} is your medication reminder verification code. It expires in ${config.verificationCodeTtlMinutes} minutes.`;

// Spoken one digit at a time, with pauses, twice.
//
// This is not padding. The reason the CALL channel exists at all is that the
// person on the other end may be elderly and may not read a text — "four eight
// two nine one five" recited at conversational speed is not a code anyone can
// write down. The digits are spaced so Twilio's TTS reads them individually
// rather than as the number four hundred and eighty-two thousand.
function voiceTwiml(code) {
  const spaced = code.split('').join(', ');
  const twilio = require('twilio');
  const r = new twilio.twiml.VoiceResponse();

  r.pause({ length: 1 });
  r.say('Hello. This is a verification call for your medication reminder service.');
  r.pause({ length: 1 });
  r.say(`Your verification code is. ${spaced}.`);
  r.pause({ length: 1 });
  r.say(`Once more. Your code is. ${spaced}.`);
  r.pause({ length: 1 });
  r.say('Goodbye.');
  r.hangup();

  return r.toString();
}

// Local-only rendering, matching the box smsAlert prints so a mock run of this
// flow reads the same as a mock run of an escalation.
function _mockBox(title, to, lines) {
  const w    = 58;
  const line = '─'.repeat(w);
  const pad  = (s) => `│ ${String(s).padEnd(w - 2)} │`;

  console.log('\n┌' + line + '┐');
  console.log(pad(title));
  console.log('├' + line + '┤');
  console.log(pad(`To:  ${to}`));
  for (const ln of lines) console.log(pad(ln));
  console.log('└' + line + '┘\n');
}

// The outbound edges, exported through module.exports so the test suite can
// intercept them the way it already intercepts callManager.placeVoiceCall.
// Everything above these lines — generation, hashing, limits, storage — then
// runs for real in tests.
async function sendVerificationSms(to, code) {
  const client = _twilioClient();
  const msg = await client.messages.create({
    to, from: config.twilioFromNumber, body: smsBody(code),
  });
  return msg.sid;
}

// TwiML inline via the `twiml` parameter, NOT a `url` pointing at a webhook.
//
// This is forced by storing only a hash: a webhook would be handed a
// verification id and would have to recite the code, which it cannot read.
// Passing the markup directly means the plaintext never leaves this process
// except in the request body to Twilio, there is no new public endpoint to
// secure, and no code ever appears in a URL or a server log.
async function placeVerificationCall(to, code) {
  const client = _twilioClient();
  const call = await client.calls.create({
    to, from: config.twilioFromNumber, twiml: voiceTwiml(code),
  });
  return call.sid;
}

// ─── The one function the API calls ──────────────────────────────────────────
//
// Generates, hashes, stores and delivers — in that order. The row is written
// BEFORE Twilio is called, deliberately: a code that went out but was never
// stored is a code nobody can check, and it would also be invisible to the rate
// limit, which is the one place a send must always be counted even when it
// fails.
async function sendCode({ accountId, contactId = null, phone, channel, draft = null }) {
  const code = generateCode();
  const hash = await hashCode(code);

  const expiresAt = new Date(Date.now() + config.verificationCodeTtlMinutes * 60 * 1000);

  // Any code already outstanding for this number stops working now. Without
  // this, requesting a second code leaves the first one live, so "resend"
  // quietly widens the guessing window every time it is pressed.
  await repo.invalidateOutstanding(accountId, phone);

  // draft is omitted rather than passed as null. Prisma refuses a bare null on a
  // nullable Json column — it cannot tell "SQL NULL" from "the JSON value null"
  // and makes you say which — and the change flow has no draft at all, so the
  // honest answer is that the column is absent.
  const verification = await repo.create({
    accountId, contactId, phone, channel, codeHash: hash, expiresAt,
    ...(draft && { draft }),
  });

  // Never log the code. This line is the one place it would be easiest to leak
  // it into Railway's log stream, where it would outlive the ten-minute expiry
  // by however long logs are retained.
  logger.info('Verification code issued', {
    verificationId: verification.id, accountId, contactId, channel,
    mode: config.mockMode ? 'mock' : 'real',
  });

  if (config.mockMode) {
    _mockBox(
      channel === 'CALL' ? '📞  MOCK VERIFICATION CALL' : '📲  MOCK VERIFICATION SMS',
      phone,
      [`Code: ${code}`, `Expires in ${config.verificationCodeTtlMinutes} minutes`]
    );
    return verification;
  }

  try {
    const sid = channel === 'CALL'
      ? await module.exports.placeVerificationCall(phone, code)
      : await module.exports.sendVerificationSms(phone, code);

    logger.info('Verification code delivered', { verificationId: verification.id, channel, sid });
  } catch (err) {
    // The row stays. It counts against the rate limit — a failing send is still
    // a send Twilio was asked to make — and it is already invalid to the caller,
    // who never received a code to enter.
    logger.error('Could not deliver verification code', {
      verificationId: verification.id, channel, error: err.message,
    });
    await repo.invalidate(verification.id).catch(() => {});
    throw err;
  }

  return verification;
}

module.exports = {
  sendCode,
  compareCode,
  checkSendAllowed,
  generateCode,
  hashCode,
  voiceTwiml,
  smsBody,
  sendVerificationSms,
  placeVerificationCall,
  BCRYPT_ROUNDS,
};
