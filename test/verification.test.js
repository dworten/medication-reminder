'use strict';
// Phone number verification.
//
// Driven over real HTTP against the real router, like api.test.js. The only
// thing stubbed is the request to Twilio — everything above it runs for real, so
// what is under test is the actual hashing, the actual expiry arithmetic and the
// actual rate-limit queries rather than a description of them.
//
// The case this suite exists for is the last section. A trigger that refuses to
// attach an unverified contact to a schedule is one careless WHERE clause away
// from refusing the UPDATE that claims a schedule for firing — and that failure
// would not look like a bug, it would look like the phone quietly never ringing
// again. That test is the one to keep if any of the others ever become
// inconvenient.

const { check, contains, section, summary, assertScratchDatabase, truncateAll, makeContact } = require('./helpers');
require('dotenv').config();

const express = require('express');
const bcrypt  = require('bcryptjs');

const db        = require('../src/db');
const config    = require('../src/config');
const apiRouter = require('../src/api');

config.nodeEnv = 'test';
config.sessionSecret = config.sessionSecret || 'test-session-secret-at-least-32-chars-long';

const session           = require('../src/session');
const phoneVerification = require('../src/phoneVerification');
const scheduleRepo      = require('../src/data/schedules');
const prisma            = db.getClient();

const PASSWORD = 'correct-horse-battery-staple';

// ─── The intercepted outbound edge ───────────────────────────────────────────

const sent = { code: null, to: null, channel: null, count: 0 };
let failNextSend = false;

function stubDelivery() {
  const capture = (channel) => async (to, code) => {
    if (failNextSend) {
      failNextSend = false;
      throw new Error('Twilio rejected the destination');
    }
    Object.assign(sent, { to, code, channel });
    sent.count += 1;
    return channel === 'CALL' ? 'CA_test' : 'SM_test';
  };
  phoneVerification.sendVerificationSms   = capture('SMS');
  phoneVerification.placeVerificationCall = capture('CALL');
}

let server, base;

function start() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(session.middleware());
  app.use('/api', apiRouter());

  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

function makeClient() {
  let cookie = null;
  return async function request(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(cookie && { Cookie: cookie }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, body: json, text, raw: res };
  };
}

const fixtures = {};

async function seedFixtures() {
  const hash = await bcrypt.hash(PASSWORD, 4);

  fixtures.account = await prisma.account.create({
    data: { email: 'verify@example.test', name: 'Verify Test', passwordHash: hash },
  });
  fixtures.other = await prisma.account.create({
    data: { email: 'other-verify@example.test', name: 'Someone Else', passwordHash: hash },
  });

  fixtures.contact = await makeContact(prisma, {
    data: { accountId: fixtures.account.id, name: 'Grandma', phone: '+15125550150' },
  });
  fixtures.caregiver = await makeContact(prisma, {
    data: { accountId: fixtures.account.id, name: 'Caregiver', phone: '+15125550160', role: 'CAREGIVER' },
  });
  fixtures.schedule = await prisma.schedule.create({
    data: {
      accountId: fixtures.account.id, name: 'Morning', dose: 'morning',
      timeOfDay: '09:20', daysOfWeek: [1, 2, 3, 4, 5, 6],
      contactId: fixtures.contact.id, escalationContactId: fixtures.caregiver.id,
    },
  });
}

// Resets the rate-limit history without touching anything else. The limits are
// counted from this table, so a suite that sends thirty codes would otherwise
// start tripping its own ceilings partway through.
const clearSends = () => prisma.contactVerification.deleteMany({});

