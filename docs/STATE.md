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

**HTTP and database — 20 of 20 checks pass (`npm run smoke`)**

- `GET /health` returns 200 `{ok:true}`. `ok:true` means `SELECT 1` reached
  Postgres, so this doubles as a database liveness check.
- `POST /hooks/cc` with a valid Bearer returns 200.
- `POST /hooks/cc` with a bad token returns 401.
- `POST /hooks/cc` with malformed JSON still returns 200.
- `GET /api/gym/program` with a bad token returns 401.
- `GET /api/gym/program` seeds the three-day split and returns it.
- `POST /api/gym/sessions` then `GET /api/gym/sessions` round-trips, and
  `started_at`/`ended_at` survive, so duration is measurable.
- Re-saving the same day keeps the earliest `started_at` and replaces the
  sets, which is what stops an evening workout collapsing to a minute when
  you hit save a second time.
- `POST /api/gym/sessions` with missing fields returns 400.
- `GET /api/gym/week` returns gym totals and active minutes by project.

**Row level, read straight out of Postgres**

- A `cc_events` row lands, with `project = 'breezi-dispatcher'` parsed from a
  Windows `cwd`, and a `received_at` stamped by the server.
- The Stop-shape fields (`permission_mode`, `effort`) are captured.
- **Nothing from the transcript is stored.** `last_assistant_message` and
  `transcript_path` are both absent from the stored `payload`. This is now
  verified against stored data, not only against `shapeOf` in isolation.
- The suite deletes its own synthetic beats and workout afterwards and
  asserts none are left. `cc_events` and `gym_sessions` are both empty, so
  the first real beat and first real workout will be unambiguous.

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
- **`npm run dev` has not actually been run**, though it now can be: a TCP
  proxy on the Postgres service makes the database reachable from this
  machine, and `.env` (gitignored) holds that URL and both tokens.
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
- **The Postgres service now has a public TCP proxy**
  (`nozomi.proxy.rlwy.net:18728`), added deliberately so rows can be read back
  and so the README's local workflow is possible at all. It is the database
  reachable from the internet, guarded only by Railway's generated password.
  `railway tcp-proxy delete --service Postgres` closes it.
- **A smoke suite that writes to the real log is a trap.** The first version
  credited synthetic Claude Code minutes to `breezi-dispatcher` and wrote a
  workout onto today's date — corrupting the very number milestone 1 exists to
  verify. It now uses a synthetic date and cleans up after itself.

## Known rough edges, deliberately not fixed in milestone 0

- **Week boundaries are computed in the database's timezone, not yours.**
  `GET /api/gym/week` uses `date_trunc('week', now())`, which Postgres
  evaluates in the server session's timezone (UTC). `TZ=America/New_York` is
  set on the app service, but that does not change Postgres. Late Sunday
  evening Eastern is already Monday UTC, so a Sunday-night workout can land in
  next week's count. The UI's own three-dot week counter uses the browser's
  local Monday and will disagree with the API at that edge.
- The gym page stores `APP_TOKEN` in `localStorage`. Anyone with the unlocked
  phone has the log. That is the accepted trade for a page that opens instantly.

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
