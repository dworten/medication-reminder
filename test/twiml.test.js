'use strict';
const { check, contains, section, summary, assertScratchDatabase, truncateAll } = require('./helpers');
require('dotenv').config();

const db     = require('../src/db');
const twiml  = require('../src/twimlHandler');
const prisma = db.getClient();


// The exact strings this app has spoken since before Phase 2.
const LEGACY_INITIAL  = 'Hi, this is your medicine reminder. Have you taken your medicine? Say Yes or No, or type 1 for yes and 2 for no.';
const LEGACY_REPROMPT = "Please take your medicine now. I'll ask again. Have you taken your medicine? Say Yes or No, or type 1 for yes and 2 for no.";

async function main() {
  // This suite truncates every table — refuse outright if the database holds
  // anything real.
  await assertScratchDatabase(prisma);

  section('default prompt is unchanged from the pre-Phase-2 wording');
  const noSchedule = await twiml.resolveBody(null);
  const xml = twiml.gatherTwiml(noSchedule, '/webhook/response?dose=morning&attempt=1&mr=3&reprompts=0');
  contains('initial prompt matches legacy text exactly', xml, `<Say>${LEGACY_INITIAL}</Say>`);
  contains('Gather has dtmf + speech', xml, 'input="dtmf speech"');
  contains('numDigits preserved', xml, 'numDigits="1"');
  contains('speechTimeout preserved', xml, 'speechTimeout="auto"');
  contains('noInput redirect preserved', xml, 'noInput=1');

  const repromptXml = twiml.gatherTwiml({ say: "Please take your medicine now. I'll ask again." }, '/webhook/response?dose=morning&attempt=1&mr=3&reprompts=1');
  contains('reprompt matches legacy text exactly', repromptXml, `<Say>${LEGACY_REPROMPT}</Say>`);

  section('a database message replaces the body, question still asked');
  await truncateAll(prisma);

  const account = await prisma.account.create({ data: { email: 'twiml@example.test' } });
  const contact = await prisma.contact.create({ data: { accountId: account.id, name: 'G', phone: '+15125550111' } });
  const ttsMsg  = await prisma.message.create({
    data: { accountId: account.id, name: 'Custom', kind: 'TTS', ttsText: 'Grandma, it is time for your morning pills.', isDefault: true },
  });
  const sched = await prisma.schedule.create({
    data: { accountId: account.id, name: 'M', dose: 'morning', timeOfDay: '09:20',
            daysOfWeek: [1,2,3,4,5,6], contactId: contact.id, messageId: ttsMsg.id },
  });

  const dbBody = await twiml.resolveBody(sched.id);
  check('custom text used as body', dbBody.say, 'Grandma, it is time for your morning pills.');
  const dbXml = twiml.gatherTwiml(dbBody, '/webhook/response?dose=morning&attempt=1&mr=3&reprompts=0');
  contains('custom body + standard question', dbXml,
    '<Say>Grandma, it is time for your morning pills. Have you taken your medicine? Say Yes or No, or type 1 for yes and 2 for no.</Say>');

  console.log('\n--- an AUDIO message plays a file, then asks the question ---');
  const audioMsg = await prisma.message.create({
    data: { accountId: account.id, name: 'Recorded', kind: 'AUDIO', audioUrl: 'https://example.com/reminder.mp3' },
  });
  await prisma.schedule.update({ where: { id: sched.id }, data: { messageId: audioMsg.id } });
  const audioBody = await twiml.resolveBody(sched.id);
  check('audio url used', audioBody.play, 'https://example.com/reminder.mp3');
  const audioXml = twiml.gatherTwiml(audioBody, '/webhook/response?dose=morning&attempt=1&mr=3&reprompts=0');
  contains('Play element emitted', audioXml, '<Play>https://example.com/reminder.mp3</Play>');
  contains('question still spoken after audio', audioXml, 'Have you taken your medicine?');

  console.log('\n--- fallbacks: missing schedule / unreachable message ---');
  const gone = await twiml.resolveBody('00000000-0000-0000-0000-000000000000');
  check('unknown schedule falls back to default body', gone.say, 'Hi, this is your medicine reminder.');
  await prisma.schedule.update({ where: { id: sched.id }, data: { messageId: null } });
  const noMsg = await twiml.resolveBody(sched.id);
  check('schedule without a message falls back', noMsg.say, 'Hi, this is your medicine reminder.');

  console.log('\n--- context threading keeps dose and attempt first ---');
  const q = twiml.contextQuery({ dose: 'evening', attempt: 2, scheduleId: 'S1', callHistoryId: 'C1', maxReprompts: 4 }, { reprompts: 1 });
  check('query string shape', q, 'dose=evening&attempt=2&sched=S1&ch=C1&mr=4&reprompts=1');
  const bare = twiml.contextQuery({ dose: 'morning', attempt: 1, scheduleId: null, callHistoryId: null, maxReprompts: 3 });
  check('no schedule → no sched/ch params', bare, 'dose=morning&attempt=1&mr=3');

  console.log('\n--- response classification unchanged ---');
  check('digit 1 → yes',      twiml.classifyResponse('1', ''), 'yes');
  check('digit 2 → no',       twiml.classifyResponse('2', ''), 'no');
  check('speech "yes" → yes', twiml.classifyResponse('', 'yes'), 'yes');
  check('speech "nope" → no', twiml.classifyResponse('', 'nope'), 'no');
  check('"one" → yes',        twiml.classifyResponse('', 'one'), 'yes');
  check('garbage → unknown',  twiml.classifyResponse('', 'purple monkey'), 'unknown');

  await truncateAll(prisma);

  process.exitCode = summary() ? 1 : 0;
}

main().catch(e => { console.error('FAILED:', e); process.exitCode = 1; }).finally(() => db.disconnect());
