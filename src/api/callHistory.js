'use strict';

// /api/call-history — what actually happened. Read-only.
//
// There is no POST, PATCH or DELETE, deliberately: this is the record of calls
// placed to a real person about real medication, and an API that can rewrite it
// is an API that can hide a missed dose. Rows are written by the call path
// alone.

const express = require('express');
const repo    = require('../data/callHistory');
const { asyncHandler } = require('./errors');
const { callHistoryQuery } = require('./validate');

const router = express.Router();

// parentId is included so a UI can nest the escalation chain — an ESCALATION_SMS
// under the ESCALATION_CALL that went unacknowledged, under the REMINDER_CALL
// that was never confirmed — without asking the server to shape it.
function present(row) {
  return {
    id:            row.id,
    parentId:      row.parentId,
    kind:          row.kind,
    dose:          row.dose,
    attempt:       row.attempt,
    repromptCount: row.repromptCount,
    outcome:       row.outcome,
    // Who it was about, and where it actually went. They differ when a call was
    // redirected — /trigger?target=test — and showing only the contact would
    // make a test call read as though it rang her.
    contact:       row.contact ? { id: row.contact.id, name: row.contact.name, phone: row.contact.phone } : null,
    toPhone:       row.toPhone,
    schedule:      row.schedule || null,
    callSid:       row.callSid,
    startedAt:     row.startedAt,
    completedAt:   row.completedAt,
    nextRetryAt:   row.nextRetryAt,
    errorMessage:  row.errorMessage,
  };
}

// GET /api/call-history?limit=&offset=&from=&to=&contactId=&dose=
router.get('/', asyncHandler(async (req, res) => {
  const query  = callHistoryQuery(req.query);
  const result = await repo.listForAccount(req.account.id, query);

  res.json({
    callHistory: result.rows.map(present),
    // The total is what lets a UI say "showing 50 of 312" instead of guessing
    // whether another page exists.
    pagination: {
      total:   result.total,
      limit:   result.limit,
      offset:  result.offset,
      hasMore: result.offset + result.rows.length < result.total,
    },
  });
}));

module.exports = router;
