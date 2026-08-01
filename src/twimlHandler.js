'use strict';

const express = require('express');
const twilio  = require('twilio');
const config  = require('./config');
const logger  = require('./logger');
const { twilioWebhookGuard } = require('./security');

const scheduleRepo    = require('./data/schedules');
const callHistoryRepo = require('./data/callHistory');

const router = express.Router();
const { VoiceResponse } = twilio.twiml;

// Every route below drives real call behaviour, so none of them are open.
router.use(twilioWebhookGuard);

// The question is always asked by the app, never by the message row. A custom
// message supplies the reminder BODY; this sentence is appended so the Gather
// that follows always makes sense, no matter what someone types into the
// messages table (or plays as an audio file).
//
// Split this way, MSG_BODY_DEFAULT + MSG_QUESTION is character-for-character
// the prompt this app has always spoken.
const MSG_QUESTION     = 'Have you taken your medicine? Say Yes or No, or type 1 for yes and 2 for no.';
const MSG_BODY_DEFAULT = 'Hi, this is your medicine reminder.';
const MSG_BODY_REPROMPT = "Please take your medicine now. I'll ask again.";
const MSG_EXHAUST      = "I wasn't able to confirm that you've taken your medicine. Please take it as soon as possible. Goodbye.";

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

// Context threaded through the call via the webhook query string. dose and
// attempt are unchanged from before; the rest are additive and every one has a
// fallback, so a call placed before a deploy still completes on the new code.
function readContext(req) {
  return {
    dose:         req.query.dose || 'morning',
    attempt:      parseInt(req.query.attempt || '1', 10),
    scheduleId:   req.query.sched || null,
    callHistoryId: req.query.ch || null,
    maxReprompts: parseInt(req.query.mr || String(config.maxReprompts), 10),
  };
}

// Rebuilds the query string for the next hop, preserving context.
function contextQuery(ctx, extra = {}) {
  const params = new URLSearchParams();
  params.set('dose', ctx.dose);
  params.set('attempt', String(ctx.attempt));
  if (ctx.scheduleId)    params.set('sched', ctx.scheduleId);
  if (ctx.callHistoryId) params.set('ch', ctx.callHistoryId);
  params.set('mr', String(ctx.maxReprompts));
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  return params.toString();
}

// A live call is waiting on this response, and Twilio gives up on a slow
// webhook. A database that is merely slow must degrade to the default prompt,
// not stall the call.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise(resolve => setTimeout(() => resolve(fallback), ms).unref()),
  ]);
}

// Resolves what to speak (or play) for the reminder body.
// Falls back to the built-in wording whenever there is no schedule, no message
// on it, or the database cannot be reached in time.
async function resolveBody(scheduleId) {
  if (!scheduleId) return { say: MSG_BODY_DEFAULT };

  const schedule = await withTimeout(scheduleRepo.getById(scheduleId), 2000, null);
  const message  = schedule && schedule.message;

  if (!message) return { say: MSG_BODY_DEFAULT };

  if (message.kind === 'AUDIO' && message.audioUrl) {
    return { play: message.audioUrl };
  }
  if (message.kind === 'TTS' && message.ttsText) {
    return { say: message.ttsText, voice: message.voice, language: message.language };
  }

  logger.warn('Message row unusable, falling back to default prompt', {
    messageId: message.id, kind: message.kind,
  });
  return { say: MSG_BODY_DEFAULT };
}

function sayOpts(body) {
  const opts = {};
  if (body.voice)    opts.voice    = body.voice;
  if (body.language) opts.language = body.language;
  return opts;
}

// body is { say } or { play }; the question is always spoken after it.
function gatherTwiml(body, actionUrl) {
  const r = new VoiceResponse();
  const g = r.gather({
    input:         'dtmf speech',
    numDigits:     '1',
    timeout:       10,
    speechTimeout: 'auto',
    action:        actionUrl,
    method:        'POST',
  });

  if (body.play) {
    g.play(body.play);
    g.say(MSG_QUESTION);
  } else {
    g.say(sayOpts(body), `${body.say} ${MSG_QUESTION}`);
  }

  // Fallback when Gather times out with no input — treat as a non-answer
  r.redirect({ method: 'POST' }, `${actionUrl}&noInput=1`);
  return r.toString();
}

