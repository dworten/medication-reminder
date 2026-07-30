'use strict';

const express = require('express');
const twilio  = require('twilio');
const config  = require('./config');
const logger  = require('./logger');
const { twilioWebhookGuard } = require('./security');

const router = express.Router();
const { VoiceResponse } = twilio.twiml;

// Every route below drives real call behaviour, so none of them are open.
router.use(twilioWebhookGuard);

const MSG_INITIAL  = 'Hi, this is your medicine reminder. Have you taken your medicine? Say Yes or No, or type 1 for yes and 2 for no.';
const MSG_REPROMPT = "Please take your medicine now. I'll ask again. Have you taken your medicine? Say Yes or No, or type 1 for yes and 2 for no.";
const MSG_EXHAUST  = "I wasn't able to confirm that you've taken your medicine. Please take it as soon as possible. Goodbye.";

function goodbyeMsg(dose) {
  return dose === 'morning'
    ? 'Great! Have a good rest of your day.'
    : 'Great! Have a good night.';
}

function normalizeSpeech(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyResponse(digits, speech) {
  const normalizedSpeech = normalizeSpeech(speech);
  const words = normalizedSpeech.split(' ').filter(Boolean);
  const hasWord = (word) => words.includes(word);

  if (digits === '1' || hasWord('yes') || hasWord('yep') || hasWord('yeah') || hasWord('yup')) {
    return 'yes';
  }
  if (digits === '2' || hasWord('no') || hasWord('nope') || hasWord('nah')) {
    return 'no';
  }

  // Twilio speech recognition can transcribe keypad presses as spoken text like "1.".
  if (normalizedSpeech === '1' || hasWord('one')) return 'yes';
  if (normalizedSpeech === '2' || hasWord('two')) return 'no';

  return 'unknown';
}

function gatherTwiml(sayText, actionUrl) {
  const r  = new VoiceResponse();
  const g  = r.gather({
    input:         'dtmf speech',
    numDigits:     '1',
    timeout:       10,
    speechTimeout: 'auto',
    action:        actionUrl,
    method:        'POST',
  });
  g.say(sayText);
  // Fallback when Gather times out with no input — treat as a non-answer
  r.redirect({ method: 'POST' }, `${actionUrl}&noInput=1`);
  return r.toString();
}

// Called by Twilio when the call is answered
// GET/POST /webhook/initial?dose=morning&attempt=1
router.post('/initial', (req, res) => {
  const dose    = req.query.dose    || 'morning';
  const attempt = req.query.attempt || '1';
  logger.call('webhook /initial', { dose, attempt });

  const action = `/webhook/response?dose=${dose}&attempt=${attempt}&reprompts=0`;
  res.type('text/xml').send(gatherTwiml(MSG_INITIAL, action));
});

// Called by Twilio with the gathered keypad / speech result
// POST /webhook/response?dose=morning&attempt=1&reprompts=0[&noInput=1]
router.post('/response', async (req, res) => {
  const dose      = req.query.dose     || 'morning';
  const attempt   = parseInt(req.query.attempt   || '1', 10);
  const reprompts = parseInt(req.query.reprompts || '0', 10);
  const noInput   = req.query.noInput === '1';

  const digits = (req.body.Digits || '').trim();
  const speech = (req.body.SpeechResult || '').toLowerCase().trim();
  const response = classifyResponse(digits, speech);

  logger.call('webhook /response', { dose, attempt, reprompts, digits, speech, response, noInput });

  const r = new VoiceResponse();

  if (response === 'yes') {
    r.say(goodbyeMsg(dose));
    r.hangup();
    logger.call('Confirmed via call', { dose, attempt, reprompts });

  } else if (reprompts >= config.maxReprompts) {
    r.say(MSG_EXHAUST);
    r.hangup();
    logger.call('Max reprompts reached, escalating', { dose, attempt });
    setImmediate(() => {
      const callManager = require('./callManager');
      callManager.handleNeverConfirmed(dose, attempt).catch(err =>
        logger.error('handleNeverConfirmed error', { error: err.message })
      );
    });

  } else {
    const nextReprompts = reprompts + 1;
    const action        = `/webhook/response?dose=${dose}&attempt=${attempt}&reprompts=${nextReprompts}`;
    res.type('text/xml').send(gatherTwiml(MSG_REPROMPT, action));
    return;
  }

  res.type('text/xml').send(r.toString());
});

// Called by Twilio for call status updates (no-answer, busy, failed, completed)
// POST /webhook/status?dose=morning&attempt=1
router.post('/status', async (req, res) => {
  const status  = req.body.CallStatus || '';
  const dose    = req.query.dose      || 'morning';
  const attempt = parseInt(req.query.attempt || '1', 10);

  logger.call('webhook /status', { status, dose, attempt, callSid: req.body.CallSid });

  const noAnswerStatuses = ['no-answer', 'busy', 'failed'];
  if (noAnswerStatuses.includes(status)) {
    setImmediate(() => {
      const callManager = require('./callManager');
      callManager.handleNoAnswer(dose, attempt).catch(err =>
        logger.error('handleNoAnswer error', { error: err.message })
      );
    });
  }

  res.sendStatus(200);
});

module.exports = router;
