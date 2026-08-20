'use strict';

// Loads .env locally; a no-op on Railway, where variables come from the
// service's environment directly.
require('dotenv').config();

const path        = require('path');
const express     = require('express');
const config      = require('./src/config');
const session     = require('./src/session');
const apiRouter   = require('./src/api');
const logger      = require('./src/logger');
const twimlRouter = require('./src/twimlHandler');
const scheduler    = require('./src/scheduler');
const retrySweeper = require('./src/retrySweeper');
const adminAlert   = require('./src/adminAlert');
const callManager  = require('./src/callManager');
const database     = require('./src/db');
const { requireTriggerSecret } = require('./src/security');

const app = express();

// Railway terminates TLS at its edge and forwards over http, so without this
// req.ip is the proxy's address rather than the caller's.
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// TwiML webhook routes — Twilio POSTs here during live calls.
// Signature-guarded inside the router.
//
// Mounted BEFORE the session middleware and outside it, deliberately. Twilio
// cannot log in and will never carry a cookie, so a live call takes exactly the
// path it did before authentication existed — no session lookup, no store round
// trip, nothing new between the request and the TwiML.
app.use('/webhook', twimlRouter);

// Sessions, only where they are needed. /trigger is included because it accepts
// a logged-in session as an alternative to the shared secret.
app.use(['/api', '/login', '/signup', '/app', '/trigger'], session.middleware());

// The API. A router, so app.js keeps owning the process and nothing else here
// has to change.
app.use('/api', apiRouter());

