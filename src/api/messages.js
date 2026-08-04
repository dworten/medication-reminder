'use strict';

// /api/messages — the reusable library of reminder wording.

const express = require('express');
const repo    = require('../data/messages');
const { asyncHandler, notFound } = require('./errors');
const { messageInput } = require('./validate');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json({ messages: await repo.list(req.account.id) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const message = await repo.getById(req.account.id, req.params.id);
  if (!message) throw notFound('No such message');
  res.json({ message });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = messageInput(req.body);
  res.status(201).json({ message: await repo.create(req.account.id, data) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  // The existing row is passed in so a partial update can be checked as a
  // whole: sending only `kind: "AUDIO"` on a TTS message must fail for the
  // missing audioUrl, which is invisible if only the payload is inspected.
  const existing = await repo.getById(req.account.id, req.params.id);
  if (!existing) throw notFound('No such message');

  const data    = messageInput(req.body, { partial: true, existing });
  const message = await repo.update(req.account.id, req.params.id, data);
  if (!message) throw notFound('No such message');

  res.json({ message });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const accountId = req.account.id;

  const message = await repo.getById(accountId, req.params.id);
  if (!message) throw notFound('No such message');

  // Unlike contacts this is not blocked: schedules.message_id is SET NULL, so
  // those schedules keep calling and fall back to the built-in wording. The
  // response says which ones, because "the call still happens but sounds
  // different" is a surprise worth naming.
  const affected = await repo.schedulesUsing(accountId, req.params.id);
  await repo.remove(accountId, req.params.id);

  res.json({
    deleted: true,
    ...(affected.length && {
      schedulesReset: affected.map((s) => ({ id: s.id, name: s.name, dose: s.dose })),
      note: 'Those schedules will now use the built-in default wording.',
    }),
  });
}));

module.exports = router;
