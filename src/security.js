'use strict';

const crypto = require('crypto');
const twilio = require('twilio');
const config = require('./config');
const logger = require('./logger');

// Once the app lives at a stable public URL, every webhook route is reachable by
// anyone who finds it — and those routes drive real calls, retries and alerts.
// Twilio signs each request it sends; verifying that signature is what keeps the
// call flow driveable only by Twilio.
//
// The signed URL is rebuilt from config.baseUrl rather than req.protocol/req.host:
// behind Railway's proxy Express sees plain http, which would never match the
// https URL Twilio actually signed.
function twilioWebhookGuard(req, res, next) {
  if (!config.validateTwilioSignature) return next();

  const signature = req.get('X-Twilio-Signature');
  const url       = `${config.baseUrl}${req.originalUrl}`;

  if (!signature) {
    logger.warn('Rejected unsigned webhook request', { path: req.originalUrl, ip: req.ip });
    return res.status(403).type('text/plain').send('Forbidden');
  }

  const valid = twilio.validateRequest(config.twilioAuthToken, signature, url, req.body || {});

  if (!valid) {
    logger.warn('Rejected webhook with bad Twilio signature', { path: req.originalUrl, ip: req.ip });
    return res.status(403).type('text/plain').send('Forbidden');
  }

  return next();
}

function safeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// /trigger places real, billable calls on demand, so it needs its own guard —
// Twilio never calls it, so there is no signature to check.
//
// Two ways in, since Phase 3. A logged-in session is the browser's route: the
// UI will have a "call now" button and should not need to know the shared
// secret. The X-Trigger-Secret header stays for curl and for anything holding
// only the secret, so existing testing is unaffected.
function requireTriggerSecret(req, res, next) {
  // Checked first because it is free — no constant-time comparison needed for
  // a session id express-session has already verified the signature of.
  //
  // How the caller got in is recorded, because it decides what they may reach.
  // The secret is held only by whoever deployed this, so that path keeps the
  // env-configured phone numbers as fallbacks. A session belongs to any
  // registered account, so that path is confined to that account's own data.
  if (req.session && req.session.accountId) {
    req.triggerVia = 'session';
    return next();
  }

  if (!config.triggerSecret) {
    // No secret configured: allow in mock mode (nothing real happens), refuse in
    // live mode rather than leaving an open "call grandma" button on the internet.
    if (config.mockMode) { req.triggerVia = 'mock'; return next(); }
    logger.warn('Blocked /trigger — TRIGGER_SECRET is not set', { ip: req.ip });
    return res.status(503).json({ error: 'TRIGGER_SECRET is not configured on this server' });
  }

  const provided = req.get('X-Trigger-Secret') || req.query.secret || '';

  if (!provided || !safeEquals(provided, config.triggerSecret)) {
    logger.warn('Rejected /trigger with bad secret', { ip: req.ip });
    return res.status(403).json({ error: 'Forbidden' });
  }

  req.triggerVia = 'secret';
  return next();
}

module.exports = { twilioWebhookGuard, requireTriggerSecret };
