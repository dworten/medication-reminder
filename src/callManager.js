'use strict';

const config = require('./config');
const logger = require('./logger');

const accountRepo     = require('./data/accounts');
const scheduleRepo    = require('./data/schedules');
const callHistoryRepo = require('./data/callHistory');

function _twilioClient() {
  const twilio = require('twilio');

  if (config.twilioApiKeySid || config.twilioApiKeySecret) {
    if (!config.twilioAccountSid || !config.twilioApiKeySid || !config.twilioApiKeySecret) {
      throw new Error('Twilio API Key auth not set — check TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET in .env');
    }
    return twilio(config.twilioApiKeySid, config.twilioApiKeySecret, {
      accountSid: config.twilioAccountSid,
    });
  }

  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    throw new Error('Twilio credentials not set — check TWILIO_ACCOUNT_SID plus TWILIO_API_KEY_SID/TWILIO_API_KEY_SECRET, or legacy TWILIO_AUTH_TOKEN, in .env');
  }
  return twilio(config.twilioAccountSid, config.twilioAuthToken);
}

// Per-schedule settings win; the env values remain as the fallback for calls
// with no schedule behind them (a manual /trigger) and for anything that
// arrives without context.
function resolveSettings(schedule) {
  const fallbackDelayMinutes = Math.round(config.retryDelayMs / 60000);
  return {
    maxAttempts:  schedule?.maxAttempts       ?? config.maxCallAttempts,
    maxReprompts: schedule?.maxReprompts      ?? config.maxReprompts,
    retryDelayMs: (schedule?.retryDelayMinutes ?? fallbackDelayMinutes) * 60 * 1000,
  };
}

// options:
//   to             explicit destination, overrides the schedule's contact
//   schedule       a schedule row WITH relations (contact, message, escalation)
//   callHistoryId  an existing row to attach to, for retries
//   accountId      used when there is no schedule to take it from
async function initiateCall(dose, attempt, options = {}) {
  const schedule = options.schedule || null;
  const settings = resolveSettings(schedule);

  const to = options.to
    || (schedule && schedule.contact && schedule.contact.phone)
    || config.grandmaPhone;

  // Open the history row before dialling, so a call that throws still leaves a
  // trace. Failure here is logged and ignored: bookkeeping must never be the
  // reason a medication reminder does not go out.
  let callHistoryId = options.callHistoryId || null;
  if (!callHistoryId) {
    const accountId = options.accountId
      || (schedule && schedule.accountId)
      || await _defaultAccountId();

    if (accountId) {
      const row = await callHistoryRepo.startAttempt({
        accountId,
        scheduleId: schedule ? schedule.id : null,
        contactId:  schedule && schedule.contact ? schedule.contact.id : null,
        dose,
        attempt,
      });
      callHistoryId = row ? row.id : null;
    } else {
      logger.warn('No account found — call will be placed but not recorded', { dose, attempt });
    }
  }

  if (config.mockMode) {
    const mock = require('./mockMode');
    // The schedule rides along so the mock escalation chain branches the way the
    // real one would, instead of always assuming the env defaults.
    return mock.runMockCall(dose, attempt, { settings, to, schedule });
  }

  return _realCall(dose, attempt, { to, schedule, callHistoryId, settings });
}

async function _defaultAccountId() {
  try {
    const account = await accountRepo.getDefault();
    return account ? account.id : null;
  } catch (err) {
    logger.error('Could not load default account', { error: err.message });
    return null;
  }
}

// Webhook URLs carry dose and attempt exactly as they always have. Everything
// else is appended and optional, so a call placed before a deploy still
// completes correctly against the new code, and every handler falls back to the
// env defaults when a parameter is absent.
//
// maxReprompts rides along in the URL rather than being looked up per webhook:
// /webhook/response is inside a live call with the caller waiting, and a
// database round trip there would be both slow and one more thing that can
// fail mid-call.
function _webhookUrls({ dose, attempt, schedule, callHistoryId, settings }) {
  const params = new URLSearchParams();
  params.set('dose', dose);
  params.set('attempt', String(attempt));
  if (schedule)      params.set('sched', schedule.id);
  if (callHistoryId) params.set('ch', callHistoryId);
  params.set('mr', String(settings.maxReprompts));

  const qs = params.toString();
  return {
    callUrl:   `${config.baseUrl}/webhook/initial?${qs}`,
    statusUrl: `${config.baseUrl}/webhook/status?${qs}`,
  };
}

