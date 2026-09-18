# STATE

Read this first in a new session.

## Where things are

Milestone 0 and **milestone 1a** are deployed and exercised end to end.
Express + Postgres, three concerns: `cc_events` (Claude Code telemetry), the
gym log (`gym_program`, `gym_sessions`), and `commitments` (gym blocks written
to Google Calendar).

- Deployed URL: **https://app-production-7e75.up.railway.app**
- Railway project: `personal-ops` (NEW project, id `3b7479e8-6335-4c96-994a-222ab56a090e`),
  workspace "breezi-ai's Projects". Services: `app` and `Postgres`.
- GitHub: `https://github.com/Breezi-AI/Schedule-Assistant.git` — the repo is
  named Schedule-Assistant, the project is named personal-ops.
- `ASSISTANT_TOKEN` and `APP_TOKEN` are fresh `openssl rand -hex 24` values set
  on the `app` service. They are not written to any file in this repo.

## Calendar

- Calendar: **Assistant - Gym**, id
  `5ca5ee97144a6e43290437d64866eaef585cb07d961e289359c7970747b54a55@group.calendar.google.com`
  (`GYM_CALENDAR_ID`).
- Service account: `personal-ops-calendar@assistant-workflows-509013.iam.gserviceaccount.com`,
  GCP project `assistant-workflows-509013`. Nothing to do with the Breezi GCP
  project, and no Breezi credential is reused anywhere.
- `GOOGLE_SA_JSON_B64` is base64 of the whole key file, 3220 characters. It
  was generated from `Downloads/assistant-workflows-509013-2e42b162eaf3.json`.
- Scope: `https://www.googleapis.com/auth/calendar`. Access level on the
  shared calendar: "Make changes to events".
- The weekly planner is armed in the deployed container:
  `[schedule] weekly planner armed: "0 18 * * 0" in America/New_York`.

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

**Unit — 33 of 33 pass (`npm run test:unit`)**

`projectFromCwd` across Windows, POSIX, mixed and malformed paths; `shapeOf`
across hostile types, and that it never stores `last_assistant_message` or the
transcript path. Plus the local-time cases below.

### Milestone 1a — calendar writes

**The week boundary is computed in your timezone (`npm run test:week`, 8 of 8)**

`date_trunc('week', now())` is gone. The boundary comes from Luxon in
`America/New_York` and is passed to the query as a parameter, so the
database's timezone no longer affects the answer. The window also gained a
far edge; without one a session dated months ahead counted toward this week
forever. The test inserts a session dated a Sunday, asserts it is counted at
9pm that Sunday, and separately asserts the old UTC boundary really would
have excluded it — so reverting the fix fails for the right reason:

```
fixture   1991-01-06T21:00:00.000-05:00   (Sunday, 9pm New York)
in UTC    1991-01-07T02:00:00.000Z        (Monday)
week start per UTC              1991-01-07   <- the old behaviour
week start per America/New_York 1990-12-31
```

**DST, in the unit tests**

17:45 local is `21:45Z` the week of 26 Oct and `22:45Z` the week of 2 Nov.
Same wall clock, instants an hour apart. That is the hour a fixed offset
loses silently, and the blocks are written a week ahead across exactly that
boundary.

**Auth round trip (`npm run smoke:calendar`)**

Created a real event, read it back, deleted it, confirmed it was gone. The
script separates the one failure mode that is separable: a bad key fails at
the token step before any calendar is named. A wrong calendar id and a
calendar that was never shared are both a bare 404 and cannot be told apart
from outside, so the script says so rather than guessing.

**Planner — 22 of 22 pass (`npm run test:planner`)**

Against the real database and the real calendar, cleaning up after itself.
Blocks land on Mon/Wed/Fri at 17:45, 17:45 and 16:05 local; the event
carries `timeZone` rather than a bare UTC instant; summary, location, colour
and opaque transparency are all as specified. **Running the planner twice
creates nothing the second time and leaves the row count unchanged.** A row
whose calendar write failed is repaired on the next run rather than
duplicated. Rotation continues correctly from each of d1, d2 and d3.

**Live, on the deployed service**

- `POST /api/blocks/plan` created the week of 2026-09-21: Mon 21st
  17:45–18:45 Deadlift + Back, Wed 23rd 17:45–18:45 Squat + Shoulders,
  Fri 25th 16:05–17:05 Incline + Upper Back.
