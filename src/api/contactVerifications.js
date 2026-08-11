'use strict';

// /api/contacts/verifications — proving a number before it can be called.
//
// Three routes and one idea: a contact's phone number is never taken on
// somebody's word. Either a code was sent to it and came back, or the number
// does not become a destination.
//
//   POST /verifications             start one for a number with no contact yet
//   POST /:id/verifications         start one for an existing contact's new number
//   POST /verifications/:id/check   enter the code — this is where a contact is
//                                   created, or a pending number goes live
//   DELETE /:id/pending             abandon a number change
//
// The check route is what completes the work, rather than handing back a "proof"
// the caller then spends on a separate create. That is deliberate: a proof token
// would need its own lifetime, its own single-use latch, and its own answer to
// "what if it is never spent", and all three are avoidable by simply doing the
// thing at the moment the code checks out.
//
// A separate router from contacts.js rather than four more routes bolted onto
// it. contacts.js is CRUD; this is a small state machine with rate limits, and
// interleaving them would leave one file where neither is easy to follow.

const express = require('express');

const logger            = require('../logger');
const config            = require('../config');
const contactRepo       = require('../data/contacts');
const repo              = require('../data/contactVerifications');
const phoneVerification = require('../phoneVerification');
const { asyncHandler, notFound, conflict, badRequest, ApiError } = require('./errors');
const {
  verificationStartInput, verificationChangeInput, verificationCheckInput, contactDraftInput,
} = require('./validate');

const router = express.Router();

// What the caller is allowed to know about a verification. Not the hash, not the
// code, not the draft — only enough to render a countdown and a form.
function publicVerification(row) {
  return {
    id:        row.id,
    phone:     row.phone,
    channel:   row.channel,
    contactId: row.contactId,
    expiresAt: row.expiresAt,
  };
}

// Turns phoneVerification's limit verdict into the codebase's error shape.
// Retry-After is set because a 429 without one is a client guessing.
function enforceSendLimit(res, verdict) {
  if (!verdict) return;
  res.set('Retry-After', String(verdict.retryAfterSeconds));
  throw new ApiError(429, verdict.message);
}

// Delivery failed at Twilio's end — a number that cannot receive texts, a
// landline asked for an SMS, an unreachable line. That is the caller's input
// being wrong, not this server breaking, and saying so is what lets someone
// switch to the other channel instead of retrying the same thing.
function deliveryFailed(err, channel) {
  logger.warn('Verification delivery failed', { channel, error: err.message });
  return badRequest(
    channel === 'CALL'
      ? 'Could not place a call to that number. Check it, or try a text instead.'
      : 'Could not text that number. Check it, or try a call instead — some landlines cannot receive texts.',
    { phone: 'could not be reached' }
  );
}

// ─── Starting a verification ─────────────────────────────────────────────────

// A number with no contact behind it yet. The name, role and notes ride along
// and wait on the verification row; the contact itself does not exist until the
// code checks out, so an abandoned verification leaves nothing behind.
router.post('/verifications', asyncHandler(async (req, res) => {
  const accountId = req.account.id;
  const { phone, channel, draft } = verificationStartInput(req.body);

  // Checked before the send, not at promote time. Finding out about a collision
  // after someone has read six digits off a phone call is a worse experience,
  // and it is a message that never needed to be paid for.
  const clash = await contactRepo.phoneInUse(accountId, phone);
  if (clash) {
    throw conflict('A contact with that phone number already exists', {
      field: 'phone', contact: { id: clash.id, name: clash.name },
    });
  }

  enforceSendLimit(res, await phoneVerification.checkSendAllowed(accountId, phone));

  let verification;
  try {
    verification = await phoneVerification.sendCode({ accountId, phone, channel, draft });
  } catch (err) {
    throw deliveryFailed(err, channel);
  }

  logger.info('Contact verification started', { accountId, verificationId: verification.id, channel });
  res.status(201).json({ verification: publicVerification(verification) });
}));

