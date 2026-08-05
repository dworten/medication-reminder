'use strict';

// Account lookups.
//
// The app is single-user today but every table carries account_id, so nothing
// here assumes "the one account" beyond getDefault(), which exists purely so
// call paths with no schedule attached (a manual /trigger, say) still have an
// account to file their history under. Phase 3's API will pass a real account
// id from the session instead and can leave getDefault() unused.

const db     = require('../db');
const config = require('../config');

async function getDefault() {
  return db.getClient().account.findFirst({ orderBy: { createdAt: 'asc' } });
}

async function getById(id) {
  return db.getClient().account.findUnique({ where: { id } });
}

async function getByEmail(email) {
  return db.getClient().account.findUnique({ where: { email } });
}

async function create({ email, name, passwordHash }) {
  return db.getClient().account.create({ data: { email, name, passwordHash } });
}

// Whether this account administers the deployment.
//
// It matters because several settings are per-deployment rather than
// per-account: TEST_PHONE_NUMBER, GRANDMA_PHONE_NUMBER, CAREGIVER_PHONE_NUMBER,
// and the Twilio credentials that pay for every call. Those belong to whoever
// runs this, so anything that would dial one of them checks here first —
// without it, open signup would let a stranger ring the admin's test phone.
//
// ADMIN_EMAIL names the account explicitly. The fallback — oldest account —
// is what this meant before, and it is kept only so an installation that never
// sets ADMIN_EMAIL still works. It is the weaker rule: "oldest" is implicit,
// and would move to whoever registered next if the original account were
// deleted. Setting ADMIN_EMAIL is the durable answer.
async function isAdmin(accountId) {
  if (!accountId) return false;

  if (config.adminEmail) {
    const account = await getById(accountId);
    return Boolean(account && account.email.toLowerCase() === config.adminEmail);
  }

  const first = await getDefault();
  return Boolean(first && first.id === accountId);
}

module.exports = { getDefault, getById, getByEmail, create, isAdmin };
