# STATE

Read this first in a new session.

## Where things are

Milestone 0 built, not yet deployed. Express + Postgres, two concerns:
`cc_events` (Claude Code telemetry) and the gym log (`gym_program`,
`gym_sessions`).

## Verified

- `src/db/schema.sql` applies cleanly to Postgres 16 and is idempotent.
- The session-grouping SQL runs as a parameterised query and produces correct
  splits and credits on simulated data.
- The gym upsert holds the earliest `started_at` across re-saves of the same day.
- Inline JS in `src/public/index.html` parses.

## NOT verified

- `npm install` has never run here — the registry was blocked in the
  environment this was written in. Install and boot it before trusting it.
- No HTTP request has been made against a running server.
- The Claude Code hook has never actually fired at `/hooks/cc`.

First job in the next session: `npm install`, boot against a real database,
POST a fake hook payload, log a fake workout.

## Decisions worth not relitigating

- Work time is credit-based, not span-based. See README.
- The server stamps every timestamp. Nothing trusts a client clock.
- `cc_events` stores the shape of a turn (tool names, counts), never transcript
  contents.
- The gym log must stay useful with no assistant attached. If logging only pays
  off because a bot reads it, it stops getting used.

## Next

Milestone 1: "Assistant" calendar, gym blocks with popup reminders and the gym's
address, 15-minute poll for moves and deletes, end-of-day reconciliation
(kept/moved/missed, recolour the event), Retell SMS on a miss.
