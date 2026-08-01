'use strict';

// Loads .env locally; a no-op on Railway, where variables come from the
// service's environment directly.
require('dotenv').config();

const express     = require('express');
const config      = require('./src/config');
const logger      = require('./src/logger');
const twimlRouter = require('./src/twimlHandler');
const scheduler   = require('./src/scheduler');
const callManager = require('./src/callManager');
const database    = require('./src/db');
const { requireTriggerSecret } = require('./src/security');

const app = express();

// Railway terminates TLS at its edge and forwards over http, so without this
// req.ip is the proxy's address rather than the caller's.
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// TwiML webhook routes — Twilio POSTs here during live calls.
// Signature-guarded inside the router.
app.use('/webhook', twimlRouter);

// Manual trigger: POST /trigger?dose=morning  (or body: { "dose": "morning" })
// Useful for ad-hoc testing without waiting for the cron schedule.
// Guarded by TRIGGER_SECRET — this places real, billable calls.
// Resolves which schedule a manual trigger should imitate, so a test call uses
// the same contact, message and escalation settings the real call would.
// Falls back to the env phone number when nothing is seeded yet.
async function resolveTriggerSchedule({ scheduleId, dose }) {
  const scheduleRepo = require('./src/data/schedules');

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

  let schedule = null;
  try {
    schedule = await resolveTriggerSchedule({ scheduleId, dose });
  } catch (err) {
    logger.error('Trigger could not load schedule', { error: err.message });
  }

  if (scheduleId && !schedule) {
    return res.status(404).json({ error: `no schedule with id ${scheduleId}` });
  }

  // target=test redirects the call to your own phone while still using the
  // schedule's message and settings — the point is to hear what she would hear.
  const to = target === 'test'
    ? config.testPhone
    : (schedule && schedule.contact && schedule.contact.phone) || config.grandmaPhone;

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
  // Note: a pending in-memory retry (callManager's setTimeout) is still lost on
  // restart — that's what the DB-backed retry sweeper in phase 2 fixes.
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    scheduler.stop();
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
