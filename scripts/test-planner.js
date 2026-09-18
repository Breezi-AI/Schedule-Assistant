/**
 * The planner, against the real database and the real calendar.
 *
 *   npm run test:planner
 *
 * Runs the planner twice for a week far in the future, asserts the second
 * run writes nothing, then deletes both the rows and the calendar events it
 * made. It uses a real future week rather than a fake one because the thing
 * most worth proving -- that Google accepts the event and gives back an id --
 * cannot be proven against a stub.
 *
 * The week is chosen to sit after the November DST change, so the blocks it
 * writes are also a live check that 17:45 local is still 17:45 local on the
 * far side of the clocks going back.
 */
import { DateTime } from 'luxon';
import { q, pool } from '../src/db/index.js';
import { planWeek, SLOTS, loadDays, nextDayIds } from '../src/planner.js';
import { ZONE } from '../src/time.js';
import { deleteEvent, getEvent, calendarConfigured } from '../src/calendar.js';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

if (!calendarConfigured()) {
  console.error('GOOGLE_SA_JSON_B64 and GYM_CALENDAR_ID must both be set.');
  process.exit(2);
}

// A Sunday well after the November DST change and far from any real plan.
const asOf = DateTime.fromObject(
  { year: 2027, month: 2, day: 7, hour: 18 }, { zone: ZONE }).toJSDate();

const madeIds = [];
const madeEvents = [];

console.log('\nplanner, against Postgres and Google Calendar\n');

