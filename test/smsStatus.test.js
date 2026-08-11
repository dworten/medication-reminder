'use strict';
// What an SMS status callback means.
//
// This suite exists because of a real, silent, week-long failure. Every
// escalation text this system sent between 4 and 11 August was rejected by the
// carrier with error 30034 (an unregistered A2P 10DLC sender), and every one of
// them was recorded in call_history as SENT. The history screen said "Alert
// sent" eleven times about texts that never arrived.
//
// The cause was an assumption, not a bug in the sending: messages.create()
// resolving means Twilio ACCEPTED the message, not that anyone received it.
// Delivery succeeds or fails minutes later, asynchronously, and nothing was
// listening. So "sent" was recorded at the only moment it could not yet be known.
//
// The mapping below is the fix, and it is a pure function precisely so it can be
// tested without a database, a network, or Twilio — the parts of this that made
// the original failure invisible.

const { check, section, summary } = require('./helpers');

// Requiring twimlHandler pulls in config, the logger and the data repos, but
// db.js builds its client lazily — nothing here opens a connection.
const { messageOutcome, isTerminalMessageStatus } = require('../src/twimlHandler');

section('a message Twilio has merely accepted is NOT a delivered message');

// The whole bug in one assertion. Twilio reports `sent` when it has handed the
// message to the carrier, which is exactly the moment the old code called it
// done — and 30034 arrives after this point.
check('queued is not terminal',    messageOutcome('queued'),    null);
check('accepted is not terminal',  messageOutcome('accepted'),  null);
check('sending is not terminal',   messageOutcome('sending'),   null);
check('sent is not terminal',      messageOutcome('sent'),      null);
check('scheduled is not terminal', messageOutcome('scheduled'), null);

section('only the carrier gets to say it arrived');
check('delivered', messageOutcome('delivered'), 'DELIVERED');

section('and a rejection is a failure, not a success');
check('undelivered → FAILED', messageOutcome('undelivered'), 'FAILED');
check('failed → FAILED',      messageOutcome('failed'),      'FAILED');

// 30034 is the exact code that went unnoticed for a week.
check('30034 is undelivered', messageOutcome('undelivered', '30034'), 'FAILED');

section('unknown and malformed statuses never invent an outcome');
// Returning null means "leave the row alone". Guessing here would let a Twilio
// API change silently overwrite a real outcome with a made-up one.
check('unknown status',  messageOutcome('teleported'), null);
check('empty string',    messageOutcome(''),           null);
check('undefined',       messageOutcome(undefined),    null);
check('null',            messageOutcome(null),         null);
check('a number',        messageOutcome(42),           null);

section('status casing is Twilio\'s business, not ours');
check('DELIVERED',   messageOutcome('DELIVERED'),   'DELIVERED');
check('Undelivered', messageOutcome('Undelivered'), 'FAILED');
check('  delivered ', messageOutcome('  delivered '), 'DELIVERED');

section('the terminal check agrees with the mapping');
check('delivered is terminal',   isTerminalMessageStatus('delivered'),   true);
check('undelivered is terminal', isTerminalMessageStatus('undelivered'), true);
check('sent is not',             isTerminalMessageStatus('sent'),        false);
check('queued is not',           isTerminalMessageStatus('queued'),      false);

process.exitCode = summary() ? 1 : 0;
