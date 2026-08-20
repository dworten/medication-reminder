'use strict';
// A Twilio error at call creation must not lose the occurrence.
//
// The old behaviour: mark the row FAILED and rethrow. The claim on the
// schedule stood, so the next tick skipped it, no retry was queued, and no
// escalation fired — a 30-second Twilio blip at 9:20 cost the whole dose with
// one log line to show for it. An UNANSWERED call, by contrast, retried and
// then escalated. These cases pin the fix: a refused dial now takes exactly
// the unanswered call's ladder.
//
// Only the outbound dial (placeReminderCall) and the SMS edge are intercepted;
// the row-keeping, the failure ladder, the sweeper's redial and the escalation
// queue are the real code against the real database.

const { check, section, summary, assertScratchDatabase, truncateAll, waitFor, makeContact } = require('./helpers');
require('dotenv').config();

const db          = require('../src/db');
const sweeper     = require('../src/retrySweeper');
const callManager = require('../src/callManager');
const smsAlert    = require('../src/smsAlert');
const repo        = require('../src/data/callHistory');
const config      = require('../src/config');

const prisma = db.getClient();

let dialed = [];
let texted = [];
let failDials = 0; // the next N dials throw, then dials succeed again

callManager.placeReminderCall = async (params) => {
  if (failDials > 0) { failDials--; throw new Error('simulated Twilio outage'); }
  dialed.push({ to: params.to, url: params.url });
  return { sid: `FAKE_CALL_SID_${dialed.length}` };
};

smsAlert.send = async (to, body) => {
  texted.push({ to, body });
  return 'FAKE_SMS_SID';
};

// The local .env runs in mock mode, which short-circuits before _realCall.
// These suites exercise the live path with its outbound edge stubbed.
config.mockMode         = false;
config.baseUrl          = config.baseUrl || 'https://example.test';
config.twilioFromNumber = config.twilioFromNumber || '+15125550100';

const fixtures = {};

async function seedFixtures() {
  fixtures.account = await prisma.account.create({ data: { email: 'dialfailure@example.test' } });
  fixtures.contact = await makeContact(prisma, {
    data: { accountId: fixtures.account.id, name: 'Recipient', phone: '+15125550150' },
  });
  fixtures.caregiver = await makeContact(prisma, {
    data: { accountId: fixtures.account.id, name: 'Caregiver', phone: '+15125550160', role: 'CAREGIVER' },
  });
  fixtures.schedule = await prisma.schedule.create({
    data: {
      accountId: fixtures.account.id, name: 'Dial Failure Test', dose: 'morning',
      timeOfDay: '09:20', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timezone: 'America/Chicago',
      contactId: fixtures.contact.id, escalationContactId: fixtures.caregiver.id,
      maxAttempts: 3, retryDelayMinutes: 5,
      escalateWithCall: false, escalateWithSms: true,
    },
  });
}

async function fullSchedule() {
  return prisma.schedule.findUnique({
    where:   { id: fixtures.schedule.id },
    include: { contact: true, escalationContact: true, message: true },
  });
}

// escalate() kicks a background sweep; drain it before truncating so it cannot
// act on rows the next section is about to delete.
async function reset() {
  await prisma.callHistory.updateMany({ data: { nextRetryAt: null } });
  await waitFor(async () => (await repo.countPendingWork()) === 0);
  await new Promise(r => setTimeout(r, 200));
  await truncateAll(prisma);
  await seedFixtures();
  dialed = [];
  texted = [];
  failDials = 0;
}

