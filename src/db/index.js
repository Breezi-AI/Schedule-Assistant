import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { weekStartDate } from '../time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example and fill it in.');
}

// Railway's Postgres needs SSL but presents a self-signed chain.
const needsSsl = /railway|render|supabase|neon/i.test(process.env.DATABASE_URL);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 5,
});

export const q = (text, params) => pool.query(text, params);

/** Run schema.sql. Idempotent — safe on every boot. */
export async function migrate() {
  const sql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

/**
 * Group cc_events into work sessions.
 *
 * A beat means "a turn just finished", so the work happened BEFORE it.
 * Measuring only first-beat-to-last-beat reports 0 for a single-beat
 * session and undercounts sparse ones, so each beat is CREDITED the time
 * since the previous beat, capped so that thinking or walking away does
 * not inflate the total. The first beat of a session gets a small floor.
 *
 * Returns: project, session_id, started_at, ended_at, beats, span_minutes,
 *          active_minutes.  Use active_minutes for "how much work"; span
 *          for "when".
 */
export async function ccSessions({ since = '30 days', project = null } = {}) {
  const gap = Number(process.env.SESSION_GAP_MINUTES || 45);
  const cap = Number(process.env.BEAT_CREDIT_CAP_MINUTES || 30);
  const floor = Number(process.env.BEAT_FLOOR_MINUTES || 3);
  const { rows } = await q(
    `
    WITH beats AS (
      SELECT session_id, project, received_at,
             LAG(received_at) OVER (PARTITION BY session_id ORDER BY received_at) AS prev
      FROM cc_events
      WHERE received_at > now() - $1::interval
        AND ($2::text IS NULL OR project = $2)
    ),
    marked AS (
      SELECT *,
             CASE WHEN prev IS NULL OR received_at - prev > make_interval(mins => $3)
                  THEN 1 ELSE 0 END AS is_new
      FROM beats
    ),
    grouped AS (
      SELECT *, SUM(is_new) OVER (PARTITION BY session_id ORDER BY received_at) AS grp
      FROM marked
    ),
    credited AS (
      SELECT *,
             CASE WHEN is_new = 1 THEN make_interval(mins => $5)
                  ELSE LEAST(received_at - prev, make_interval(mins => $4)) END AS credit
      FROM grouped
    )
    SELECT project,
           session_id,
           MIN(received_at) AS started_at,
           MAX(received_at) AS ended_at,
           COUNT(*)::int    AS beats,
           ROUND(EXTRACT(EPOCH FROM (MAX(received_at) - MIN(received_at))) / 60.0)::int AS span_minutes,
           ROUND(EXTRACT(EPOCH FROM SUM(credit)) / 60.0)::int AS active_minutes
    FROM credited
    GROUP BY project, session_id, grp
    ORDER BY started_at DESC
    `,
    [since, project, gap, cap, floor]
  );
  return rows;
}

/**
 * Sessions and average duration for the week containing `asOf`.
 *
 * The week boundary is computed in the local zone by `weekStartDate` and
 * passed in as a parameter, rather than by `date_trunc('week', now())` which
 * Postgres evaluates in the database session's timezone (UTC on Railway).
 * That is the whole bug: at 9pm Sunday in New York it is already Monday in
 * UTC, so the database reported the week as starting the next Monday and a
 * Sunday-evening workout fell outside "this week" the instant it was logged.
 *
 * `asOf` exists so that boundary can be tested at a fixed instant instead of
 * only on whatever day the suite happens to run. Nothing in production passes
 * it.
 */
export async function gymWeekSummary({ asOf = new Date() } = {}) {
  const weekStart = weekStartDate(asOf);
  const { rows } = await q(
    `SELECT COUNT(*)::int AS sessions,
            COALESCE(ROUND(AVG(
              EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0
            ))::int, 0) AS avg_minutes
     FROM gym_sessions
     WHERE session_date >= $1::date
       AND session_date <  ($1::date + 7)`,
    [weekStart]
  );
  return { ...rows[0], week_start: weekStart };
}

/** Active minutes per project per day. What the weekly summary reads. */
export async function ccDaily({ since = '14 days' } = {}) {
  const sessions = await ccSessions({ since });
  const out = {};
  for (const s of sessions) {
    const day = new Date(s.started_at).toISOString().slice(0, 10);
    const key = s.project ?? 'unknown';
    out[day] ??= {};
    out[day][key] = (out[day][key] ?? 0) + (s.active_minutes || 0);
  }
  return out;
}
