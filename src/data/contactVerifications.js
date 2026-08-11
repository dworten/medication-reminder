'use strict';

// Verification reads and writes.
//
// Same rule as every other repo here: accountId is part of the statement, not
// something the caller is trusted to have checked. A verification id that
// belongs to someone else matches zero rows and the caller gets a 404 — it never
// becomes "here is a code you may guess at".
//
// The two writes that finish a verification (createContact, promotePendingPhone)
// run inside a transaction with the row that authorised them. Without that, a
// crash between "code accepted" and "contact created" would leave a consumed
// verification and no contact — the code spent, and the number no closer to
// being added.

const db = require('../db');

function client() {
  return db.getClient();
}

async function create(data) {
  return client().contactVerification.create({ data });
}

async function getById(accountId, id) {
  const rows = await client().contactVerification.findMany({
    where: { id, accountId },
    take:  1,
  });
  return rows[0] || null;
}

// The most recent send to a number, for the resend cooldown. Ordered by
// created_at rather than filtered by state on purpose: a burned or consumed
// code was still a message Twilio was asked to send, and the cooldown exists to
// stop the sending, not the succeeding.
async function lastSendTo(accountId, phone) {
  const rows = await client().contactVerification.findMany({
    where:   { accountId, phone },
    orderBy: { createdAt: 'desc' },
    take:    1,
    select:  { createdAt: true },
  });
  return rows[0] || null;
}

// Sends within a window — the whole of the rate limit. With `phone` it is the
// per-number ceiling; without it, the per-account one.
async function countSince(accountId, since, { phone } = {}) {
  return client().contactVerification.count({
    where: {
      accountId,
      createdAt: { gte: since },
      ...(phone && { phone }),
    },
  });
}

// Everything still live for this number stops working. Called before issuing a
// new code, so pressing "resend" replaces the outstanding code rather than
// adding a second valid one.
async function invalidateOutstanding(accountId, phone) {
  return client().contactVerification.updateMany({
    where: {
      accountId, phone,
      consumedAt:    null,
      invalidatedAt: null,
    },
    data: { invalidatedAt: new Date() },
  });
}

async function invalidate(id) {
  return client().contactVerification.updateMany({
    where: { id, consumedAt: null, invalidatedAt: null },
    data:  { invalidatedAt: new Date() },
  });
}

// A wrong guess. Returns the new attempt count so the caller can tell the user
// how many are left, and burn the row when they run out.
async function recordFailedAttempt(id) {
  const row = await client().contactVerification.update({
    where: { id },
    data:  { checkAttempts: { increment: 1 } },
    select: { checkAttempts: true },
  });
  return row.checkAttempts;
}

// ─── The two ways a verification finishes ────────────────────────────────────

// The create flow: no contact existed, and one comes into being here — already
// verified, because the code that authorised it just checked out.
//
// consumedAt is written in the same transaction. The updateMany is conditional
// on the row still being unconsumed, so two requests racing the same code
// produce one contact and one "already used" rather than two contacts.
async function createContact({ accountId, verificationId, phone, channel, draft }) {
  return client().$transaction(async (tx) => {
    const claimed = await tx.contactVerification.updateMany({
      where: { id: verificationId, accountId, consumedAt: null, invalidatedAt: null },
      data:  { consumedAt: new Date() },
    });
    if (claimed.count === 0) return null;

    return tx.contact.create({
      data: {
        ...draft,
        accountId,
        phone,
        phoneVerifiedAt:  new Date(),
        phoneVerifiedVia: channel,
        pendingPhone:     null,
      },
    });
  });
}

// The change flow: a pending number becomes the live one.
//
// Guarded on pendingPhone still equalling the number that was verified. Between
// the code going out and coming back, someone could have started a different
// change on the same contact — promoting the verified number then would set the
// phone to something nobody is currently expecting.
async function promotePendingPhone({ accountId, verificationId, contactId, phone, channel }) {
  return client().$transaction(async (tx) => {
    const claimed = await tx.contactVerification.updateMany({
      where: { id: verificationId, accountId, consumedAt: null, invalidatedAt: null },
      data:  { consumedAt: new Date() },
    });
    if (claimed.count === 0) return null;

    const promoted = await tx.contact.updateMany({
      where: { id: contactId, accountId, pendingPhone: phone },
      data:  {
        phone,
        pendingPhone:     null,
        phoneVerifiedAt:  new Date(),
        phoneVerifiedVia: channel,
      },
    });
    if (promoted.count === 0) return null;

    const rows = await tx.contact.findMany({ where: { id: contactId, accountId }, take: 1 });
    return rows[0] || null;
  });
}

module.exports = {
  create, getById, lastSendTo, countSince,
  invalidateOutstanding, invalidate, recordFailedAttempt,
  createContact, promotePendingPhone,
};
