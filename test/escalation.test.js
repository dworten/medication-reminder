'use strict';
// Stage 4 — the escalation chain.
//
// The outbound edges (Twilio voice, Twilio SMS) are intercepted; everything
// below them — queueing, the parent/child links, cancelling, pulling forward,
// the sweeper's claim — is the real code against the real database.
//
// What these cases are really testing is a single rule: the caregiver is
// alerted exactly once. Not zero times because a process died mid-chain, and
// not twice because a webhook arrived twice.

const { check, section, summary, assertScratchDatabase, truncateAll, waitFor } = require('./helpers');
require('dotenv').config();

const db          = require('../src/db');
const sweeper     = require('../src/retrySweeper');
const callManager = require('../src/callManager');
const smsAlert    = require('../src/smsAlert');
const repo        = require('../src/data/callHistory');
const config      = require('../src/config');

const prisma = db.getClient();

let texted = [];
let escalationCalls = [];

smsAlert.send = async (to, body) => {
  texted.push({ to, body });
  return 'FAKE_SMS_SID';
};

// Only the outbound Twilio request is intercepted. deliverEscalationCall itself
// — queueing the follow-up before dialling, the parent links, the already-placed
// guard — runs for real against the real database.
callManager.placeVoiceCall = async (params) => {
  escalationCalls.push({ to: params.to, url: params.url });
  return { sid: `FAKE_ESC_CALL_SID_${escalationCalls.length}` };
};

// The local .env runs in mock mode, which short-circuits the escalation call
// into a terminal print. These suites are exercising the live path with its
// outbound edge stubbed, so turn it off for this process only.
config.mockMode         = false;
config.baseUrl          = config.baseUrl || 'https://example.test';
config.twilioFromNumber = config.twilioFromNumber || '+15125550100';

const fixtures = {};

async function seedFixtures({ withCall = true, withSms = true, ackMinutes = 3 } = {}) {
  fixtures.account = await prisma.account.create({ data: { email: 'escalation@example.test' } });
  fixtures.contact = await prisma.contact.create({
    data: { accountId: fixtures.account.id, name: 'Grandma', phone: '+15125550150' },
  });
  fixtures.caregiver = await prisma.contact.create({
    data: { accountId: fixtures.account.id, name: 'Caregiver', phone: '+15125550160', role: 'CAREGIVER' },
  });
  fixtures.schedule = await prisma.schedule.create({
    data: {
      accountId: fixtures.account.id, name: 'Escalation Test', dose: 'morning',
      timeOfDay: '09:20', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timezone: 'America/Chicago',
      contactId: fixtures.contact.id, escalationContactId: fixtures.caregiver.id,
      maxAttempts: 3, retryDelayMinutes: 5,
      escalateWithCall: withCall, escalateWithSms: withSms, escalationAckMinutes: ackMinutes,
    },
  });
  return prisma.schedule.findUnique({
    where:   { id: fixtures.schedule.id },
    include: { contact: true, escalationContact: true, message: true },
  });
}

// escalate() kicks a sweep in the background, so a section can still have work
// in flight when the next one starts. Emptying the queue first and waiting for
// it to drain stops that sweep from operating on rows this is about to delete —
// which shows up as a wall of "no record found for update" noise otherwise.
async function reset(opts) {
  await prisma.callHistory.updateMany({ data: { nextRetryAt: null } });
  await waitFor(async () => (await repo.countPendingWork()) === 0);
  await new Promise(r => setTimeout(r, 200));

  await truncateAll(prisma);
  texted = [];
  escalationCalls = [];
  return seedFixtures(opts);
}

// A reminder attempt that exhausted its retries — the row the chain hangs off.
async function exhaustedReminder() {
  return repo.startAttempt({
    accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
    contactId: fixtures.contact.id, dose: 'morning', attempt: 3,
  });
}

async function rowsOfKind(kind) {
  return prisma.callHistory.findMany({ where: { kind }, orderBy: { startedAt: 'asc' } });
}

