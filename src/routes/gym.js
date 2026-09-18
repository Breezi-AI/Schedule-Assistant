import { Router } from 'express';
import { q, ccSessions } from '../db/index.js';

export const gym = Router();

const DEFAULT_PROGRAM = {
  days: [
    { id: 'd1', name: 'Deadlift + Back', exercises: [
      { id: 'e1', name: 'Deadlift',          sets: 4, reps: '4'    },
      { id: 'e2', name: 'Barbell Row',       sets: 3, reps: '8'    },
      { id: 'e3', name: 'Lat Pulldown',      sets: 3, reps: '10'   },
      { id: 'e4', name: 'Shrugs',            sets: 3, reps: '15'   },
      { id: 'e5', name: 'Farmer Carry',      sets: 3, reps: 'walk' },
      { id: 'e6', name: 'Wrist Curl',        sets: 2, reps: '15'   },
      { id: 'e7', name: 'Reverse Curl',      sets: 2, reps: '15'   },
    ]},
    { id: 'd2', name: 'Squat + Shoulders', exercises: [
      { id: 'e8',  name: 'Back Squat',        sets: 4, reps: '5'  },
      { id: 'e9',  name: 'Overhead Press',    sets: 3, reps: '6'  },
      { id: 'e10', name: 'Romanian Deadlift', sets: 3, reps: '8'  },
      { id: 'e11', name: 'Lateral Raise',     sets: 3, reps: '15' },
      { id: 'e12', name: 'Rear Delt Flye',    sets: 3, reps: '15' },
    ]},
    { id: 'd3', name: 'Incline + Upper Back', exercises: [
      { id: 'e13', name: 'Incline Bench',     sets: 4, reps: '5'  },
      { id: 'e14', name: 'Incline DB Press',  sets: 3, reps: '8'  },
      { id: 'e15', name: 'Cable Row',         sets: 3, reps: '10' },
      { id: 'e16', name: 'Shrugs',            sets: 3, reps: '15' },
      { id: 'e17', name: 'Curls',             sets: 2, reps: '12' },
      { id: 'e18', name: 'Triceps Pushdown',  sets: 2, reps: '12' },
    ]},
  ],
};

/** Shared-secret gate. Single user, so a bearer token is enough. */
export function requireToken(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.APP_TOKEN || token !== process.env.APP_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

gym.use(requireToken);

// --- program -----------------------------------------------------

gym.get('/program', async (_req, res) => {
  const { rows } = await q('SELECT days FROM gym_program WHERE id = 1');
  if (!rows.length) {
    await q('INSERT INTO gym_program (id, days) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(DEFAULT_PROGRAM.days)]);
    return res.json({ days: DEFAULT_PROGRAM.days });
  }
  res.json({ days: rows[0].days });
});

gym.put('/program', async (req, res) => {
  const days = req.body?.days;
  if (!Array.isArray(days) || !days.length) {
    return res.status(400).json({ error: 'days must be a non-empty array' });
  }
  await q(
    `INSERT INTO gym_program (id, days, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET days = EXCLUDED.days, updated_at = now()`,
    [JSON.stringify(days)]
  );
  res.json({ ok: true });
});

// --- sessions ----------------------------------------------------

gym.get('/sessions', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 120, 500);
  const { rows } = await q(
    `SELECT id, session_date, day_id, day_name, sets, names,
            started_at, ended_at, logged_at
     FROM gym_sessions ORDER BY session_date DESC, logged_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ sessions: rows });
});

gym.post('/sessions', async (req, res) => {
  const s = req.body || {};
  if (!s.id || !s.date || !s.dayId) {
    return res.status(400).json({ error: 'id, date and dayId are required' });
  }
  // Guard the client clock. A started_at in the future, or absurdly far in
  // the past, yields a nonsense duration -- fall back to now() instead.
  let startedAt = s.startedAt ? new Date(s.startedAt) : null;
  if (startedAt && (isNaN(startedAt) ||
      startedAt > new Date(Date.now() + 60_000) ||
      startedAt < new Date(Date.now() - 6 * 60 * 60_000))) {
    startedAt = null;
  }

  const { rows } = await q(
    `INSERT INTO gym_sessions
       (id, session_date, day_id, day_name, sets, names, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (id) DO UPDATE SET
       sets       = EXCLUDED.sets,
       names      = EXCLUDED.names,
       day_name   = EXCLUDED.day_name,
       -- keep the earliest known start across re-saves of the same day
       started_at = LEAST(gym_sessions.started_at, EXCLUDED.started_at),
       ended_at   = now()
     RETURNING id, started_at, ended_at`,
    [s.id, s.date, s.dayId, s.dayName ?? null,
     JSON.stringify(s.sets ?? {}), JSON.stringify(s.names ?? {}),
     startedAt ? startedAt.toISOString() : new Date().toISOString()]
  );
  res.json({ ok: true, session: rows[0] });
});

// --- this week, the only number that matters right now -----------

gym.get('/week', async (_req, res) => {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS sessions,
            COALESCE(ROUND(AVG(
              EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0
            ))::int, 0) AS avg_minutes
     FROM gym_sessions
     WHERE session_date >= date_trunc('week', now())::date`
  );
  const cc = await ccSessions({ since: '7 days' });
  const byProject = {};
  for (const s of cc) {
    byProject[s.project ?? 'unknown'] =
      (byProject[s.project ?? 'unknown'] ?? 0) + (s.active_minutes || 0);
  }
  res.json({
    gym: { ...rows[0], target: 3 },
    claude_code_minutes_by_project: byProject,
  });
});
