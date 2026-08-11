'use strict';

// Seeds the database with exactly what the environment variables used to
// configure — the same recipient, the same wording, the same times, the same
// retry and escalation behaviour. Running it turns a fresh Railway Postgres into
// a working install without opening Prisma Studio once.
//
//   npm run db:seed             create anything missing, touch nothing existing
//   npm run db:seed -- --force  also overwrite the settings on rows that exist
//
// It is safe to run repeatedly. The default is deliberately additive: once you
// have edited a schedule in Prisma Studio, a redeploy that happens to re-run the
// seed must not quietly put your changes back. --force is the way to say you
// meant it.
//
// Phone numbers and the account email come from the environment, not from this
// file, so nothing personal lives in the repo.

require('dotenv').config();

const { PrismaClient } = require('../src/generated/prisma');
const { PrismaPg }     = require('@prisma/adapter-pg');

const FORCE = process.argv.includes('--force');

const env = (name, fallback = '') => (process.env[name] || fallback).trim();

const ACCOUNT_EMAIL  = env('SEED_ACCOUNT_EMAIL', 'vworten@gmail.com');
const ACCOUNT_NAME   = env('SEED_ACCOUNT_NAME', 'Medication Reminder');
const TIMEZONE       = env('TIMEZONE', 'America/Chicago');

const RECIPIENT_NAME = env('SEED_RECIPIENT_NAME', 'Grandma');
const RECIPIENT_PHONE = env('GRANDMA_PHONE_NUMBER');
const CAREGIVER_NAME = env('SEED_CAREGIVER_NAME', 'Caregiver');
const CAREGIVER_PHONE = env('CAREGIVER_PHONE_NUMBER');

const MAX_ATTEMPTS   = parseInt(env('MAX_CALL_ATTEMPTS', '3'), 10);
const RETRY_MINUTES  = parseInt(env('RETRY_DELAY_MINUTES', '5'), 10);
const MAX_REPROMPTS  = parseInt(env('MAX_REPROMPTS', '3'), 10);
const ACK_MINUTES    = parseInt(env('ESCALATION_ACK_MINUTES', '3'), 10);

// Character-for-character the sentence twimlHandler speaks when a schedule has
// no message attached. Seeding the same text means turning this row on changes
// nothing audible — it just moves the wording from code into data, where a UI
// can edit it later.
const DEFAULT_TTS = 'Hi, this is your medicine reminder.';

// The schedule as it has actually run, not as the cron strings read.
//
// Sunday mornings are EXCLUDED on purpose: the 9:20 AM call was interrupting her
// Sunday School class. That skip used to be a hardcoded special case in
// scheduler.js; since Stage 2 it lives here, in days_of_week, which is the only
// place it can now be changed. Do not "fix" this by making mornings daily.
//
// Evening runs every day including Sunday.
const SCHEDULES = [
  {
    dose:       'morning',
    name:       'Morning meds',
    timeOfDay:  '09:20',
    daysOfWeek: [1, 2, 3, 4, 5, 6], // Mon–Sat
    note:       'Sunday excluded — Sunday School',
  },
  {
    dose:       'evening',
    name:       'Evening meds',
    timeOfDay:  '21:20',
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6], // every day
    note:       'every day',
  },
];

const log = {
  created: (what, detail) => console.log(`  +  created  ${what.padEnd(22)} ${detail}`),
  updated: (what, detail) => console.log(`  ~  updated  ${what.padEnd(22)} ${detail}`),
  kept:    (what, detail) => console.log(`  =  kept     ${what.padEnd(22)} ${detail}`),
  warn:    (msg)          => console.log(`  !  ${msg}`),
};

