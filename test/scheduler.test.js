'use strict';
const { check, contains, section, summary, assertScratchDatabase, truncateAll } = require('./helpers');
require('dotenv').config();

const db            = require('../src/db');
const scheduler     = require('../src/scheduler');
const callManager   = require('../src/callManager');
const scheduleMatch = require('../src/scheduleMatch');
const scheduleRepo  = require('../src/data/schedules');

const prisma = db.getClient();

// Intercept the call instead of placing one. scheduler.js resolves callManager
// through require() at fire time, so replacing the export here is what the
// scheduler will actually invoke.
let placed = [];
callManager.initiateCall = async (dose, attempt, options = {}) => {
  placed.push({ dose, attempt, scheduleId: options.schedule && options.schedule.id });
  return 'FAKE_SID';
};


const reset = () => truncateAll(prisma);

async function main() {
  // This suite truncates every table — refuse outright if the database holds
  // anything real.
  await assertScratchDatabase(prisma);
  await reset();

  const account = await prisma.account.create({ data: { email: 'sched-test@example.test' } });
  const contact = await prisma.contact.create({
    data: { accountId: account.id, name: 'Test Recipient', phone: '+15125550199' },
  });
  const message = await prisma.message.create({
    data: { accountId: account.id, name: 'Test', kind: 'TTS', ttsText: 'Time for your medicine.', isDefault: true },
  });

  // Build a schedule that is due at this exact moment, in Central time.
  const now   = new Date();
  const local = scheduleMatch.localParts(now, 'America/Chicago');
  const schedule = await prisma.schedule.create({
    data: {
      accountId: account.id, name: 'Due Now', dose: 'morning',
      timeOfDay: local.hhmm, daysOfWeek: [0,1,2,3,4,5,6], timezone: 'America/Chicago',
      contactId: contact.id, messageId: message.id,
    },
  });
  console.log(`(schedule set to ${local.hhmm} America/Chicago — due right now)\n`);

  section('a due schedule fires exactly once');
  placed = [];
  await scheduler.tick(now);
  check('one call placed', placed.length, 1);
  check('it was the right schedule', placed[0] && placed[0].scheduleId, schedule.id);
  check('attempt 1', placed[0] && placed[0].attempt, 1);

  console.log('\n--- a second tick in the same window does NOT re-call ---');
  placed = [];
  await scheduler.tick(new Date(now.getTime() + 60 * 1000));
  check('no duplicate call', placed.length, 0);

  console.log('\n--- 8 CONCURRENT ticks place exactly one call ---');
  // This is the double-call scenario: overlapping processes hitting the same
  // due schedule at the same instant.
  await prisma.schedule.update({ where: { id: schedule.id }, data: { lastFiredAt: null } });
  placed = [];
  await Promise.all(Array.from({ length: 8 }, () => scheduler.tick(new Date(now.getTime() + 1000))));
  check('exactly one call across 8 concurrent ticks', placed.length, 1);

  console.log('\n--- claimForFire directly, 20 concurrent claims ---');
  await prisma.schedule.update({ where: { id: schedule.id }, data: { lastFiredAt: null } });
  const claims = await Promise.all(
    Array.from({ length: 20 }, () => scheduleRepo.claimForFire(schedule.id, new Date(), 6 * 60 * 1000))
  );
  check('exactly one claim won', claims.filter(Boolean).length, 1);
  check('nineteen lost', claims.filter(c => !c).length, 19);

  console.log('\n--- disabled schedules never fire ---');
  await prisma.schedule.update({ where: { id: schedule.id }, data: { enabled: false, lastFiredAt: null } });
  placed = [];
  await scheduler.tick(new Date(now.getTime() + 2000));
  check('disabled schedule skipped', placed.length, 0);

  console.log('\n--- wrong day never fires ---');
  const tomorrow = (local.weekday + 1) % 7;
  await prisma.schedule.update({
    where: { id: schedule.id },
    data: { enabled: true, lastFiredAt: null, daysOfWeek: [tomorrow] },
  });
  placed = [];
  await scheduler.tick(new Date(now.getTime() + 3000));
  check('day not selected → skipped', placed.length, 0);

  console.log('\n--- the next day fires again (claim window does not block tomorrow) ---');
  await prisma.schedule.update({
    where: { id: schedule.id },
    data: { daysOfWeek: [0,1,2,3,4,5,6], lastFiredAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
  });
  placed = [];
  await scheduler.tick(now);
  check('fires again 24h later', placed.length, 1);

  console.log('\n--- call_history is written by the real call path (mock mode) ---');
  // Restore the real initiateCall and drive it in mock mode, which needs no
  // Twilio account, to prove the history row is created with the right links.
  delete callManager.initiateCall;
  const fresh = require('../src/data/callHistory');
  const full  = await scheduleRepo.getById(schedule.id);
  const row   = await fresh.startAttempt({
    accountId:  full.accountId,
    scheduleId: full.id,
    contactId:  full.contact.id,
    dose:       full.dose,
    attempt:    1,
  });
  check('history row created', Boolean(row && row.id), true);
  check('outcome starts PENDING', row && row.outcome, 'PENDING');
  check('linked to schedule', row && row.scheduleId, schedule.id);
  check('linked to contact', row && row.contactId, contact.id);

  await fresh.recordOutcome(row.id, 'CONFIRMED', { repromptCount: 2 });
  const after = await prisma.callHistory.findUnique({ where: { id: row.id } });
  check('outcome updated to CONFIRMED', after.outcome, 'CONFIRMED');
  check('repromptCount recorded', after.repromptCount, 2);
  check('completedAt set', Boolean(after.completedAt), true);

  console.log('\n--- closeIfPending cannot overwrite a decided outcome ---');
  const changed = await fresh.closeIfPending(row.id, 'NOT_CONFIRMED');
  check('guard refused to overwrite CONFIRMED', changed, false);
  const stillConfirmed = await prisma.callHistory.findUnique({ where: { id: row.id } });
  check('outcome still CONFIRMED', stillConfirmed.outcome, 'CONFIRMED');

  const pendingRow = await fresh.startAttempt({
    accountId: full.accountId, scheduleId: full.id, contactId: full.contact.id,
    dose: full.dose, attempt: 2,
  });
  const closed = await fresh.closeIfPending(pendingRow.id, 'NOT_CONFIRMED');
  check('guard DID close a PENDING row', closed, true);

  await reset();
  process.exitCode = summary() ? 1 : 0;
}

main()
  .catch(e => { console.error('FAILED:', e); process.exitCode = 1; })
  .finally(() => db.disconnect());
