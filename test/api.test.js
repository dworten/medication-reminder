'use strict';
// Phase 3, step 1 — the API and its authentication.
//
// Driven over real HTTP against the real router on an ephemeral port, using
// Node's built-in fetch. Nothing is stubbed: the session cookie is issued by
// express-session, stored in Postgres, and returned by the client the way a
// browser would. Mocking any of that would test the mock.
//
// The case this suite exists for is the last one: a request carrying another
// account's row id must get 404, not data. Everything else is table stakes.

const { check, contains, section, summary, assertScratchDatabase, truncateAll, makeContact } = require('./helpers');
require('dotenv').config();

const express = require('express');
const bcrypt  = require('bcryptjs');

const db        = require('../src/db');
const config    = require('../src/config');
const apiRouter = require('../src/api');

// Live-mode cookies are `secure`, which a plain-http test server never sends
// back. This is the one setting that has to differ from production.
config.nodeEnv = 'test';
config.sessionSecret = config.sessionSecret || 'test-session-secret-at-least-32-chars-long';

const session = require('../src/session');
const prisma  = db.getClient();

const PASSWORD = 'correct-horse-battery-staple';

// The outbound edge of verification, intercepted the way callManager's
// placeVoiceCall already is. Everything upstream — generating the code, hashing
// it, storing it, the rate limits — runs for real; only the request to Twilio is
// replaced. Capturing the plaintext here is the only way a test can enter the
// right code, since what gets stored is a hash by design.
const phoneVerification = require('../src/phoneVerification');
const sent = { code: null, to: null, channel: null };

phoneVerification.sendVerificationSms = async (to, code) => {
  Object.assign(sent, { to, code, channel: 'SMS' });
  return 'SM_test_sid';
};
phoneVerification.placeVerificationCall = async (to, code) => {
  Object.assign(sent, { to, code, channel: 'CALL' });
  return 'CA_test_sid';
};

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

// A cookie jar just big enough to behave like a browser for one origin.
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
  const hash = await bcrypt.hash(PASSWORD, 4); // low cost: this is a test

  fixtures.account = await prisma.account.create({
    data: { email: 'api@example.test', name: 'API Test', passwordHash: hash },
  });
  // A second account, existing only so "scoped to my account" can be disproved
  // rather than assumed.
  fixtures.other = await prisma.account.create({
    data: { email: 'other@example.test', name: 'Someone Else', passwordHash: hash },
  });

  fixtures.contact = await makeContact(prisma, {
    data: { accountId: fixtures.account.id, name: 'Grandma', phone: '+15125550150' },
  });
  fixtures.caregiver = await makeContact(prisma, {
    data: { accountId: fixtures.account.id, name: 'Caregiver', phone: '+15125550160', role: 'CAREGIVER' },
  });
  fixtures.otherContact = await makeContact(prisma, {
    data: { accountId: fixtures.other.id, name: 'Not Yours', phone: '+15125550190' },
  });
  fixtures.message = await prisma.message.create({
    data: { accountId: fixtures.account.id, name: 'Default', kind: 'TTS', ttsText: 'Take your pills.', isDefault: true },
  });
  fixtures.schedule = await prisma.schedule.create({
    data: {
      accountId: fixtures.account.id, name: 'Morning', dose: 'morning',
      timeOfDay: '09:20', daysOfWeek: [1, 2, 3, 4, 5, 6],
      contactId: fixtures.contact.id, escalationContactId: fixtures.caregiver.id,
      messageId: fixtures.message.id,
    },
  });
  fixtures.otherSchedule = await prisma.schedule.create({
    data: {
      accountId: fixtures.other.id, name: 'Not Yours', dose: 'evening',
      timeOfDay: '21:20', daysOfWeek: [0], contactId: fixtures.otherContact.id,
    },
  });
  await prisma.callHistory.createMany({
    data: [
      { accountId: fixtures.account.id, scheduleId: fixtures.schedule.id, contactId: fixtures.contact.id,
        dose: 'morning', attempt: 1, outcome: 'CONFIRMED', startedAt: new Date('2026-08-01T14:20:00Z') },
      { accountId: fixtures.account.id, scheduleId: fixtures.schedule.id, contactId: fixtures.contact.id,
        dose: 'evening', attempt: 1, outcome: 'NO_ANSWER', startedAt: new Date('2026-08-02T02:20:00Z') },
      { accountId: fixtures.other.id, scheduleId: fixtures.otherSchedule.id, contactId: fixtures.otherContact.id,
        dose: 'morning', attempt: 1, outcome: 'CONFIRMED', startedAt: new Date('2026-08-02T14:20:00Z') },
    ],
  });
}