async function _realCall(dose, attempt, ctx) {
  const { to, callHistoryId } = ctx;

  if (!to) {
    await callHistoryRepo.recordOutcome(callHistoryId, 'FAILED', {
      errorMessage: 'no destination phone number',
    });
    throw new Error('No destination phone number set — check the schedule\'s contact, or GRANDMA_PHONE_NUMBER / TEST_PHONE_NUMBER in .env');
  }

  const client = _twilioClient();
  const { callUrl, statusUrl } = _webhookUrls({ dose, attempt, ...ctx });

  logger.call('Placing call', { dose, attempt, to, scheduleId: ctx.schedule?.id, callHistoryId });

  try {
    const call = await client.calls.create({
      to,
      from:                 config.twilioFromNumber,
      url:                  callUrl,
      statusCallback:       statusUrl,
      statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });

    logger.call('Call placed', { sid: call.sid, dose, attempt });
    await callHistoryRepo.attachCallSid(callHistoryId, call.sid);
    return call.sid;
  } catch (err) {
    await callHistoryRepo.recordOutcome(callHistoryId, 'FAILED', { errorMessage: err.message });
    throw err;
  }
}

// Loads the schedule behind an in-flight call. Returns null when the call has
// no schedule (a manual trigger) or the database is unavailable — callers fall
// back to the env settings rather than failing the call.
async function loadScheduleContext(scheduleId) {
  if (!scheduleId) return null;
  try {
    return await scheduleRepo.getById(scheduleId);
  } catch (err) {
    logger.error('Could not load schedule for in-flight call', { scheduleId, error: err.message });
    return null;
  }
}

// Triggered by Twilio status callback when a call goes unanswered.
// ctx carries { scheduleId, callHistoryId } parsed from the webhook URL.
async function handleNoAnswer(dose, attempt, ctx = {}) {
  const schedule = await loadScheduleContext(ctx.scheduleId);
  const settings = resolveSettings(schedule);

  logger.call('No answer / failed', { dose, attempt, maxAttempts: settings.maxAttempts });

  await callHistoryRepo.recordOutcome(ctx.callHistoryId, ctx.outcome || 'NO_ANSWER');

  if (attempt < settings.maxAttempts) {
    const next  = attempt + 1;
    const dueAt = new Date(Date.now() + settings.retryDelayMs);

    // Persisted, not a setTimeout. The old in-memory timer lived only in this
    // process, so a Railway deploy inside the retry window dropped the retry
    // and the missed-dose SMS that should have followed — silently. Writing
    // next_retry_at means a restart costs a minute of delay, not the dose.
    const persisted = await _persistRetry(ctx.callHistoryId, dueAt, { dose, nextAttempt: next });

    if (persisted) {
      logger.call('Retry persisted', {
        dose, nextAttempt: next, dueAt: dueAt.toISOString(), callHistoryId: ctx.callHistoryId,
      });
    } else {
      // Deliberately no in-memory fallback: reintroducing a timer here would
      // bring back the very failure this replaced, and worse, could double-call
      // if the write actually landed. Escalate instead — a caregiver alert is
      // strictly better than a retry nobody knows was lost.
      logger.error('RETRY LOST — could not persist next_retry_at; escalating instead', {
        dose, nextAttempt: next, callHistoryId: ctx.callHistoryId,
      });
      await escalate(dose, 'retry could not be scheduled (database unavailable)', schedule, ctx);
    }
  } else {
    await escalate(dose, `no answer after all ${settings.maxAttempts} attempts`, schedule, ctx);
  }
}

