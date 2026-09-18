/**
 * Generate next week's gym blocks without waiting for Sunday.
 *
 *   npm run plan:week
 *   npm run plan:week -- --as-of 2026-10-28T12:00:00-04:00
 *   npm run plan:week -- --dry-run
 *
 * Safe to run repeatedly: the planner is idempotent, so a second run reports
 * everything as skipped rather than writing a second set of blocks.
 */
import { planWeek, SLOTS, loadDays, nextDayIds } from '../src/planner.js';
import { ZONE, comingWeekStart, slotFor } from '../src/time.js';
import { pool } from '../src/db/index.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const asOfArg = args[args.indexOf('--as-of') + 1];
const asOf = args.includes('--as-of') && asOfArg ? new Date(asOfArg) : new Date();

if (isNaN(asOf)) {
  console.error(`--as-of "${asOfArg}" is not a date`);
  process.exit(2);
}

try {
  if (dryRun) {
    const weekStart = comingWeekStart(asOf, ZONE);
    const days = await loadDays();
    const dayIds = await nextDayIds(SLOTS.length, days);
    const nameById = new Map(days.map((d) => [d.id, d.name]));
    console.log(`\nwould plan the week of ${weekStart.toISODate()} (${ZONE})\n`);
    SLOTS.forEach((s, i) => {
      const w = slotFor(weekStart, s.dayOffset, s.hour, s.minute, s.minutes);
      console.log(`  ${s.label.padEnd(10)} ${w.date}  ${w.startLocal.slice(11)}-${w.endLocal.slice(11)} ${w.offset}` +
        `  Gym - ${nameById.get(dayIds[i]) || dayIds[i]}`);
    });
    console.log('\nnothing written (--dry-run)\n');
  } else {
    const r = await planWeek({ asOf });
    console.log(`\nweek of ${r.weekStart} (${r.zone})\n`);
    for (const b of r.created) {
      console.log(`  created   ${b.date} ${b.startLocal.slice(11)}-${b.endLocal.slice(11)} ${b.offset}  ${b.dayName}`);
      console.log(`            ${b.htmlLink}`);
    }
    for (const b of r.repaired) {
      console.log(`  repaired  ${b.date} ${b.startLocal.slice(11)}-${b.endLocal.slice(11)}  ${b.dayName} (row existed with no event)`);
      console.log(`            ${b.htmlLink}`);
    }
    for (const b of r.skipped) console.log(`  skipped   ${b.date}  ${b.reason}`);
    for (const b of r.failed) console.log(`  FAILED    ${b.date}  ${b.error}`);
    console.log(`\n${r.created.length} created, ${r.repaired.length} repaired, ` +
      `${r.skipped.length} skipped, ${r.failed.length} failed\n`);
    if (r.failed.length) process.exitCode = 1;
  }
} finally {
  await pool.end();
}
