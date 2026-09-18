/**
 * The weekly gym planner. Milestone 1a: it writes blocks and nothing else.
 *
 * No reconciliation, no recolouring, no move detection, no SMS. Those need
 * planned-vs-actual pairs to verify against, and those pairs only start
 * existing once this has been running.
 */
import { q } from './db/index.js';
import { ZONE, comingWeekStart, slotFor } from './time.js';
import { insertEvent, calendarConfigured } from './calendar.js';

export const GYM_LOCATION =
  'Onelife Fitness - Newnan Sports Club, 460 Newnan Crossing Byp, Newnan, GA 30263';

/** Monday, Wednesday, Friday. Day offset from the Monday that starts the week. */
export const SLOTS = [
  { dayOffset: 0, hour: 17, minute: 45, minutes: 60, label: 'Monday' },
  { dayOffset: 2, hour: 17, minute: 45, minutes: 60, label: 'Wednesday' },
  { dayOffset: 4, hour: 16, minute: 5,  minutes: 60, label: 'Friday' },
];

const DEFAULT_DAYS = [
  { id: 'd1', name: 'Deadlift + Back' },
  { id: 'd2', name: 'Squat + Shoulders' },
  { id: 'd3', name: 'Incline + Upper Back' },
];

/** The program as the user has it, falling back to the stock split. */
export async function loadDays() {
  const { rows } = await q('SELECT days FROM gym_program WHERE id = 1');
  const days = rows[0]?.days;
  if (!Array.isArray(days) || !days.length) return DEFAULT_DAYS;
  return days
    .filter((d) => d && d.id)
    .map((d) => ({ id: d.id, name: d.name || d.id }));
}

/**
 * Which lifts come next, continuing from the last workout actually logged.
 *
 * Driven by gym_sessions rather than by what was previously planned, and
 * that is the point: if Wednesday's squat day gets missed, the next plan
 * still starts at squats instead of rotating past them. Skipping a session
 * delays a lift; it never drops it.
 *
 * Within one run the three days are fixed. The correction for a mid-week
 * miss lands on the next planning run, which re-reads the log. Reacting
 * inside a week means noticing a miss, which is 1b.
 */
export async function nextDayIds(count, days) {
  const ids = days.map((d) => d.id);
  const { rows } = await q(
    `SELECT day_id FROM gym_sessions ORDER BY session_date DESC, logged_at DESC LIMIT 1`
  );
  let start = 0;
  const last = rows[0]?.day_id;
  if (last) {
    const i = ids.indexOf(last);
    if (i >= 0) start = (i + 1) % ids.length;
  }
  return Array.from({ length: count }, (_, n) => ids[(start + n) % ids.length]);
}

/**
 * Plan the coming week.
 *
 * Idempotency is enforced by the primary key, not by a check. Each block's
 * id is "<kind>-<local date>", and the row is inserted with ON CONFLICT DO
 * NOTHING *before* the calendar is touched. Only a run that actually won
 * the insert goes on to create an event, so two runs -- or two racing runs
 * -- cannot produce two events for one date.
 *
 * The cost of that ordering is a row that exists with no event, if the
 * calendar call fails after the insert won. That is recoverable and the
 * opposite is not: a later run sees calendar_event_id IS NULL and fills it
 * in, so a transient Google outage self-heals on the next run instead of
 * leaving a duplicate nobody notices.
 */
export async function planWeek({ asOf = new Date(), zone = ZONE, kind = 'gym' } = {}) {
  if (!calendarConfigured()) {
    throw new Error(
      'Calendar is not configured: GOOGLE_SA_JSON_B64 and GYM_CALENDAR_ID must both be set.'
    );
  }

  const weekStart = comingWeekStart(asOf, zone);
  const days = await loadDays();
  const dayIds = await nextDayIds(SLOTS.length, days);
  const nameById = new Map(days.map((d) => [d.id, d.name]));
  const colorId = process.env.GYM_EVENT_COLOR_ID || '6';

  const created = [];
  const skipped = [];
  const repaired = [];
  const failed = [];

  for (let i = 0; i < SLOTS.length; i++) {
    const slot = SLOTS[i];
    const when = slotFor(weekStart, slot.dayOffset, slot.hour, slot.minute, slot.minutes);
    const dayId = dayIds[i];
    const dayName = nameById.get(dayId) || dayId;
    const id = `${kind}-${when.date}`;

    // The database is the lock.
    const ins = await q(
      `INSERT INTO commitments (id, kind, day_id, planned_start, planned_end, status)
       VALUES ($1, $2, $3, $4, $5, 'planned')
       ON CONFLICT (id) DO NOTHING`,
      [id, kind, dayId, when.startUtc, when.endUtc]
    );

    if (ins.rowCount === 0) {
      const { rows } = await q(
        'SELECT calendar_event_id FROM commitments WHERE id = $1', [id]);
      if (rows[0]?.calendar_event_id) {
        skipped.push({ id, date: when.date, reason: 'already planned' });
        continue;
      }
      // Row exists but never got its event. Finish the job rather than
      // leaving a block that is in the database and not on the calendar.
    }

    try {
      const event = await insertEvent({
        summary: `Gym - ${dayName}`,
        location: GYM_LOCATION,
        startLocal: when.startLocal,
        endLocal: when.endLocal,
        zone: when.zone,
        colorId,
      });
      await q('UPDATE commitments SET calendar_event_id = $2 WHERE id = $1', [id, event.id]);
      const record = {
        id, date: when.date, dayId, dayName, slot: slot.label,
        startLocal: when.startLocal, endLocal: when.endLocal,
        offset: when.offset, eventId: event.id, htmlLink: event.htmlLink,
      };
      if (ins.rowCount === 0) repaired.push(record); else created.push(record);
    } catch (err) {
      failed.push({ id, date: when.date, error: err.message });
      // The row stays, with a null event id, so the next run retries it.
    }
  }

  return {
    weekStart: weekStart.toISODate(),
    zone,
    created, repaired, skipped, failed,
  };
}
