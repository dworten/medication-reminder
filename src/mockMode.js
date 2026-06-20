'use strict';

const readline = require('readline');
const config   = require('./config');
const logger   = require('./logger');

// Line queue — handles both interactive TTY and piped input (e.g. printf '2\n' | node app.js)
// Without this, piped lines emitted before the next listener is registered are lost.
const _lineQueue = [];
const _waiters   = [];
let   _rl        = null;

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
}

function ask(question) {
  _ensureRL();
  process.stdout.write(question);
  return new Promise(resolve => {
    if (_lineQueue.length) {
      resolve(_lineQueue.shift());
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

// Entry point: simulate placing a call
async function runMockCall(dose, attempt) {
  console.log(`\n${HR}`);
  console.log(`  MOCK CALL  |  Dose: ${dose.toUpperCase()}  |  Attempt: ${attempt} / ${config.maxCallAttempts}`);
  console.log(`  Calling:   ${config.grandmaPhone || '(GRANDMA_PHONE_NUMBER not set in .env)'}`);
  console.log(HR);
  console.log('  Simulate the phone ringing. Enter a response:\n');
  console.log('    1 or yes       → she picks up and says yes');
  console.log('    2 or no        → she picks up and says no');
  console.log('    [Enter] or "no answer" → no pickup / voicemail\n');

  const raw   = await ask('  > ');
  const input = raw.toLowerCase();

  if (!input || input === 'no answer' || input === 'noanswer' || input === 'voicemail') {
    logger.call('Mock: no answer', { dose, attempt });
    await _handleNoAnswer(dose, attempt);
    return;
  }

  // She picked up — play the initial message
  voice(
    'Hi, this is your medicine reminder. Have you taken your medicine? ' +
    'Say Yes or No, or type 1 for yes and 2 for no.'
  );

  await _handleResponse(dose, attempt, input, 0);
}

// Recursive response handler — mirrors TwiML /webhook/response logic
async function _handleResponse(dose, attempt, input, repromptCount) {
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
  if (repromptCount >= config.maxReprompts) {
    voice("I wasn't able to confirm that you've taken your medicine. Please take it as soon as possible. Goodbye.");
    console.log('\n  ❌  Max reprompts reached without confirmation.\n');
    logger.call('Mock: max reprompts reached', { dose, attempt, repromptCount });
    await _sendEscalationSms(dose, 'answered but never confirmed medication taken');
    return;
  }

  // Reprompt
  const repromptNum = repromptCount + 1;
  voice(
    "Please take your medicine now. I'll ask again. " +
    'Have you taken your medicine? Say Yes or No, or type 1 for yes and 2 for no.'
  );
  console.log(`\n  (Reprompt ${repromptNum} of ${config.maxReprompts})\n`);
  console.log('    1 or yes → confirmed    2 or no → still no\n');

  const next = (await ask('  > ')).toLowerCase();
  await _handleResponse(dose, attempt, next, repromptNum);
}

// Simulate no-answer with retry logic
async function _handleNoAnswer(dose, attempt) {
  const maxAttempts  = config.maxCallAttempts;
  const delayMinutes = Math.round(config.retryDelayMs / 60000);

  if (attempt < maxAttempts) {
    const next = attempt + 1;
    console.log(`\n  📵  No answer. In live mode a retry would fire in ${delayMinutes} min.`);
    console.log(`      Simulating retry ${next} / ${maxAttempts} immediately...\n`);
    logger.call('Mock: no answer, retrying', { dose, attempt, nextAttempt: next });
    await runMockCall(dose, next);
  } else {
    console.log(`\n  📵  All ${maxAttempts} attempts exhausted.\n`);
    logger.call('Mock: all attempts exhausted', { dose });
    await _sendEscalationSms(dose, `no answer after all ${maxAttempts} attempts`);
  }
}

async function _sendEscalationSms(dose, reason) {
  const smsAlert = require('./smsAlert');
  const timeStr  = new Date().toLocaleString('en-US', { timeZone: config.timezone });
  const to       = config.caregiverPhone || '(CAREGIVER_PHONE_NUMBER not set in .env)';
  const body     = `MEDICATION ALERT: Could not confirm ${dose} dose taken as of ${timeStr}. (${reason})`;
  await smsAlert.send(to, body);
}

module.exports = { runMockCall };