// The sweeper depends on this write, so it gets more than one shot at it before
// we conclude the retry is unrecoverable.
async function _persistRetry(callHistoryId, dueAt, meta, tries = 3) {
  if (!callHistoryId) {
    logger.error('No call_history row to attach a retry to — the database was unreachable when this call was placed', meta);
    return false;
  }

  for (let i = 1; i <= tries; i++) {
    try {
      await callHistoryRepo.scheduleRetry(callHistoryId, dueAt);
      return true;
    } catch (err) {
      logger.error(`Could not persist retry (attempt ${i}/${tries})`, { error: err.message, ...meta });
      if (i < tries) await new Promise(r => setTimeout(r, 300 * i));
    }
  }
  return false;
}

// Triggered by twimlHandler when max reprompts are exhausted inside an
// answered call.
async function handleNeverConfirmed(dose, attempt, ctx = {}) {
  const schedule = await loadScheduleContext(ctx.scheduleId);

  logger.call('Answered but never confirmed', { dose, attempt });

  await callHistoryRepo.recordOutcome(ctx.callHistoryId, 'NOT_CONFIRMED', {
    repromptCount: ctx.repromptCount,
  });

  await escalate(dose, 'answered but never confirmed medication taken', schedule, ctx);
}

// ─── Escalation chain (Stage 4) ──────────────────────────────────────────────
//
// What used to be one hardcoded "text the caregiver" is now a chain configured
// per schedule and recorded step by step in call_history:
//
//   REMINDER_CALL (never confirmed)
//     └─ ESCALATION_CALL   the fallback contact, asked to press 1
//          └─ ESCALATION_SMS   queued at the same moment, due after the ack
//                              window; cancelled if he presses 1, pulled
//                              forward if the call goes unanswered
//
// escalate_with_call / escalate_with_sms decide which steps exist. Both off is
// a misconfiguration; call-only skips the text; sms-only is the default and is
// exactly what this app did before.

// Resolves the chain from a schedule, falling back to env for escalations with
// no schedule behind them (a manual /trigger).
function escalationPlan(schedule) {
  const contact = (schedule && schedule.escalationContact) || null;
  const to      = (contact && contact.phone) || config.caregiverPhone || null;

  const ackMinutes = (schedule && schedule.escalationAckMinutes) || config.escalationAckMinutes;

  return {
    contact,
    to,
    // A call step with nowhere to dial is not a step. Dropping it here rather
    // than at delivery time means the chain starts at the SMS instead of
    // queueing a call that can only fail.
    withCall: Boolean(schedule ? schedule.escalateWithCall : config.escalateWithCall) && Boolean(to),
    withSms:  Boolean(schedule ? schedule.escalateWithSms  : config.escalateWithSms),
    ackMs:    ackMinutes * 60 * 1000,
  };
}

