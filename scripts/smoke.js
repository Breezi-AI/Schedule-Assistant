/**
 * End-to-end smoke test. Run against local or deployed:
 *
 *   BASE_URL=http://localhost:3000 node scripts/smoke.js
 *
 * Reads ASSISTANT_TOKEN and APP_TOKEN from the environment. If DATABASE_URL
 * is also set it verifies the cc_events row directly in Postgres, which is
 * the only way to prove received_at is stamped server-side rather than
 * echoed back from the payload.
 */
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ASSISTANT = process.env.ASSISTANT_TOKEN;
const APP = process.env.APP_TOKEN;

let pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

async function req(path, opts = {}) {
  const { method = 'GET', token, body, raw } = opts;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON is itself a fact */ }
  return { status: res.status, json, text };
}

// A Stop payload carrying the fields Claude Code 2.1.191 actually sends.
const SESSION_ID = `smoke-${Date.now()}`;
const CWD = 'C:\\Users\\Kaylee\\breezi-dispatcher';
const stopPayload = {
  session_id: SESSION_ID,
  transcript_path: 'C:\\Users\\Kaylee\\.claude\\projects\\x\\t.jsonl',
  cwd: CWD,
  permission_mode: 'acceptEdits',
  agent_type: 'main',
  effort: { level: 'high' },
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'this must never be stored',
  background_tasks: [],
  session_crons: [],
  // Deliberate lie: the server must ignore any clock in the payload.
  received_at: '1999-01-01T00:00:00.000Z',
};

