'use strict';
// Admin alerts — the alerts about failed alerts.
//
// Pure: the two outbound edges (voice and SMS) are intercepted and the
// heartbeat's history read is stubbed, so no database and no Twilio. What runs
// for real is everything these cases are about: channel selection, the
// fallback when a channel is down, the storm guard, and the rule that notify()
// never throws into the call path.

const { check, contains, section, summary } = require('./helpers');

const config = require('../src/config');

// Configure before first use. mockMode off so _deliver actually exercises the
// channel logic rather than printing a box.
config.mockMode                  = false;
config.adminAlertPhone           = '+15125550142';
config.adminAlertChannel         = 'call';
config.adminAlertCooldownMinutes = 60;

const adminAlert = require('../src/adminAlert');
const repo       = require('../src/data/callHistory');

let calls = [];
let sms   = [];
let failCalls = false;
let failSms   = false;

adminAlert.placeAlertCall = async (to, twiml) => {
  if (failCalls) throw new Error('voice edge down');
  calls.push({ to, twiml });
  return { sid: 'CA_ADMIN' };
};
adminAlert.sendAlertSms = async (to, body) => {
  if (failSms) throw new Error('sms edge down');
  sms.push({ to, body });
  return 'SM_ADMIN';
};

function reset({ channel = 'call' } = {}) {
  calls = []; sms = [];
  failCalls = false; failSms = false;
  config.adminAlertChannel = channel;
  adminAlert.resetCooldowns();
}

const MIN = 60 * 1000;

