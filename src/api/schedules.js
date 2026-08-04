'use strict';

// /api/schedules — when she gets called, who calls her, and what happens when
// she doesn't answer.
//
// This is the resource that actually places phone calls, so it validates the
// hardest: a bad row here is not a broken page, it is a missed dose or a call
// at the wrong hour.

const express = require('express');
const repo    = require('../data/schedules');
const logger  = require('../logger');
const { asyncHandler, notFound, badRequest } = require('./errors');
const { scheduleInput } = require('./validate');

const router = express.Router();

// A schedule's contact and message must belong to the same account. The foreign
// key only proves the row exists — it says nothing about whose it is, so
// without this a caller could aim their schedule at another account's contact
// and have this app phone a stranger.
async function assertOwnedReferences(accountId, data) {
  const errors = {};

  if (data.contactId !== undefined && data.contactId !== null) {
    if (!(await repo.belongsToAccount('contact', accountId, data.contactId))) {
      errors.contactId = 'no such contact';
    }
  }
  if (data.escalationContactId) {
    if (!(await repo.belongsToAccount('contact', accountId, data.escalationContactId))) {
      errors.escalationContactId = 'no such contact';
    }
  }
  if (data.messageId) {
    if (!(await repo.belongsToAccount('message', accountId, data.messageId))) {
      errors.messageId = 'no such message';
    }
  }

  if (Object.keys(errors).length) throw badRequest('Validation failed', errors);
}

// Escalating with neither a call nor an SMS means nobody is told about a missed
// dose. The database allows it; this does not, because a schedule in that state
// looks configured and silently alerts no one.
function assertSomeoneIsAlerted(data, existing) {
  const withCall = data.escalateWithCall ?? existing?.escalateWithCall ?? false;
  const withSms  = data.escalateWithSms  ?? existing?.escalateWithSms  ?? true;

  if (!withCall && !withSms) {
    throw badRequest('Validation failed', {
      escalateWithSms: 'at least one of escalateWithCall or escalateWithSms must be on, or nobody is told about a missed dose',
    });
  }

  const contactId = data.escalationContactId !== undefined
    ? data.escalationContactId
    : existing?.escalationContactId;

  if ((withCall || withSms) && !contactId) {
    throw badRequest('Validation failed', {
      escalationContactId: 'is required when escalation is enabled — the alert would have nowhere to go',
    });
  }
}

router.get('/', asyncHandler(async (req, res) => {
  res.json({ schedules: await repo.listForAccount(req.account.id) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const schedule = await repo.getForAccount(req.account.id, req.params.id);
  if (!schedule) throw notFound('No such schedule');
  res.json({ schedule });
}));

router.post('/', asyncHandler(async (req, res) => {
  const accountId = req.account.id;
  const data      = scheduleInput(req.body);

  await assertOwnedReferences(accountId, data);
  assertSomeoneIsAlerted(data, null);

  const schedule = await repo.createForAccount(accountId, data);
  logger.info('Schedule created via API', {
    accountId, scheduleId: schedule.id, dose: schedule.dose, timeOfDay: schedule.timeOfDay,
  });
  res.status(201).json({ schedule });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const accountId = req.account.id;

  const existing = await repo.getForAccount(accountId, req.params.id);
  if (!existing) throw notFound('No such schedule');

  const data = scheduleInput(req.body, { partial: true });
  await assertOwnedReferences(accountId, data);
  assertSomeoneIsAlerted(data, existing);

  const schedule = await repo.updateForAccount(accountId, req.params.id, data);
  if (!schedule) throw notFound('No such schedule');

  logger.info('Schedule updated via API', { accountId, scheduleId: schedule.id });
  res.json({ schedule });
}));

// Its own endpoint because it is the field someone reaches for in a hurry —
// pausing the calls while she is in hospital — and that should not require
// sending a whole schedule back.
router.post('/:id/enabled', asyncHandler(async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    throw badRequest('Validation failed', { enabled: 'must be true or false' });
  }

  const schedule = await repo.setEnabled(req.account.id, req.params.id, enabled);
  if (!schedule) throw notFound('No such schedule');

  logger.info(`Schedule ${enabled ? 'enabled' : 'DISABLED'} via API`, {
    accountId: req.account.id, scheduleId: schedule.id, dose: schedule.dose,
  });
  res.json({ schedule });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const deleted = await repo.removeForAccount(req.account.id, req.params.id);
  if (!deleted) throw notFound('No such schedule');
  // call_history.schedule_id is SET NULL, so the record of calls already placed
  // survives the schedule that placed them.
  logger.info('Schedule deleted via API', { accountId: req.account.id, scheduleId: req.params.id });
  res.status(204).end();
}));

module.exports = router;