// Starts the chain. Queues the first step rather than sending anything inline:
// a crash between "attempts exhausted" and "SMS sent" used to lose the alert
// with nothing to recover it. Writing the row first makes it durable; the
// sweeper is kicked immediately, so in the normal case it still goes out within
// a second rather than waiting for the next tick.
async function escalate(dose, reason, schedule = null, ctx = {}) {
  const accountId = (schedule && schedule.accountId) || await _defaultAccountId();
  const plan      = escalationPlan(schedule);

  if (!plan.withCall && !plan.withSms) {
    logger.error('NOBODY WILL BE ALERTED — this schedule escalates with neither a call nor an SMS', {
      dose, reason, scheduleId: schedule ? schedule.id : null,
    });
    return;
  }

  if (!accountId) {
    logger.error('Cannot queue escalation — no account; sending inline as a last resort', { dose, reason });
    return _sendEscalationInline(dose, reason, schedule);
  }

  const kind     = plan.withCall ? 'ESCALATION_CALL' : 'ESCALATION_SMS';
  const parentId = ctx.callHistoryId || null;

  try {
    // Twilio delivers a status callback more than once often enough to matter,
    // and both handleNoAnswer and handleNeverConfirmed can land on the same
    // reminder row. Without this guard that is two calls to the caregiver.
    const existing = await callHistoryRepo.findChildByKind(parentId, kind);
    if (existing) {
      logger.warn('Escalation already queued for this attempt, not queueing again', {
        callHistoryId: existing.id, parentId, kind, dose,
      });
      return;
    }

    let row;
    try {
      row = await callHistoryRepo.enqueueEscalation({
        accountId,
        scheduleId: schedule ? schedule.id : (ctx.scheduleId || null),
        contactId:  plan.contact ? plan.contact.id : null,
        parentId,
        dose,
        kind,
        reason,
        dueAt:  new Date(),
      });
    } catch (err) {
      // The check above is a read before a write; two callbacks arriving
      // together can both pass it. The unique index catches what the check
      // cannot, and losing that race means the step already exists — which is
      // success, not failure. Falling through to the inline-send handler below
      // would text the caregiver a second time.
      if (_isDuplicateStep(err)) {
        logger.warn('Escalation step already queued by a concurrent handler', { parentId, kind, dose });
        return;
      }
      throw err;
    }

    logger.call('Escalation queued', { callHistoryId: row.id, kind, dose, reason, parentId });

    kickSweeper();
  } catch (err) {
    logger.error('Could not queue escalation, sending inline instead', { error: err.message, dose, reason });

    // Last line of defence. If this fails too the alert is genuinely gone, and
    // that deserves its own unmistakable log line rather than surfacing as a
    // generic handler error three frames up — this is the case where a missed
    // dose goes unnoticed by anyone.
    try {
      await _sendEscalationInline(dose, reason, schedule);
    } catch (sendErr) {
      logger.error('ESCALATION LOST — could not queue it and could not send it', {
        dose,
        reason,
        queueError: err.message,
        sendError:  sendErr.message,
      });
    }
  }
}

// Prisma's unique-constraint violation. The only unique constraint the
// escalation path can hit is (parent_id, kind), i.e. "this step already exists".
function _isDuplicateStep(err) {
  return err && err.code === 'P2002';
}

// Runs a queued step without waiting out the tick interval. Fire-and-forget: if
// it fails the next tick picks the row up anyway, which is the entire point of
// queueing first.
function kickSweeper() {
  setImmediate(() => {
    require('./retrySweeper').runOnce().catch(err =>
      logger.error('Immediate escalation sweep failed (the next tick will retry)', { error: err.message })
    );
  });
}

function _escalationBody(dose, reason, timezone, extra = '') {
  const timeStr = new Date().toLocaleString('en-US', { timeZone: timezone || config.timezone });
  const base    = `MEDICATION ALERT: Could not confirm ${dose} dose taken as of ${timeStr}. (${reason})`;
  return extra ? `${base} ${extra}` : base;
}

// Last resort when the row could not be written at all. Not durable — but an
// alert attempted is better than no alert.
async function _sendEscalationInline(dose, reason, schedule) {
  const smsAlert = require('./smsAlert');

  const to = (schedule && schedule.escalationContact && schedule.escalationContact.phone)
    || config.caregiverPhone;

  if (!to) {
    logger.error('Cannot escalate — no escalation contact and no CAREGIVER_PHONE_NUMBER', { dose, reason });
    return;
  }

  await smsAlert.send(to, _escalationBody(dose, reason, schedule && schedule.timezone));
}

function _escalationDestination(row) {
  const schedule = row.schedule || null;
  return (row.contact && row.contact.phone)
    || (schedule && schedule.escalationContact && schedule.escalationContact.phone)
    || config.caregiverPhone;
}

// Unfixable by retrying — record it and let the sweeper close the item out
// rather than looping on it every minute forever.
async function _noDestination(row, what) {
  await callHistoryRepo.recordOutcome(row.id, 'FAILED', {
    errorMessage: `${row.errorMessage || ''} | no escalation destination configured`.trim(),
  });
  logger.error(`${what} has nowhere to go — set an escalation contact or CAREGIVER_PHONE_NUMBER`, {
    callHistoryId: row.id, dose: row.dose,
  });
}

