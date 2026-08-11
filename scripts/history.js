'use strict';

// Prints recent call_history from the terminal, escalation chains indented under
// the attempt that caused them.
//
//   npm run db:history            the last 20 attempts
//   npm run db:history -- 50      the last 50
//   npm run db:history -- --queue only what is still queued for the sweeper
//
// This exists so verifying a call does not mean opening Prisma Studio and
// mentally joining three tables. It is read-only — Phase 3's API will serve the
// same shape over HTTP.

require('dotenv').config();

const { PrismaClient } = require('../src/generated/prisma');
const { PrismaPg }     = require('@prisma/adapter-pg');

const args      = process.argv.slice(2);
const QUEUE_ONLY = args.includes('--queue');
const LIMIT      = parseInt(args.find(a => /^\d+$/.test(a)) || '20', 10);

const TZ = (process.env.TIMEZONE || 'America/Chicago').trim();

// The outcomes that mean a dose was confirmed, versus the ones that mean nobody
// could tell. Anything unconfirmed is what you are actually scanning for.
//
// SENT moved out of GOOD. It means Twilio accepted an alert text, not that
// anyone received it — the carrier's verdict comes later, as DELIVERED or
// FAILED. Scanning this output for trouble and seeing "ok" against eleven texts
// the carrier had rejected is exactly how a week of silent failures stayed
// silent, so an unconfirmed delivery now reads as in-flight rather than fine.
const GOOD = new Set(['CONFIRMED', 'DELIVERED']);
const OPEN = new Set(['PENDING', 'SENT']);

function mark(outcome) {
  if (GOOD.has(outcome)) return 'ok  ';
  if (OPEN.has(outcome)) return '..  ';
  return 'XX  ';
}

function when(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-US', {
    timeZone: TZ, month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// Who it was about, and where it actually went. Showing only the contact hid
// redirected calls entirely: a /trigger?target=test attempt read as though it
// had rung the contact.
function destination(row) {
  const name  = row.contact ? row.contact.name : '(no contact)';
  const onFile = row.contact ? row.contact.phone : null;

  if (!row.toPhone)        return `${name} ${onFile || ''}`.trim();
  if (row.toPhone === onFile) return `${name} ${row.toPhone}`;
  return `${name} → ${row.toPhone} (redirected)`;
}

function describe(row, indent) {
  const who  = destination(row);
  const kind = row.kind.replace('ESCALATION_', 'ESC ').replace('REMINDER_CALL', 'CALL');

  const bits = [
    `${indent}${mark(row.outcome)}${when(row.startedAt).padEnd(16)}`,
    kind.padEnd(9),
    row.dose.padEnd(8),
    `try ${row.attempt}`,
    row.outcome.padEnd(14),
    who,
  ];

  const notes = [];
  if (row.repromptCount) notes.push(`${row.repromptCount} reprompts`);
  if (row.nextRetryAt)   notes.push(`QUEUED for ${when(row.nextRetryAt)}`);
  if (row.retryClaimedAt) notes.push('claimed');
  if (row.callSid)       notes.push(row.callSid);
  if (row.errorMessage)  notes.push(`"${row.errorMessage}"`);

  // Blanks, not the branch again: repeating "└─" on the detail line reads as a
  // second child rather than a continuation of this one.
  const hang = ' '.repeat(indent.length + 6);
  return bits.join('  ') + (notes.length ? `\n${hang}${notes.join('  |  ')}` : '');
}

async function main() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) {
    console.error('\nDATABASE_URL is not set — nothing to read.\n');
    process.exit(1);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  try {
    // Roots are attempts with no parent: reminder calls, plus any escalation
    // queued when the database was unreachable and no parent could be recorded.
    const roots = await prisma.callHistory.findMany({
      where: {
        parentId: null,
        ...(QUEUE_ONLY && { nextRetryAt: { not: null } }),
      },
      include: { contact: true, schedule: { select: { name: true } } },
      orderBy: { startedAt: 'desc' },
      take:    LIMIT,
    });

    if (!roots.length) {
      console.log(QUEUE_ONLY
        ? '\nNothing queued — the sweeper has no outstanding work.\n'
        : '\nNo call history yet. Place one with POST /trigger, or wait for a schedule.\n');
      return;
    }

    // One query for every child rather than one per root.
    const children = await prisma.callHistory.findMany({
      where:   { parentId: { in: roots.map(r => r.id) } },
      include: { contact: true },
      orderBy: { startedAt: 'asc' },
    });
    const grandchildren = await prisma.callHistory.findMany({
      where:   { parentId: { in: children.map(c => c.id) } },
      include: { contact: true },
      orderBy: { startedAt: 'asc' },
    });

    const byParent = new Map();
    for (const row of [...children, ...grandchildren]) {
      if (!byParent.has(row.parentId)) byParent.set(row.parentId, []);
      byParent.get(row.parentId).push(row);
    }

    console.log(`\n${QUEUE_ONLY ? 'Queued work' : `Last ${roots.length} attempts`}  (times in ${TZ})\n`);

    for (const root of roots.reverse()) {
      console.log(describe(root, ''));
      for (const child of byParent.get(root.id) || []) {
        console.log(describe(child, '     └─ '));
        for (const grandchild of byParent.get(child.id) || []) {
          console.log(describe(grandchild, '          └─ '));
        }
      }
    }

    const queued = await prisma.callHistory.count({ where: { nextRetryAt: { not: null } } });
    console.log(`\n${queued} item(s) queued for the sweeper.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\nCould not read call history:', err.message, '\n');
  process.exit(1);
});
