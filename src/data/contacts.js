'use strict';

// Contact reads and writes for the API.
//
// Every query is filtered by accountId, including the writes — and the writes
// use updateMany/deleteMany rather than update/delete precisely so that the
// filter is part of the statement. `update({ where: { id } })` would happily
// modify another account's row if an id ever leaked; `updateMany({ where: { id,
// accountId } })` matches nothing instead, and the caller gets a 404.
//
// There is one account today. This is what makes adding a second one a change
// of who logs in rather than an audit of every query.

const db = require('../db');

function client() {
  return db.getClient();
}

async function list(accountId) {
  return client().contact.findMany({
    where:   { accountId },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
}

async function getById(accountId, id) {
  const rows = await client().contact.findMany({ where: { id, accountId }, take: 1 });
  return rows[0] || null;
}

async function create(accountId, data) {
  return client().contact.create({ data: { ...data, accountId } });
}

async function update(accountId, id, data) {
  const result = await client().contact.updateMany({ where: { id, accountId }, data });
  if (result.count === 0) return null;
  return getById(accountId, id);
}

async function remove(accountId, id) {
  const result = await client().contact.deleteMany({ where: { id, accountId } });
  return result.count === 1;
}

// Whether a contact can be deleted at all. The schedules → contacts foreign
// keys are RESTRICT, so the database would refuse anyway — this exists to say
// WHICH schedules are in the way, which a foreign key error cannot.
async function schedulesUsing(accountId, id) {
  return client().schedule.findMany({
    where: {
      accountId,
      OR: [{ contactId: id }, { escalationContactId: id }],
    },
    select: { id: true, name: true, dose: true },
  });
}

module.exports = { list, getById, create, update, remove, schedulesUsing };