- A second trigger reported all three as `already planned` and created
  nothing.
- `GET /api/blocks?from=&to=` returns all three with their event ids; a bad
  token returns 401.
- Read back from Google, all three carry
  **`"reminders": {"useDefault": true}`** — which is what lets the
  calendar-level 35 and 10 minute notifications reach the phone.
- Milestone 0's suite still passes 20 of 20 against the deployed URL, so
  none of this regressed the hook collector or the gym log.

## NOT verified

- **The Sunday 18:00 cron has never actually fired.** It is armed in the
  deployed container and the log line proves the schedule and zone were
  accepted, but the first real firing is Sunday 20 September. Every plan so
  far came from the manual trigger. Until one fires, "node-cron runs weekly
  on Railway" is an assumption — in particular a container that restarts
  between Sundays restarts the timer, and Railway restarts containers.
- **No notification has been seen arriving on the phone.** The events carry
  `useDefault: true`, which is the necessary condition, but the 35 and 10
  minute defaults are a setting in a Google account this service cannot read.
  The first real proof is a phone buzzing at 17:10 on Monday 21 September.
- **A real Claude Code hook has never fired at `/hooks/cc`.** Every beat so far
  is a synthetic POST from the smoke script. Wiring the Stop hook into a repo
  is what closes this.
- **The gym page has not been opened on a phone and no real workout logged.**
  Every gym row so far is synthetic. Rotation currently starts at d1 because
  `gym_sessions` is empty; the rotation rule is unit-tested but has never run
  against a real log.
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
- **`GOOGLE_SA_JSON_B64` and `GYM_CALENDAR_ID` were not in Railway**, despite
  the 1a brief saying both were already set. A live `railway variables` on
  both services in the only environment showed neither. Had that been taken on
  trust, the deployed planner would have failed at the first Sunday with
  nothing watching. **Check the variable exists; do not trust that it was
  set.** They are set now, and the stored base64 is exactly 3220 characters,
  matching the source byte for byte.
- **`node-cron` is given the timezone explicitly.** The container's `TZ` is
  not what schedules it. A Railway container is UTC unless told otherwise, and
  a weekly job that silently drifts by an hour twice a year is the same class
  of bug as the week-count one.
- **The idempotency ordering matters more than the idempotency.** Inserting
  the row before creating the event means a crash leaves a block with no
  calendar entry, which the next run repairs. Creating the event first would
  mean a crash leaves an event with no row — a duplicate nobody ever notices,
  on a calendar that is supposed to be trustworthy.

## Known rough edges, deliberately not fixed

- The gym page stores `APP_TOKEN` in `localStorage`. Anyone with the unlocked
  phone has the log. That is the accepted trade for a page that opens instantly.
- **The plan does not react to a miss inside its own week.** Rotation is read
  once per planning run, so missing Monday does not re-label Wednesday. The
  correction lands on the next Sunday, which re-reads the log. Reacting
  sooner means noticing a miss, which is 1b.
- **Nothing reconciles the calendar back.** If a block is moved or deleted in
  Google Calendar, `commitments` still says `planned` at the original time.
  1a writes; it does not watch.
- **The planner only ever writes the coming week.** A container that is down
  across a Sunday simply misses that week; nothing backfills. The manual
  trigger is the recovery, which is part of why it exists.

## Decisions worth not relitigating

- Work time is credit-based, not span-based. See README.
- The server stamps every timestamp. Nothing trusts a client clock.
- `cc_events` stores the shape of a turn, never transcript contents.
- The gym log must stay useful with no assistant attached. If logging only pays
  off because a bot reads it, it stops getting used.
- The baseline commit is the code exactly as authored; every fix is a separate
  commit on top, so the diff is reviewable.

## Next

Milestone 1b — reconciliation, recolouring, move detection, SMS on a miss —
is gated on two weeks of real planned-vs-actual pairs. Those pairs only start
existing now that 1a writes the plan, and the first of them is the week of
21 September. Before 1b, the work that matters is the work that generates
evidence:

1. Confirm the cron fires on its own on Sunday 20 September at 18:00.
2. Confirm a notification actually arrives on the phone before Monday's block.
3. Log real workouts from the phone, so rotation runs against a real log
   rather than starting at d1 every time.
4. Wire the Stop hook into a repo and confirm a real beat lands.
5. Let `cc_events` accumulate enough beats to test the gap/cap/floor
   arithmetic against an evening you can remember.
