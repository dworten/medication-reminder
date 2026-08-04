'use strict';

// Login sessions, stored in Postgres.
//
// express-session's default MemoryStore would drop every login on redeploy, and
// this app redeploys often — the same reasoning that moved retries out of
// setTimeout in Stage 3. connect-pg-simple keeps them in the `session` table,
// which prisma/migrations owns.
//
// Deliberately NOT mounted globally. app.js applies this only to the routes
// that need it, so a Twilio webhook — which will never carry a cookie — takes
// exactly the path it did before this existed.

const crypto  = require('crypto');
const config  = require('./config');
const logger  = require('./logger');

let _middleware = null;

function secret() {
  if (config.sessionSecret) return config.sessionSecret;

  // Live mode never reaches here: config.validate() refuses to boot without a
  // secret. Mock mode is local-only, so a per-process random value is enough —
  // it just means a restart logs you out.
  logger.warn('SESSION_SECRET is not set — using a random per-process secret (mock mode only; logins will not survive a restart)');
  return crypto.randomBytes(32).toString('hex');
}

// Built lazily so requiring this file never opens a connection pool, matching
// src/db.js. The store keeps its own pg pool: connect-pg-simple needs a raw
// client and Prisma's is not one to hand out.
function middleware() {
  if (_middleware) return _middleware;

  const session   = require('express-session');
  const PgSession = require('connect-pg-simple')(session);

  const store = new PgSession({
    conString:  config.databaseUrl,
    tableName:  'session',
    // The table comes from a migration. Letting the library create it would put
    // a table outside prisma/migrations and show up as drift from then on.
    createTableIfMissing: false,
    // Sweep expired rows every 15 minutes rather than the default hour, so a
    // logged-out or expired session stops being a row that exists.
    pruneSessionInterval: 15 * 60,
  });

  store.on('error', (err) => logger.error('Session store error', { error: err.message }));

  _middleware = session({
    name:   'medreminder.sid',
    secret: secret(),
    store,
    // Only write a row once something is actually stored on the session. Without
    // this every unauthenticated request — including a probe from a stranger —
    // would insert a session row.
    saveUninitialized: false,
    resave:            false,
    // Pushes the expiry forward on activity, so an open tab is not logged out
    // mid-use at exactly N days after login.
    rolling:           true,
    cookie: {
      httpOnly: true,
      // Not readable by JavaScript, not sent cross-site, and — in production —
      // not sent over plain http at all. `trust proxy` in app.js is what makes
      // the secure flag work behind Railway's TLS termination; without it
      // express would see http and refuse to set the cookie.
      sameSite: 'lax',
      secure:   config.nodeEnv === 'production',
      maxAge:   config.sessionTtlHours * 60 * 60 * 1000,
    },
  });

  logger.info('Session store ready', {
    ttlHours:     config.sessionTtlHours,
    secureCookie: config.nodeEnv === 'production',
  });

  return _middleware;
}

module.exports = { middleware };
