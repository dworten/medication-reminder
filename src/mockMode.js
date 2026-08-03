'use strict';

const readline = require('readline');
const config   = require('./config');
const logger   = require('./logger');

// Line queue — handles both interactive TTY and piped input (e.g. printf '2\n' | node app.js)
// Without this, piped lines emitted before the next listener is registered are lost.
const _lineQueue = [];
const _waiters   = [];
let   _rl        = null;
let   _closed    = false;

function _ensureRL() {
  if (_rl) return;
  _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  _rl.on('line', line => {
    if (_waiters.length) {
      _waiters.shift()(line);
    } else {
      _lineQueue.push(line);
    }
  });
  // Piped input can run out mid-scenario (or stdin may be closed entirely).
  // Without this, every pending ask() would hang forever; an empty line is the
  // "no answer" branch, which is the right default for a missing response.
  // The flag matters as much as the drain: prompts issued *after* close would
  // otherwise queue a waiter that nothing will ever resolve.
  _rl.on('close', () => {
    _closed = true;
    while (_waiters.length) _waiters.shift()('');
  });
}

function ask(question) {
  _ensureRL();
  process.stdout.write(question);
  return new Promise(resolve => {
    if (_lineQueue.length) {
      resolve(_lineQueue.shift());
    } else if (_closed) {
      resolve('');
    } else {
      _waiters.push(resolve);
    }
  });
}

const HR = '═'.repeat(62);

function voice(msg) {
  console.log(`\n  🔊  "${msg}"`);
}

function info(msg) {
  console.log(`  ↳  ${msg}`);
}

// Settings come from the schedule when a schedule fired the call, so a local
// simulation reflects what the database actually says. Falls back to the env
// values when called without context.
function _settings(opts) {
  return opts.settings || {
    maxAttempts:  config.maxCallAttempts,
    maxReprompts: config.maxReprompts,
    retryDelayMs: config.retryDelayMs,
  };
}

// Entry point: simulate placing a call
// opts: { settings, to }
async function runMockCall(dose, attempt, opts = {}) {
  const settings = _settings(opts);
  const to       = opts.to || config.grandmaPhone;

  console.log(`\n${HR}`);
  console.log(`  MOCK CALL  |  Dose: ${dose.toUpperCase()}  |  Attempt: ${attempt} / ${settings.maxAttempts}`);
  console.log(`  Calling:   ${to || '(no contact phone — check the schedule or GRANDMA_PHONE_NUMBER)'}`);
  console.log(HR);
  console.log('  Simulate the phone ringing. Enter a response:\n');
  console.log('    1 or yes       → she picks up and says yes');
  console.log('    2 or no        → she picks up and says no');
  console.log('    [Enter] or "no answer" → no pickup / voicemail\n');

  const raw   = await ask('  > ');
  const input = raw.toLowerCase();

  if (!input || input === 'no answer' || input === 'noanswer' || input === 'voicemail') {
    logger.call('Mock: no answer', { dose, attempt });
    await _handleNoAnswer(dose, attempt, opts);
    return;
  }

  // She picked up — play the initial message
  voice(
    'Hi, this is your medicine reminder. Have you taken your medicine? ' +
    'Say Yes or No, or type 1 for yes and 2 for no.'
  );

  await _handleResponse(dose, attempt, input, 0, opts);
}

// Recursive response handler — mirrors TwiML /webhook/response logic
async function _handleResponse(dose, attempt, input, repromptCount, opts = {}) {
  const settings = _settings(opts);
  const isYes = ['1', 'yes', 'y', 'yep', 'yeah', 'yup'].includes(input);
  const isNo  = ['2', 'no',  'n', 'nope', 'nah'].includes(input);

  if (!isYes && !isNo) {
    info(`Unrecognized input "${input}" — treating as no response.`);
  }

  if (isYes) {
    const msg = dose === 'morning'
      ? 'Great! Have a good rest of your day.'
      : 'Great! Have a good night.';
    voice(msg);
    console.log('\n  ✅  Medication confirmed. Call complete.\n');
    logger.call('Mock: medication confirmed', { dose, attempt, repromptCount });
    return;
  }

  // "No" or unrecognized
  if (repromptCount >= settings.maxReprompts) {
    voice("I wasn't able to confirm that you've taken your medicine. Please take it as soon as possible. Goodbye.");
    console.log('\n  ❌  Max reprompts reached without confirmation.\n');
    logger.call('Mock: max reprompts reached', { dose, attempt, repromptCount });
    await _runEscalation(dose, 'answered but never confirmed medication taken', opts);
    return;
  }

  // Reprompt
  const repromptNum = repromptCount + 1;
  voice(
    "Please take your medicine now. I'll ask again. " +
    'Have you taken your medicine? Say Yes or No, or type 1 for yes and 2 for no.'
  );
  console.log(`\n  (Reprompt ${repromptNum} of ${settings.maxReprompts})\n`);
  console.log('    1 or yes → confirmed    2 or no → still no\n');

  const next = (await ask('  > ')).toLowerCase();
  await _handleResponse(dose, attempt, next, repromptNum, opts);
}