function prismaClient() {
  const url = env('DATABASE_URL');
  if (!url) {
    console.error('\nDATABASE_URL is not set — nothing to seed.\n');
    console.error('Locally, put the Postgres service\'s DATABASE_PUBLIC_URL in .env.');
    console.error('On Railway it is injected as a reference variable.\n');
    process.exit(1);
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

function checkRequiredEnv() {
  const missing = [];
  if (!RECIPIENT_PHONE) missing.push('GRANDMA_PHONE_NUMBER');
  if (!CAREGIVER_PHONE) missing.push('CAREGIVER_PHONE_NUMBER');

  if (missing.length) {
    console.error(`\nRefusing to seed — these are not set: ${missing.join(', ')}`);
    console.error('The seed builds contacts from them; a schedule with no number would');
    console.error('look configured and never reach anyone.\n');
    process.exit(1);
  }

  // Catching this here rather than at 9:20 PM, when a call silently fails to
  // dial. Twilio requires E.164 and rejects anything else outright.
  for (const [name, value] of [['GRANDMA_PHONE_NUMBER', RECIPIENT_PHONE], ['CAREGIVER_PHONE_NUMBER', CAREGIVER_PHONE]]) {
    if (!/^\+[1-9]\d{7,14}$/.test(value)) {
      console.error(`\n${name}="${value}" is not E.164 format.`);
      console.error('It must start with + and a country code, e.g. +15125550123.\n');
      process.exit(1);
    }
  }
}

async function seedAccount(prisma) {
  const existing = await prisma.account.findUnique({ where: { email: ACCOUNT_EMAIL } });
  if (existing) {
    log.kept('account', existing.email);
    return existing;
  }
  const account = await prisma.account.create({
    data: { email: ACCOUNT_EMAIL, name: ACCOUNT_NAME, timezone: TIMEZONE },
  });
  log.created('account', account.email);
  return account;
}

// (account_id, phone) is unique, so the phone number is the identity here. A
// changed number is a new contact rather than an edit — which is correct: the
// call history of the old number should not silently follow the new one.
async function seedContact(prisma, accountId, { name, phone, role, notes }) {
  const existing = await prisma.contact.findUnique({
    where: { accountId_phone: { accountId, phone } },
  });

  if (existing) {
    if (FORCE && (existing.name !== name || existing.role !== role)) {
      const updated = await prisma.contact.update({
        where: { id: existing.id }, data: { name, role, notes },
      });
      log.updated('contact', `${updated.name} ${updated.phone}`);
      return updated;
    }
    log.kept('contact', `${existing.name} ${existing.phone}`);
    return existing;
  }

  // Stamped GRANDFATHERED, like the contacts the verification migration found
  // already in place.
  //
  // The seed's numbers come from GRANDMA_PHONE_NUMBER and
  // CAREGIVER_PHONE_NUMBER — set by hand, by the person who owns them, in an
  // environment file. That is not a code, and it is not recorded as one. But
  // without a stamp these rows would be unverified, and the schedules created
  // three lines later reference them: the trigger would refuse every one, and
  // `npm run db:seed` would fail on a fresh database with no way forward except
  // verifying two numbers before the app can start at all.
  const contact = await prisma.contact.create({
    data: {
      accountId, name, phone, role, notes,
      phoneVerifiedAt:  new Date(),
      phoneVerifiedVia: 'GRANDFATHERED',
    },
  });
  log.created('contact', `${contact.name} ${contact.phone}`);
  return contact;
}

async function seedMessage(prisma, accountId) {
  const existing = await prisma.message.findFirst({
    where: { accountId, isDefault: true },
  });

  if (existing) {
    log.kept('default message', `"${(existing.ttsText || existing.audioUrl || '').slice(0, 40)}"`);
    return existing;
  }

  const message = await prisma.message.create({
    data: {
      accountId,
      name:      'Default reminder',
      kind:      'TTS',
      ttsText:   DEFAULT_TTS,
      isDefault: true,
    },
  });
  log.created('default message', `"${message.ttsText}"`);
  return message;
}

// Identity is (account, dose): this app has one morning schedule and one evening
// schedule, and `dose` is the value that travels through the whole call path.
async function seedSchedule(prisma, account, spec, { contact, caregiver, message }) {
  const existing = await prisma.schedule.findFirst({
    where: { accountId: account.id, dose: spec.dose },
  });

  const settings = {
    name:       spec.name,
    timeOfDay:  spec.timeOfDay,
    daysOfWeek: spec.daysOfWeek,
    timezone:   TIMEZONE,
    contactId:  contact.id,
    messageId:  message.id,
    maxAttempts:          MAX_ATTEMPTS,
    retryDelayMinutes:    RETRY_MINUTES,
    maxReprompts:         MAX_REPROMPTS,
    escalationContactId:  caregiver.id,
    // Today's behaviour exactly: text the caregiver, don't call him. Flip
    // escalate_with_call to true in Prisma Studio to turn on the full Stage 4
    // chain — call the caregiver first, text him only if he doesn't acknowledge.
    escalateWithCall:     false,
    escalateWithSms:      true,
    escalationAckMinutes: ACK_MINUTES,
  };

  const describe = `${spec.timeOfDay} ${TIMEZONE} — ${spec.note}`;

  if (existing) {
    if (!FORCE) {
      log.kept(`${spec.dose} schedule`, describe);
      return existing;
    }
    // enabled and lastFiredAt are left alone even under --force: one is a
    // deliberate on/off switch, the other is the double-call guard, and
    // resetting it could re-fire a call that already went out.
    const updated = await prisma.schedule.update({ where: { id: existing.id }, data: settings });
    log.updated(`${spec.dose} schedule`, describe);
    return updated;
  }

  const schedule = await prisma.schedule.create({
    data: { accountId: account.id, dose: spec.dose, enabled: true, ...settings },
  });
  log.created(`${spec.dose} schedule`, describe);
  return schedule;
}

async function main() {
  checkRequiredEnv();
  const prisma = prismaClient();

  console.log(`\nSeeding ${ACCOUNT_EMAIL}${FORCE ? '  (--force: existing rows will be overwritten)' : ''}\n`);

  try {
    const account = await seedAccount(prisma);

    const contact = await seedContact(prisma, account.id, {
      name:  RECIPIENT_NAME,
      phone: RECIPIENT_PHONE,
      role:  'RECIPIENT',
      notes: 'Primary recipient of the medication reminder calls.',
    });

    const caregiver = await seedContact(prisma, account.id, {
      name:  CAREGIVER_NAME,
      phone: CAREGIVER_PHONE,
      role:  'CAREGIVER',
      notes: 'Alerted when a dose cannot be confirmed.',
    });

    const message = await seedMessage(prisma, account.id);

    const schedules = [];
    for (const spec of SCHEDULES) {
      schedules.push(await seedSchedule(prisma, account, spec, { contact, caregiver, message }));
    }

    const disabled = schedules.filter(s => !s.enabled);
    if (disabled.length) {
      log.warn(`${disabled.length} schedule(s) are DISABLED and will not fire — enable them in Prisma Studio.`);
    }

    console.log('\nDone. Verify with:');
    console.log('  npm run db:studio                        inspect and edit the rows');
    console.log('  curl -X POST "$BASE_URL/trigger?dose=morning&target=test" \\');
    console.log('       -H "X-Trigger-Secret: $TRIGGER_SECRET"   place a test call from the database');
    console.log('  npm run db:history                       see the attempt that call recorded\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\nSeed failed:', err.message, '\n');
  process.exit(1);
});
