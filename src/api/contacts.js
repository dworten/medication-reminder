'use strict';

// /api/contacts — the people who can be called.

const express = require('express');
const repo    = require('../data/contacts');
const { asyncHandler, notFound, conflict } = require('./errors');
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

router.post('/', asyncHandler(async (req, res) => {
  const data = contactInput(req.body);
  res.status(201).json({ contact: await repo.create(req.account.id, data) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
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