async function main() {
  await assertScratchDatabase(prisma);
  await truncateAll(prisma);
  await prisma.session.deleteMany({});
  await seedFixtures();
  stubDelivery();
  await start();

  const api = makeClient();
  await api('POST', '/api/login', { email: 'verify@example.test', password: PASSWORD });

  let r;

  // ── Codes ─────────────────────────────────────────────────────────────────

  section('a code is six digits, and is never stored or returned in the clear');

  r = await api('POST', '/api/contacts/verifications',
    { name: 'Neighbour', phone: '+15125550170', channel: 'SMS' });
  check('201', r.status, 201);

  const first = r.body.verification;
  check('six digits', /^\d{6}$/.test(sent.code), true);
  check('sent to the right number', sent.to, '+15125550170');
  check('response carries no code', JSON.stringify(r.body).includes(sent.code), false);

  const stored = await prisma.contactVerification.findUnique({ where: { id: first.id } });
  check('not stored in the clear', stored.codeHash === sent.code, false);
  check('stored as bcrypt', stored.codeHash.startsWith('$2'), true);
  check('and the hash really is of that code', await bcrypt.compare(sent.code, stored.codeHash), true);

  section('the contact does not exist until the code comes back');
  check('no contact yet', await prisma.contact.count({ where: { phone: '+15125550170' } }), 0);

  r = await api('POST', `/api/contacts/verifications/${first.id}/check`, { code: sent.code });
  check('201', r.status, 201);
  check('now it exists', r.body.contact.phone, '+15125550170');
  check('verified', Boolean(r.body.contact.phoneVerifiedAt), true);
  check('by SMS', r.body.contact.phoneVerifiedVia, 'SMS');

  section('a code is single-use');
  r = await api('POST', `/api/contacts/verifications/${first.id}/check`, { code: sent.code });
  check('400 the second time', r.status, 400);
  contains('says why', r.body.error, 'already been used');
  check('and no second contact', await prisma.contact.count({ where: { phone: '+15125550170' } }), 1);

  await prisma.contact.deleteMany({ where: { phone: '+15125550170' } });
  await clearSends();

  section('a wrong code is refused, and burns after enough tries');

  r = await api('POST', '/api/contacts/verifications',
    { name: 'Wrong', phone: '+15125550171', channel: 'SMS' });
  const burn = r.body.verification;
  const realCode = sent.code;
  const wrongCode = realCode === '000000' ? '111111' : '000000';

  for (let i = 1; i < config.verificationMaxChecks; i++) {
    r = await api('POST', `/api/contacts/verifications/${burn.id}/check`, { code: wrongCode });
    check(`wrong attempt ${i} refused`, r.status, 400);
  }
  contains('counts down out loud', r.body.error, 'attempt');

  r = await api('POST', `/api/contacts/verifications/${burn.id}/check`, { code: wrongCode });
  check('the last one burns it', r.status, 400);
  contains('and says so', r.body.error, 'invalid');

  // The point of the ceiling: the RIGHT code no longer works either.
  r = await api('POST', `/api/contacts/verifications/${burn.id}/check`, { code: realCode });
  check('even the right code is dead now', r.status, 400);
  check('and no contact was made', await prisma.contact.count({ where: { phone: '+15125550171' } }), 0);

  await clearSends();

  section('an expired code is refused');

  r = await api('POST', '/api/contacts/verifications',
    { name: 'Slow', phone: '+15125550172', channel: 'SMS' });
  const stale = r.body.verification;
  await prisma.contactVerification.update({
    where: { id: stale.id },
    data:  { expiresAt: new Date(Date.now() - 1000) },
  });

  r = await api('POST', `/api/contacts/verifications/${stale.id}/check`, { code: sent.code });
  check('400', r.status, 400);
  contains('says expired', r.body.error, 'expired');
  check('no contact', await prisma.contact.count({ where: { phone: '+15125550172' } }), 0);

  await clearSends();

  section('issuing a new code kills the old one');

  r = await api('POST', '/api/contacts/verifications',
    { name: 'Resend', phone: '+15125550173', channel: 'SMS' });
  const older = r.body.verification;
  const olderCode = sent.code;

  // The cooldown is the server's, so it has to be stood down to resend within
  // the same second. What is under test here is supersession, not the clock.
  await prisma.contactVerification.updateMany({
    where: { id: older.id },
    data:  { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
  });

  r = await api('POST', '/api/contacts/verifications',
    { name: 'Resend', phone: '+15125550173', channel: 'SMS' });
  const newer = r.body.verification;

  r = await api('POST', `/api/contacts/verifications/${older.id}/check`, { code: olderCode });
  check('the superseded code is dead', r.status, 400);
  r = await api('POST', `/api/contacts/verifications/${newer.id}/check`, { code: sent.code });
  check('the newest one works', r.status, 201);

  await prisma.contact.deleteMany({ where: { phone: '+15125550173' } });
  await clearSends();

  // ── Channels ──────────────────────────────────────────────────────────────

  section('a code can arrive by voice call');

  r = await api('POST', '/api/contacts/verifications',
    { name: 'Landline', phone: '+15125550174', channel: 'CALL' });
  check('201', r.status, 201);
  check('placed as a call, not a text', sent.channel, 'CALL');

  const twiml = phoneVerification.voiceTwiml('482915');
  contains('speaks the digits separately', twiml, '4, 8, 2, 9, 1, 5');
  check('and says them twice', (twiml.match(/4, 8, 2, 9, 1, 5/g) || []).length, 2);
  contains('with pauses to write it down', twiml, '<Pause');

  r = await api('POST', `/api/contacts/verifications/${r.body.verification.id}/check`, { code: sent.code });
  check('and it verifies the same way', r.status, 201);
  check('recorded as CALL', r.body.contact.phoneVerifiedVia, 'CALL');

  await prisma.contact.deleteMany({ where: { phone: '+15125550174' } });
  await clearSends();

  section('a delivery failure is the caller\'s problem, not a 500');
  failNextSend = true;
  r = await api('POST', '/api/contacts/verifications',
    { name: 'Unreachable', phone: '+15125550175', channel: 'SMS' });
  check('400 not 500', r.status, 400);
  contains('suggests the other channel', r.body.error, 'call');

  await clearSends();

  // ── Rate limits ───────────────────────────────────────────────────────────

  section('sends to one number are capped per hour');

  const target = '+15125550180';
  for (let i = 0; i < config.verificationMaxSendsPerNumber; i++) {
    r = await api('POST', '/api/contacts/verifications', { name: 'Spam', phone: target, channel: 'SMS' });
    check(`send ${i + 1} allowed`, r.status, 201);
    // Stand the cooldown down between sends; the per-hour ceiling is what is
    // under test here, and it is a different limit.
    await prisma.contactVerification.updateMany({
      where: { phone: target },
      data:  { createdAt: new Date(Date.now() - 5 * 60 * 1000) },
    });
  }

  r = await api('POST', '/api/contacts/verifications', { name: 'Spam', phone: target, channel: 'SMS' });
  check('one past the cap is 429', r.status, 429);
  check('with a Retry-After', Boolean(r.raw.headers.get('retry-after')), true);

  await clearSends();

  section('the resend cooldown stops a double-click costing two messages');
  r = await api('POST', '/api/contacts/verifications', { name: 'Fast', phone: '+15125550181', channel: 'SMS' });
  check('first send fine', r.status, 201);
  const before = sent.count;
  r = await api('POST', '/api/contacts/verifications', { name: 'Fast', phone: '+15125550181', channel: 'SMS' });
  check('immediate resend is 429', r.status, 429);
  check('and nothing was sent', sent.count, before);

  await clearSends();

  section('an account is capped across ALL numbers, not just one');
  // The limit that actually bounds the bill: capping a single number does
  // nothing about someone walking through a thousand different ones.
  for (let i = 0; i < config.verificationMaxSendsPerAccount; i++) {
    r = await api('POST', '/api/contacts/verifications',
      { name: 'Sweep', phone: `+1512555${String(2000 + i).padStart(4, '0')}`, channel: 'SMS' });
    check(`account send ${i + 1} allowed`, r.status, 201);
  }
  r = await api('POST', '/api/contacts/verifications',
    { name: 'Sweep', phone: '+15125559998', channel: 'SMS' });
  check('a fresh number is still refused once the account cap is hit', r.status, 429);

  await clearSends();

  // ── Changing a number ─────────────────────────────────────────────────────

  section('changing a number does not touch the live one until the code is back');

  r = await api('POST', `/api/contacts/${fixtures.contact.id}/verifications`,
    { phone: '+15125550999', channel: 'SMS' });
  check('201', r.status, 201);
  const change = r.body.verification;

  let row = await prisma.contact.findUnique({ where: { id: fixtures.contact.id } });
  check('live number untouched', row.phone, '+15125550150');
  check('new one is only pending', row.pendingPhone, '+15125550999');
  check('still verified throughout', Boolean(row.phoneVerifiedAt), true);

  // The call path is what actually matters here: mid-change, a call must still
  // go to the number that was verified.
  const loaded = await scheduleRepo.getById(fixtures.schedule.id);
  check('the call path still resolves the OLD number', loaded.contact.phone, '+15125550150');

  r = await api('POST', `/api/contacts/verifications/${change.id}/check`, { code: sent.code });
  check('promoted on a correct code', r.status, 200);
  check('now live', r.body.contact.phone, '+15125550999');
  check('and nothing is pending', r.body.contact.pendingPhone, null);

  section('a pending change can be abandoned, and the live number survives it');
  await api('POST', `/api/contacts/${fixtures.contact.id}/verifications`,
    { phone: '+15125550888', channel: 'SMS' });
  r = await api('DELETE', `/api/contacts/${fixtures.contact.id}/pending`);
  check('200', r.status, 200);
  check('pending gone', r.body.contact.pendingPhone, null);
  check('live number kept', r.body.contact.phone, '+15125550999');

  // Put it back, so the sections below start from the fixture's number.
  await prisma.contact.update({
    where: { id: fixtures.contact.id }, data: { phone: '+15125550150' },
  });
  await clearSends();

  // ── Scoping ───────────────────────────────────────────────────────────────

  section('a verification belongs to one account and no other');

  r = await api('POST', '/api/contacts/verifications',
    { name: 'Mine', phone: '+15125550600', channel: 'SMS' });
  const mine = r.body.verification;
  const mineCode = sent.code;

  const stranger = makeClient();
  await stranger('POST', '/api/login', { email: 'other-verify@example.test', password: PASSWORD });

  r = await stranger('POST', `/api/contacts/verifications/${mine.id}/check`, { code: mineCode });
  check('another account cannot spend it', r.status, 404);
  check('and it still works for its owner',
    (await api('POST', `/api/contacts/verifications/${mine.id}/check`, { code: mineCode })).status, 201);

  r = await stranger('POST', `/api/contacts/${fixtures.contact.id}/verifications`,
    { phone: '+15125550601', channel: 'SMS' });
  check('nor start a change on someone else\'s contact', r.status, 404);

  await prisma.contact.deleteMany({ where: { phone: '+15125550600' } });
  await clearSends();

  // ── The rule, at both levels ──────────────────────────────────────────────

  section('a schedule cannot reference an unverified contact');

  const unverified = await prisma.contact.create({
    data: {
      accountId: fixtures.account.id, name: 'Unproven', phone: '+15125550700',
      phoneVerifiedAt: null, phoneVerifiedVia: null,
    },
  });

  r = await api('POST', '/api/schedules', {
    name: 'Bad', dose: 'morning', timeOfDay: '10:00', daysOfWeek: [1],
    contactId: unverified.id, escalationContactId: fixtures.caregiver.id,
  });
  check('the API refuses it', r.status, 400);
  contains('naming the field', r.body.details.contactId, 'not verified');

  r = await api('POST', '/api/schedules', {
    name: 'Bad escalation', dose: 'morning', timeOfDay: '10:00', daysOfWeek: [1],
    contactId: fixtures.contact.id, escalationContactId: unverified.id,
  });
  check('escalation contact too', r.status, 400);
  contains('naming that field', r.body.details.escalationContactId, 'not verified');

  // Past the API entirely — this is the guarantee, rather than the courtesy.
  let raw = null;
  try {
    await prisma.schedule.create({
      data: {
        accountId: fixtures.account.id, name: 'Straight to the DB', dose: 'evening',
        timeOfDay: '20:00', daysOfWeek: [1], contactId: unverified.id,
      },
    });
  } catch (err) { raw = err; }
  check('and the database refuses it too', Boolean(raw), true);
  contains('by name', String(raw && raw.message), 'schedules_contact_must_be_verified');

  section('an unverified contact cannot be smuggled in by UPDATE either');
  raw = null;
  try {
    await prisma.schedule.update({
      where: { id: fixtures.schedule.id },
      data:  { contactId: unverified.id },
    });
  } catch (err) { raw = err; }
  check('repointing a live schedule is refused', Boolean(raw), true);
  check('and it still points where it did',
    (await prisma.schedule.findUnique({ where: { id: fixtures.schedule.id } })).contactId,
    fixtures.contact.id);

  section('a contact a schedule uses cannot be quietly un-verified');
  raw = null;
  try {
    await prisma.contact.update({
      where: { id: fixtures.contact.id },
      data:  { phoneVerifiedAt: null, phoneVerifiedVia: null },
    });
  } catch (err) { raw = err; }
  check('refused', Boolean(raw), true);
  contains('by name', String(raw && raw.message), 'contacts_cannot_unverify_while_scheduled');

  // ── The regression that matters ───────────────────────────────────────────

  section('THE ONE THAT MATTERS: firing a schedule is never blocked by any of this');

  // The trigger sits on UPDATE of schedules, and claimForFire is an UPDATE of
  // schedules that runs before every single call. If the trigger ever stopped
  // being guarded on the reference actually changing, this is what would break —
  // and it would present as the phone silently never ringing again, with a green
  // API test suite and nothing in the logs.
  await prisma.schedule.update({
    where: { id: fixtures.schedule.id }, data: { lastFiredAt: null },
  });

  const claimed = await scheduleRepo.claimForFire(fixtures.schedule.id, new Date(), 60 * 1000);
  check('a schedule still claims for firing', claimed, true);

  // And again with an unverified contact sitting in the same account, so the
  // guard is proved to be about THIS row rather than about the table being clean.
  await prisma.schedule.update({
    where: { id: fixtures.schedule.id }, data: { lastFiredAt: null },
  });
  check('even with unverified contacts in the account',
    await scheduleRepo.claimForFire(fixtures.schedule.id, new Date(), 60 * 1000), true);

  // The harshest version: the contact this live schedule points at has no stamp
  // at all. That state is unreachable through the API, but a restored backup or
  // a hand-edited row could produce it — and even then, firing must not stop.
  // A missed dose is worse than a number nobody re-proved.
  await prisma.$executeRaw`UPDATE contacts SET phone_verified_at = NULL, phone_verified_via = NULL WHERE id = ${fixtures.contact.id}::uuid`;
  await prisma.schedule.update({
    where: { id: fixtures.schedule.id }, data: { lastFiredAt: null },
  });
  check('even when its own contact somehow has no stamp',
    await scheduleRepo.claimForFire(fixtures.schedule.id, new Date(), 60 * 1000), true);

  await prisma.$executeRaw`UPDATE contacts SET phone_verified_at = now(), phone_verified_via = 'GRANDFATHERED' WHERE id = ${fixtures.contact.id}::uuid`;

  section('and the other writes the scheduler makes are equally unaffected');
  check('disabling a schedule still works',
    Boolean(await scheduleRepo.setEnabled(fixtures.account.id, fixtures.schedule.id, false)), true);
  check('and enabling it again',
    Boolean(await scheduleRepo.setEnabled(fixtures.account.id, fixtures.schedule.id, true)), true);

  await new Promise((resolve) => server.close(resolve));
  await prisma.session.deleteMany({});
  await truncateAll(prisma);

  process.exitCode = summary() ? 1 : 0;
}

main()
  .catch((e) => { console.error('FAILED:', e); process.exitCode = 1; })
  .finally(async () => {
    if (server) server.close();
    await db.disconnect();
  });
