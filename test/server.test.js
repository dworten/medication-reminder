'use strict';
// app.js itself — the wiring no other suite touches.
//
// The API suites mount the router on a throwaway express app, which is the
// right way to test the API but leaves app.js untested: the page gating, the
// redirects, and /trigger, which is not part of the API router at all.
//
// /trigger is the reason this exists. It used to resolve schedules across EVERY
// account, so once registration opened, a stranger's trigger would have used
// the deployment owner's schedule and rung the owner's grandmother.

const path = require('path');
const { spawn } = require('child_process');
const { check, contains, section, summary, assertScratchDatabase, truncateAll, makeContact } = require('./helpers');
require('dotenv').config();

const bcrypt = require('bcryptjs');
const db     = require('../src/db');

const prisma   = db.getClient();
const PORT     = 8097;
const BASE     = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'server-suite-password';
const SECRET   = 'server-suite-trigger-secret';
const ADMIN_EMAIL = 'admin@example.test';

let server;

function client() {
  let cookie = null;
  return async function request(method, urlPath, body, headers = {}) {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(cookie && { Cookie: cookie }),
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* html */ }
    return { status: res.status, body: json, text, location: res.headers.get('location') };
  };
}

const fixtures = {};

async function seed() {
  const hash = await bcrypt.hash(PASSWORD, 4);

  // ADMIN_EMAIL names the admin explicitly, and the server below is started
  // with it pointed here. Deliberately NOT the oldest account — the fallback
  // rule is "oldest", so creating this one second proves the email is what
  // decides, not creation order.
  fixtures.stranger = await prisma.account.create({
    data: { email: 'stranger@example.test', passwordHash: hash },
  });

  fixtures.owner = await prisma.account.create({
    data: { email: ADMIN_EMAIL, passwordHash: hash },
  });
  const contact = await makeContact(prisma, {
    data: { accountId: fixtures.owner.id, name: 'Grandma', phone: '+15125550150' },
  });
  fixtures.ownerSchedule = await prisma.schedule.create({
    data: {
      accountId: fixtures.owner.id, name: 'Morning', dose: 'morning',
      timeOfDay: '09:20', daysOfWeek: [1, 2, 3, 4, 5, 6], contactId: contact.id,
    },
  });

}

async function start() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'app.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      MOCK_MODE: 'true',
      TRIGGER_SECRET: SECRET,
      ADMIN_EMAIL,
      SESSION_SECRET: process.env.SESSION_SECRET || 'server-suite-session-secret-32-chars-min',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  // Wait for it to actually listen rather than sleeping a fixed amount.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return log;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server did not start:\n${log}`);
}

async function main() {
  await assertScratchDatabase(prisma);
  await truncateAll(prisma);
  await prisma.session.deleteMany({});
  await seed();
  await start();

  // ── pages ─────────────────────────────────────────────────────────────────

  section('pages are gated, and lead where they should');
  const anon = client();

  let r = await anon('GET', '/app');
  check('/app redirects when logged out', r.status, 302);
  check('to /login', r.location, '/login');
  r = await anon('GET', '/app/app.js');
  check('so do its modules', r.status, 302);
  r = await anon('GET', '/');
  check('/ forwards to /login', r.location, '/login');
  r = await anon('GET', '/login');
  check('/login is served', r.status, 200);
  r = await anon('GET', '/signup');
  check('/signup is served', r.status, 200);
  contains('and is the signup form', r.text, '/api/signup');

  section('webhooks are untouched by any of the auth work');
  const hook = await fetch(`${BASE}/webhook/status`, { method: 'POST' });
  check('unsigned webhook is 403, not 401 or a redirect', hook.status, 403);

  // ── /trigger: the security fix ────────────────────────────────────────────

  section('/trigger is closed to anonymous callers');
  r = await anon('POST', '/trigger?dose=morning');
  check('403 without a secret or session', r.status, 403);

  section('/trigger by shared secret still behaves as it always did');
  r = await anon('POST', '/trigger?dose=morning', undefined, { 'X-Trigger-Secret': SECRET });
  check('accepted', r.status, 200);
  check('and used the database', r.body.source, 'database');

  section('A STRANGER CANNOT TRIGGER A CALL ON SOMEONE ELSE\'S SCHEDULE');
  const stranger = client();
  r = await stranger('POST', '/api/login', { email: 'stranger@example.test', password: PASSWORD });
  check('the stranger is signed in', r.status, 200);

  // They have no schedules at all. Before the fix this found the owner's
  // morning schedule and rang the owner's grandmother.
  r = await stranger('POST', '/trigger?dose=morning');
  check('refused — no schedule of their own', r.status, 400);
  contains('and says so', r.body.error, 'your account');

  // Naming the owner's schedule directly must not work either.
  r = await stranger('POST', `/trigger?dose=morning&scheduleId=${fixtures.ownerSchedule.id}`);
  check('a foreign schedule id → 404', r.status, 404);

  // TEST_PHONE_NUMBER belongs to the deployment owner, not to every account.
  r = await stranger('POST', '/trigger?dose=morning&target=test');
  check('target=test refused for a stranger', r.status, 403);
  contains('and explains whose number it is', r.body.error, 'not yours');

  section('the ADMIN account, named by email, is unaffected');
  const owner = client();
  r = await owner('POST', '/api/login', { email: ADMIN_EMAIL, password: PASSWORD });
  check('owner signed in', r.status, 200);

  r = await owner('POST', '/trigger?dose=morning');
  check('their own schedule triggers fine', r.status, 200);
  check('resolved from the database', r.body.source, 'database');
  check('and it is their schedule', r.body.schedule.id, fixtures.ownerSchedule.id);

  r = await owner('POST', '/trigger?dose=morning&target=test');
  // TEST_PHONE_NUMBER may or may not be set in this environment; either the
  // call is accepted or it complains the number is missing. What must NOT
  // happen is the 403 a non-owner gets.
  check('target=test is allowed for the owner', r.status !== 403, true);

  section('a dose with no schedule is refused rather than falling back');
  r = await owner('POST', '/trigger?dose=evening');
  check('400, not a call to the env number', r.status, 400);

  await new Promise((resolve) => server.close?.() ?? resolve());
  server.kill();
  await prisma.session.deleteMany({});
  await truncateAll(prisma);

  process.exitCode = summary() ? 1 : 0;
}

main()
  .catch((e) => { console.error('FAILED:', e); process.exitCode = 1; })
  .finally(async () => {
    if (server) server.kill();
    await db.disconnect();
  });