async function main() {
  await assertScratchDatabase(prisma);

  // ── plan resolution ────────────────────────────────────────────────────────

  section('the chain is read from the schedule, not from env');
  let sched = await reset({ withCall: true, withSms: true, ackMinutes: 7 });
  let plan = callManager.escalationPlan(sched);
  check('call step on', plan.withCall, true);
  check('sms step on', plan.withSms, true);
  check('ack window from the schedule', plan.ackMs, 7 * 60 * 1000);
  check('dials the escalation contact', plan.to, '+15125550160');

  section('a call step with nowhere to dial is dropped, not queued to fail');
  await truncateAll(prisma);
  const orphanAccount = await prisma.account.create({ data: { email: 'orphan@example.test' } });
  const orphanContact = await prisma.contact.create({
    data: { accountId: orphanAccount.id, name: 'Nobody', phone: '+15125550170' },
  });
  const noFallback = await prisma.schedule.create({
    data: {
      accountId: orphanAccount.id, name: 'No fallback', dose: 'evening',
      timeOfDay: '21:20', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      contactId: orphanContact.id, escalateWithCall: true, escalateWithSms: true,
    },
  });
  const noFallbackFull = await prisma.schedule.findUnique({
    where: { id: noFallback.id }, include: { contact: true, escalationContact: true, message: true },
  });
  const orphanPlan = callManager.escalationPlan(noFallbackFull);
  // config.caregiverPhone may be set from .env; the point is only that a call
  // step is never kept when there is no number behind it.
  check('call step matches whether a number exists', orphanPlan.withCall, Boolean(config.caregiverPhone));

  // ── SMS-only: the behaviour this app has always had ────────────────────────

  section('SMS-only chain still goes straight to the text');
  sched = await reset({ withCall: false, withSms: true });
  let reminder = await exhaustedReminder();
  await callManager.escalate('morning', 'no answer after all 3 attempts', sched, {
    callHistoryId: reminder.id,
  });

  let sms = await rowsOfKind('ESCALATION_SMS');
  check('one SMS step queued', sms.length, 1);
  check('no call step', (await rowsOfKind('ESCALATION_CALL')).length, 0);
  check('linked to the reminder attempt', sms[0].parentId, reminder.id);
  check('delivered by the immediate kick', await waitFor(async () => texted.length === 1), true);

  // ── call → SMS chain ───────────────────────────────────────────────────────

  section('call-then-SMS chain queues the call step first');
  sched = await reset({ withCall: true, withSms: true });
  reminder = await exhaustedReminder();
  await callManager.escalate('morning', 'no answer after all 3 attempts', sched, {
    callHistoryId: reminder.id,
  });

  let calls = await rowsOfKind('ESCALATION_CALL');
  check('a call step was queued', calls.length, 1);
  check('linked to the reminder attempt', calls[0].parentId, reminder.id);
  check('addressed to the fallback contact', calls[0].contactId, fixtures.caregiver.id);
  check('no SMS queued yet', (await rowsOfKind('ESCALATION_SMS')).length, 0);
  check('and no text sent', texted.length, 0);

  section('placing the call queues the follow-up SMS before dialling');
  check('the kick placed the call', await waitFor(async () => escalationCalls.length === 1), true);
  const followUpQueued = await waitFor(async () => (await rowsOfKind('ESCALATION_SMS')).length === 1);
  check('follow-up SMS now queued', followUpQueued, true);

  sms = await rowsOfKind('ESCALATION_SMS');
  check('linked to the call step', sms[0].parentId, calls[0].id);
  check('still PENDING', sms[0].outcome, 'PENDING');
  check('not sent yet', texted.length, 0);
  const minutesOut = Math.round((sms[0].nextRetryAt - Date.now()) / 60000);
  check('due after the ack window, not now', minutesOut, 3);

  section('a sweep before the ack window lapses sends nothing');
  let result = await sweeper.runOnce();
  check('nothing claimed', result.claimed, 0);
  check('no text', texted.length, 0);

  // ── acknowledgment cancels the text ────────────────────────────────────────

  section('acknowledging on the call cancels the follow-up SMS');
  const canceled = await callManager.acknowledgeEscalation({
    callHistoryId: calls[0].id, followUpId: sms[0].id, dose: 'morning',
  });
  check('cancel succeeded', canceled, true);

  let callRow = await prisma.callHistory.findUnique({ where: { id: calls[0].id } });
  check('call step CONFIRMED', callRow.outcome, 'CONFIRMED');
  let smsRow = await prisma.callHistory.findUnique({ where: { id: sms[0].id } });
  check('SMS step CANCELED', smsRow.outcome, 'CANCELED');
  check('and removed from the queue', smsRow.nextRetryAt, null);

  // Even once the window would have lapsed, nothing goes out.
  await prisma.callHistory.update({
    where: { id: sms[0].id }, data: { nextRetryAt: null },
  });
  result = await sweeper.runOnce();
  check('no text after acknowledgment', texted.length, 0);

  section('an acknowledged call ends the chain at the status callback too');
  await callManager.handleEscalationCallEnded('morning', {
    callHistoryId: calls[0].id, followUpId: sms[0].id, outcome: null,
  });
  smsRow = await prisma.callHistory.findUnique({ where: { id: sms[0].id } });
  check('SMS stays cancelled', smsRow.outcome, 'CANCELED');
  check('and is not requeued', smsRow.nextRetryAt, null);

  // ── no answer pulls the text forward ───────────────────────────────────────

  section('a fallback who never answers gets the SMS immediately');
  sched = await reset({ withCall: true, withSms: true, ackMinutes: 30 });
  reminder = await exhaustedReminder();
  await callManager.escalate('morning', 'no answer after all 3 attempts', sched, {
    callHistoryId: reminder.id,
  });
  await waitFor(async () => (await rowsOfKind('ESCALATION_SMS')).length === 1);

  calls = await rowsOfKind('ESCALATION_CALL');
  sms   = await rowsOfKind('ESCALATION_SMS');
  const beforePull = Math.round((sms[0].nextRetryAt - Date.now()) / 60000);
  check('SMS parked 30 minutes out', beforePull, 30);

  await callManager.handleEscalationCallEnded('morning', {
    callHistoryId: calls[0].id, followUpId: sms[0].id, outcome: 'NO_ANSWER',
  });

  callRow = await prisma.callHistory.findUnique({ where: { id: calls[0].id } });
  check('call step NO_ANSWER', callRow.outcome, 'NO_ANSWER');
  check('the text went out at once', await waitFor(async () => texted.length === 1), true);
  check('to the fallback contact', texted[0].to, '+15125550160');
  check('and says a call was tried first', texted[0].body.includes('tried calling you'), true);

  // The sweeper clears next_retry_at after delivery returns, so this settles a
  // beat behind the text itself.
  const closedOut = await waitFor(async () => {
    const r = await prisma.callHistory.findUnique({ where: { id: sms[0].id } });
    return r.outcome === 'SENT' && r.nextRetryAt === null;
  });
  check('SMS step SENT and off the queue', closedOut, true);

  section('a SENT row swept again is not sent twice');
  // The window where a process died between recording SENT and clearing the
  // queue flag. The row comes back round; nothing should go out.
  await prisma.callHistory.update({
    where: { id: sms[0].id },
    data:  { nextRetryAt: new Date(Date.now() - 1000), retryClaimedAt: null },
  });
  result = await sweeper.runOnce();
  check('claimed again', result.claimed, 1);
  check('but no second text', texted.length, 1);

  section('answered but never acknowledged is treated as unreached');
  sched = await reset({ withCall: true, withSms: true, ackMinutes: 30 });
  reminder = await exhaustedReminder();
  await callManager.escalate('morning', 'never confirmed', sched, { callHistoryId: reminder.id });
  await waitFor(async () => (await rowsOfKind('ESCALATION_SMS')).length === 1);
  calls = await rowsOfKind('ESCALATION_CALL');
  sms   = await rowsOfKind('ESCALATION_SMS');

  // status=completed with no acknowledgment recorded — i.e. voicemail picked up.
  await callManager.handleEscalationCallEnded('morning', {
    callHistoryId: calls[0].id, followUpId: sms[0].id, outcome: null,
  });
  callRow = await prisma.callHistory.findUnique({ where: { id: calls[0].id } });
  check('call step NOT_CONFIRMED', callRow.outcome, 'NOT_CONFIRMED');
  check('SMS sent anyway', await waitFor(async () => texted.length === 1), true);

  // ── durability: the reason the SMS is queued up front ──────────────────────

  section('THE CRASH CASE: the SMS fires on its own if no webhook ever arrives');
  sched = await reset({ withCall: true, withSms: true, ackMinutes: 3 });
  reminder = await exhaustedReminder();
  await callManager.escalate('morning', 'no answer after all 3 attempts', sched, {
    callHistoryId: reminder.id,
  });
  await waitFor(async () => (await rowsOfKind('ESCALATION_SMS')).length === 1);
  sms = await rowsOfKind('ESCALATION_SMS');

  // Nothing else happens: Twilio's status callback is lost, the process that
  // placed the call is gone. Wind the clock past the ack window.
  await prisma.callHistory.update({
    where: { id: sms[0].id }, data: { nextRetryAt: new Date(Date.now() - 1000) },
  });
  result = await sweeper.runOnce();
  check('the sweeper picked it up unaided', result.done, 1);
  check('the caregiver was alerted', texted.length, 1);

  section('NO DOUBLE ALERT: a repeated status callback queues one chain');
  sched = await reset({ withCall: true, withSms: true });
  reminder = await exhaustedReminder();
  // Twilio delivering the same status twice, or handleNoAnswer racing
  // handleNeverConfirmed on the same attempt.
  await Promise.all([
    callManager.escalate('morning', 'no answer after all 3 attempts', sched, { callHistoryId: reminder.id }),
    callManager.escalate('morning', 'no answer after all 3 attempts', sched, { callHistoryId: reminder.id }),
  ]);
  await waitFor(async () => escalationCalls.length > 0);
  calls = await rowsOfKind('ESCALATION_CALL');
  check('exactly one call step', calls.length, 1);

  section('NO DOUBLE ALERT: a re-swept call step does not redial or requeue');
  // The work item was claimed and the call placed, then the process died before
  // clearing next_retry_at — so the sweeper sees it again.
  await waitFor(async () => (await rowsOfKind('ESCALATION_SMS')).length === 1);
  await prisma.callHistory.update({
    where: { id: calls[0].id },
    data:  { nextRetryAt: new Date(Date.now() - 1000), retryClaimedAt: null },
  });
  const callsBefore = escalationCalls.length;
  await sweeper.runOnce();
  check('no second dial', escalationCalls.length, callsBefore);
  check('no second follow-up SMS', (await rowsOfKind('ESCALATION_SMS')).length, 1);

  section('every step is recorded as its own linked row');
  const chain = await repo.chainFrom(reminder.id);
  check('two steps hang off the reminder attempt', chain.length, 2);
  check('first is the call', chain[0].kind, 'ESCALATION_CALL');
  check('then the SMS', chain[1].kind, 'ESCALATION_SMS');
  check('the SMS hangs off the call, not the reminder', chain[1].parentId, chain[0].id);

  section('a schedule that escalates with neither step alerts nobody, loudly');
  sched = await reset({ withCall: false, withSms: false });
  reminder = await exhaustedReminder();
  await callManager.escalate('morning', 'no answer after all 3 attempts', sched, {
    callHistoryId: reminder.id,
  });
  check('nothing queued', (await prisma.callHistory.count({ where: { kind: { not: 'REMINDER_CALL' } } })), 0);
  check('and nothing sent', texted.length, 0);

  await truncateAll(prisma);
  process.exitCode = summary() ? 1 : 0;
}

main()
  .catch(e => { console.error('FAILED:', e); process.exitCode = 1; })
  .finally(() => db.disconnect());