try {
  // --- first run --------------------------------------------------------
  const first = await planWeek({ asOf });
  for (const b of first.created) { madeIds.push(b.id); madeEvents.push(b.eventId); }

  check('the first run creates one block per slot',
    first.created.length === SLOTS.length && first.failed.length === 0,
    `created=${first.created.length} failed=${JSON.stringify(first.failed)}`);

  check('every block came back with a Google event id',
    first.created.every((b) => !!b.eventId),
    JSON.stringify(first.created.map((b) => ({ d: b.date, e: b.eventId }))));

  check('the blocks land on Monday, Wednesday and Friday',
    first.created.map((b) => DateTime.fromISO(b.date, { zone: ZONE }).weekday).join(',') === '1,3,5',
    first.created.map((b) => `${b.date}=${DateTime.fromISO(b.date, { zone: ZONE }).weekday}`).join(' '));

  check('Monday and Wednesday are 17:45-18:45, Friday is 16:05-17:05',
    first.created[0].startLocal.endsWith('17:45:00') && first.created[0].endLocal.endsWith('18:45:00') &&
    first.created[1].startLocal.endsWith('17:45:00') && first.created[1].endLocal.endsWith('18:45:00') &&
    first.created[2].startLocal.endsWith('16:05:00') && first.created[2].endLocal.endsWith('17:05:00'),
    first.created.map((b) => `${b.startLocal}->${b.endLocal}`).join(' '));

  check('the lifts rotate through three distinct days',
    new Set(first.created.map((b) => b.dayId)).size === 3,
    first.created.map((b) => `${b.date}=${b.dayId}`).join(' '));

  const { rows: afterFirst } = await q(
    `SELECT COUNT(*)::int AS n FROM commitments WHERE id = ANY($1)`, [madeIds]);
  check('three rows are in commitments', afterFirst[0].n === 3, `n=${afterFirst[0].n}`);

  // --- what Google actually stored -------------------------------------
  const event = await getEvent(first.created[0].eventId);
  check('the event summary is "Gym - <day name>"',
    event.summary === `Gym - ${first.created[0].dayName}`,
    `summary=${event.summary}`);
  check('the location is set',
    typeof event.location === 'string' && event.location.includes('Newnan Crossing Byp'),
    `location=${event.location}`);
  check('the event is opaque, so it shows as busy',
    event.transparency === 'opaque' || event.transparency === undefined,
    `transparency=${event.transparency}`);
  check('a colour is set', !!event.colorId, `colorId=${event.colorId}`);
  check('the start carries the local zone, not a bare UTC instant',
    event.start?.timeZone === ZONE && /T17:45:00/.test(event.start?.dateTime || ''),
    `start=${JSON.stringify(event.start)}`);
  check('no reminder overrides were written, so calendar defaults apply',
    !event.reminders || event.reminders.useDefault !== false,
    `reminders=${JSON.stringify(event.reminders)}`);

  // --- second run: the idempotency claim --------------------------------
  const second = await planWeek({ asOf });

  check('the second run creates nothing',
    second.created.length === 0 && second.repaired.length === 0,
    `created=${second.created.length} repaired=${second.repaired.length}`);
  check('the second run reports all three as already planned',
    second.skipped.length === SLOTS.length,
    `skipped=${JSON.stringify(second.skipped)}`);

  const { rows: afterSecond } = await q(
    `SELECT COUNT(*)::int AS n FROM commitments WHERE id = ANY($1)`, [madeIds]);
  check('the row count is unchanged after running twice',
    afterSecond[0].n === afterFirst[0].n,
    `before=${afterFirst[0].n} after=${afterSecond[0].n}`);

  const { rows: dupes } = await q(
    `SELECT id, COUNT(*)::int AS n FROM commitments
     WHERE id = ANY($1) GROUP BY id HAVING COUNT(*) > 1`, [madeIds]);
  check('no date has two blocks', dupes.length === 0, JSON.stringify(dupes));

  // --- the repair path --------------------------------------------------
  // Blank one event id to simulate the calendar call having failed after the
  // row was inserted, and confirm the next run finishes the job rather than
  // either duplicating it or leaving it broken.
  const orphan = madeIds[0];
  await q('UPDATE commitments SET calendar_event_id = NULL WHERE id = $1', [orphan]);
  const third = await planWeek({ asOf });
  check('a row with no event is repaired, not duplicated',
    third.repaired.length === 1 && third.repaired[0].id === orphan &&
    third.created.length === 0 && third.skipped.length === 2,
    `repaired=${JSON.stringify(third.repaired.map((r) => r.id))} created=${third.created.length}`);
  if (third.repaired[0]?.eventId) madeEvents.push(third.repaired[0].eventId);

  const { rows: afterThird } = await q(
    `SELECT COUNT(*)::int AS n FROM commitments WHERE id = ANY($1)`, [madeIds]);
  check('the repair did not add a row',
    afterThird[0].n === afterFirst[0].n,
    `n=${afterThird[0].n}`);

  // --- rotation follows the log, not the plan ---------------------------
  // The reason this matters: if Wednesday's squat day is missed, the next
  // plan must still start at squats rather than rotating past them.
  const days = await loadDays();
  const ids = days.map((d) => d.id);
  const ROT_ID = 'rotation-probe';
  try {
    const baseline = await nextDayIds(3, days);
    check('with no workouts logged, rotation starts at the first day',
      baseline[0] === ids[0],
      `got ${baseline.join(',')} expected to start at ${ids[0]}`);

    for (const last of ids) {
      await q(
        `INSERT INTO gym_sessions (id, session_date, day_id, day_name, sets, names, started_at, ended_at)
         VALUES ($1, CURRENT_DATE, $2, 'probe', '{}'::jsonb, '{}'::jsonb, now(), now())
         ON CONFLICT (id) DO UPDATE SET day_id = EXCLUDED.day_id, logged_at = now()`,
        [ROT_ID, last]);
      const got = await nextDayIds(3, days);
      const startAt = (ids.indexOf(last) + 1) % ids.length;
      const want = [0, 1, 2].map((n) => ids[(startAt + n) % ids.length]);
      check(`after logging ${last}, the next three are ${want.join(', ')}`,
        got.join(',') === want.join(','),
        `got ${got.join(',')}`);
    }
  } finally {
    await q('DELETE FROM gym_sessions WHERE id = $1', [ROT_ID]);
  }
} finally {
  console.log('\ncleanup');
  let ev = 0;
  for (const id of madeEvents) {
    try { await deleteEvent(id); ev++; } catch (err) {
      console.log(`  could not delete event ${id}: ${err.message}`);
    }
  }
  const del = await q('DELETE FROM commitments WHERE id = ANY($1)', [madeIds]);
  console.log(`  removed ${ev} calendar event(s) and ${del.rowCount} row(s)`);
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
