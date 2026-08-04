'use strict';

// Message library reads and writes for the API.
//
// Same account-scoping rule as contacts.js: writes go through updateMany /
// deleteMany with accountId in the filter, so a foreign id matches nothing
// rather than touching another account's row.

const db = require('../db');

function client() {
  return db.getClient();
}

async function list(accountId) {
  return client().message.findMany({
    where:   { accountId },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });
}

async function getById(accountId, id) {
  const rows = await client().message.findMany({ where: { id, accountId }, take: 1 });
  return rows[0] || null;
}

// Making a message the default has to unset the previous one, and a partial
// unique index enforces that there is only ever one. Both statements run in a
// transaction so a failure cannot leave an account with none — a schedule
// pointing at no message falls back to the built-in prompt silently, which is
// exactly the kind of quiet wrong-behaviour this project keeps designing out.
async function create(accountId, data) {
  if (!data.isDefault) {
    return client().message.create({ data: { ...data, accountId } });
  }

  return client().$transaction(async (tx) => {
    await tx.message.updateMany({ where: { accountId, isDefault: true }, data: { isDefault: false } });
    return tx.message.create({ data: { ...data, accountId } });
  });
}

async function update(accountId, id, data) {
  if (!data.isDefault) {
    const result = await client().message.updateMany({ where: { id, accountId }, data });
    if (result.count === 0) return null;
    return getById(accountId, id);
  }

  return client().$transaction(async (tx) => {
    // Clear the old default first, excluding this row so it is not unset and
    // immediately re-set.
    await tx.message.updateMany({
      where: { accountId, isDefault: true, NOT: { id } },
      data:  { isDefault: false },
    });
    const result = await tx.message.updateMany({ where: { id, accountId }, data });
    if (result.count === 0) return null;
    const rows = await tx.message.findMany({ where: { id, accountId }, take: 1 });
    return rows[0] || null;
  });
}

async function remove(accountId, id) {
  const result = await client().message.deleteMany({ where: { id, accountId } });
  return result.count === 1;
}

// Deleting a message sets schedules.message_id to NULL rather than blocking, so
// this is reported instead of refused: those schedules keep calling, they just
// fall back to the built-in wording.
async function schedulesUsing(accountId, id) {
  return client().schedule.findMany({
    where:  { accountId, messageId: id },
    select: { id: true, name: true, dose: true },
  });
}

module.exports = { list, getById, create, update, remove, schedulesUsing };
