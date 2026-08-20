'use strict';
const { check, section, summary, assertScratchDatabase, truncateAll, waitFor, makeContact } = require('./helpers');
require('dotenv').config();

const db          = require('../src/db');
const sweeper     = require('../src/retrySweeper');
const callManager = require('../src/callManager');
const smsAlert    = require('../src/smsAlert');
const repo        = require('../src/data/callHistory');
const config      = require('../src/config');

const prisma = db.getClient();

// Intercept the outbound edges. Everything below the interception — claiming,
// idempotency, completion, expiry — is the real code against the real database.
let placed = [];
let texted = [];
let failNextCall = false;
let failNextSms  = false;

callManager.initiateCall = async (dose, attempt, options = {}) => {
  if (failNextCall) { failNextCall = false; throw new Error('simulated Twilio outage'); }
  // Mirrors what the real initiateCall records, minus the Twilio request. The
  // parentId in particular has to be forwarded: it is what the sweeper's
  // idempotency check reads back.
  const row = await repo.startAttempt({
    accountId:  options.schedule ? options.schedule.accountId : fixtures.account.id,
    scheduleId: options.schedule ? options.schedule.id : null,
    contactId:  options.schedule && options.schedule.contact ? options.schedule.contact.id : null,
    toPhone:    options.to,
    parentId:   options.parentId,
    dose, attempt,
  });
  placed.push({ dose, attempt, id: row && row.id, to: options.to });
  return 'FAKE_CALL_SID';
};

// smsAttempts counts every call, delivered or not. Tests need it to tell "the
// background kick has not run yet" from "it ran and failed" — those two states
// look identical if you only inspect the queued row.
let smsAttempts = 0;

smsAlert.send = async (to, body) => {
  smsAttempts++;
  if (failNextSms) { failNextSms = false; throw new Error('simulated SMS failure'); }
  texted.push({ to, body });
  return 'FAKE_SMS_SID';
};

const fixtures = {};

async function seedFixtures() {
  fixtures.account = await prisma.account.create({ data: { email: 'sweeper@example.test' } });
  fixtures.contact = await makeContact(prisma, {
    data: { accountId: fixtures.account.id, name: 'Recipient', phone: '+15125550150' },
  });
  fixtures.caregiver = await makeContact(prisma, {
    data: { accountId: fixtures.account.id, name: 'Caregiver', phone: '+15125550160', role: 'CAREGIVER' },
  });
  fixtures.schedule = await prisma.schedule.create({
    data: {
      accountId: fixtures.account.id, name: 'Sweeper Test', dose: 'morning',
      timeOfDay: '09:20', daysOfWeek: [0,1,2,3,4,5,6], timezone: 'America/Chicago',
      contactId: fixtures.contact.id, escalationContactId: fixtures.caregiver.id,
      maxAttempts: 3, retryDelayMinutes: 5,
    },
  });
}

// A call attempt that went unanswered and owes a retry.
async function queueRetry({ attempt = 1, dueAt = new Date(Date.now() - 1000), startedAt = null, toPhone } = {}) {
  const row = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, dose: 'morning', attempt,
      kind: 'REMINDER_CALL', outcome: 'NO_ANSWER', nextRetryAt: dueAt,
      ...(toPhone !== undefined && { toPhone }),
      ...(startedAt && { startedAt }),
    },
  });
  return row;
}

