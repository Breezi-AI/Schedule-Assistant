# STATE

Read this first in a new session.

## Where things are

Milestone 0 **deployed and exercised over HTTP**. Express + Postgres, two
concerns: `cc_events` (Claude Code telemetry) and the gym log (`gym_program`,
`gym_sessions`).

- Deployed URL: **https://app-production-7e75.up.railway.app**
- Railway project: `personal-ops` (NEW project, id `3b7479e8-6335-4c96-994a-222ab56a090e`),
  workspace "breezi-ai's Projects". Services: `app` and `Postgres`.
- GitHub: `https://github.com/Breezi-AI/Schedule-Assistant.git` — the repo is
  named Schedule-Assistant, the project is named personal-ops.
- `ASSISTANT_TOKEN` and `APP_TOKEN` are fresh `openssl rand -hex 24` values set
  on the `app` service. They are not written to any file in this repo.

## Verified

Everything below was run on 2026-09-17, most of it against the deployed URL.

**Boot and build**

- `npm install` works. 82 packages, 0 vulnerabilities, locally and in the
  Railway build. The previous note that the registry was blocked was true of
  the environment this repo was authored in, not of this machine.
- `src/db/schema.sql` applies cleanly on boot and is idempotent. It has now run
  against **Postgres 18** (`ghcr.io/railwayapp-templates/postgres-ssl:18`), not
  the Postgres 16 this file previously recorded.
- The server boots and listens. Railway logs: `personal-ops listening on :8080`.

**HTTP — 12 of 12 checks pass (`npm run smoke`)**

- `GET /health` returns 200 `{ok:true}`. `ok:true` means `SELECT 1` reached
  Postgres, so this doubles as a database liveness check.
- `POST /hooks/cc` with a valid Bearer returns 200.
- `POST /hooks/cc` with a bad token returns 401.
- `POST /hooks/cc` with malformed JSON still returns 200.
- `GET /api/gym/program` with a bad token returns 401.
- `GET /api/gym/program` seeds the three-day split and returns it.
- `POST /api/gym/sessions` then `GET /api/gym/sessions` round-trips, and
  `started_at`/`ended_at` survive, so duration is measurable.
- `POST /api/gym/sessions` with missing fields returns 400.
- `GET /api/gym/week` returns gym totals and active minutes by project.

**The two claims the hook collector exists to make**

Both are proved by the week endpoint rather than by reading the row, and the
proof is sound because it exercises the real query path:

- *`project` is populated from `cwd`.* The smoke payload sends the Windows cwd
  `C:\Users\Kaylee\breezi-dispatcher`. `GET /api/gym/week` comes back keyed
  `breezi-dispatcher`. The only source of that key is the `project` column.
- *`received_at` is stamped server-side.* The smoke payload deliberately
  claims `received_at: 1999-01-01`. `ccSessions` filters
  `received_at > now() - '7 days'`. The row is still inside that window, so the
  payload clock was ignored.

**Unit — 19 of 19 pass (`npm run test:unit`)**

`projectFromCwd` across Windows, POSIX, mixed and malformed paths; `shapeOf`
across hostile types, and that it never stores `last_assistant_message` or the
transcript path.

## NOT verified

- **A real Claude Code hook has never fired at `/hooks/cc`.** Every beat so far
  is a synthetic POST from the smoke script. Wiring the Stop hook into a repo
  is what closes this.
- **The gym page has not been opened on a phone and no real workout logged.**
  Every gym row so far is synthetic.
- **No row of `cc_events` has been read back directly.** The `payload` column
  has not been eyeballed, so "no transcript content is stored" rests on the
  unit test of `shapeOf`, not on inspection of stored data. Reading a row needs
  either a Railway SSH key or a TCP proxy on the Postgres service; neither
  exists yet and both are persistent artifacts, so neither was created.
- **`npm run dev` against a reachable database.** This machine has no local
  Postgres and Railway's `DATABASE_URL` is an internal hostname, so the local
  workflow in the README cannot be run as written. A TCP proxy on the Postgres
  service is what would fix it.
- **The session-grouping SQL against real, accumulated, multi-beat data.** It
  has only ever seen single synthetic beats, where `active_minutes` is just
  `BEAT_FLOOR_MINUTES`. The gap/cap/floor arithmetic is still unproven on a
  real evening of work.

## What surprised us

- **A Stop payload has no `tool_calls` field.** Read out of the installed
  Claude Code 2.1.191 binary: a Stop hook sends `session_id`,
  `transcript_path`, `cwd`, `permission_mode`, `agent_id`, `agent_type`,
  `effort`, `hook_event_name`, `stop_hook_active`, `last_assistant_message`,
  `background_tasks`, `session_crons`. `tool_names` and `tool_count` would have
  been empty forever. Nothing in milestone 0 depended on them — session
  grouping reads only `received_at`, `session_id` and `project` — but the
  premise "cc_events stores the shape of a turn (tool names, counts)" was
  wrong and has been corrected. Capturing tool names needs a PostToolUse hook,
  which would also flood `cc_events` with beats and corrupt the credit
  arithmetic, so it is not a small change. Leave it for later.
- **`"async": true` is not valid on an HTTP hook.** It belongs to
  `BashCommandHookSchema`, not `HttpHookSchema`, so it was being dropped and
  every Stop would have blocked the turn for up to the 5s timeout — against
  rule 2 in `.claude/CLAUDE.md`. Removed. **An HTTP Stop hook is synchronous;
  the service being slow to wake is felt at the end of every turn.**
- **`cwd` arrives OS-native.** `hooks.js` split it on `/` only, so on Windows
  every beat would have stored the whole path as the project name. Caught by a
  unit test, not by reading the code.
- **This machine has no Visual C++ runtime**, so the portable EnterpriseDB
  Postgres binaries cannot start (`STATUS_DLL_NOT_FOUND`). A local Postgres
  needs an admin install. That is why Railway is doing double duty.
- Railway provisions **Postgres 18**, not 16.

## Decisions worth not relitigating

- Work time is credit-based, not span-based. See README.
- The server stamps every timestamp. Nothing trusts a client clock.
- `cc_events` stores the shape of a turn, never transcript contents.
- The gym log must stay useful with no assistant attached. If logging only pays
  off because a bot reads it, it stops getting used.
- The baseline commit is the code exactly as authored; every fix is a separate
  commit on top, so the diff is reviewable.

## Next

Milestone 1 is gated on two weeks of real gym rows, because its whole job is
verifying against that log. Before then the only work worth doing is:

1. Wire the Stop hook into a repo and confirm a real beat lands.
2. Log real workouts from the phone.
3. Let `cc_events` accumulate enough beats to test the gap/cap/floor
   arithmetic against an evening you can remember.
