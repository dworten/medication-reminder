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

module.exports = { listEnabled, getById, claimForFire, WITH_RELATIONS };
