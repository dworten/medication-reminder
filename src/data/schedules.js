'use strict';

// Schedule reads and the fire-claim write.
//
// Every query pulls the relations the call path needs (contact, escalation
// contact, message) in one round trip, so placing a call never fans out into
// several queries while Twilio waits.

const db = require('../db');

const WITH_RELATIONS = {
  contact:           true,
  escalationContact: true,
  message:           true,
};

async function listEnabled() {
  return db.getClient().schedule.findMany({
    where:   { enabled: true },
    include: WITH_RELATIONS,
    orderBy: { timeOfDay: 'asc' },
  });
}

async function getById(id) {
  return db.getClient().schedule.findUnique({
    where:   { id },
    include: WITH_RELATIONS,
  });
}

// Atomically stake a claim on firing this schedule.
//
// This is the single guard against double-calling. It is one conditional UPDATE:
// Postgres serialises concurrent attempts, so exactly one caller sees count = 1
// and every other sees 0. Replicas stay at 1, but a stray second process — an
// overlapping deploy, a tick that runs long — cannot place a duplicate call.
//
// The window works because occurrences of a given schedule are at least a day
// apart while a duplicate attempt would land seconds later: any lastFiredAt
// inside the window means "this occurrence already fired". It must be wider
// than the grace period, or a catch-up tick would re-fire a call that already
// went out.
//
// Claimed BEFORE the call is placed, deliberately. Claiming afterwards would
// mean a crash between dialling and writing leaves the schedule unclaimed, and
// the next tick calls her a second time. The reverse failure — claimed but the
// call throws — is visible in call_history and safe.
async function claimForFire(scheduleId, now, windowMs) {
  const notAlreadyFired = new Date(now.getTime() - windowMs);

  const result = await db.getClient().schedule.updateMany({
    where: {
      id:      scheduleId,
      enabled: true,
      OR: [
        { lastFiredAt: null },
        { lastFiredAt: { lt: notAlreadyFired } },
      ],
    },
    data: { lastFiredAt: now },
  });

  return result.count === 1;
}

// ─── Account-scoped access for the API (Phase 3) ─────────────────────────────
//
// Separate names rather than an extra argument on the functions above: those
// are called from the live call path — callManager, twimlHandler, the scheduler
// — and changing their signatures to serve the API would put the reminder flow
// at risk for the sake of tidiness.
//
// Writes filter on accountId inside updateMany/deleteMany so a foreign id
// matches zero rows instead of modifying someone else's schedule.

async function listForAccount(accountId) {
  return db.getClient().schedule.findMany({
    where:   { accountId },
    include: WITH_RELATIONS,
    orderBy: [{ timeOfDay: 'asc' }, { name: 'asc' }],
  });
}

async function getForAccount(accountId, id) {
  const rows = await db.getClient().schedule.findMany({
    where:   { id, accountId },
    include: WITH_RELATIONS,
    take:    1,
  });
  return rows[0] || null;
}

async function createForAccount(accountId, data) {
  const created = await db.getClient().schedule.create({ data: { ...data, accountId } });
  return getForAccount(accountId, created.id);
}

async function updateForAccount(accountId, id, data) {
  const result = await db.getClient().schedule.updateMany({ where: { id, accountId }, data });
  if (result.count === 0) return null;
  return getForAccount(accountId, id);
}

async function removeForAccount(accountId, id) {
  const result = await db.getClient().schedule.deleteMany({ where: { id, accountId } });
  return result.count === 1;
}

// enabled is its own endpoint because it is the one field someone reaches for
// in a hurry — pausing the calls while she is in hospital, say — and it should
// not require sending back a whole schedule to do it.
//
// last_fired_at is deliberately untouched: it is the double-call guard, and
// clearing it could re-fire a call that already went out today.
async function setEnabled(accountId, id, enabled) {
  const result = await db.getClient().schedule.updateMany({
    where: { id, accountId },
    data:  { enabled },
  });
  if (result.count === 0) return null;
  return getForAccount(accountId, id);
}

// Confirms a contact or message belongs to this account before it is attached
// to a schedule. Without it, a caller could point their schedule at another
// account's contact — the foreign key only checks that the row exists, not
// whose it is.
async function belongsToAccount(model, accountId, id) {
  if (!id) return true;
  const count = await db.getClient()[model].count({ where: { id, accountId } });
  return count === 1;
}

module.exports = {
  listEnabled, getById, claimForFire, WITH_RELATIONS,
  listForAccount, getForAccount, createForAccount, updateForAccount, removeForAccount,
  setEnabled, belongsToAccount,
};
