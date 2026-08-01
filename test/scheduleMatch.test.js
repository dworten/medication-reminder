'use strict';
const { check, contains, section, summary, assertScratchDatabase, truncateAll } = require('./helpers');
const m = require('../src/scheduleMatch');


// Central-time schedule: 9:20 AM, Mon-Sat (Sunday morning skipped, as today).
const morning = { timeOfDay: '09:20', timezone: 'America/Chicago', daysOfWeek: [1,2,3,4,5,6] };
// 9:20 PM every day.
const evening = { timeOfDay: '21:20', timezone: 'America/Chicago', daysOfWeek: [0,1,2,3,4,5,6] };

const at = (iso) => new Date(iso);
const due = (s, iso, grace = 5) => m.evaluate(s, at(iso), grace).due;

section('CDT (summer, UTC-5): 9:20 AM Central = 14:20 UTC');
// 2026-08-03 is a Monday.
check('9:20 AM CDT Monday fires',            due(morning, '2026-08-03T14:20:00Z'), true);
check('9:19 AM CDT does not fire',           due(morning, '2026-08-03T14:19:00Z'), false);
check('9:25 AM CDT still fires (grace edge)',due(morning, '2026-08-03T14:25:00Z'), true);
check('9:26 AM CDT too late',                due(morning, '2026-08-03T14:26:00Z'), false);
check('8:20 AM CDT (an hour early) no',      due(morning, '2026-08-03T13:20:00Z'), false);

console.log('\n--- CST (winter, UTC-6): 9:20 AM Central = 15:20 UTC ---');
// 2026-01-05 is a Monday. Same wall-clock time, different UTC instant.
check('9:20 AM CST Monday fires',            due(morning, '2026-01-05T15:20:00Z'), true);
check('14:20 UTC in winter does NOT fire',   due(morning, '2026-01-05T14:20:00Z'), false);

console.log('\n--- days-of-week ---');
// 2026-08-02 is a Sunday.
check('Sunday morning skipped',              due(morning, '2026-08-02T14:20:00Z'), false);
check('Sunday evening fires',                due(evening, '2026-08-03T02:20:00Z'), true);
check('Saturday morning fires',              due(morning, '2026-08-01T14:20:00Z'), true);

console.log('\n--- evening across the UTC date boundary ---');
// 9:20 PM CDT Sunday 2026-08-02 = 02:20 UTC Monday 2026-08-03.
// The weekday must be read in Chicago (Sunday), not UTC (Monday).
check('9:20 PM Sun CDT = 02:20 UTC Mon',     due(evening, '2026-08-03T02:20:00Z'), true);
const eveningWeekdaysOnly = { ...evening, daysOfWeek: [1,2,3,4,5] };
check('Mon-Fri evening: Sunday night no',    due(eveningWeekdaysOnly, '2026-08-03T02:20:00Z'), false);
check('Mon-Fri evening: Monday night yes',   due(eveningWeekdaysOnly, '2026-08-04T02:20:00Z'), true);

console.log('\n--- DST transition days (US spring forward 2026-03-08) ---');
// Before the jump the offset is -6, after it is -5. 9:20 AM local fires either way.
check('9:20 AM on spring-forward Sunday(evening sched)', due(evening, '2026-03-09T02:20:00Z'), true);
check('9:20 AM CDT day after spring forward', due(morning, '2026-03-09T14:20:00Z'), true);
// Fall back 2026-11-01.
check('9:20 AM CST day after fall back',      due(morning, '2026-11-02T15:20:00Z'), true);

console.log('\n--- timezone independence ---');
const tokyo = { timeOfDay: '09:20', timezone: 'Asia/Tokyo', daysOfWeek: [0,1,2,3,4,5,6] };
// 9:20 JST = 00:20 UTC same day.
check('Tokyo 9:20 fires at 00:20 UTC',        due(tokyo, '2026-08-03T00:20:00Z'), true);
check('Tokyo not firing at 14:20 UTC',        due(tokyo, '2026-08-03T14:20:00Z'), false);

console.log('\n--- bad data fails closed (no call, no crash) ---');
check('invalid timezone → not due',           due({ ...morning, timezone: 'Mars/Olympus' }, '2026-08-03T14:20:00Z'), false);
check('invalid timeOfDay → not due',          due({ ...morning, timeOfDay: '9:20' }, '2026-08-03T14:20:00Z'), false);
check('empty daysOfWeek → not due',           due({ ...morning, daysOfWeek: [] }, '2026-08-03T14:20:00Z'), false);
check('null daysOfWeek → not due',            due({ ...morning, daysOfWeek: null }, '2026-08-03T14:20:00Z'), false);

console.log('\n--- grace = 0 behaves like the old exact-minute cron ---');
check('exact minute fires with grace 0',      due(morning, '2026-08-03T14:20:00Z', 0), true);
check('one minute late misses with grace 0',  due(morning, '2026-08-03T14:21:00Z', 0), false);

console.log('\n--- midnight boundary (documented limitation) ---');
const midnight = { timeOfDay: '00:02', timezone: 'America/Chicago', daysOfWeek: [0,1,2,3,4,5,6] };
check('00:02 fires at 00:02 local',           due(midnight, '2026-08-03T05:02:00Z'), true);
check('00:02 catch-up at 00:06 local',        due(midnight, '2026-08-03T05:06:00Z'), true);

console.log('\n--- findDue picks only the due ones ---');
const both = m.findDue([morning, evening], at('2026-08-03T14:20:00Z'), 5);
check('only morning due at 9:20 AM',          both.length, 1);
check('and it is the 09:20 one',              both[0].schedule.timeOfDay, '09:20');

process.exitCode = summary() ? 1 : 0;