// Called by the sweeper for a queued ESCALATION_SMS row. Throwing here is
// meaningful: the sweeper releases the claim and tries again next minute.
async function deliverEscalation(row) {
  const smsAlert = require('./smsAlert');
  const schedule = row.schedule || null;

  // The narrow window where the fallback contact acknowledged the call between
  // this row being claimed and being sent. Cancelling is guarded on "unclaimed",
  // so the cancel loses that race by design — this is the cheap second look that
  // stops the text anyway.
  const current = await callHistoryRepo.currentOutcome(row.id);
  if (current && current !== 'PENDING') {
    logger.info('Escalation SMS no longer needed, skipping', {
      callHistoryId: row.id, outcome: current,
    });
    return;
  }

  const to = _escalationDestination(row);
  if (!to) return _noDestination(row, 'Escalation SMS');

  // Say so when a call was tried first, otherwise "we couldn't reach her" reads
  // as the only thing that happened.
  const afterCall = row.parentId
    ? await callHistoryRepo.findById(row.parentId).catch(() => null)
    : null;
  const extra = afterCall && afterCall.kind === 'ESCALATION_CALL'
    ? 'We also tried calling you and could not reach you.'
    : '';

  const body = _escalationBody(
    row.dose, row.errorMessage || 'unconfirmed dose', schedule && schedule.timezone, extra
  );
  const sid = await smsAlert.send(to, body);

  await callHistoryRepo.recordOutcome(row.id, 'SENT');
  if (sid) await callHistoryRepo.attachCallSid(row.id, sid);

  logger.call('Escalation delivered', { callHistoryId: row.id, to, dose: row.dose });
}

// Called by the sweeper for a queued ESCALATION_CALL row: ring the fallback
// contact and ask him to acknowledge.
//
// The follow-up SMS is queued BEFORE the call is placed, not after it fails.
// Ordering it this way is what makes the chain survive a redeploy: once the row
// exists, the alert goes out after the ack window no matter what happens to this
// process. Acknowledging cancels it; a call nobody answers pulls it forward.
async function deliverEscalationCall(row) {
  const schedule = row.schedule || null;
  const plan     = escalationPlan(schedule);
  const to       = _escalationDestination(row);

  if (!to) return _noDestination(row, 'Escalation call');

  // The call went out on an earlier run that died before it could complete the
  // work item. Re-dialling would ring the caregiver twice.
  if (row.callSid) {
    logger.warn('Escalation call already placed by an earlier run, skipping', {
      callHistoryId: row.id, callSid: row.callSid,
    });
    return;
  }

  let followUp = null;
  if (plan.withSms) {
    followUp = await callHistoryRepo.findChildByKind(row.id, 'ESCALATION_SMS');
    if (!followUp) {
      try {
        followUp = await callHistoryRepo.enqueueEscalation({
          accountId:  row.accountId,
          scheduleId: row.scheduleId,
          contactId:  row.contactId,
          parentId:   row.id,
          dose:       row.dose,
          kind:       'ESCALATION_SMS',
          reason:     row.errorMessage || 'unconfirmed dose',
          dueAt:      new Date(Date.now() + plan.ackMs),
        });
      } catch (err) {
        if (!_isDuplicateStep(err)) throw err;
        followUp = await callHistoryRepo.findChildByKind(row.id, 'ESCALATION_SMS');
      }
    }
  }

  logger.call('Placing escalation call', {
    callHistoryId: row.id, to, dose: row.dose,
    followUpSmsId: followUp ? followUp.id : null,
    ackMinutes:    Math.round(plan.ackMs / 60000),
  });

  if (config.mockMode) {
    logger.call('Mock: escalation call (no Twilio request made)', { to, dose: row.dose });
    await callHistoryRepo.recordOutcome(row.id, 'NO_ANSWER');
    if (followUp) await callHistoryRepo.makeDueNow(followUp.id);
    return;
  }

  const recipient = schedule && schedule.contact ? schedule.contact.name : null;
  const params    = new URLSearchParams();
  params.set('dose', row.dose);
  params.set('attempt', '1');
  params.set('k', 'ESCALATION_CALL');
  params.set('ch', row.id);
  if (row.scheduleId) params.set('sched', row.scheduleId);
  if (followUp)       params.set('fu', followUp.id);
  if (recipient)      params.set('who', recipient);
  // One re-ask inside the escalation call. This is an alert, not a conversation.
  params.set('mr', '1');

  const qs = params.toString();

  // Called through module.exports so the test suite can intercept the outbound
  // edge, the way it already intercepts smsAlert.send. Everything above this
  // line — the queueing, the links, the idempotency — then runs for real.
  const call = await module.exports.placeVoiceCall({
    to,
    from:                 config.twilioFromNumber,
    url:                  `${config.baseUrl}/webhook/escalation?${qs}`,
    statusCallback:       `${config.baseUrl}/webhook/status?${qs}`,
    statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST',
  });

  await callHistoryRepo.attachCallSid(row.id, call.sid);
  logger.call('Escalation call placed', { sid: call.sid, callHistoryId: row.id, to });
}