async function main() {
  await assertScratchDatabase(prisma);
  await truncateAll(prisma);
  await seedFixtures();

  section('a dial Twilio refuses queues a redial instead of losing the occurrence');
  failDials = 1;
  const sid = await callManager.initiateCall('morning', 1, { schedule: await fullSchedule() });
  check('resolves rather than throwing', sid, null);
  const row = await prisma.callHistory.findFirst({ where: { kind: 'REMINDER_CALL' } });
  check('the attempt left a row', Boolean(row), true);
  check('marked FAILED', row.outcome, 'FAILED');
  check('carrying the Twilio error', row.errorMessage.includes('simulated Twilio outage'), true);
  check('a redial is queued on the row', Boolean(row.nextRetryAt), true);
  check('due in ~5 minutes (the schedule value)', Math.round((row.nextRetryAt - Date.now()) / 60000), 5);
  check('nobody escalated over a transient blip', texted.length, 0);

  section('the queued redial fires and rings the same number');
  await prisma.callHistory.update({ where: { id: row.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } });
  let result = await sweeper.runOnce();
  check('sweeper completed the item', result.done, 1);
  check('a call went out', dialed.length, 1);
  check('to the recipient', dialed[0].to, fixtures.contact.phone);
  check('as attempt 2', dialed[0].url.includes('attempt=2'), true);
  const child = await prisma.callHistory.findFirst({ where: { parentId: row.id } });
  check('linked to the refused attempt', Boolean(child), true);
  check('carrying its call SID', Boolean(child.callSid), true);
  check('open, awaiting its webhooks', child.outcome, 'PENDING');

  section('a refusal on the FINAL attempt escalates, and says why');
  await reset();
  failDials = 1;
  await callManager.initiateCall('evening', 3, { schedule: await fullSchedule() });
  const last = await prisma.callHistory.findFirst({ where: { kind: 'REMINDER_CALL' } });
  check('marked FAILED', last.outcome, 'FAILED');
  check('no redial past the attempt budget', last.nextRetryAt, null);
  const esc = await prisma.callHistory.findFirst({ where: { kind: 'ESCALATION_SMS' } });
  check('escalation queued', Boolean(esc), true);
  check('linked to the refused attempt', esc.parentId, last.id);
  // "no answer after all 3 attempts" would be a lie about a phone that never rang.
  check('reason says the call could not be placed', esc.errorMessage.includes('could not be placed'), true);
  const delivered = await waitFor(async () => texted.length > 0);
  check('the caregiver was actually texted (immediate kick)', delivered, true);
  check('to the caregiver', texted[0].to, fixtures.caregiver.phone);

  section('a sustained outage walks the whole ladder and still ends at the caregiver');
  await reset();
  failDials = 3; // every attempt the budget allows is refused
  await callManager.initiateCall('morning', 1, { schedule: await fullSchedule() });
  for (let i = 0; i < 2; i++) {
    await prisma.callHistory.updateMany({
      where: { nextRetryAt: { not: null } },
      data:  { nextRetryAt: new Date(Date.now() - 1000) },
    });
    await sweeper.runOnce();
  }
  check('no call ever went out', dialed.length, 0);
  check('three refused attempts recorded',
    await prisma.callHistory.count({ where: { kind: 'REMINDER_CALL' } }), 3);
  check('exactly one escalation',
    await prisma.callHistory.count({ where: { kind: 'ESCALATION_SMS' } }), 1);
  const alerted = await waitFor(async () => texted.length > 0);
  check('the caregiver heard about it', alerted, true);

  section('the success path is unchanged');
  await reset();
  const okSid = await callManager.initiateCall('morning', 1, { schedule: await fullSchedule() });
  check('returns the call SID', okSid, 'FAKE_CALL_SID_1');
  const okRow = await prisma.callHistory.findFirst({ where: { kind: 'REMINDER_CALL' } });
  check('row open, awaiting its webhooks', okRow.outcome, 'PENDING');
  check('SID attached', Boolean(okRow.callSid), true);
  check('nothing queued', okRow.nextRetryAt, null);

  await reset();
  await truncateAll(prisma);
  process.exitCode = summary() ? 1 : 0;
}

main().catch(e => { console.error('FAILED:', e); process.exitCode = 1; }).finally(() => db.disconnect());
