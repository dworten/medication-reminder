'use strict';

// Sets or changes the login password for an account.
//
//   npm run set-password                  the only account, or SEED_ACCOUNT_EMAIL
//   npm run set-password -- you@mail.com  a specific account
//
// The password is typed, never passed as an argument — an argument lands in
// shell history and in the process list, where anyone on the machine can read
// it. There is deliberately no signup flow: the account row comes from the
// seed, and this is the only way it ever gets a password.

require('dotenv').config();

const readline = require('readline');
const bcrypt   = require('bcryptjs');

const { PrismaClient } = require('../src/generated/prisma');
const { PrismaPg }     = require('@prisma/adapter-pg');

// 12 rounds: comfortably above bcrypt's practical floor, and about a quarter of
// a second on modest hardware — irrelevant for a login that happens rarely,
// meaningful against someone working through a stolen hash.
const ROUNDS = 12;
const MIN_LENGTH = 12;

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  return new Promise((resolve) => {
    if (hidden) {
      // readline has no built-in masking. Intercepting the echo is the standard
      // workaround: the prompt is written once, then keystrokes are swallowed.
      let written = false;
      rl._writeToOutput = (chunk) => {
        if (!written) { rl.output.write(question); written = true; return; }
        if (chunk.includes('\n') || chunk.includes('\r')) rl.output.write('\n');
      };
    }
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function client() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) {
    console.error('\nDATABASE_URL is not set.\n');
    process.exit(1);
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

async function pickAccount(prisma, emailArg) {
  if (emailArg) {
    const account = await prisma.account.findUnique({ where: { email: emailArg.toLowerCase() } });
    if (!account) {
      console.error(`\nNo account with email "${emailArg}".\n`);
      process.exit(1);
    }
    return account;
  }

  const accounts = await prisma.account.findMany({ orderBy: { createdAt: 'asc' } });

  if (!accounts.length) {
    console.error('\nNo accounts exist yet. Run `npm run db:seed` first.\n');
    process.exit(1);
  }
  if (accounts.length > 1) {
    console.error('\nMore than one account exists. Say which:\n');
    for (const a of accounts) console.error(`  npm run set-password -- ${a.email}`);
    console.error('');
    process.exit(1);
  }
  return accounts[0];
}

async function main() {
  const emailArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const prisma   = client();

  try {
    const account = await pickAccount(prisma, emailArg);

    console.log(`\nSetting the login password for ${account.email}`);
    console.log(account.passwordHash ? '(this account already has one — it will be replaced)\n' : '(this account has no password yet)\n');

    const password = await ask('New password: ', { hidden: true });

    if (password.length < MIN_LENGTH) {
      console.error(`\nToo short — use at least ${MIN_LENGTH} characters.`);
      console.error('This is the only credential protecting an API that can change who gets called.\n');
      process.exit(1);
    }

    const again = await ask('Confirm password: ', { hidden: true });
    if (password !== again) {
      console.error('\nThose did not match. Nothing was changed.\n');
      process.exit(1);
    }

    await prisma.account.update({
      where: { id: account.id },
      data:  { passwordHash: await bcrypt.hash(password, ROUNDS) },
    });

    console.log(`\nPassword set for ${account.email}.`);
    console.log('Existing sessions are unaffected — sign out everywhere by clearing the `session` table.\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\nCould not set the password:', err.message, '\n');
  process.exit(1);
});
