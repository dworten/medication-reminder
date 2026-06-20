'use strict';

require('dotenv').config();

const express     = require('express');
const config      = require('./src/config');
const logger      = require('./src/logger');
const twimlRouter = require('./src/twimlHandler');
const scheduler   = require('./src/scheduler');
const callManager = require('./src/callManager');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// TwiML webhook routes — Twilio POSTs here during live calls
app.use('/webhook', twimlRouter);

// Manual trigger: POST /trigger?dose=morning  (or body: { "dose": "morning" })
// Useful for ad-hoc testing without waiting for the cron schedule
app.post('/trigger', async (req, res) => {
  const dose = (req.body.dose || req.query.dose || 'morning').toLowerCase();
  const target = (req.body.target || req.query.target || 'grandma').toLowerCase();
  if (!['morning', 'evening'].includes(dose)) {
    return res.status(400).json({ error: 'dose must be "morning" or "evening"' });
  }
  if (!['grandma', 'test'].includes(target)) {
    return res.status(400).json({ error: 'target must be "grandma" or "test"' });
  }
  const to = target === 'test' ? config.testPhone : config.grandmaPhone;
  if (!to) {
    return res.status(400).json({ error: `${target === 'test' ? 'TEST_PHONE_NUMBER' : 'GRANDMA_PHONE_NUMBER'} is not set` });
  }
  logger.info('Manual trigger', { dose, target });
  res.json({ ok: true, dose, target, mode: config.mockMode ? 'mock' : 'real' });

  // Fire after response so the HTTP client gets a reply immediately
  setImmediate(() => {
    callManager.initiateCall(dose, 1, { to }).catch(err =>
      logger.error('Trigger call failed', { error: err.message })
    );
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    mode:     config.mockMode ? 'mock' : 'real',
    timezone: config.timezone,
    uptime:   Math.round(process.uptime()),
  });
});

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
  callManager.initiateCall(dose, 1)
    .then(() => process.exit(0))
    .catch(err => {
      logger.error('CLI test failed', { error: err.message });
      process.exit(1);
    });
} else {
  app.listen(config.port, () => {
    logger.info('Medication reminder started', {
      port:     config.port,
      mode:     config.mockMode ? 'mock' : 'real',
      timezone: config.timezone,
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
}
