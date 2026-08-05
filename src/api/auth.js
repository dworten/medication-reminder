'use strict';

// Login, logout, and the guard every other API route sits behind.

const express = require('express');
const bcrypt  = require('bcryptjs');

const logger      = require('../logger');
const config      = require('../config');
const accountRepo = require('../data/accounts');
const db          = require('../db');
const { asyncHandler, ApiError } = require('./errors');
const { signupInput } = require('./validate');

const router = express.Router();

// Matches scripts/set-password.js. About a quarter of a second on modest
// hardware — irrelevant for something that happens rarely, meaningful against
// someone working through a stolen hash.
const BCRYPT_ROUNDS = 12;

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

const ATTEMPTS    = new Map();
const MAX_TRIES   = 10;
// Tighter than the login ceiling: a burst of failed logins is sometimes a real
// person who forgot their password, a burst of registrations never is.
const MAX_SIGNUPS = 3;
const WINDOW_MS   = 15 * 60 * 1000;

function record(ip) {
  const existing = ATTEMPTS.get(ip);
  if (!existing || Date.now() > existing.resetAt) {
    const fresh = { count: 0, signups: 0, resetAt: Date.now() + WINDOW_MS };
    ATTEMPTS.set(ip, fresh);
    return fresh;
  }
  return existing;
}

function tooManyAttempts(ip) {
  const existing = ATTEMPTS.get(ip);
  if (!existing) return false;
  if (Date.now() > existing.resetAt) { ATTEMPTS.delete(ip); return false; }
  return existing.count >= MAX_TRIES;
}

function noteFailure(ip) { record(ip).count += 1; }

function signupAttempts(ip) {
  const existing = ATTEMPTS.get(ip);
  if (!existing || Date.now() > existing.resetAt) return 0;
  return existing.signups;
}

function noteSignup(ip) { record(ip).signups += 1; }

// Bounded so a flood of distinct source IPs cannot grow this without limit.
function pruneAttempts() {
  if (ATTEMPTS.size < 1000) return;
  const now = Date.now();
  for (const [ip, entry] of ATTEMPTS) if (now > entry.resetAt) ATTEMPTS.delete(ip);
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

// Public registration.
//
// Every call and text a new account schedules is placed on this deployment's
// Twilio credentials and billed to its owner, so this is a more consequential
// endpoint than a signup form usually is. Three things follow from that: it is
// rate limited harder than login, SIGNUP_ENABLED can close it from Railway
// without a deploy, and a new account starts completely empty — no contacts, no
// schedules, and no access to the owner's env-configured phone numbers.
router.post('/signup', asyncHandler(async (req, res) => {
  if (!config.signupEnabled) {
    throw new ApiError(503, 'Registration is closed');
  }

  const ip = req.ip || 'unknown';
  pruneAttempts();

  // Shares the login limiter's map but has its own, tighter ceiling: a burst of
  // signups is never legitimate, where a burst of failed logins sometimes is.
  if (signupAttempts(ip) >= MAX_SIGNUPS) {
    logger.warn('Signup rate limited', { ip });
    throw new ApiError(429, 'Too many accounts created from here. Try again later.');
  }

  const { email, password, name } = signupInput(req.body);

  const existing = await accountRepo.getByEmail(email);
  if (existing) {
    // Registration inherently reveals whether an address is taken — there is no
    // way to accept or refuse without saying so. Login stays deliberately vague;
    // this cannot be.
    throw new ApiError(409, 'An account with that email already exists');
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  let account;
  try {
    account = await accountRepo.create({ email, name, passwordHash: hash });
  } catch (err) {
    // Two requests racing past the check above; the unique index settles it.
    if (err.code === 'P2002') throw new ApiError(409, 'An account with that email already exists');
    throw err;
  }

  noteSignup(ip);
  logger.info('Account created', { accountId: account.id, email: account.email, ip });

  // Signed straight in — asking someone to register and then log in with the
  // credentials they just typed is a pointless second step.
  await new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve()))
  );
  req.session.accountId = account.id;
  await new Promise((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve()))
  );

  res.status(201).json({ account: publicAccount(account) });
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