// An existing contact moving to a new number.
//
// The new number is parked in pending_phone. `phone` is not touched — it keeps
// its verified value and keeps ringing throughout, which is the whole reason a
// number can be changed on a schedule that is live without anything stopping or
// being misdirected.
router.post('/:id/verifications', asyncHandler(async (req, res) => {
  const accountId = req.account.id;
  const { phone, channel } = verificationChangeInput(req.body);

  const contact = await contactRepo.getById(accountId, req.params.id);
  if (!contact) throw notFound('No such contact');

  if (contact.phone === phone) {
    throw badRequest('Validation failed', {
      phone: 'is already this contact\'s verified number',
    });
  }

  const clash = await contactRepo.phoneInUse(accountId, phone, { exceptContactId: contact.id });
  if (clash) {
    throw conflict('Another contact already uses that phone number', {
      field: 'phone', contact: { id: clash.id, name: clash.name },
    });
  }

  enforceSendLimit(res, await phoneVerification.checkSendAllowed(accountId, phone));

  await contactRepo.setPendingPhone(accountId, contact.id, phone);

  let verification;
  try {
    verification = await phoneVerification.sendCode({
      accountId, contactId: contact.id, phone, channel,
    });
  } catch (err) {
    // Roll the proposal back. Leaving it would show a pending number in the
    // interface that no code was ever delivered for, and the only way out would
    // be cancelling something that never really started.
    await contactRepo.clearPendingPhone(accountId, contact.id).catch(() => {});
    throw deliveryFailed(err, channel);
  }

  logger.info('Contact number change started', {
    accountId, contactId: contact.id, verificationId: verification.id, channel,
  });
  res.status(201).json({ verification: publicVerification(verification) });
}));

// ─── Entering the code ───────────────────────────────────────────────────────

router.post('/verifications/:id/check', asyncHandler(async (req, res) => {
  const accountId = req.account.id;
  const { code }  = verificationCheckInput(req.body);

  const verification = await repo.getById(accountId, req.params.id);

  // Compared even when there is no row, against a hash of something nobody
  // knows. Returning immediately here would make a real verification id take
  // ~250ms and a wrong one take a microsecond, which is a way to enumerate them.
  const matches = await phoneVerification.compareCode(code, verification && verification.codeHash);

  if (!verification) throw notFound('No such verification');

  if (verification.consumedAt) {
    throw badRequest('That code has already been used. Request a new one if you need to.');
  }
  if (verification.invalidatedAt) {
    throw badRequest('That code is no longer valid. Request a new one.');
  }
  if (verification.expiresAt <= new Date()) {
    await repo.invalidate(verification.id);
    throw badRequest(`That code has expired — they last ${config.verificationCodeTtlMinutes} minutes. Request a new one.`);
  }

  if (!matches) {
    const attempts   = await repo.recordFailedAttempt(verification.id);
    const remaining  = config.verificationMaxChecks - attempts;

    // Burned rather than merely counted. Without a ceiling, six digits is a
    // million guesses against an endpoint that will answer all of them.
    if (remaining <= 0) {
      await repo.invalidate(verification.id);
      logger.warn('Verification burned after too many wrong codes', {
        accountId, verificationId: verification.id, attempts,
      });
      throw badRequest('Too many incorrect attempts. That code is now invalid — request a new one.');
    }

    throw badRequest(
      `That code is not right. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`,
      { code: 'is not correct' }
    );
  }

  // ── Correct. Finish the job the verification was started for. ──

  if (verification.contactId) {
    const contact = await repo.promotePendingPhone({
      accountId,
      verificationId: verification.id,
      contactId:      verification.contactId,
      phone:          verification.phone,
      channel:        verification.channel,
    });

    // Either the row was consumed by a request that raced this one, or the
    // contact's pending number changed underneath — someone started a different
    // change while this code was in flight. Promoting anyway would set the phone
    // to a number nobody is currently expecting.
    if (!contact) {
      throw conflict('This number change is no longer current. Start it again.');
    }

    logger.info('Contact number verified and promoted', {
      accountId, contactId: contact.id, via: verification.channel,
    });
    return res.json({ contact });
  }

  // Re-validated on the way out, not trusted because it was validated on the way
  // in. This JSON sat in a database column in between, where a hand edit could
  // have put anything in it.
  const draft = contactDraftInput(verification.draft || {});

  const contact = await repo.createContact({
    accountId,
    verificationId: verification.id,
    phone:          verification.phone,
    channel:        verification.channel,
    draft,
  });

  if (!contact) throw conflict('That code has already been used.');

  logger.info('Contact created after verification', {
    accountId, contactId: contact.id, via: verification.channel,
  });
  res.status(201).json({ contact });
}));

// ─── Abandoning a number change ──────────────────────────────────────────────
//
// Clears the proposal and kills any code still outstanding for it. The contact's
// live number was never touched, so there is nothing to restore.
router.delete('/:id/pending', asyncHandler(async (req, res) => {
  const accountId = req.account.id;

  const contact = await contactRepo.getById(accountId, req.params.id);
  if (!contact) throw notFound('No such contact');

  if (contact.pendingPhone) {
    await repo.invalidateOutstanding(accountId, contact.pendingPhone);
  }

  const updated = await contactRepo.clearPendingPhone(accountId, contact.id);
  logger.info('Pending number change cancelled', { accountId, contactId: contact.id });
  res.json({ contact: updated });
}));

module.exports = router;
module.exports.publicVerification = publicVerification;