async function main() {
  await assertScratchDatabase(prisma);
  await truncateAll(prisma);
  await prisma.session.deleteMany({});
  await seedFixtures();
  await start();

  const api = makeClient();

  // ── authentication ────────────────────────────────────────────────────────

  section('everything is closed until you log in');
  let r = await api('GET', '/api/me');
  check('/api/me is 401', r.status, 401);
  r = await api('GET', '/api/contacts');
  check('contacts 401', r.status, 401);
  r = await api('GET', '/api/schedules');
  check('schedules 401', r.status, 401);
  r = await api('GET', '/api/call-history');
  check('call history 401', r.status, 401);
  r = await api('POST', '/api/contacts', { name: 'X', phone: '+15125550001' });
  check('writes 401 too', r.status, 401);

  section('a bad password does not get in, and says nothing useful');
  r = await api('POST', '/api/login', { email: 'api@example.test', password: 'wrong' });
  check('401', r.status, 401);
  check('same message whatever is wrong', r.body.error, 'Invalid email or password');
  r = await api('POST', '/api/login', { email: 'nobody@example.test', password: PASSWORD });
  check('unknown email is indistinguishable', r.body.error, 'Invalid email or password');

  section('an account with no password set can never log in');
  const noPassword = await prisma.account.create({ data: { email: 'nopass@example.test' } });
  r = await api('POST', '/api/login', { email: 'nopass@example.test', password: '' });
  check('empty password rejected', r.status, 400);
  r = await api('POST', '/api/login', { email: 'nopass@example.test', password: 'anything' });
  check('and so is any password', r.status, 401);
  await prisma.account.delete({ where: { id: noPassword.id } });

  section('logging in issues a session');
  r = await api('POST', '/api/login', { email: 'api@example.test', password: PASSWORD });
  check('200', r.status, 200);
  check('returns the account', r.body.account.email, 'api@example.test');
  check('never returns the hash', r.body.account.passwordHash, undefined);
  contains('cookie is httpOnly', r.raw.headers.get('set-cookie'), 'HttpOnly');
  contains('cookie is sameSite lax', r.raw.headers.get('set-cookie'), 'SameSite=Lax');

  r = await api('GET', '/api/me');
  check('/api/me now works', r.status, 200);
  check('and knows who I am', r.body.account.email, 'api@example.test');
  check('no hash here either', r.body.account.passwordHash, undefined);

  // ── contacts ──────────────────────────────────────────────────────────────

  section('contacts: list, verify-then-create, update, delete');
  r = await api('GET', '/api/contacts');
  check('lists only my contacts', r.body.contacts.length, 2);
  check('not the other account\'s', r.body.contacts.some(c => c.name === 'Not Yours'), false);

  // Creating a contact is now two requests: send a code, then enter it. The
  // contact does not exist in between.
  r = await api('POST', '/api/contacts/verifications',
    { name: 'Neighbour', phone: '+15125550170', role: 'CAREGIVER', channel: 'SMS' });
  check('code sent', r.status, 201);
  check('never returns the code', r.body.verification.code, undefined);
  check('no contact yet', (await api('GET', '/api/contacts')).body.contacts.length, 2);

  r = await api('POST', `/api/contacts/verifications/${r.body.verification.id}/check`, { code: sent.code });
  check('created on a correct code', r.status, 201);
  const newContactId = r.body.contact.id;
  check('stored as given', r.body.contact.phone, '+15125550170');
  check('and marked verified', Boolean(r.body.contact.phoneVerifiedAt), true);
  check('recording how', r.body.contact.phoneVerifiedVia, 'SMS');

  r = await api('PATCH', `/api/contacts/${newContactId}`, { name: 'Neighbour Pat' });
  check('updated', r.status, 200);
  check('name changed', r.body.contact.name, 'Neighbour Pat');
  check('phone untouched by a partial update', r.body.contact.phone, '+15125550170');

  r = await api('DELETE', `/api/contacts/${newContactId}`);
  check('deleted', r.status, 204);
  r = await api('GET', `/api/contacts/${newContactId}`);
  check('and gone', r.status, 404);

  section('contacts: the unverified back doors are shut');
  r = await api('POST', '/api/contacts', { name: 'Sneaky', phone: '+15125550171' });
  check('direct create is 405', r.status, 405);
  contains('and says what to do instead', JSON.stringify(r.body.details), '/api/contacts/verifications');

  r = await api('PATCH', `/api/contacts/${fixtures.contact.id}`, { phone: '+15125559999' });
  check('PATCHing a phone is 400', r.status, 400);
  contains('and points at verification', r.body.details.phone, 'verification');
  check('number unchanged',
    (await prisma.contact.findUnique({ where: { id: fixtures.contact.id } })).phone, '+15125550150');

  section('contacts: validation, not a 500');
  r = await api('POST', '/api/contacts/verifications', { name: 'Bad', phone: '5125550150', channel: 'SMS' });
  check('400 not 500', r.status, 400);
  contains('names the field', JSON.stringify(r.body.details), 'phone');
  contains('explains E.164', r.body.details.phone, 'E.164');

  r = await api('POST', '/api/contacts/verifications', { phone: '+15125550111', channel: 'SMS' });
  check('missing name rejected', r.status, 400);
  check('says which field', r.body.details.name, 'is required');

  r = await api('POST', '/api/contacts/verifications', { name: 'X', phone: '+15125550112', channel: 'CARRIER PIGEON' });
  check('unknown channel rejected', r.status, 400);
  contains('lists the real ones', r.body.details.channel, 'SMS');

  section('contacts: a duplicate phone is a 409, before any code is sent');
  const sendsBefore = await prisma.contactVerification.count();
  r = await api('POST', '/api/contacts/verifications', { name: 'Dup', phone: '+15125550150', channel: 'SMS' });
  check('409', r.status, 409);
  contains('says why', r.body.error, 'already exists');
  check('and nothing was sent', await prisma.contactVerification.count(), sendsBefore);

  section('contacts: one still used by a schedule cannot be deleted');
  r = await api('DELETE', `/api/contacts/${fixtures.contact.id}`);
  check('409', r.status, 409);
  check('and says which schedule', r.body.details.schedules[0].name, 'Morning');

  // ── messages ──────────────────────────────────────────────────────────────

  section('messages: TTS needs words, AUDIO needs a file');
  r = await api('POST', '/api/messages', { name: 'Empty', kind: 'TTS' });
  check('TTS without text rejected', r.status, 400);
  check('says so', r.body.details.ttsText, 'is required when kind is TTS');

  r = await api('POST', '/api/messages', { name: 'Bad audio', kind: 'AUDIO', audioUrl: 'http://example.com/a.mp3' });
  check('plain http rejected', r.status, 400);
  contains('wants https', r.body.details.audioUrl, 'https');

  r = await api('POST', '/api/messages', { name: 'Evening', kind: 'TTS', ttsText: 'Evening pills.' });
  check('created', r.status, 201);
  const messageId = r.body.message.id;

  section('messages: making one default unsets the previous one');
  r = await api('PATCH', `/api/messages/${messageId}`, { isDefault: true });
  check('200', r.status, 200);
  check('is now default', r.body.message.isDefault, true);
  const oldDefault = await prisma.message.findUnique({ where: { id: fixtures.message.id } });
  check('the old one is not', oldDefault.isDefault, false);

  // ── schedules ─────────────────────────────────────────────────────────────

  section('schedules: the constraints that matter are 400s');
  const validSchedule = {
    name: 'Test', dose: 'morning', timeOfDay: '09:20', daysOfWeek: [1, 2, 3],
    contactId: fixtures.contact.id, escalationContactId: fixtures.caregiver.id,
  };

  r = await api('POST', '/api/schedules', { ...validSchedule, daysOfWeek: [] });
  check('empty daysOfWeek rejected', r.status, 400);
  contains('explains', r.body.details.daysOfWeek, 'between 1 and 7');

  r = await api('POST', '/api/schedules', { ...validSchedule, daysOfWeek: [1, 1, 2] });
  check('duplicate days rejected', r.status, 400);

  r = await api('POST', '/api/schedules', { ...validSchedule, daysOfWeek: [0, 7] });
  check('day 7 rejected', r.status, 400);

  r = await api('POST', '/api/schedules', { ...validSchedule, timeOfDay: '9:20' });
  check('H:MM rejected', r.status, 400);
  r = await api('POST', '/api/schedules', { ...validSchedule, timeOfDay: '25:00' });
  check('25:00 rejected', r.status, 400);

  r = await api('POST', '/api/schedules', { ...validSchedule, timezone: 'America/Nowhere' });
  check('unknown timezone rejected', r.status, 400);
  contains('names IANA', r.body.details.timezone, 'IANA');

  r = await api('POST', '/api/schedules', { ...validSchedule, dose: 'lunchtime' });
  check('unknown dose rejected', r.status, 400);

  r = await api('POST', '/api/schedules', { ...validSchedule, escalationAckMinutes: 0 });
  check('ack window below 1 rejected', r.status, 400);

  section('schedules: a schedule that alerts nobody is refused');
  r = await api('POST', '/api/schedules', { ...validSchedule, escalateWithCall: false, escalateWithSms: false });
  check('400', r.status, 400);
  contains('explains the consequence', JSON.stringify(r.body.details), 'nobody is told');

  section('schedules: cannot borrow another account\'s contact');
  r = await api('POST', '/api/schedules', { ...validSchedule, contactId: fixtures.otherContact.id });
  check('400', r.status, 400);
  check('reads as no such contact', r.body.details.contactId, 'no such contact');

  section('schedules: create, toggle, delete');
  r = await api('POST', '/api/schedules', validSchedule);
  check('created', r.status, 201);
  const scheduleId = r.body.schedule.id;
  check('enabled by default', r.body.schedule.enabled, true);
  check('relations came back', r.body.schedule.contact.name, 'Grandma');

  // Computed server-side so the interface cannot drift from the scheduler.
  check('carries nextRunAt', typeof r.body.schedule.nextRunAt, 'string');
  check('which is in the future', new Date(r.body.schedule.nextRunAt) > new Date(), true);
  r = await api('GET', '/api/schedules');
  check('and on the list too', r.body.schedules.every(s => 'nextRunAt' in s), true);

  r = await api('POST', `/api/schedules/${scheduleId}/enabled`, { enabled: false });
  check('disabled', r.status, 200);
  check('reflected', r.body.schedule.enabled, false);
  // Still reported when off, so the UI can say "would have been…" rather than
  // going blank on the state where nobody gets called.
  check('nextRunAt still reported when disabled', typeof r.body.schedule.nextRunAt, 'string');
  r = await api('POST', `/api/schedules/${scheduleId}/enabled`, { enabled: 'no' });
  check('non-boolean rejected', r.status, 400);

  r = await api('DELETE', `/api/schedules/${scheduleId}`);
  check('deleted', r.status, 204);

  // ── call history ──────────────────────────────────────────────────────────

  section('call history: read-only, paginated, filterable');
  r = await api('GET', '/api/call-history');
  check('200', r.status, 200);
  check('only my rows', r.body.callHistory.length, 2);
  check('total agrees', r.body.pagination.total, 2);
  check('hasMore false', r.body.pagination.hasMore, false);

  r = await api('GET', '/api/call-history?limit=1');
  check('paginates', r.body.callHistory.length, 1);
  check('hasMore true', r.body.pagination.hasMore, true);
  check('newest first', r.body.callHistory[0].dose, 'evening');

  r = await api('GET', '/api/call-history?limit=1&offset=1');
  check('offset works', r.body.callHistory[0].dose, 'morning');

  r = await api('GET', '/api/call-history?dose=morning');
  check('filters by dose', r.body.callHistory.length, 1);

  r = await api(`GET`, `/api/call-history?from=2026-08-02T00:00:00Z`);
  check('filters by date', r.body.callHistory.length, 1);
  r = await api(`GET`, `/api/call-history?contactId=${fixtures.contact.id}`);
  check('filters by contact', r.body.callHistory.length, 2);

  r = await api('GET', '/api/call-history?limit=0');
  check('limit 0 rejected', r.status, 400);
  r = await api('GET', '/api/call-history?limit=5000');
  check('unbounded limit rejected', r.status, 400);
  r = await api('GET', '/api/call-history?from=banana');
  check('bad date rejected', r.status, 400);

  r = await api('POST', '/api/call-history', { dose: 'morning' });
  check('there is no way to write history', r.status, 404);

  // ── the case this suite exists for ────────────────────────────────────────

  section('ANOTHER ACCOUNT\'S ROWS ARE NOT REACHABLE, EVEN BY ID');
  r = await api('GET', `/api/contacts/${fixtures.otherContact.id}`);
  check('read → 404', r.status, 404);
  r = await api('PATCH', `/api/contacts/${fixtures.otherContact.id}`, { name: 'Hijacked' });
  check('update → 404', r.status, 404);
  r = await api('DELETE', `/api/contacts/${fixtures.otherContact.id}`);
  check('delete → 404', r.status, 404);
  r = await api('GET', `/api/schedules/${fixtures.otherSchedule.id}`);
  check('schedule read → 404', r.status, 404);
  r = await api('POST', `/api/schedules/${fixtures.otherSchedule.id}/enabled`, { enabled: false });
  check('schedule toggle → 404', r.status, 404);
  r = await api('DELETE', `/api/schedules/${fixtures.otherSchedule.id}`);
  check('schedule delete → 404', r.status, 404);

  // 404 has to mean "nothing happened", not "nothing was returned".
  const untouched = await prisma.contact.findUnique({ where: { id: fixtures.otherContact.id } });
  check('the other contact still exists', Boolean(untouched), true);
  check('and was not renamed', untouched.name, 'Not Yours');
  const otherSchedule = await prisma.schedule.findUnique({ where: { id: fixtures.otherSchedule.id } });
  check('the other schedule still exists', Boolean(otherSchedule), true);
  check('and is still enabled', otherSchedule.enabled, true);

  // ── logout ────────────────────────────────────────────────────────────────

  section('logging out ends the session server-side');
  const sessionsBefore = await prisma.session.count();
  check('a session row existed', sessionsBefore > 0, true);

  r = await api('POST', '/api/logout');
  check('200', r.status, 200);
  r = await api('GET', '/api/me');
  check('/api/me is 401 again', r.status, 401);
  r = await api('GET', '/api/contacts');
  check('and so is everything else', r.status, 401);

  // ── signup ────────────────────────────────────────────────────────────────

  section('signup: validation before anything is created');
  const fresh = makeClient();
  const before = await prisma.account.count();

  r = await fresh('POST', '/api/signup', { email: 'not-an-email', password: 'a-long-enough-password' });
  check('bad email rejected', r.status, 400);
  contains('names the field', JSON.stringify(r.body.details), 'email');

  r = await fresh('POST', '/api/signup', { email: 'new@example.test', password: 'short' });
  check('short password rejected', r.status, 400);
  contains('says how long', r.body.details.password, 'at least');

  r = await fresh('POST', '/api/signup', { email: 'new@example.test' });
  check('missing password rejected', r.status, 400);

  check('nothing was created by any of that', await prisma.account.count(), before);

  section('signup: creates an account and signs you straight in');
  r = await fresh('POST', '/api/signup', {
    email: 'NEW@Example.Test', name: 'New Person', password: 'a-long-enough-password',
  });
  check('201', r.status, 201);
  check('email normalised to lowercase', r.body.account.email, 'new@example.test');
  check('never returns the hash', r.body.account.passwordHash, undefined);

  r = await fresh('GET', '/api/me');
  check('already signed in', r.status, 200);
  check('as the new account', r.body.account.email, 'new@example.test');

  section('signup: the email is taken');
  const another = makeClient();
  r = await another('POST', '/api/signup', { email: 'new@example.test', password: 'a-long-enough-password' });
  check('409', r.status, 409);
  contains('says why', r.body.error, 'already exists');

  section('signup: the password actually works');
  const relog = makeClient();
  r = await relog('POST', '/api/login', { email: 'new@example.test', password: 'a-long-enough-password' });
  check('can log in with it', r.status, 200);

  section('A NEW ACCOUNT SEES NOTHING OF ANYONE ELSE\'S');
  // The whole reason open registration is safe to run at all.
  r = await fresh('GET', '/api/contacts');
  check('no contacts', r.body.contacts.length, 0);
  r = await fresh('GET', '/api/schedules');
  check('no schedules', r.body.schedules.length, 0);
  r = await fresh('GET', '/api/call-history');
  check('no history', r.body.callHistory.length, 0);

  // And cannot reach the fixture account's rows by id.
  r = await fresh('GET', `/api/contacts/${fixtures.contact.id}`);
  check('a known contact id → 404', r.status, 404);
  r = await fresh('POST', `/api/schedules/${fixtures.schedule.id}/enabled`, { enabled: false });
  check('cannot disable a stranger\'s schedule', r.status, 404);
  const stillOn = await prisma.schedule.findUnique({ where: { id: fixtures.schedule.id } });
  check('and it really is untouched', stillOn.enabled, true);

  section('/api/me reports whether this account administers the deployment');
  // A display hint for the interface — it hides the Test buttons rather than
  // showing ones that only 403. /trigger checks for itself regardless.
  // `api` was signed out two sections ago; this needs two live sessions.
  const asFixture = makeClient();
  await asFixture('POST', '/api/login', { email: 'api@example.test', password: PASSWORD });

  config.adminEmail = 'api@example.test';
  r = await asFixture('GET', '/api/me');
  check('the named admin is flagged', r.body.account.isAdmin, true);
  r = await fresh('GET', '/api/me');
  check('a new account is not', r.body.account.isAdmin, false);

  // The email decides, not who registered first — `fresh` is the NEWER account.
  config.adminEmail = 'new@example.test';
  r = await asFixture('GET', '/api/me');
  check('changing ADMIN_EMAIL moves it', r.body.account.isAdmin, false);
  r = await fresh('GET', '/api/me');
  check('to whoever it names', r.body.account.isAdmin, true);
  config.adminEmail = '';

  section('signup can be closed without a deploy');
  config.signupEnabled = false;
  r = await makeClient()('POST', '/api/signup', { email: 'nope@example.test', password: 'a-long-enough-password' });
  check('503', r.status, 503);
  check('and no account made', await prisma.account.findUnique({ where: { email: 'nope@example.test' } }), null);
  config.signupEnabled = true;

  section('unknown API paths are JSON, not HTML');
  r = await api('GET', '/api/nope');
  check('404', r.status, 404);
  check('json body', r.body.error, 'No such endpoint');

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
