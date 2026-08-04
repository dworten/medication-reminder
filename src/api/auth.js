'use strict';

// Login, logout, and the guard every other API route sits behind.

const express = require('express');
const bcrypt  = require('bcryptjs');

const logger      = require('../logger');
const accountRepo = require('../data/accounts');
const db          = require('../db');
const { asyncHandler, ApiError } = require('./errors');

const router = express.Router();

// A password hash is never sent to a client, and neither is anything derived
// from it. Every account response goes through this.
function publicAccount(account) {
  return {
    id:          account.id,
    email:       account.email,
    name:        account.name,
    timezone:    account.timezone,
    lastLoginAt: account.lastLoginAt,
    createdAt:   account.createdAt,
  };
}

// ─── Brute-force limiting ────────────────────────────────────────────────────
//
// In memory, keyed by IP. That is honest for this deployment — railway.json
// pins numReplicas to 1 — but it does mean the counter resets on redeploy, so
// it slows an attacker down rather than locking them out. Anything stronger
// belongs in the database, and is not worth it for a single-user app behind a
// long random password.

const ATTEMPTS   = new Map();
const MAX_TRIES  = 10;
const WINDOW_MS  = 15 * 60 * 1000;

function tooManyAttempts(ip) {
  const record = ATTEMPTS.get(ip);
  if (!record) return false;
  if (Date.now() > record.resetAt) { ATTEMPTS.delete(ip); return false; }
  return record.count >= MAX_TRIES;
}

function noteFailure(ip) {
  const record = ATTEMPTS.get(ip);
  if (!record || Date.now() > record.resetAt) {
    ATTEMPTS.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
    return;
  }
  record.count += 1;
}

// Bounded so a flood of distinct source IPs cannot grow this without limit.
function pruneAttempts() {
  if (ATTEMPTS.size < 1000) return;
  const now = Date.now();
  for (const [ip, record] of ATTEMPTS) if (now > record.resetAt) ATTEMPTS.delete(ip);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// A real bcrypt hash of a value nobody knows, compared against when the email
// does not exist. Without it, "no such account" returns in a millisecond and a
// wrong password takes ~100ms — which tells an attacker which emails are real.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

router.post('/login', asyncHandler(async (req, res) => {
  const ip = req.ip || 'unknown';
  pruneAttempts();

  if (tooManyAttempts(ip)) {
    logger.warn('Login rate limited', { ip });
    throw new ApiError(429, 'Too many login attempts. Try again in 15 minutes.');
  }

  const email    = String(req.body?.email    || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    throw new ApiError(400, 'Email and password are required');
  }

  const account = await db.getClient().account.findUnique({ where: { email } });

  // An account with no password set is not loginable. It is not an error state
  // — it is every account until `npm run set-password` has been run — but it
  // must never authenticate.
  const hash = account?.passwordHash || DUMMY_HASH;
  const ok   = await bcrypt.compare(password, hash);

  if (!account || !account.passwordHash || !ok) {
    noteFailure(ip);
    logger.warn('Failed login', { ip, email, reason: !account ? 'no such account' : (!account.passwordHash ? 'no password set' : 'bad password') });
    // One message for all three cases: which one it was is not the caller's
    // business, and saying would enumerate accounts.
    throw new ApiError(401, 'Invalid email or password');
  }

  ATTEMPTS.delete(ip);

  // Regenerate before storing anything, so a session id an attacker planted in
  // the browser beforehand is not the one that ends up authenticated.
  await new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve()))
  );

  req.session.accountId = account.id;

  await new Promise((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve()))
  );

  const updated = await db.getClient().account.update({
    where: { id: account.id },
    data:  { lastLoginAt: new Date() },
  });

  logger.info('Login', { accountId: account.id, email: account.email, ip });
  res.json({ account: publicAccount(updated) });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const accountId = req.session?.accountId;

  if (req.session) {
    // destroy() removes the row, not just the cookie — a logged-out session
    // should stop existing server-side, not merely be forgotten by the browser.
    await new Promise((resolve) => req.session.destroy(() => resolve()));
  }

  res.clearCookie('medreminder.sid');
  if (accountId) logger.info('Logout', { accountId });
  res.json({ ok: true });
}));

// The guard. Loads the account fresh rather than trusting anything cached in
// the session beyond its id, so a deleted account cannot keep acting through a
// session that outlived it.
const requireAuth = asyncHandler(async (req, _res, next) => {
  const accountId = req.session?.accountId;
  if (!accountId) throw new ApiError(401, 'Not authenticated');

  const account = await accountRepo.getById(accountId);
  if (!account) {
    await new Promise((resolve) => req.session.destroy(() => resolve()));
    throw new ApiError(401, 'Not authenticated');
  }

  req.account = account;
  next();
});

// GET /api/me — how the frontend asks "am I logged in, and as whom?"
router.get('/me', requireAuth, (req, res) => {
  res.json({ account: publicAccount(req.account) });
});

module.exports = router;
module.exports.requireAuth    = requireAuth;
module.exports.publicAccount  = publicAccount;
