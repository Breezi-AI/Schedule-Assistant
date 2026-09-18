/**
 * Planned blocks, and the manual trigger for the weekly planner.
 *
 * Same APP_TOKEN gate as the gym routes -- one person, one secret.
 */
import { Router } from 'express';
import { q } from '../db/index.js';
import { requireToken } from './gym.js';
import { planWeek } from '../planner.js';
import { ZONE } from '../time.js';

export const blocks = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

blocks.use(requireToken);

/**
 * GET /api/blocks?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * `from` and `to` are local dates and `to` is inclusive, because a person
 * asking for Monday to Friday means Friday. They are converted to instants
 * in the local zone by Postgres, so the window matches what the calendar
 * shows rather than a UTC day that starts at 8pm the evening before.
 */
blocks.get('/', wrap(async (req, res) => {
  const { from, to } = req.query;
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (from && !isDate(from)) return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
  if (to && !isDate(to)) return res.status(400).json({ error: 'to must be YYYY-MM-DD' });

  const where = [];
  const params = [ZONE];
  if (from) {
    params.push(from);
    where.push(`planned_start >= ($${params.length}::date::timestamp AT TIME ZONE $1)`);
  }
  if (to) {
    params.push(to);
    where.push(`planned_start < (($${params.length}::date + 1)::timestamp AT TIME ZONE $1)`);
  }

  const { rows } = await q(
    `SELECT id, kind, day_id, planned_start, planned_end, calendar_event_id,
            status, created_at,
            to_char(planned_start AT TIME ZONE $1, 'YYYY-MM-DD') AS local_date,
            to_char(planned_start AT TIME ZONE $1, 'HH24:MI')    AS local_start,
            to_char(planned_end   AT TIME ZONE $1, 'HH24:MI')    AS local_end
     FROM commitments
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY planned_start ASC`,
    params
  );
  res.json({ zone: ZONE, blocks: rows });
}));

/**
 * POST /api/blocks/plan
 *
 * Generate next week without waiting for Sunday. Safe to call repeatedly --
 * the planner is idempotent, so a second call reports everything as skipped
 * rather than writing a second set of blocks.
 */
blocks.post('/plan', wrap(async (req, res) => {
  const asOf = req.body?.asOf ? new Date(req.body.asOf) : new Date();
  if (isNaN(asOf)) return res.status(400).json({ error: 'asOf must be a date' });
  try {
    const result = await planWeek({ asOf });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
}));
