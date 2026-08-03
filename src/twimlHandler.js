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

    // Stage 4 escalation chain. Absent on every reminder call, which is what
    // makes `kind` default to REMINDER_CALL and leaves that path untouched.
    kind:       req.query.k   || 'REMINDER_CALL',
    followUpId: req.query.fu  || null,
    recipient:  req.query.who || null,
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
  // Only emitted when set, so a reminder call's URLs are byte-for-byte what
  // they were before Stage 4.
  if (ctx.kind && ctx.kind !== 'REMINDER_CALL') params.set('k', ctx.kind);
  if (ctx.followUpId) params.set('fu',  ctx.followUpId);
  if (ctx.recipient)  params.set('who', ctx.recipient);
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
// `question` defaults to the medication prompt — the escalation call passes its
// own, since "press 1 to acknowledge" is a different ask entirely.
function gatherTwiml(body, actionUrl, question = MSG_QUESTION) {
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
    g.say(question);
  } else {
    g.say(sayOpts(body), `${body.say} ${question}`);
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

// ─── Escalation call (Stage 4) ───────────────────────────────────────────────
//
// Deliberately its own pair of routes rather than a branch inside /initial and
// /response. This call has a different audience, a different script and a
// different meaning for "yes", and the reminder path is the part of this app
// that must not break — so it is left alone entirely.

const ESC_QUESTION = 'Press 1 to acknowledge this alert.';
const ESC_ACK      = 'Thank you. This alert has been acknowledged. Goodbye.';
const ESC_UNACK    = 'No acknowledgment received. A text message will be sent instead. Goodbye.';

function escalationMessage(ctx) {
  const who  = ctx.recipient ? `${ctx.recipient}` : 'The medication recipient';
  const when = ctx.dose === 'morning' ? 'morning' : 'evening';
  return `This is an automated medication alert. ${who} did not confirm taking the ${when} medication.`;
}

// Called by Twilio when the fallback contact answers
// POST /webhook/escalation?dose=&ch=&fu=&who=&k=ESCALATION_CALL
router.post('/escalation', (req, res) => {
  const ctx = readContext(req);
  logger.call('webhook /escalation', {
    dose: ctx.dose, callHistoryId: ctx.callHistoryId, followUpSmsId: ctx.followUpId,
  });

  // No database read at all on this path: everything the message needs already
  // rode in on the query string, and an alert call is the last place to add a
  // round trip that can time out.
  const action = `/webhook/escalation-response?${contextQuery(ctx, { reprompts: 0 })}`;
  res.type('text/xml').send(
    gatherTwiml({ say: escalationMessage(ctx) }, action, ESC_QUESTION)
  );
});

// POST /webhook/escalation-response?...&reprompts=0[&noInput=1]
router.post('/escalation-response', async (req, res) => {
  const ctx       = readContext(req);
  const reprompts = parseInt(req.query.reprompts || '0', 10);

  const digits   = (req.body.Digits || '').trim();
  const speech   = (req.body.SpeechResult || '').toLowerCase().trim();
  const response = classifyResponse(digits, speech);

  logger.call('webhook /escalation-response', {
    dose: ctx.dose, reprompts, digits, speech, response, callHistoryId: ctx.callHistoryId,
  });

  const r = new VoiceResponse();
  const callManager = require('./callManager');

  if (response === 'yes') {
    // Awaited, unlike the reminder path's fire-and-forget confirm: the follow-up
    // SMS is due on a clock, and cancelling it after the response has gone out
    // means racing the sweeper for it.
    await callManager.acknowledgeEscalation({
      callHistoryId: ctx.callHistoryId,
      followUpId:    ctx.followUpId,
      dose:          ctx.dose,
    });
    r.say(ESC_ACK);
    r.hangup();

  } else if (reprompts >= ctx.maxReprompts) {
    // Nothing to do here: the SMS is already queued and the status callback
    // pulls it forward when the call ends. Saying so is only courtesy.
    r.say(ESC_UNACK);
    r.hangup();

  } else {
    const action = `/webhook/escalation-response?${contextQuery(ctx, { reprompts: reprompts + 1 })}`;
    res.type('text/xml').send(
      gatherTwiml({ say: escalationMessage(ctx) }, action, ESC_QUESTION)
    );
    return;
  }

  res.type('text/xml').send(r.toString());
});

// Called by Twilio for call status updates (no-answer, busy, failed, completed)
// POST /webhook/status?dose=morning&attempt=1[&sched=&ch=&mr=&k=&fu=]
router.post('/status', async (req, res) => {
  const status = req.body.CallStatus || '';
  const ctx    = readContext(req);

  logger.call('webhook /status', {
    status, dose: ctx.dose, attempt: ctx.attempt, callSid: req.body.CallSid,
  });

  const OUTCOME_BY_STATUS = { 'no-answer': 'NO_ANSWER', busy: 'BUSY', failed: 'FAILED' };
  const outcome = OUTCOME_BY_STATUS[status];

  // An escalation call that goes unanswered escalates onward to the SMS; it does
  // not redial. Routing it into handleNoAnswer would put the caregiver into the
  // recipient's retry loop, which is not what "fallback" means.
  if (ctx.kind === 'ESCALATION_CALL') {
    if (outcome || status === 'completed') {
      setImmediate(() => {
        const callManager = require('./callManager');
        callManager.handleEscalationCallEnded(ctx.dose, {
          callHistoryId: ctx.callHistoryId,
          followUpId:    ctx.followUpId,
          outcome,
        }).catch(err => logger.error('handleEscalationCallEnded error', { error: err.message }));
      });
    }
    return res.sendStatus(200);
  }

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
module.exports.classifyResponse   = classifyResponse;
module.exports.gatherTwiml        = gatherTwiml;
module.exports.resolveBody        = resolveBody;
module.exports.contextQuery       = contextQuery;
module.exports.escalationMessage  = escalationMessage;
