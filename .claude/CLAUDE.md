# personal-ops

Time-blocking and accountability for Jake. **Separate project from Breezi** — no
shared package, no plugin. Read `docs/STATE.md` before doing anything.

## Shape

`src/index.js` boots, runs the schema, serves. Modules:

- `src/db/` — pool, schema, the session-grouping queries
- `src/time.js` — every local-time decision in the project, via Luxon
- `src/calendar.js` — Google Calendar over plain REST
- `src/planner.js` — the weekly gym planner
- `src/schedule.js` — the Sunday 18:00 cron that runs it
- `src/routes/hooks.js` — receives Claude Code hook beats
- `src/routes/gym.js` — gym program and sessions API
- `src/routes/blocks.js` — planned blocks and the manual planner trigger
- `src/public/` — the gym log UI, plain HTML, no build step

## Rules

1. **The server stamps time.** Never trust a timestamp from a payload. Client
   clocks get guarded or discarded.
2. **Ingest returns fast and does no thinking.** Hooks have a short budget;
   never block a turn on this service.
3. **Telemetry never breaks the user's work.** A failed insert in `/hooks/cc`
   logs and returns 200.
4. **Store shapes, not contents.** Tool names and counts, never transcripts or
   message bodies.
5. **No build step for the UI.** It's one HTML file on purpose — it has to be
   openable and fixable from a phone.
6. **Schema changes go in `schema.sql`** and must stay idempotent; it runs on
   every boot.
7. **Never do offset arithmetic on a local time.** Everything goes through
   `src/time.js` and Luxon. Adding "UTC-5" to a wall clock is correct for half
   the year and silently wrong for the other half, and nothing in any log
   explains the missing hour. This has already bitten once, in the week-count
   query.
8. **Writes that can be retried must be idempotent by key, not by check.**
   A commitment's id is `<kind>-<local date>` and the row is inserted before
   the calendar is touched, so two runs cannot race through a
   check-then-insert window and produce two events.

## Google Calendar, the three rules

1. **Address the calendar by `GYM_CALENDAR_ID`. Never enumerate
   `calendarList`.** A service account does not accept sharing invitations,
   so its `calendarList` is permanently empty -- which looks exactly like the
   sharing having failed when it is fine.
2. **Never send a `reminders` field.** Reminders are per-identity. Overrides
   written by a service account belong to the service account and reach
   nobody. The phone notifications come from the calendar's own defaults, and
   leaving the field absent is what lets them apply. A correct event reads
   back as `"reminders": {"useDefault": true}`.
3. **`google-auth-library` plus `fetch`, not the `googleapis` package.** This
   needs four endpoints.

## Not in scope yet

Reconciliation, recolouring, move detection, SMS, constraints, email, the
learning layer. Milestone 1b is gated on two weeks of real planned-vs-actual
pairs, which only start existing now that 1a writes the plan.
