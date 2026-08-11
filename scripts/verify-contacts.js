'use strict';

// npm run verify-contacts — the verification stamp, from the command line.
//
//   npm run verify-contacts                  list every contact and its stamp
//   npm run verify-contacts -- --mark <id>   stamp one as verified
//   npm run verify-contacts -- --mark-all    stamp every unverified contact
//   npm run verify-contacts -- --unmark <id> withdraw a stamp
//
// The migration already grandfathered the contacts that existed when
// verification was added, so on a normal install there is nothing to do here.
// This exists for the cases the migration cannot cover: a contact restored from
// a backup taken before the column existed, a row typed straight into Prisma
// Studio, or the opposite direction — a number you have stopped trusting and
// want to force back through a real code.
//
// --unmark is refused by the database when a schedule still points at the
// contact, and that refusal is the correct one: withdrawing the stamp would
// otherwise leave a live schedule in a state the API would never let you create.
// Repoint or delete those schedules first.

require('dotenv').config();

const { PrismaClient } = require('../src/generated/prisma');
const { PrismaPg }     = require('@prisma/adapter-pg');

function prismaClient() {
  const connectionString = (process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] || true);
}

// Never print a full number to a terminal that may be shared or recorded.
const mask = (phone) =>
  (phone && phone.length > 6 ? `${phone.slice(0, 5)}${'*'.repeat(phone.length - 7)}${phone.slice(-2)}` : phone);

function describe(contact) {
  const stamp = contact.phoneVerifiedAt
    ? `verified  ${String(contact.phoneVerifiedVia).padEnd(14)} ${contact.phoneVerifiedAt.toISOString().slice(0, 10)}`
    : 'UNVERIFIED';
  const pending = contact.pendingPhone ? `  (pending ${mask(contact.pendingPhone)})` : '';
  return `  ${contact.id}  ${contact.name.padEnd(18)} ${mask(contact.phone).padEnd(16)} ${stamp}${pending}`;
}

async function list(prisma) {
  const contacts = await prisma.contact.findMany({
    orderBy: [{ accountId: 'asc' }, { name: 'asc' }],
  });

  if (!contacts.length) {
    console.log('\nNo contacts.\n');
    return;
  }

  console.log('\nContacts\n');
  for (const contact of contacts) console.log(describe(contact));

  const unverified = contacts.filter((c) => !c.phoneVerifiedAt);
  console.log(`\n${contacts.length} contact(s), ${unverified.length} unverified.`);

  if (unverified.length) {
    console.log('\nAn unverified contact cannot be attached to a schedule. Either verify it');
    console.log('through the app, or stamp it here:  npm run verify-contacts -- --mark <id>\n');
  } else {
    console.log('');
  }
}

async function mark(prisma, id) {
  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact) {
    console.error(`No contact with id ${id}`);
    process.exit(1);
  }
  if (contact.phoneVerifiedAt) {
    console.log(`\n${contact.name} is already verified (${contact.phoneVerifiedVia}).\n`);
    return;
  }

  const updated = await prisma.contact.update({
    where: { id },
    data:  { phoneVerifiedAt: new Date(), phoneVerifiedVia: 'GRANDFATHERED' },
  });
  console.log(`\n  ~  marked verified   ${updated.name}  ${mask(updated.phone)}\n`);
}

async function markAll(prisma) {
  const result = await prisma.contact.updateMany({
    where: { phoneVerifiedAt: null },
    data:  { phoneVerifiedAt: new Date(), phoneVerifiedVia: 'GRANDFATHERED' },
  });
  console.log(`\n  ~  marked ${result.count} contact(s) verified\n`);
}

async function unmark(prisma, id) {
  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact) {
    console.error(`No contact with id ${id}`);
    process.exit(1);
  }

  // Reported before attempting, so the refusal below arrives with its reason
  // already on screen rather than as a bare constraint name.
  const blocking = await prisma.schedule.findMany({
    where:  { OR: [{ contactId: id }, { escalationContactId: id }] },
    select: { name: true, dose: true },
  });

  if (blocking.length) {
    console.error(`\nCannot un-verify ${contact.name} — still used by:`);
    for (const s of blocking) console.error(`  - ${s.name} (${s.dose})`);
    console.error('\nRepoint or delete those schedules first. Un-verifying now would leave them');
    console.error('in a state the API would refuse to create.\n');
    process.exit(1);
  }

  await prisma.contact.update({
    where: { id },
    data:  { phoneVerifiedAt: null, phoneVerifiedVia: null },
  });
  console.log(`\n  ~  withdrew verification   ${contact.name}  ${mask(contact.phone)}\n`);
  console.log('It must pass a code before any schedule can use it again.\n');
}

async function main() {
  const prisma = prismaClient();

  try {
    if (args.includes('--mark-all'))  return await markAll(prisma);
    if (flag('--mark'))               return await mark(prisma, flag('--mark'));
    if (flag('--unmark'))             return await unmark(prisma, flag('--unmark'));
    return await list(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