async function main() {
  await assertScratchDatabase(prisma);
  await truncateAll(prisma);
  await seedFixtures();

  section('a due retry is picked up and fired');
  placed = [];
  let row = await queueRetry({ attempt: 1 });
  let result = await sweeper.runOnce();
  check('one item claimed', result.claimed, 1);
  check('one completed', result.done, 1);
  check('a call was placed', placed.length, 1);
  check('as attempt 2', placed[0].attempt, 2);
  let after = await prisma.callHistory.findUnique({ where: { id: row.id } });
  check('next_retry_at cleared (work done)', after.nextRetryAt, null);

  section('a retry that is not due yet is left alone');
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  await queueRetry({ dueAt: new Date(Date.now() + 10 * 60 * 1000) });
  result = await sweeper.runOnce();
  check('nothing claimed', result.claimed, 0);
  check('no call placed', placed.length, 0);

  section('THE CRASH CASE: a claim held by a dead process is recovered');
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  row = await queueRetry();
  // Simulate: a process claimed this and died before doing the work.
  await prisma.callHistory.update({
    where: { id: row.id },
    data:  { retryClaimedAt: new Date(Date.now() - (config.retryStaleClaimMinutes + 5) * 60 * 1000) },
  });
  result = await sweeper.runOnce();
  check('stale claim reclaimed', result.claimed, 1);
  check('the retry actually fired', placed.length, 1);

  section('a claim held by a LIVE process is not stolen');
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  row = await queueRetry();
  await prisma.callHistory.update({
    where: { id: row.id },
    data:  { retryClaimedAt: new Date() },   // claimed one second ago
  });
  result = await sweeper.runOnce();
  check('live claim respected', result.claimed, 0);
  check('no duplicate call', placed.length, 0);

  section('NO DOUBLE CALL: concurrent sweeps on the same due item');
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  await queueRetry();
  const runs = await Promise.all(Array.from({ length: 8 }, () => sweeper.runOnce()));
  check('exactly one sweep claimed it', runs.reduce((n, r) => n + r.claimed, 0), 1);
  check('exactly one call placed', placed.length, 1);

  section('idempotency: a retry already placed is not placed again');
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  row = await queueRetry({ attempt: 1 });
  // This attempt's retry already went out, then the process died before it
  // could clear next_retry_at — so the row comes back round.
  await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, parentId: row.id, dose: 'morning', attempt: 2,
      kind: 'REMINDER_CALL', outcome: 'NO_ANSWER',
    },
  });
  result = await sweeper.runOnce();
  check('item was claimed', result.claimed, 1);
  check('but no second call placed', placed.length, 0);
  after = await prisma.callHistory.findUnique({ where: { id: row.id } });
  check('and the item was closed out', after.nextRetryAt, null);

  section('a child that FAILED at creation does not end the chain');
  // Twilio refused the dial: the child row was opened before dialling and
  // nothing ever rang. Treating that as "already placed" is how a transient
  // outage used to kill the sequence with one warn line — no redial, no
  // escalation. The bare child (no queued recovery, no children) is the
  // crashed-mid-recovery shape; the sweeper reruns the failure ladder on it.
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  row = await queueRetry({ attempt: 1 });
  const refused = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, parentId: row.id, dose: 'morning', attempt: 2,
      kind: 'REMINDER_CALL', outcome: 'FAILED', // no callSid: never dialled
    },
  });
  result = await sweeper.runOnce();
  check('item completed', result.done, 1);
  check('no dial straight from the parent', placed.length, 0);
  let refusedAfter = await prisma.callHistory.findUnique({ where: { id: refused.id } });
  check('the failure ladder queued a redial on the child', Boolean(refusedAfter.nextRetryAt), true);

  // The revived child then fires like any other queued retry.
  await prisma.callHistory.update({ where: { id: refused.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } });
  result = await sweeper.runOnce();
  check('the redial went out', placed.length, 1);
  check('as attempt 3', placed[0].attempt, 3);

  section('a FAILED child WITH a call SID is a placed call, not a refused one');
  // Twilio placed it and reported failure through the status callback, which
  // schedules its own recovery. Redialling from here would race that.
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  row = await queueRetry({ attempt: 1 });
  const placedThenFailed = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, parentId: row.id, dose: 'morning', attempt: 2,
      kind: 'REMINDER_CALL', outcome: 'FAILED', callSid: 'CA_PLACED_THEN_FAILED',
    },
  });
  result = await sweeper.runOnce();
  check('no second dial', placed.length, 0);
  after = await prisma.callHistory.findUnique({ where: { id: placedThenFailed.id } });
  check('the child was left alone', after.nextRetryAt, null);

  section('a never-dialled child whose recovery is already queued is left alone');
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  row = await queueRetry({ attempt: 1 });
  const recovering = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, parentId: row.id, dose: 'morning', attempt: 2,
      kind: 'REMINDER_CALL', outcome: 'FAILED',
      nextRetryAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
  result = await sweeper.runOnce();
  check('no dial', placed.length, 0);
  after = await prisma.callHistory.findUnique({ where: { id: recovering.id } });
  check('its own schedule was not moved',
    Math.round((after.nextRetryAt - Date.now()) / 60000) >= 25, true);

  section('a never-dialled FINAL attempt escalates when its recovery was lost');
  await truncateAll(prisma); await seedFixtures();
  placed = []; texted = [];
  row = await queueRetry({ attempt: 2 });
  const lastRefused = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, parentId: row.id, dose: 'morning', attempt: 3,
      kind: 'REMINDER_CALL', outcome: 'FAILED',
    },
  });
  result = await sweeper.runOnce();
  check('no redial past the attempt budget', placed.length, 0);
  const rescue = await prisma.callHistory.findFirst({ where: { kind: 'ESCALATION_SMS' } });
  check('escalation queued instead', Boolean(rescue), true);
  check('under the refused attempt', rescue && rescue.parentId, lastRefused.id);

  section('a SEPARATE call\'s retry is not mistaken for this one');
  // Two test calls in one morning. Both are attempt 1 of the same schedule and
  // dose, so matching on (schedule, dose, attempt) inside a time window made the
  // second call's retry find the FIRST call's attempt-2 row and skip — the
  // sequence silently stopped dead with no retry and no escalation.
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  const firstCall = await queueRetry({ attempt: 1, dueAt: new Date(Date.now() - 60000) });
  await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, parentId: firstCall.id, dose: 'morning', attempt: 2,
      kind: 'REMINDER_CALL', outcome: 'NO_ANSWER',
    },
  });
  await prisma.callHistory.update({ where: { id: firstCall.id }, data: { nextRetryAt: null } });

  // Now a second, unrelated test call — same schedule, same dose, also attempt 1.
  const secondCall = await queueRetry({ attempt: 1 });
  result = await sweeper.runOnce();
  check('the second call retried', placed.length, 1);
  check('as attempt 2', placed[0].attempt, 2);
  const retryRow = await prisma.callHistory.findFirst({ where: { parentId: secondCall.id } });
  check('linked to the call that spawned it', Boolean(retryRow), true);

  section('NO DOUBLE CALL: concurrent sweeps cannot both place a retry');
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  const raced = await queueRetry({ attempt: 1 });
  await Promise.all(Array.from({ length: 6 }, () => sweeper.runOnce()));
  check('exactly one retry placed', placed.length, 1);
  check('exactly one child row',
    await prisma.callHistory.count({ where: { parentId: raced.id } }), 1);

  section('a failed work item is released, not stuck');
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  row = await queueRetry();
  failNextCall = true;
  result = await sweeper.runOnce();
  check('failure counted', result.failed, 1);
  after = await prisma.callHistory.findUnique({ where: { id: row.id } });
  check('still queued for another go', Boolean(after.nextRetryAt), true);
  check('claim released', after.retryClaimedAt, null);
  // Next sweep succeeds.
  result = await sweeper.runOnce();
  check('second sweep succeeds', result.done, 1);
  check('call finally placed', placed.length, 1);

  section('ESCALATION IS DURABLE: written to the queue before it is sent');
  // Queued directly, with no immediate kick, so this isolates the sweeper's
  // half of the contract: an escalation sitting in the database gets delivered.
  await truncateAll(prisma); await seedFixtures();
  texted = [];
  const queued = await repo.enqueueEscalation({
    accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
    contactId: fixtures.caregiver.id, dose: 'morning',
    kind: 'ESCALATION_SMS', reason: 'no answer after all 3 attempts',
    dueAt: new Date(Date.now() - 1000),
  });
  check('queued as PENDING', queued.outcome, 'PENDING');
  check('due immediately', queued.nextRetryAt !== null, true);

  result = await sweeper.runOnce();
  check('sweeper delivered it', result.done, 1);
  check('SMS sent', texted.length, 1);
  check('to the caregiver', texted[0].to, '+15125550160');
  check('body names the dose', texted[0].body.includes('morning'), true);
  const delivered = await prisma.callHistory.findUnique({ where: { id: queued.id } });
  check('outcome SENT', delivered.outcome, 'SENT');
  check('removed from the queue', delivered.nextRetryAt, null);

  section('escalate() queues first, then delivers without waiting for a tick');
  await truncateAll(prisma); await seedFixtures();
  texted = [];
  const full = await prisma.schedule.findUnique({
    where: { id: fixtures.schedule.id },
    include: { contact: true, escalationContact: true, message: true },
  });
  await callManager.escalate('morning', 'no answer after all 3 attempts', full, {});

  const rowExists = await prisma.callHistory.findFirst({ where: { kind: 'ESCALATION_SMS' } });
  check('row written durably', Boolean(rowExists), true);
  check('addressed to the escalation contact', rowExists.contactId, fixtures.caregiver.id);

  // The background kick should deliver it without any tick running.
  const settled = await waitFor(async () => texted.length > 0);
  check('delivered by the immediate kick, no tick needed', settled, true);
  const kicked = await waitFor(async () => {
    const r = await prisma.callHistory.findUnique({ where: { id: rowExists.id } });
    return r.outcome === 'SENT' && r.nextRetryAt === null;
  });
  check('and closed out', kicked, true);

  section('a failed escalation stays queued and is retried');
  await truncateAll(prisma); await seedFixtures();
  texted = [];
  // Re-fetch after re-seeding: the previous `full` points at deleted rows, and
  // passing it would make enqueueEscalation fail on the foreign key rather than
  // exercising the path under test.
  const full2 = await prisma.schedule.findUnique({
    where: { id: fixtures.schedule.id },
    include: { contact: true, escalationContact: true, message: true },
  });
  // Fail the delivery the kick attempts, so the row must survive for the sweep.
  smsAttempts = 0;
  failNextSms = true;
  await callManager.escalate('evening', 'never confirmed', full2, {});

  // Wait for the kick to have actually TRIED and failed. Waiting only for
  // "queued and unclaimed" would pass instantly against the row's initial
  // state, and the sweep below would then race the kick for the claim.
  const kickTried = await waitFor(async () => smsAttempts >= 1);
  check('the background kick attempted delivery', kickTried, true);
  check('no SMS went out', texted.length, 0);

  const stillQueued = await waitFor(async () => {
    const r = await prisma.callHistory.findFirst({ where: { kind: 'ESCALATION_SMS' } });
    return r && r.nextRetryAt !== null && r.retryClaimedAt === null;
  });
  check('failed delivery left it queued and unclaimed', stillQueued, true);

  result = await sweeper.runOnce();
  check('the next sweep delivered it', texted.length, 1);
  check('completed', result.done, 1);

  section('work too old is abandoned rather than retried forever');
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  const old = new Date(Date.now() - (config.retryGiveUpHours + 1) * 60 * 60 * 1000);
  row = await queueRetry({ startedAt: old, dueAt: old });
  result = await sweeper.runOnce();
  check('abandoned', result.abandoned, 1);
  check('no call placed', placed.length, 0);
  after = await prisma.callHistory.findUnique({ where: { id: row.id } });
  check('outcome CANCELED', after.outcome, 'CANCELED');
  check('removed from the queue', after.nextRetryAt, null);

  section('handleNoAnswer persists a retry instead of a timer');
  await truncateAll(prisma); await seedFixtures();
  const attemptRow = await repo.startAttempt({
    accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
    contactId: fixtures.contact.id, dose: 'morning', attempt: 1,
  });
  await callManager.handleNoAnswer('morning', 1, {
    scheduleId: fixtures.schedule.id, callHistoryId: attemptRow.id, outcome: 'NO_ANSWER',
  });
  const persisted = await prisma.callHistory.findUnique({ where: { id: attemptRow.id } });
  check('outcome recorded', persisted.outcome, 'NO_ANSWER');
  check('next_retry_at persisted', Boolean(persisted.nextRetryAt), true);
  const minutesOut = Math.round((persisted.nextRetryAt - Date.now()) / 60000);
  check('due in ~5 minutes (the schedule value)', minutesOut, 5);

  section('final attempt escalates instead of retrying');
  await truncateAll(prisma); await seedFixtures();
  texted = [];
  const lastRow = await repo.startAttempt({
    accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
    contactId: fixtures.contact.id, dose: 'morning', attempt: 3,
  });
  await callManager.handleNoAnswer('morning', 3, {
    scheduleId: fixtures.schedule.id, callHistoryId: lastRow.id, outcome: 'NO_ANSWER',
  });
  const finalRow = await prisma.callHistory.findUnique({ where: { id: lastRow.id } });
  check('no retry queued on the final attempt', finalRow.nextRetryAt, null);
  const esc = await prisma.callHistory.findFirst({ where: { kind: 'ESCALATION_SMS' } });
  check('escalation queued instead', Boolean(esc), true);

  section('a retry rings the number the first attempt actually used');
  // The /trigger?target=test case. The destination was overridden, so the retry
  // must follow it rather than rebuilding from the contact — otherwise a test
  // call rings the test phone and its retry rings the real person.
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  await queueRetry({ attempt: 1, toPhone: '+15125559999' });
  result = await sweeper.runOnce();
  check('the retry fired', placed.length, 1);
  check('to the redirected number', placed[0].to, '+15125559999');
  check('not the schedule contact', placed[0].to === fixtures.contact.phone, false);

  section('with no recorded destination it falls back to the contact');
  // Rows written before to_phone existed, and anything queued without one.
  await truncateAll(prisma); await seedFixtures();
  placed = [];
  await queueRetry({ attempt: 1, toPhone: null });
  result = await sweeper.runOnce();
  check('the retry fired', placed.length, 1);
  check('to the contact', placed[0].to, fixtures.contact.phone);

  // ── answered, but nothing confirmed ──────────────────────────────────────
  //
  // She picks up and hangs up, or says no and hangs up. Twilio reports that as
  // `completed`, which used to close the row and stop — so the one case where
  // she has actually told you the dose was missed alerted nobody. It now takes
  // the no-answer path. These cases exist mostly to prove it can never redial a
  // call she confirmed.

  section('answered then hung up: retried like a no-answer');
  await truncateAll(prisma); await seedFixtures();
  placed = []; texted = [];
  const hungUp = await repo.startAttempt({
    accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
    contactId: fixtures.contact.id, dose: 'morning', attempt: 1,
  });
  let acted = await callManager.handleAnsweredNoConfirmation('morning', 1, {
    scheduleId: fixtures.schedule.id, callHistoryId: hungUp.id,
  });
  check('it acted', acted, true);
  after = await prisma.callHistory.findUnique({ where: { id: hungUp.id } });
  check('outcome NOT_CONFIRMED', after.outcome, 'NOT_CONFIRMED');
  check('a retry was queued', Boolean(after.nextRetryAt), true);
  check('due in ~5 minutes', Math.round((after.nextRetryAt - Date.now()) / 60000), 5);
  check('nobody escalated to yet', await prisma.callHistory.count({ where: { kind: 'ESCALATION_SMS' } }), 0);

  section('hanging up on the LAST attempt escalates, and says why');
  await truncateAll(prisma); await seedFixtures();
  texted = [];
  const lastHangUp = await repo.startAttempt({
    accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
    contactId: fixtures.contact.id, dose: 'evening', attempt: 3,
  });
  await callManager.handleAnsweredNoConfirmation('evening', 3, {
    scheduleId: fixtures.schedule.id, callHistoryId: lastHangUp.id,
  });
  after = await prisma.callHistory.findUnique({ where: { id: lastHangUp.id } });
  check('no retry past the last attempt', after.nextRetryAt, null);
  const hangUpEsc = await prisma.callHistory.findFirst({ where: { kind: 'ESCALATION_SMS' } });
  check('escalation queued', Boolean(hangUpEsc), true);
  check('linked to the attempt', hangUpEsc.parentId, lastHangUp.id);
  // "no answer after all 3 attempts" would be a lie about a call she picked up.
  check('reason says she answered', hangUpEsc.errorMessage.includes('answered without confirming'), true);

  section('NEVER REDIAL A CONFIRMED DOSE: a late `completed` is ignored');
  await truncateAll(prisma); await seedFixtures();
  placed = []; texted = [];
  const confirmed = await repo.startAttempt({
    accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
    contactId: fixtures.contact.id, dose: 'morning', attempt: 1,
  });
  await repo.recordOutcome(confirmed.id, 'CONFIRMED');
  acted = await callManager.handleAnsweredNoConfirmation('morning', 1, {
    scheduleId: fixtures.schedule.id, callHistoryId: confirmed.id,
  });
  check('it declined to act', acted, false);
  after = await prisma.callHistory.findUnique({ where: { id: confirmed.id } });
  check('still CONFIRMED', after.outcome, 'CONFIRMED');
  check('no retry queued', after.nextRetryAt, null);
  check('no escalation', await prisma.callHistory.count({ where: { kind: { not: 'REMINDER_CALL' } } }), 0);

  section('the reprompt-exhausted path is not handled twice');
  await truncateAll(prisma); await seedFixtures();
  texted = [];
  const exhausted = await repo.startAttempt({
    accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
    contactId: fixtures.contact.id, dose: 'morning', attempt: 1,
  });
  // handleNeverConfirmed already ran: it recorded NOT_CONFIRMED and escalated.
  await callManager.handleNeverConfirmed('morning', 1, {
    scheduleId: fixtures.schedule.id, callHistoryId: exhausted.id, repromptCount: 3,
  });
  const escCount = await prisma.callHistory.count({ where: { kind: { not: 'REMINDER_CALL' } } });
  // Now Twilio's `completed` arrives for the same call.
  acted = await callManager.handleAnsweredNoConfirmation('morning', 1, {
    scheduleId: fixtures.schedule.id, callHistoryId: exhausted.id,
  });
  check('it declined to act', acted, false);
  after = await prisma.callHistory.findUnique({ where: { id: exhausted.id } });
  check('no retry queued on top of the escalation', after.nextRetryAt, null);
  check('still exactly one escalation',
    await prisma.callHistory.count({ where: { kind: { not: 'REMINDER_CALL' } } }), escCount);

  // ── the stale-PENDING watchdog ───────────────────────────────────────────
  //
  // Everything after "call created" arrives by webhook. These rows are what a
  // lost callback leaves behind: PENDING, no next_retry_at, invisible to the
  // queue. The watchdog is what stops that state from lasting for days.

  const staleAge = () => new Date(Date.now() - (config.pendingWatchdogMinutes + 10) * 60 * 1000);

  section('watchdog: a call whose callback never came is failed and retried');
  await truncateAll(prisma); await seedFixtures();
  placed = []; texted = [];
  row = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, dose: 'morning', attempt: 1,
      kind: 'REMINDER_CALL', outcome: 'PENDING', callSid: 'CA_NO_CALLBACK',
      startedAt: staleAge(),
    },
  });
  let wd = await sweeper.watchdogOnce();
  check('one row flagged', wd.flagged, 1);
  after = await prisma.callHistory.findUnique({ where: { id: row.id } });
  check('flipped to FAILED', after.outcome, 'FAILED');
  check('says the callback never came', after.errorMessage.includes('status callback'), true);
  check('a redial was queued', Boolean(after.nextRetryAt), true);
  check('no escalation on a first attempt', texted.length, 0);

  section('watchdog: a fresh PENDING call is left alone');
  await truncateAll(prisma); await seedFixtures();
  row = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, dose: 'morning', attempt: 1,
      kind: 'REMINDER_CALL', outcome: 'PENDING', callSid: 'CA_IN_FLIGHT',
      startedAt: new Date(Date.now() - 5 * 60 * 1000),
    },
  });
  wd = await sweeper.watchdogOnce();
  check('nothing flagged', wd.flagged, 0);
  after = await prisma.callHistory.findUnique({ where: { id: row.id } });
  check('still PENDING', after.outcome, 'PENDING');

  section('watchdog: queued work is the sweeper\'s business, not the watchdog\'s');
  await truncateAll(prisma); await seedFixtures();
  row = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, dose: 'morning', attempt: 1,
      kind: 'REMINDER_CALL', outcome: 'PENDING',
      startedAt: staleAge(), nextRetryAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  wd = await sweeper.watchdogOnce();
  check('a row in the retry queue is not touched', wd.flagged, 0);

  section('watchdog: a stale FINAL attempt escalates');
  await truncateAll(prisma); await seedFixtures();
  texted = [];
  row = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.contact.id, dose: 'evening', attempt: 3,
      kind: 'REMINDER_CALL', outcome: 'PENDING', callSid: 'CA_LAST_STALE',
      startedAt: staleAge(),
    },
  });
  wd = await sweeper.watchdogOnce();
  check('flagged', wd.flagged, 1);
  after = await prisma.callHistory.findUnique({ where: { id: row.id } });
  check('flipped to FAILED', after.outcome, 'FAILED');
  check('no redial past the attempt budget', after.nextRetryAt, null);
  const wdEsc = await prisma.callHistory.findFirst({ where: { kind: 'ESCALATION_SMS' } });
  check('escalation queued', Boolean(wdEsc), true);
  check('under the stale attempt', wdEsc && wdEsc.parentId, row.id);

  section('watchdog: a stale queued escalation SMS is requeued, not failed');
  await truncateAll(prisma); await seedFixtures();
  row = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.caregiver.id, dose: 'morning', attempt: 1,
      kind: 'ESCALATION_SMS', outcome: 'PENDING', errorMessage: 'no answer after all 3 attempts',
      startedAt: staleAge(),
    },
  });
  wd = await sweeper.watchdogOnce();
  check('flagged', wd.flagged, 1);
  after = await prisma.callHistory.findUnique({ where: { id: row.id } });
  check('still PENDING — an alert is never written off', after.outcome, 'PENDING');
  check('back in the queue', Boolean(after.nextRetryAt), true);

  section('watchdog: a stale escalation call closes out and the text still goes');
  await truncateAll(prisma); await seedFixtures();
  texted = [];
  const escCall = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.caregiver.id, dose: 'morning', attempt: 1,
      kind: 'ESCALATION_CALL', outcome: 'PENDING', callSid: 'CA_ESC_STALE',
      startedAt: staleAge(),
    },
  });
  const followUp = await prisma.callHistory.create({
    data: {
      accountId: fixtures.account.id, scheduleId: fixtures.schedule.id,
      contactId: fixtures.caregiver.id, parentId: escCall.id, dose: 'morning', attempt: 1,
      kind: 'ESCALATION_SMS', outcome: 'PENDING', errorMessage: 'no answer after all 3 attempts',
      startedAt: staleAge(), nextRetryAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  wd = await sweeper.watchdogOnce();
  check('the call step was flagged', wd.flagged, 1);
  after = await prisma.callHistory.findUnique({ where: { id: escCall.id } });
  check('flipped to FAILED', after.outcome, 'FAILED');
  const textArrived = await waitFor(async () => {
    const r = await prisma.callHistory.findUnique({ where: { id: followUp.id } });
    return r.outcome === 'SENT' || (r.nextRetryAt !== null && r.nextRetryAt <= new Date());
  });
  check('the follow-up text was pulled forward', textArrived, true);

  await truncateAll(prisma);
  process.exitCode = summary() ? 1 : 0;
}

main().catch(e => { console.error('FAILED:', e); process.exitCode = 1; }).finally(() => db.disconnect());