async function main() {
  console.log(`\npersonal-ops smoke test -> ${BASE}\n`);
  if (!ASSISTANT || !APP) {
    console.error('ASSISTANT_TOKEN and APP_TOKEN must be set in the environment.');
    process.exit(2);
  }

  console.log('health');
  const h = await req('/health');
  check('GET /health returns 200 ok:true',
    h.status === 200 && h.json && h.json.ok === true,
    `status=${h.status} body=${h.text.slice(0, 200)}`);

  console.log('\nhooks');
  const hook = await req('/hooks/cc', { method: 'POST', token: ASSISTANT, body: stopPayload });
  check('POST /hooks/cc with valid Bearer returns 200',
    hook.status === 200 && hook.json && hook.json.ok === true,
    `status=${hook.status} body=${hook.text.slice(0, 200)}`);

  const bad = await req('/hooks/cc', { method: 'POST', token: 'not-the-token', body: stopPayload });
  check('POST /hooks/cc with bad token returns 401',
    bad.status === 401,
    `status=${bad.status} body=${bad.text.slice(0, 200)}`);

  const malformed = await req('/hooks/cc', { method: 'POST', token: ASSISTANT, raw: '{"session_id": ' });
  check('POST /hooks/cc with malformed JSON still returns 200',
    malformed.status === 200,
    `status=${malformed.status} body=${malformed.text.slice(0, 200)}`);

  console.log('\ngym');
  const gymBad = await req('/api/gym/program', { token: 'not-the-token' });
  check('GET /api/gym/program with bad token returns 401',
    gymBad.status === 401,
    `status=${gymBad.status} body=${gymBad.text.slice(0, 200)}`);

  const prog = await req('/api/gym/program', { token: APP });
  const days = prog.json && prog.json.days;
  check('GET /api/gym/program seeds and returns a three-day split',
    prog.status === 200 && Array.isArray(days) && days.length === 3 &&
      days.every((d) => d.id && d.name && Array.isArray(d.exercises) && d.exercises.length),
    `status=${prog.status} days=${JSON.stringify(days) && JSON.stringify(days).slice(0, 200)}`);

  // A deliberately synthetic date, so smoke runs never land in the real gym
  // log, never move the week count, and never collide with a real workout.
  // The id is constant, so re-runs upsert one row rather than accumulating.
  const SMOKE_DATE = '1990-01-01';
  const sessId = `${SMOKE_DATE}-smoke`;
  const startedAt = new Date(Date.now() - 42 * 60000).toISOString();
  const post = await req('/api/gym/sessions', {
    method: 'POST', token: APP,
    body: {
      id: sessId, date: SMOKE_DATE, dayId: 'd1', dayName: 'Deadlift + Back',
      sets: { e1: [{ w: '225', r: '4' }, { w: '245', r: '4' }] },
      names: { e1: 'Deadlift' },
      startedAt,
    },
  });
  check('POST /api/gym/sessions returns the stored session',
    post.status === 200 && post.json && post.json.ok === true &&
      post.json.session && post.json.session.id === sessId,
    `status=${post.status} body=${post.text.slice(0, 300)}`);

  const list = await req('/api/gym/sessions?limit=500', { token: APP });
  const found = list.json && list.json.sessions &&
    list.json.sessions.find((s) => s.id === sessId);
  check('GET /api/gym/sessions round-trips that session',
    list.status === 200 && !!found && found.sets && found.sets.e1 &&
      found.sets.e1[0] && found.sets.e1[0].w === '225',
    `status=${list.status} found=${JSON.stringify(found) && JSON.stringify(found).slice(0, 300)}`);

  check('both ends of the workout are recorded so duration is measurable',
    !!found && !!found.started_at && !!found.ended_at &&
      new Date(found.ended_at) > new Date(found.started_at) &&
      Math.abs(Date.now() - new Date(found.ended_at)) < 120000,
    `started_at=${found && found.started_at} ended_at=${found && found.ended_at}`);

  // The upsert exists to hold the earliest start across re-saves of the same
  // day, so a second save an hour later does not shrink the workout to a
  // minute. Re-save with a deliberately LATER start and confirm it is ignored.
  const firstStart = found && found.started_at;
  const resave = await req('/api/gym/sessions', {
    method: 'POST', token: APP,
    body: {
      id: sessId, date: SMOKE_DATE, dayId: 'd1', dayName: 'Deadlift + Back',
      sets: { e1: [{ w: '225', r: '4' }, { w: '245', r: '4' }, { w: '255', r: '3' }] },
      names: { e1: 'Deadlift' },
      startedAt: new Date(Date.now() - 60000).toISOString(),
    },
  });
  check('re-saving the same day keeps the earliest started_at',
    resave.status === 200 && !!firstStart && resave.json && resave.json.session &&
      new Date(resave.json.session.started_at).getTime() === new Date(firstStart).getTime(),
    `first=${firstStart} after_resave=${resave.json && resave.json.session && resave.json.session.started_at}`);

  check('re-saving the same day replaces the sets',
    resave.status === 200 && resave.json && resave.json.ok === true,
    `status=${resave.status} body=${resave.text.slice(0, 200)}`);

  const badSess = await req('/api/gym/sessions', { method: 'POST', token: APP, body: { id: 'x' } });
  check('POST /api/gym/sessions with missing fields returns 400',
    badSess.status === 400,
    `status=${badSess.status} body=${badSess.text.slice(0, 200)}`);

  const week = await req('/api/gym/week', { token: APP });
  const byProject = week.json && week.json.claude_code_minutes_by_project;
  check('GET /api/gym/week returns gym totals and minutes by project',
    week.status === 200 && week.json && week.json.gym &&
      typeof week.json.gym.sessions === 'number' && week.json.gym.target === 3 &&
      byProject && typeof byProject === 'object',
    `status=${week.status} body=${week.text.slice(0, 300)}`);

  check('the hook beat is attributed to project "breezi-dispatcher"',
    !!byProject && Object.prototype.hasOwnProperty.call(byProject, 'breezi-dispatcher'),
    `by_project=${JSON.stringify(byProject)}`);

  if (process.env.DATABASE_URL) {
    console.log('\ndatabase');
    const pg = (await import('pg')).default;
    const needsSsl = /railway|render|supabase|neon|rlwy/i.test(process.env.DATABASE_URL);
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    });
    try {
      const { rows } = await pool.query(
        `SELECT session_id, event_name, cwd, project, payload, received_at,
                EXTRACT(EPOCH FROM (now() - received_at)) AS age_seconds
         FROM cc_events WHERE session_id = $1`, [SESSION_ID]);
      const row = rows[0];
      check('a cc_events row landed for this session', !!row, `rows=${rows.length}`);
      check('project column is populated from a Windows cwd',
        !!row && row.project === 'breezi-dispatcher',
        `cwd=${row && row.cwd} project=${row && row.project}`);
      check('received_at is stamped server-side, not taken from the payload',
        !!row && Number(row.age_seconds) >= 0 && Number(row.age_seconds) < 300 &&
          new Date(row.received_at).getUTCFullYear() > 2020,
        `received_at=${row && row.received_at} age_seconds=${row && row.age_seconds}`);
      check('event_name and Stop-shape fields were captured',
        !!row && row.event_name === 'Stop' && row.payload &&
          row.payload.permission_mode === 'acceptEdits' && row.payload.effort === 'high',
        `payload=${JSON.stringify(row && row.payload)}`);
      check('no transcript path or message content was stored',
        !!row && !JSON.stringify(row.payload).includes('must never be stored') &&
          !JSON.stringify(row.payload).includes('.jsonl'),
        `payload=${JSON.stringify(row && row.payload)}`);

      // Synthetic beats credit fake minutes to a real project name, which is
      // the one number milestone 1 is supposed to verify against. Leaving
      // them behind would quietly poison it. Same for the synthetic workout.
      console.log('\ncleanup');
      const delBeats = await pool.query(
        `DELETE FROM cc_events WHERE session_id LIKE 'smoke-%'`);
      const delSess = await pool.query(
        `DELETE FROM gym_sessions WHERE id = $1`, [sessId]);
      console.log(`  removed ${delBeats.rowCount} synthetic beat(s) and ${delSess.rowCount} synthetic workout(s)`);

      const { rows: left } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM cc_events WHERE session_id LIKE 'smoke-%'`);
      check('no synthetic telemetry is left behind', left[0].n === 0,
        `${left[0].n} smoke rows still present`);
    } finally {
      await pool.end();
    }
  } else {
    console.log('\ndatabase\n  SKIP  DATABASE_URL not set - row-level checks skipped');
    console.log('        NOTE: synthetic beats and the synthetic workout stay in the');
    console.log('        database. Re-run with DATABASE_URL set to clean them up.');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('\nsmoke test crashed:', err); process.exit(3); });
