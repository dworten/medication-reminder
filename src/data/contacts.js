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

// NOTE: there is deliberately no create() here.
//
// A contact row is only ever born from a verification that checked out, so the
// insert lives in data/contactVerifications.js where it can share a transaction
// with the row that authorised it. A create() on this module would be a way to
// add a contact whose number nobody proved — which is the entire thing this
// feature exists to prevent, sitting one import away from any future caller.

// Sets the number a contact is proposing to move to. `phone` is untouched: it
// keeps its verified value and keeps ringing until a code comes back. This is
// what makes editing a number safe on a schedule that is live.
async function setPendingPhone(accountId, id, pendingPhone) {
  const result = await client().contact.updateMany({
    where: { id, accountId },
    data:  { pendingPhone },
  });
  if (result.count === 0) return null;
  return getById(accountId, id);
}

async function clearPendingPhone(accountId, id) {
  const result = await client().contact.updateMany({
    where: { id, accountId },
    data:  { pendingPhone: null },
  });
  if (result.count === 0) return null;
  return getById(accountId, id);
}

// Whether a contact exists, belongs to this account, and has a verified number.
// Used by the schedules API so a bad reference is a field error naming the
// contact, rather than the database trigger's blunter refusal.
async function isVerified(accountId, id) {
  if (!id) return true;
  const count = await client().contact.count({
    where: { id, accountId, phoneVerifiedAt: { not: null } },
  });
  return count === 1;
}

// Does any contact on this account already hold this number — live or pending?
//
// Checked before a code goes out rather than only at promote time: discovering
// the collision after someone has read six digits off a phone call is a worse
// experience than being told immediately, and it is also a send that never
// needed to be paid for.
async function phoneInUse(accountId, phone, { exceptContactId = null } = {}) {
  const rows = await client().contact.findMany({
    where: {
      accountId,
      OR: [{ phone }, { pendingPhone: phone }],
      ...(exceptContactId && { id: { not: exceptContactId } }),
    },
    take: 1,
    select: { id: true, name: true },
  });
  return rows[0] || null;
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

module.exports = {
  list, getById, update, remove, schedulesUsing,
  setPendingPhone, clearPendingPhone, isVerified, phoneInUse,
};
