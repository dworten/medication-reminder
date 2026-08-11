'use strict';

// Minimal assertion helpers — this project has no test framework and does not
// need one for a handful of suites.

let pass = 0, fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        got:  ${JSON.stringify(actual)}`);
    console.log(`        want: ${JSON.stringify(expected)}`);
  }
}

function contains(label, haystack, needle) {
  const ok = String(haystack).includes(needle);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        in: ${haystack}`);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

function summary() {
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
}

// Guard for the suites that write to a real database.
//
// These tests truncate every table. That is fine against a scratch database and
// catastrophic against the one holding a real medication schedule, so they
// refuse to run the moment they see an account that is not obviously a fixture.
// Seed data created by prisma/seed.js uses a real email address and will trip
// this deliberately.
async function assertScratchDatabase(prisma) {
  const accounts = await prisma.account.findMany({ select: { email: true } });
  const real = accounts.filter(a => !a.email.endsWith('@example.test'));

  if (real.length) {
    console.error('\nRefusing to run: this database holds real data.');
    console.error(`Found ${real.length} non-fixture account(s): ${real.map(a => a.email).join(', ')}`);
    console.error('These suites truncate every table. Point DATABASE_URL at a scratch database first.\n');
    process.exit(1);
  }
}

// escalate() queues a row and then kicks a sweep in the background, so the SMS
// normally goes out within milliseconds rather than waiting for the next tick.
// Tests have to let that settle before asserting, or they race it.
async function waitFor(predicate, { timeoutMs = 5000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, everyMs));
  }
  return false;
}

// A fixture contact, carrying a verification stamp.
//
// Not a convenience. A database trigger refuses to attach an unverified contact
// to a schedule, so an unstamped fixture makes every schedule insert in every
// suite fail — which is the correct behaviour under test and useless as a
// starting state. Stamped GRANDFATHERED because that is what these are: numbers
// asserted by the fixture rather than proved by a code.
//
// Takes the same argument shape as prisma.contact.create so the call sites read
// unchanged, and so a suite that WANTS an unverified contact can pass
// phoneVerifiedAt: null and override it.
async function makeContact(prisma, args) {
  return prisma.contact.create({
    ...args,
    data: {
      phoneVerifiedAt:  new Date(),
      phoneVerifiedVia: 'GRANDFATHERED',
      ...args.data,
    },
  });
}

async function truncateAll(prisma) {
  // FK-safe order: schedules reference contacts with RESTRICT.
  // call_history rows reference each other via parent_id, so they go first as a
  // group — the FK is SET NULL, which a bulk delete satisfies.
  await prisma.callHistory.deleteMany({});
  await prisma.schedule.deleteMany({});
  await prisma.message.deleteMany({});
  // Cascades from contacts and accounts would take these anyway; deleting them
  // explicitly keeps the order readable rather than load-bearing.
  await prisma.contactVerification.deleteMany({});
  await prisma.contact.deleteMany({});
  await prisma.account.deleteMany({});
}

module.exports = {
  check, contains, section, summary,
  assertScratchDatabase, truncateAll, waitFor, makeContact,
};