// The escalation call's outbound edge. Deliberately separate from _realCall,
// which is the reminder path and is left exactly as it was.
async function placeVoiceCall(params) {
  return _twilioClient().calls.create(params);
}

// The fallback contact pressed 1. Close out the call step and cancel the text.
// Awaited inside the live webhook rather than deferred: the SMS is due on a
// clock, so cancelling it late means it has already gone out.
async function acknowledgeEscalation(ctx = {}) {
  try {
    await callHistoryRepo.recordOutcome(ctx.callHistoryId, 'CONFIRMED');
    const canceled = await callHistoryRepo.cancelWork(
      ctx.followUpId, 'acknowledged on the escalation call'
    );

    logger.call('Escalation acknowledged', {
      callHistoryId: ctx.callHistoryId, followUpSmsId: ctx.followUpId, canceled, dose: ctx.dose,
    });
    return canceled;
  } catch (err) {
    // The caller is on the line and the TwiML response must still go out. The
    // consequence of failing here is a redundant SMS, not a missed alert.
    logger.error('Could not record escalation acknowledgment', {
      callHistoryId: ctx.callHistoryId, error: err.message,
    });
    return false;
  }
}

// Twilio's status callback for an ESCALATION_CALL. The reminder path's retry
// logic must not run here: an unanswered escalation call escalates onward to the
// SMS, it does not redial the caregiver.
async function handleEscalationCallEnded(dose, ctx = {}) {
  if (ctx.outcome) {
    await callHistoryRepo.recordOutcome(ctx.callHistoryId, ctx.outcome);
  } else {
    // Answered, then hung up without pressing 1 — voicemail, most likely.
    // Guarded on PENDING so it cannot overwrite a CONFIRMED written moments ago
    // by /webhook/escalation-response.
    await callHistoryRepo.closeIfPending(ctx.callHistoryId, 'NOT_CONFIRMED');
  }

  const current = await callHistoryRepo.currentOutcome(ctx.callHistoryId);
  if (current === 'CONFIRMED') {
    logger.info('Escalation call was acknowledged, no SMS needed', { callHistoryId: ctx.callHistoryId });
    return;
  }

  // Not acknowledged. The SMS would fire on its own once the ack window lapses;
  // pulling it forward just means the alert lands now that we know the call
  // failed, instead of some minutes later.
  const pulled = await callHistoryRepo.makeDueNow(ctx.followUpId);

  logger.call('Escalation call unacknowledged, sending the SMS now', {
    callHistoryId: ctx.callHistoryId, followUpSmsId: ctx.followUpId, pulled, dose, outcome: current,
  });

  if (pulled) kickSweeper();
}

module.exports = {
  initiateCall,
  handleNoAnswer,
  handleNeverConfirmed,
  handleEscalationCallEnded,
  acknowledgeEscalation,
  escalate,
  escalationPlan,
  deliverEscalation,
  deliverEscalationCall,
  placeVoiceCall,
  resolveSettings,
  loadScheduleContext,
};
