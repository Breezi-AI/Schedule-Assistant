/**
 * All local-time reasoning lives here, and all of it goes through Luxon.
 *
 * The rule this module exists to enforce: never do offset arithmetic. Adding
 * "UTC-5" to a wall clock is correct for half the year and silently wrong for
 * the other half, and the failure is invisible -- an event simply appears an
 * hour off, with nothing in any log to explain it.
 */
import { DateTime } from 'luxon';

/** The timezone this service thinks in. Not the database's, not the container's. */
export const ZONE = process.env.APP_TIMEZONE || 'America/New_York';

/**
 * The Monday that starts the week containing `asOf`, as a YYYY-MM-DD date in
 * the local zone.
 *
 * This is the fix for the week-boundary bug. `date_trunc('week', now())` is
 * evaluated in the database session's timezone, which on Railway is UTC. At
 * 9pm Sunday in New York it is already Monday in UTC, so Postgres reported the
 * week as starting the *next* Monday and a Sunday-evening workout fell outside
 * "this week" the moment it was logged. Computing the boundary here, in the
 * zone the human actually lives in, and passing it as a parameter removes the
 * database's timezone from the answer entirely.
 */
export function weekStartDate(asOf = new Date(), zone = ZONE) {
  return DateTime.fromJSDate(asOf, { zone }).startOf('week').toISODate();
}

/**
 * The Monday that starts the week AFTER the one containing `asOf`.
 *
 * What the Sunday 18:00 planner writes. Run on a Sunday it means tomorrow;
 * run manually on a Wednesday it still means the next calendar week, so the
 * manual trigger and the cron produce the same week rather than two different
 * answers depending on which day you happened to press the button.
 */
export function comingWeekStart(asOf = new Date(), zone = ZONE) {
  return DateTime.fromJSDate(asOf, { zone }).startOf('week').plus({ weeks: 1 });
}

/**
 * Turn "day 3 of the week at 16:05 local, lasting 60 minutes" into a real
 * instant, correctly on both sides of a DST change.
 *
 * Returns the local wall-clock strings Google Calendar wants alongside the
 * absolute instants Postgres stores, because those are genuinely different
 * facts and conflating them is how an hour goes missing.
 */
export function slotFor(weekStart, dayOffset, hour, minute, durationMinutes) {
  const start = weekStart.plus({ days: dayOffset }).set({
    hour, minute, second: 0, millisecond: 0,
  });
  const end = start.plus({ minutes: durationMinutes });
  return {
    date: start.toISODate(),
    zone: start.zoneName,
    startLocal: start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    endLocal: end.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    startUtc: start.toUTC().toISO(),
    endUtc: end.toUTC().toISO(),
    offset: start.toFormat('ZZ'),
  };
}

/** Human-readable day name for a local date, e.g. "Mon 3 Nov". */
export function prettyDay(isoDate, zone = ZONE) {
  return DateTime.fromISO(isoDate, { zone }).toFormat('ccc d LLL');
}