// Simulate no-answer with retry logic
async function _handleNoAnswer(dose, attempt, opts = {}) {
  const settings     = _settings(opts);
  const maxAttempts  = settings.maxAttempts;
  const delayMinutes = Math.round(settings.retryDelayMs / 60000);

  if (attempt < maxAttempts) {
    const next = attempt + 1;
    console.log(`\n  📵  No answer. In live mode a retry would fire in ${delayMinutes} min.`);
    console.log(`      Simulating retry ${next} / ${maxAttempts} immediately...\n`);
    logger.call('Mock: no answer, retrying', { dose, attempt, nextAttempt: next });
    await runMockCall(dose, next, opts);
  } else {
    console.log(`\n  📵  All ${maxAttempts} attempts exhausted.\n`);
    logger.call('Mock: all attempts exhausted', { dose });
    await _runEscalation(dose, `no answer after all ${maxAttempts} attempts`, opts);
  }
}

// Walks the Stage 4 escalation chain in the terminal.
//
// Mock mode never touches the database — the point of it is to try the flow with
// no Twilio account and no Postgres — so this mirrors the chain rather than
// running it. What it does read is the schedule that fired the call, so the
// branch you see locally is the branch your real configuration would take.
async function _runEscalation(dose, reason, opts = {}) {
  const schedule = opts.schedule || null;

  const withCall = schedule ? schedule.escalateWithCall : config.escalateWithCall;
  const withSms  = schedule ? schedule.escalateWithSms  : config.escalateWithSms;

  const fallback = (schedule && schedule.escalationContact) || null;
  const to = (fallback && fallback.phone)
    || config.caregiverPhone
    || '(CAREGIVER_PHONE_NUMBER not set in .env)';

  if (!withCall && !withSms) {
    console.log('\n  ⚠️   This schedule escalates with neither a call nor an SMS — nobody would be alerted.\n');
    logger.error('Mock: no escalation step enabled', { dose, reason });
    return;
  }

  let acknowledged = false;

  if (withCall) {
    const ackMinutes = (schedule && schedule.escalationAckMinutes) || config.escalationAckMinutes;

    console.log(`\n${HR}`);
    console.log(`  MOCK ESCALATION CALL  |  Dose: ${dose.toUpperCase()}`);
    console.log(`  Calling fallback:     ${to}${fallback ? `  (${fallback.name})` : ''}`);
    console.log(HR);
    if (withSms) {
      console.log(`  In live mode the follow-up SMS is already queued, due in ${ackMinutes} min`);
      console.log('  unless this call is acknowledged.\n');
    }
    console.log('    1 or yes       → acknowledges the alert');
    console.log('    [Enter] or "no answer" → no pickup / voicemail\n');

    const raw = (await ask('  > ')).toLowerCase();

    if (['1', 'yes', 'y', 'yep', 'yeah', 'yup'].includes(raw)) {
      voice('Thank you. This alert has been acknowledged. Goodbye.');
      acknowledged = true;
      logger.call('Mock: escalation acknowledged', { dose });
    } else {
      const who = (schedule && schedule.contact && schedule.contact.name) || 'The medication recipient';
      voice(`This is an automated medication alert. ${who} did not confirm taking the ${dose} medication. Press 1 to acknowledge this alert.`);
      info('Not acknowledged.');
      logger.call('Mock: escalation call unacknowledged', { dose });
    }
  }

  if (acknowledged) {
    console.log('\n  ✅  Acknowledged on the call — the follow-up SMS is cancelled.\n');
    return;
  }

  if (!withSms) {
    console.log('\n  ⚠️   No SMS step configured, so the chain ends here unacknowledged.\n');
    return;
  }

  const smsAlert = require('./smsAlert');
  const timeStr  = new Date().toLocaleString('en-US', { timeZone: (schedule && schedule.timezone) || config.timezone });
  const extra    = withCall ? ' We also tried calling you and could not reach you.' : '';
  await smsAlert.send(to, `MEDICATION ALERT: Could not confirm ${dose} dose taken as of ${timeStr}. (${reason})${extra}`);
}

module.exports = { runMockCall };