// Called by Twilio when the call is answered
// POST /webhook/initial?dose=morning&attempt=1[&sched=&ch=&mr=]
router.post('/initial', async (req, res) => {
  const ctx = readContext(req);
  logger.call('webhook /initial', { dose: ctx.dose, attempt: ctx.attempt, scheduleId: ctx.scheduleId });

  const body   = await resolveBody(ctx.scheduleId);
  const action = `/webhook/response?${contextQuery(ctx, { reprompts: 0 })}`;

  res.type('text/xml').send(gatherTwiml(body, action));
});

// Called by Twilio with the gathered keypad / speech result
// POST /webhook/response?...&reprompts=0[&noInput=1]
router.post('/response', async (req, res) => {
  const ctx       = readContext(req);
  const reprompts = parseInt(req.query.reprompts || '0', 10);
  const noInput   = req.query.noInput === '1';

  const digits = (req.body.Digits || '').trim();
  const speech = (req.body.SpeechResult || '').toLowerCase().trim();
  const response = classifyResponse(digits, speech);

  logger.call('webhook /response', {
    dose: ctx.dose, attempt: ctx.attempt, reprompts, digits, speech, response, noInput,
  });

  const r = new VoiceResponse();

  if (response === 'yes') {
    r.say(goodbyeMsg(ctx.dose));
    r.hangup();
    logger.call('Confirmed via call', { dose: ctx.dose, attempt: ctx.attempt, reprompts });

    // Fire-and-forget: the caller is hanging up either way, and a slow database
    // must not delay the goodbye.
    setImmediate(() => {
      callHistoryRepo.recordOutcome(ctx.callHistoryId, 'CONFIRMED', { repromptCount: reprompts })
        .catch(err => logger.error('recordOutcome error', { error: err.message }));
    });

  } else if (reprompts >= ctx.maxReprompts) {
    r.say(MSG_EXHAUST);
    r.hangup();
    logger.call('Max reprompts reached, escalating', { dose: ctx.dose, attempt: ctx.attempt });
    setImmediate(() => {
      const callManager = require('./callManager');
      callManager.handleNeverConfirmed(ctx.dose, ctx.attempt, {
        scheduleId:    ctx.scheduleId,
        callHistoryId: ctx.callHistoryId,
        repromptCount: reprompts,
      }).catch(err => logger.error('handleNeverConfirmed error', { error: err.message }));
    });

  } else {
    const nextReprompts = reprompts + 1;
    const action = `/webhook/response?${contextQuery(ctx, { reprompts: nextReprompts })}`;
    // The reprompt uses the built-in nudge rather than the custom message: the
    // message row is the reminder, this is the "are you still there" follow-up.
    res.type('text/xml').send(gatherTwiml({ say: MSG_BODY_REPROMPT }, action));
    return;
  }

  res.type('text/xml').send(r.toString());
});

// Called by Twilio for call status updates (no-answer, busy, failed, completed)
// POST /webhook/status?dose=morning&attempt=1[&sched=&ch=&mr=]
router.post('/status', async (req, res) => {
  const status = req.body.CallStatus || '';
  const ctx    = readContext(req);

  logger.call('webhook /status', {
    status, dose: ctx.dose, attempt: ctx.attempt, callSid: req.body.CallSid,
  });

  const OUTCOME_BY_STATUS = { 'no-answer': 'NO_ANSWER', busy: 'BUSY', failed: 'FAILED' };
  const outcome = OUTCOME_BY_STATUS[status];

  if (outcome) {
    setImmediate(() => {
      const callManager = require('./callManager');
      callManager.handleNoAnswer(ctx.dose, ctx.attempt, {
        scheduleId:    ctx.scheduleId,
        callHistoryId: ctx.callHistoryId,
        outcome,
      }).catch(err => logger.error('handleNoAnswer error', { error: err.message }));
    });
  } else if (status === 'completed') {
    // Answered, but no confirmation ever recorded — she picked up and hung up.
    // Guarded on PENDING so it can never overwrite a CONFIRMED written moments
    // earlier by /response.
    setImmediate(() => {
      callHistoryRepo.closeIfPending(ctx.callHistoryId, 'NOT_CONFIRMED')
        .catch(err => logger.error('closeIfPending error', { error: err.message }));
    });
  }

  res.sendStatus(200);
});

module.exports = router;
module.exports.classifyResponse = classifyResponse;
module.exports.gatherTwiml      = gatherTwiml;
module.exports.resolveBody      = resolveBody;
module.exports.contextQuery     = contextQuery;
