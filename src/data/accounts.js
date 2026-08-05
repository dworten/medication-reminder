'use strict';

// Account lookups.
//
// The app is single-user today but every table carries account_id, so nothing
// here assumes "the one account" beyond getDefault(), which exists purely so
// call paths with no schedule attached (a manual /trigger, say) still have an
// account to file their history under. Phase 3's API will pass a real account
// id from the session instead and can leave getDefault() unused.

const db = require('../db');

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

// Whether this account is the one the deployment was set up for — the oldest,
// same as getDefault().
//
// It matters because several settings are per-deployment rather than per-account:
// TEST_PHONE_NUMBER, GRANDMA_PHONE_NUMBER, CAREGIVER_PHONE_NUMBER, and the
// Twilio credentials that pay for every call. Those fallbacks belong to the
// owner alone, so anything that would dial one of them has to check this first.
// Without it, open signup would let a stranger ring the owner's test phone.
async function isPrimary(accountId) {
  const first = await getDefault();
  return Boolean(first && first.id === accountId);
}

module.exports = { getDefault, getById, getByEmail, create, isPrimary };
