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

module.exports = { getDefault, getById };
