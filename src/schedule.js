/**
 * The Sunday 18:00 planner.
 *
 * node-cron is given the timezone explicitly rather than relying on the
 * container's TZ. Railway containers are UTC unless told otherwise, and a
 * schedule that drifts by an hour twice a year is exactly the failure this
 * project keeps running into.
 */
import cron from 'node-cron';
import { ZONE } from './time.js';
import { planWeek } from './planner.js';
import { calendarConfigured } from './calendar.js';

export const WEEKLY_SPEC = '0 18 * * 0'; // Sundays at 18:00 local

export function startSchedule() {
  if (!calendarConfigured()) {
    console.warn(
      '[schedule] calendar is not configured (GOOGLE_SA_JSON_B64 / GYM_CALENDAR_ID); ' +
      'the weekly planner will not be scheduled'
    );
    return null;
  }

  const task = cron.schedule(WEEKLY_SPEC, async () => {
    const startedAt = new Date().toISOString();
    try {
      const r = await planWeek();
      console.log(
        `[schedule] planned week of ${r.weekStart}: ` +
        `${r.created.length} created, ${r.repaired.length} repaired, ` +
        `${r.skipped.length} skipped, ${r.failed.length} failed`
      );
      for (const f of r.failed) console.error(`[schedule] ${f.id}: ${f.error}`);
    } catch (err) {
      // A failed plan must not take the service down with it.
      console.error(`[schedule] run started ${startedAt} failed:`, err.message);
    }
  }, { timezone: ZONE });

  console.log(`[schedule] weekly planner armed: "${WEEKLY_SPEC}" in ${ZONE}`);
  return task;
}
