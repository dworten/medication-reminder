'use strict';

// /api/contacts — the people who can be called.

const express = require('express');
const repo    = require('../data/contacts');
const { asyncHandler, notFound, conflict, badRequest, ApiError } = require('./errors');
const { contactInput } = require('./validate');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json({ contacts: await repo.list(req.account.id) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const contact = await repo.getById(req.account.id, req.params.id);
  if (!contact) throw notFound('No such contact');
  res.json({ contact });
}));

// Creating a contact directly is gone.
//
// A contact is born from a verification that checked out — POST
// /api/contacts/verifications, then POST /api/contacts/verifications/:id/check,
// which returns the created contact. Leaving this route in place as an
// unverified back door would make the whole feature advisory.
//
// A 405 with the route to use, rather than a 404: the endpoint existed until
// now, and anything still calling it deserves to be told what replaced it rather
// than left to guess that the API moved.
router.post('/', (_req, _res, next) => {
  next(new ApiError(405, 'Contacts are created by verifying a phone number first', {
    start: 'POST /api/contacts/verifications  { phone, channel: "SMS" | "CALL", name, role?, notes? }',
    then:  'POST /api/contacts/verifications/:id/check  { code }  → returns the created contact',
    why:   'a contact\'s number is never taken on trust, so a typo cannot be called',
  }));
});

router.patch('/:id', asyncHandler(async (req, res) => {
  // The phone number is not editable here, and this is the check that keeps
  // contacts.phone meaning "verified". Letting a PATCH through would put an
  // unproven number one request away from being dialled — which is the exact
  // failure this feature exists to prevent, and it would arrive silently.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'phone')) {
    throw badRequest('Validation failed', {
      phone: 'cannot be changed here — start a verification at POST /api/contacts/:id/verifications, and the new number goes live when the code checks out',
    });
  }

  const data = contactInput(req.body, { partial: true });
  const contact = await repo.update(req.account.id, req.params.id, data);
  // null means zero rows matched — either no such contact, or it belongs to
  // another account. Both are "not found" as far as this caller is concerned;
  // distinguishing them would confirm the row exists.
  if (!contact) throw notFound('No such contact');
  res.json({ contact });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const accountId = req.account.id;

  const contact = await repo.getById(accountId, req.params.id);
  if (!contact) throw notFound('No such contact');

  // The foreign keys are RESTRICT, so the database would refuse this anyway —
  // but a foreign key error cannot say WHICH schedules are in the way, and that
  // is the only part the caller can act on.
  const blocking = await repo.schedulesUsing(accountId, req.params.id);
  if (blocking.length) {
    throw conflict('This contact is still used by a schedule', {
      schedules: blocking.map((s) => ({ id: s.id, name: s.name, dose: s.dose })),
      hint: 'Point those schedules at a different contact, or delete them first.',
    });
  }

  await repo.remove(accountId, req.params.id);
  res.status(204).end();
}));

module.exports = router;
