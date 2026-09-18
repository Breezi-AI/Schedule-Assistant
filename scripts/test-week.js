/**
 * The week-boundary bug, tested against a real database.
 *
 *   npm run test:week      (needs DATABASE_URL)
 *
 * The unit tests prove weekStartDate returns the right Monday. This proves
 * the consequence that actually mattered: a workout logged at 9pm on a Sunday
 * is counted in that week rather than vanishing from it.
 *
 * It also computes what the old UTC-based boundary would have said, and
 * asserts that it really would have excluded the row -- so if someone reverts
 * the fix, this fails for the right reason rather than passing by luck.
 */
import { DateTime } from 'luxon';

const NY = 'America/New_York';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must be set.');
  process.exit(2);
}

const { q, pool, gymWeekSummary } = await import('../src/db/index.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

// A Sunday far from any real data. 21:00 in New York, which is already
// Monday in UTC -- the exact instant the old query got wrong.
const sundayNight = DateTime.fromObject(
  { year: 1991, month: 1, day: 6, hour: 21, minute: 0 }, { zone: NY });

const SESSION_ID = 'weekboundary-test';

console.log('\nweek boundary, against Postgres\n');

check('the fixture really is a Sunday evening in New York',
  sundayNight.weekday === 7 && sundayNight.hour === 21,
  `weekday=${sundayNight.weekday} hour=${sundayNight.hour}`);

const asOf = sundayNight.toJSDate();
const utcSaysWeekStarts = DateTime.fromJSDate(asOf, { zone: 'utc' })
  .startOf('week').toISODate();
const localSaysWeekStarts = DateTime.fromJSDate(asOf, { zone: NY })
  .startOf('week').toISODate();

console.log(`  fixture   ${sundayNight.toISO()}`);
console.log(`  in UTC    ${DateTime.fromJSDate(asOf, { zone: 'utc' }).toISO()}`);
console.log(`  week start per UTC   ${utcSaysWeekStarts}   <- the old behaviour`);
console.log(`  week start per ${NY}  ${localSaysWeekStarts}\n`);

check('the two timezones genuinely disagree at this instant',
  utcSaysWeekStarts !== localSaysWeekStarts,
  `both said ${utcSaysWeekStarts} -- fixture is not on a boundary, test proves nothing`);

check('the old UTC boundary would have excluded a session dated this Sunday',
  utcSaysWeekStarts > sundayNight.toISODate(),
  `utc week start ${utcSaysWeekStarts} vs session date ${sundayNight.toISODate()}`);

try {
  await q(
    `INSERT INTO gym_sessions (id, session_date, day_id, day_name, sets, names, started_at, ended_at)
     VALUES ($1, $2, 'd1', 'Deadlift + Back', '{}'::jsonb, '{}'::jsonb, $3, $4)
     ON CONFLICT (id) DO UPDATE SET session_date = EXCLUDED.session_date,
       started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at`,
    [SESSION_ID, sundayNight.toISODate(),
     sundayNight.toUTC().toISO(), sundayNight.plus({ minutes: 55 }).toUTC().toISO()]
  );

  const summary = await gymWeekSummary({ asOf });

  check('the Sunday-evening session is counted in that week',
    summary.sessions >= 1,
    `sessions=${summary.sessions} week_start=${summary.week_start}`);

  check('the reported week starts on the local Monday, not the UTC one',
    summary.week_start === localSaysWeekStarts,
    `week_start=${summary.week_start} expected=${localSaysWeekStarts}`);

  check('its duration is measured',
    summary.avg_minutes === 55,
    `avg_minutes=${summary.avg_minutes}`);

  // The window must also have a far edge. Without one, a session dated months
  // ahead would count toward this week forever.
  const weekBefore = await gymWeekSummary({ asOf: sundayNight.minus({ weeks: 1 }).toJSDate() });
  check('the previous week does not also claim it',
    weekBefore.sessions === 0,
    `previous week reported ${weekBefore.sessions} session(s)`);

  const weekAfter = await gymWeekSummary({ asOf: sundayNight.plus({ weeks: 1 }).toJSDate() });
  check('the following week does not claim it either',
    weekAfter.sessions === 0,
    `following week reported ${weekAfter.sessions} session(s)`);
} finally {
  const del = await q('DELETE FROM gym_sessions WHERE id = $1', [SESSION_ID]);
  console.log(`\n  cleaned up ${del.rowCount} test row(s)`);
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