async function main() {
  const t0 = Date.now();

  section('the default channel is a voice call that names the failure');
  reset();
  let sent = await adminAlert.notify('RETRY LOST', 'Morning meds (morning) to Grandma: retry #2 could not be written', t0);
  check('reported sent', sent, true);
  check('one call placed', calls.length, 1);
  check('no SMS', sms.length, 0);
  check('to the admin phone', calls[0].to, '+15125550142');
  contains('the TwiML speaks the event', calls[0].twiml, 'RETRY LOST');
  contains('and the detail', calls[0].twiml, 'Morning meds');
  check('spoken twice', calls[0].twiml.split('RETRY LOST').length - 1 >= 2, true);

  section('TwiML is XML-escaped, because error text carries anything');
  reset();
  await adminAlert.notify('ESCALATION LOST', 'queue error: connect ECONNREFUSED <db> & timeout', t0);
  contains('angle brackets escaped', calls[0].twiml, '&lt;db&gt;');
  contains('ampersand escaped', calls[0].twiml, '&amp; timeout');
  check('no raw angle bracket around db', calls[0].twiml.includes('<db>'), false);

  section('storm guard: the same event does not alert twice inside the cooldown');
  reset();
  check('first alert sent', await adminAlert.notify('RETRY LOST', 'a', t0), true);
  check('immediate repeat suppressed', await adminAlert.notify('RETRY LOST', 'b', t0 + 1000), false);
  check('still suppressed near the edge', await adminAlert.notify('RETRY LOST', 'c', t0 + 59 * MIN), false);
  check('only one call went out', calls.length, 1);
  check('a DIFFERENT event is not suppressed', await adminAlert.notify('ESCALATION LOST', 'd', t0 + 1000), true);
  check('two calls now', calls.length, 2);

  section('suppressed repeats are counted, not lost');
  reset();
  await adminAlert.notify('CALL NEVER RESOLVED', 'row 1', t0);
  await adminAlert.notify('CALL NEVER RESOLVED', 'row 2', t0 + 1000);
  await adminAlert.notify('CALL NEVER RESOLVED', 'row 3', t0 + 2000);
  sent = await adminAlert.notify('CALL NEVER RESOLVED', 'row 4', t0 + 61 * MIN);
  check('sends again after the cooldown', sent, true);
  check('two calls total', calls.length, 2);
  contains('the second names what was swallowed', calls[1].twiml, '+2 more since the last alert');

  section('sms channel falls back to a call when SMS is down');
  // The recursion case: SMS is the alert channel and SMS is what is broken.
  reset({ channel: 'sms' });
  failSms = true;
  sent = await adminAlert.notify('ALERT TEXT NOT DELIVERED', 'carrier refused 30034', t0);
  check('still delivered', sent, true);
  check('no SMS went out', sms.length, 0);
  check('the voice fallback fired', calls.length, 1);
  contains('carrying the same message', calls[0].twiml, 'carrier refused 30034');

  section('call channel falls back to SMS when voice is down');
  reset({ channel: 'call' });
  failCalls = true;
  sent = await adminAlert.notify('RETRY LOST', 'x', t0);
  check('still delivered', sent, true);
  check('via SMS', sms.length, 1);
  contains('same message', sms[0].body, 'RETRY LOST');

  section('channel "both" survives one edge being down');
  reset({ channel: 'both' });
  failSms = true;
  sent = await adminAlert.notify('RETRY LOST', 'x', t0);
  check('delivered', sent, true);
  check('the call went out', calls.length, 1);

  section('both channels down: ADMIN ALERT LOST, and notify still never throws');
  reset();
  failCalls = true; failSms = true;
  let threw = false;
  try { sent = await adminAlert.notify('RETRY LOST', 'x', t0); } catch { threw = true; }
  check('did not throw into the call path', threw, false);
  check('reported not sent', sent, false);
  check('nothing delivered', calls.length + sms.length, 0);
  // The cooldown entry stands, so the NEXT occurrence after the window retries.
  failCalls = false; failSms = false;
  check('a later occurrence tries again', await adminAlert.notify('RETRY LOST', 'x', t0 + 61 * MIN), true);

  section('no admin phone configured: quietly nothing');
  reset();
  const savedPhone = config.adminAlertPhone;
  config.adminAlertPhone = '';
  check('reported not sent', await adminAlert.notify('RETRY LOST', 'x', t0), false);
  check('nothing delivered', calls.length + sms.length, 0);
  config.adminAlertPhone = savedPhone;

  section('heartbeat summarizes the day and says the system is alive');
  reset();
  repo.summarizeSince = async () => [
    { kind: 'REMINDER_CALL',   outcome: 'CONFIRMED',  count: 2 },
    { kind: 'REMINDER_CALL',   outcome: 'NO_ANSWER',  count: 1 },
    { kind: 'ESCALATION_SMS',  outcome: 'DELIVERED',  count: 1 },
    { kind: 'ESCALATION_SMS',  outcome: 'FAILED',     count: 1 },
    { kind: 'ESCALATION_CALL', outcome: 'CONFIRMED',  count: 1 },
  ];
  check('delivered', await adminAlert.heartbeat(new Date()), true);
  check('as a call on the configured channel', calls.length, 1);
  contains('says it is alive', calls[0].twiml, 'system alive');
  contains('counts the reminder calls', calls[0].twiml, '3 reminder calls');
  contains('counts confirmations', calls[0].twiml, '2 confirmed');
  contains('counts the misses', calls[0].twiml, '1 not confirmed');
  contains('counts escalation steps', calls[0].twiml, '3 escalation steps');
  contains('names the undelivered alert', calls[0].twiml, '1 NOT delivered');

  section('a quiet day reads as quiet, not broken');
  reset();
  repo.summarizeSince = async () => [];
  await adminAlert.heartbeat(new Date());
  contains('says no calls', calls[0].twiml, 'no calls');

  section('heartbeat with the database down still goes out, and says so');
  reset();
  repo.summarizeSince = async () => { throw new Error('connection refused'); };
  check('delivered anyway', await adminAlert.heartbeat(new Date()), true);
  contains('reports the read failure', calls[0].twiml, "could not read the day's history");
  contains('with the reason', calls[0].twiml, 'connection refused');

  section('heartbeat is not storm-guarded away by a busy day of alerts');
  reset();
  repo.summarizeSince = async () => [];
  await adminAlert.notify('RETRY LOST', 'x', t0);
  check('heartbeat still delivers', await adminAlert.heartbeat(new Date()), true);
  check('both went out', calls.length, 2);

  process.exitCode = summary() ? 1 : 0;
}

main().catch((e) => { console.error('FAILED:', e); process.exitCode = 1; });