// Sign-in page. Already-authenticated visitors go straight through rather than
// being asked to log in again.
app.get('/login', (req, res) => {
  if (req.session && req.session.accountId) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Registration. Serving the page when SIGNUP_ENABLED is off would be an
// invitation to a form that can only fail, so it redirects instead — and the
// API refuses independently, since the page is not the guard.
app.get('/signup', (req, res) => {
  if (req.session && req.session.accountId) return res.redirect('/app');
  if (!config.signupEnabled) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// The interface.
//
// Gated at the route, not just by the API it calls. The markup names contacts
// and schedules, so serving it to anyone who asks would leak who gets called
// even if every fetch it makes came back 401. A page redirects rather than
// returning JSON — a browser following a link wants somewhere to go.
function requirePage(req, res, next) {
  if (req.session && req.session.accountId) return next();
  return res.redirect('/login');
}

// The shell is served explicitly, and BEFORE the static mount. Left to
// express.static, a request for /app is a directory and answers 301 → /app/,
// which works but wastes a round trip and means the route below never runs.
// Client-side routing lives in the hash, so this is the only HTML there is.
app.get(['/app', '/app/'], requirePage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'index.html'));
});

// index:false and redirect:false leave directory handling to the route above
// rather than having two things answer for the same path.
app.use('/app', requirePage, express.static(path.join(__dirname, 'public', 'app'), {
  index:    false,
  redirect: false,
}));

// Always to /login, which then forwards to /app if there is a session.
//
// It cannot decide that itself: the session middleware is mounted on specific
// paths so Twilio's webhooks never touch it, and '/' as a mount path would
// match every request including those. One extra redirect is a fair price for
// keeping the call path clear of session lookups.
app.get('/', (_req, res) => res.redirect('/login'));

// Manual trigger: POST /trigger?dose=morning  (or body: { "dose": "morning" })
// Useful for ad-hoc testing without waiting for the cron schedule.
// Guarded by TRIGGER_SECRET — this places real, billable calls.
// Resolves which schedule a manual trigger should imitate, so a test call uses
// the same contact, message and escalation settings the real call would.
// Falls back to the env phone number when nothing is seeded yet.
// Which schedule a manual trigger should imitate.
//
// accountId is the whole of the security here. Without it this searched EVERY
// account's schedules and returned the first matching dose — so once anyone
// could register, a stranger's /trigger would have used the deployment owner's
// schedule and rung the owner's grandmother. Same for a schedule id: a foreign
// id has to resolve to nothing, not to someone else's row.
async function resolveTriggerSchedule({ scheduleId, dose, accountId }) {
  const scheduleRepo = require('./src/data/schedules');

  if (accountId) {
    if (scheduleId) return scheduleRepo.getForAccount(accountId, scheduleId);
    const mine = await scheduleRepo.listForAccount(accountId);
    return mine.find(s => s.enabled && s.dose === dose) || null;
  }

  // No account context means the shared secret, which only the deployment owner
  // holds — the pre-Phase-3 behaviour, unchanged.
  if (scheduleId) return scheduleRepo.getById(scheduleId);
  const enabled = await scheduleRepo.listEnabled();
  return enabled.find(s => s.dose === dose) || null;
}

app.post('/trigger', requireTriggerSecret, async (req, res) => {
  const dose = (req.body.dose || req.query.dose || 'morning').toLowerCase();
  const target = (req.body.target || req.query.target || 'grandma').toLowerCase();
  const scheduleId = req.body.scheduleId || req.query.scheduleId || null;

  if (!['morning', 'evening'].includes(dose)) {
    return res.status(400).json({ error: 'dose must be "morning" or "evening"' });
  }
  if (!['grandma', 'test'].includes(target)) {
    return res.status(400).json({ error: 'target must be "grandma" or "test"' });
  }

  // A session belongs to any registered account; the shared secret belongs only
  // to whoever deployed this. That distinction decides everything below.
  const accountId = req.triggerVia === 'session' ? req.session.accountId : null;

  let schedule = null;
  try {
    schedule = await resolveTriggerSchedule({ scheduleId, dose, accountId });
  } catch (err) {
    logger.error('Trigger could not load schedule', { error: err.message });
  }

  if (scheduleId && !schedule) {
    return res.status(404).json({ error: `no schedule with id ${scheduleId}` });
  }

  // GRANDMA_PHONE_NUMBER, TEST_PHONE_NUMBER and CAREGIVER_PHONE_NUMBER are
  // per-deployment, not per-account: they belong to the owner. A signed-in
  // stranger must never reach them, so for a session the destination can only
  // come from a schedule in their own account.
  if (accountId) {
    const accountRepo = require('./src/data/accounts');
    // Fails closed: if the check itself errors, the answer is "not the admin".
    const admin = await accountRepo.isAdmin(accountId).catch(() => false);

    if (target === 'test' && !admin) {
      return res.status(403).json({
        error: 'target=test dials this deployment\'s TEST_PHONE_NUMBER, which is not yours to call',
      });
    }
    if (!schedule) {
      return res.status(400).json({
        error: `No enabled ${dose} schedule on your account — create one first`,
      });
    }
    if (!schedule.contact?.phone) {
      return res.status(400).json({ error: 'That schedule has no contact to call' });
    }
  }

  // target=test redirects the call to your own phone while still using the
  // schedule's message and settings — the point is to hear what she would hear.
  const to = target === 'test'
    ? config.testPhone
    : (schedule && schedule.contact && schedule.contact.phone) || (accountId ? null : config.grandmaPhone);

  if (!to) {
    return res.status(400).json({
      error: target === 'test'
        ? 'TEST_PHONE_NUMBER is not set'
        : 'No contact phone — seed a schedule with a contact, or set GRANDMA_PHONE_NUMBER',
    });
  }

  logger.info('Manual trigger', { dose, target, scheduleId: schedule ? schedule.id : null });

  res.json({
    ok:       true,
    dose,
    target,
    mode:     config.mockMode ? 'mock' : 'real',
    source:   schedule ? 'database' : 'env fallback',
    schedule: schedule ? { id: schedule.id, name: schedule.name, contact: schedule.contact?.name } : null,
  });

  // Fire after response so the HTTP client gets a reply immediately
  setImmediate(() => {
    callManager.initiateCall(dose, 1, { to, schedule }).catch(err =>
      logger.error('Trigger call failed', { error: err.message })
    );
  });
});

// Health check — also Railway's healthcheck target.
// Echoes the resolved baseUrl so you can confirm the webhook URL Twilio will be
// handed without shelling into the container.
//
// Note the status code: this returns 200 even when the database is down, and
// reports the database as a field instead. Railway restarts the container when
// its healthcheck fails, and a process that can still place calls should not be
// killed over a Postgres blip. Read the `db` field to see the real state.
app.get('/health', async (_req, res) => {
  const db = await database.ping();

  res.json({
    status:   'ok',
    mode:     config.mockMode ? 'mock' : 'real',
    db:       db.ok ? 'ok' : 'down',
    dbReason: db.ok ? undefined : db.reason,
    timezone: config.timezone,
    baseUrl:  config.baseUrl,
    uptime:   Math.round(process.uptime()),
  });
});

// Mock mode drives an interactive readline prompt, which needs a terminal.
// On Railway stdin is closed, so it would sit waiting for input that never
// arrives and place no calls at all — fail fast instead.
function assertMockModeIsRunnable() {
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  if (config.mockMode && (onRailway || config.nodeEnv === 'production')) {
    logger.error('MOCK_MODE=true cannot run here — it needs an interactive terminal. Set MOCK_MODE=false.');
    process.exit(1);
  }
}

function assertConfigIsValid() {
  const problems = config.validate();
  if (problems.length) {
    logger.error('Refusing to start — configuration is incomplete', { problems });
    for (const p of problems) console.error(`  x ${p}`);
    process.exit(1);
  }
}

// CLI: node app.js --test [morning|evening]
// In test mode skip the server entirely — mock calls don't need webhooks,
// and skipping the listen avoids port conflicts on repeated runs.
const testIdx = process.argv.indexOf('--test');
if (testIdx !== -1) {
  const dose = (process.argv[testIdx + 1] || 'morning').toLowerCase();
  if (!['morning', 'evening'].includes(dose)) {
    console.error('Usage: node app.js --test [morning|evening]');
    process.exit(1);
  }
  assertMockModeIsRunnable();
  assertConfigIsValid();
  callManager.initiateCall(dose, 1)
    .then(() => process.exit(0))
    .catch(err => {
      logger.error('CLI test failed', { error: err.message });
      process.exit(1);
    });
} else {
  assertMockModeIsRunnable();
  assertConfigIsValid();

  // The webhook signature check is the only thing standing between the public
  // /webhook routes and anyone who finds the URL — those routes drive real
  // calls, retries and alerts. Turning it off is a legitimate local debugging
  // move and a silent hole anywhere else, so switching it off is never quiet.
  if (!config.validateTwilioSignature) {
    const detail = {
      fix: 'set VALIDATE_TWILIO_SIGNATURE=true (and TWILIO_AUTH_TOKEN) unless you are curl-testing locally',
    };
    const message = 'WEBHOOKS ARE UNAUTHENTICATED — VALIDATE_TWILIO_SIGNATURE=false, so anyone who finds the URL can drive the call flow';
    if (config.mockMode) logger.warn(message, detail);
    else                 logger.error(message, detail);
  }

  // Bind 0.0.0.0 explicitly. Node's default (:: with IPv4 fallback) already
  // accepts external connections, but Railway's edge connects over IPv4 and
  // their docs call for 0.0.0.0 — being explicit removes it as a suspect.
  const server = app.listen(config.port, '0.0.0.0', () => {
    const addr = server.address();
    logger.info('Medication reminder started', {
      port:     config.port,
      // Diagnostic: portFromEnv=false means Railway did not inject PORT and we
      // fell back to 3000 — the public domain's target port must then be 3000.
      portFromEnv: Boolean(process.env.PORT),
      boundTo:  `${addr.address}:${addr.port}`,
      mode:     config.mockMode ? 'mock' : 'real',
      timezone: config.timezone,
      baseUrl:  config.baseUrl,
    });

    scheduler.start();

    // Runs on its own minute tick, independent of the scheduler: a retry queued
    // before a restart is picked up by whichever process comes back, which is
    // the whole point of persisting it.
    retrySweeper.start();

    // Admin alerts and the daily heartbeat. Says so at boot when
    // ADMIN_ALERT_PHONE is unset, because "failures are log-only" is a state
    // the operator should have chosen, not discovered.
    adminAlert.start();

    if (config.mockMode) {
      console.log('');
      console.log('  MOCK MODE is ON — no real Twilio calls will be made.');
      console.log('  To run a test right now (in a new terminal):');
      console.log('    npm run test:morning');
      console.log('    npm run test:evening');
      console.log('');
    }
  });

  // Railway sends SIGTERM on every deploy. Stop the cron jobs and drain
  // in-flight requests instead of dying mid-webhook.
  //
  // A pending retry is no longer at risk here: it lives in call_history with
  // next_retry_at set, so whichever process comes back after the deploy sweeps
  // it up. Stopping the sweeper cleanly just avoids starting work we cannot
  // finish before the process exits.
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    scheduler.stop();
    retrySweeper.stop();
    adminAlert.stop();
    server.close(async () => {
      await database.disconnect();
      logger.info('Shutdown complete');
      process.exit(0);
    });

    // Don't hang forever if a connection refuses to close.
    setTimeout(() => process.exit(0), 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}
